"""Reference geometry. Implements CONTRACT.md; web/src/core mirrors it."""
import json
from pathlib import Path

import numpy as np

R = 1737400.0
NAZ = 720
SUN_R = 695700e3
DATA = Path(__file__).resolve().parent.parent / "web/public/data"


def unit(lat, lon):
    la, lo = np.radians(lat), np.radians(lon)
    return np.stack([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)], -1)


def enu(lat, lon):
    la, lo = np.radians(lat), np.radians(lon)
    e = np.array([-np.sin(lo), np.cos(lo), 0.0])
    n = np.array([-np.sin(la) * np.cos(lo), -np.sin(la) * np.sin(lo), np.cos(la)])
    return e, n, unit(lat, lon)


def sp_fwd(lat, lon):
    rho = 2 * R * np.tan(np.pi / 4 + np.radians(lat) / 2)
    return rho * np.sin(np.radians(lon)), rho * np.cos(np.radians(lon))


def sp_inv(x, y):
    return np.degrees(2 * np.arctan(np.hypot(x, y) / (2 * R)) - np.pi / 2), np.degrees(np.arctan2(x, y))


def schedule():
    out, d = [], 10.0
    while d <= 300000:
        out.append(d)
        d += min(max(0.02 * d, 10.0), 240.0)
    return np.array(out)


class Dem:
    """Reads the shipped artifacts, so validation tests exactly what the browser gets."""

    def __init__(self, dem_dir=DATA / "dem"):
        dem_dir = Path(dem_dir)
        self.tiles = json.loads((dem_dir / "manifest.json").read_text())["tiles"]
        for t in self.tiles:
            t["a"] = np.memmap(dem_dir / t["file"], dtype="<i2", mode="r", shape=(t["h"], t["w"]))

    def sample(self, lat, lon, with_sigma=False):
        lat, lon = np.asarray(lat, float), np.asarray(lon, float)
        h, sig = np.zeros(lat.shape), np.zeros(lat.shape)
        for t in reversed(self.tiles):  # coarsest first, finer tiles overwrite
            if t["proj"] == "spstere":
                x, y = sp_fwd(lat, lon)
                c, r = (x - t["x0"]) / t["px"], (t["y0"] - y) / t["px"]
                ok = (c >= 0) & (c <= t["w"] - 1) & (r >= 0) & (r <= t["h"] - 1)
                c, r = c[ok], r[ok]
                c0 = np.minimum(c.astype(int), t["w"] - 2)
                c1 = c0 + 1
            else:
                ok = np.ones(lat.shape, bool)
                c = ((lon.ravel() - t["lon0"]) % 360) * t["ppd"]
                r = np.clip((t["lat0"] - lat.ravel()) * t["ppd"], 0, t["h"] - 1)
                c0 = c.astype(int) % t["w"]
                c1 = (c0 + 1) % t["w"]
            r0 = np.minimum(r.astype(int), t["h"] - 2)
            fc, fr = c - np.floor(c), r - r0
            a = t["a"]
            v = (a[r0, c0] * (1 - fc) + a[r0, c1] * fc) * (1 - fr) + (a[r0 + 1, c0] * (1 - fc) + a[r0 + 1, c1] * fc) * fr
            h[ok] = t["offset"] + t["scale"] * v
            sig[ok] = t["sigma_h"]
        return (h, sig) if with_sigma else h


def horizon(dem, lat, lon, mast=0.0, naz=NAZ):
    """-> el_deg[naz], dist_m[naz], sigma_h_m[naz] (DEM sigma at the sample that set the max)."""
    e, n, u = enu(lat, lon)
    site = (R + float(dem.sample(lat, lon)) + mast) * u
    d = schedule()
    az = np.radians(np.arange(naz) * 360.0 / naz)
    dirh = np.cos(az)[:, None] * n + np.sin(az)[:, None] * e
    p = np.cos(d / R)[None, :, None] * u + np.sin(d / R)[None, :, None] * dirh[:, None, :]
    plat, plon = np.degrees(np.arcsin(p[..., 2])), np.degrees(np.arctan2(p[..., 1], p[..., 0]))
    res = dem.sample(plat, plon, with_sigma=True) if isinstance(dem, Dem) else (dem.sample(plat, plon), None)
    v = (R + res[0])[..., None] * p - site
    up = v @ u
    el = np.degrees(np.arctan2(up, np.sqrt(np.maximum((v * v).sum(-1) - up * up, 0))))
    k = el.argmax(1)
    rows = np.arange(naz)
    return el[rows, k], d[k], (res[1][rows, k] if res[1] is not None else np.zeros(naz))


def azel(lat, lon, h_site, body_km):
    """Az/el (deg) and distance (m) of a body given its Moon-centred MOON_ME vector(s) in km."""
    e, n, u = enu(lat, lon)
    v = np.asarray(body_km) * 1000.0 - (R + h_site) * u
    up, dist = v @ u, np.linalg.norm(v, axis=-1)
    return np.degrees(np.arctan2(v @ e, v @ n)) % 360, np.degrees(np.arcsin(up / dist)), dist


def horizon_at(hor_el, az):
    i = np.asarray(az) / (360.0 / len(hor_el))
    i0 = np.floor(i).astype(int)
    f = i - i0
    return hor_el[i0 % len(hor_el)] * (1 - f) + hor_el[(i0 + 1) % len(hor_el)] * f


def sun_frac(el_sun, hor, dist_sun):
    x = np.clip((el_sun - hor) / np.degrees(np.arcsin(SUN_R / dist_sun)), -1, 1)
    return 1 - (np.arccos(x) - x * np.sqrt(1 - x * x)) / np.pi
