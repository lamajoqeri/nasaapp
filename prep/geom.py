"""Reference geometry. Implements CONTRACT.md; web/src/core mirrors it."""
import json
from pathlib import Path

import numpy as np

R = 1737400.0
NAZ = 720
SUN_R = 695700e3
EARTH_R = 6371e3  # mean radius, for eclipses
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
            fc, fr = (c - np.floor(c) if t["proj"] == "eqc" else c - c0), r - r0  # c - c0 keeps the last column exact
            a = t["a"]
            v = (a[r0, c0] * (1 - fc) + a[r0, c1] * fc) * (1 - fr) + (a[r0 + 1, c0] * (1 - fc) + a[r0 + 1, c1] * fc) * fr
            h[ok] = t["offset"] + t["scale"] * v
            sig[ok] = t["sigma_h"]
        return (h, sig) if with_sigma else h


def horizon(dem, lat, lon, mast=0.0, naz=NAZ, d=None, azs=None):
    """-> el_deg[naz], dist_m[naz], sigma_h_m[naz] (DEM sigma at the sample that set the max)."""
    e, n, u = enu(lat, lon)
    site = (R + float(dem.sample(lat, lon)) + mast) * u
    d = schedule() if d is None else d
    az = np.radians(np.arange(naz) * 360.0 / naz if azs is None else azs)
    naz = len(az)
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


# ---- time series, metrics, uncertainty (reference for web/src/core) ----

def eclipse(saz, sel, eaz, eel, dist_sun, dist_earth):
    """Share (0..1) of the Sun's disk hidden behind Earth's disk, seen from the site (small-angle circles).
    ponytail: solid 6371 km Earth, no atmosphere (real umbra is ~2% wider); fine at hourly steps."""
    r1 = np.degrees(np.arcsin(SUN_R / dist_sun))
    r2 = np.degrees(np.arcsin(EARTH_R / dist_earth))
    a1, e1, a2, e2 = (np.radians(x) for x in (saz, sel, eaz, eel))
    d = np.degrees(np.arccos(np.clip(np.sin(e1) * np.sin(e2) + np.cos(e1) * np.cos(e2) * np.cos(a1 - a2), -1, 1)))
    with np.errstate(invalid="ignore", divide="ignore"):
        dd = np.maximum(d, 1e-12)
        lens = (r1 ** 2 * np.arccos(np.clip((dd ** 2 + r1 ** 2 - r2 ** 2) / (2 * dd * r1), -1, 1))
                + r2 ** 2 * np.arccos(np.clip((dd ** 2 + r2 ** 2 - r1 ** 2) / (2 * dd * r2), -1, 1))
                - 0.5 * np.sqrt(np.maximum((-dd + r1 + r2) * (dd + r1 - r2) * (dd - r1 + r2) * (dd + r1 + r2), 0)))
    f = lens / (np.pi * r1 ** 2)
    f = np.where(d >= r1 + r2, 0.0, f)
    f = np.where(d <= abs(r2 - r1), np.minimum(1.0, (r2 / r1) ** 2), f)
    return np.clip(f, 0, 1)


def load_ephem():
    meta = json.loads((DATA / "ephem.json").read_text())
    return meta, np.fromfile(DATA / "ephem.bin", dtype="<f4").reshape(-1, 6).astype(float)


def series(dem, eph, i0, n, lat, lon, mast=2.0, margin=0.0, hor=None):
    """Hourly series from ephem step i0 for n steps. hor = (el, dist, sigma) to reuse a horizon."""
    el, dist, sig = hor if hor is not None else horizon(dem, lat, lon, mast)
    h = float(dem.sample(lat, lon)) + mast
    v = eph[i0:i0 + n]
    saz, sel, sd = azel(lat, lon, h, v[:, :3])
    eaz, eel, ed = azel(lat, lon, h, v[:, 3:])
    ecl = eclipse(saz, sel, eaz, eel, sd, ed)
    return {"sun_az": saz, "sun_el": sel, "sun_frac": sun_frac(sel, horizon_at(el, saz), sd) * (1 - ecl), "eclipse": ecl,
            "earth_az": eaz, "earth_el": eel, "earth_visible": eel - horizon_at(el, eaz) > margin,
            "sun_dist": sd, "horizon": (el, dist, sig)}


def _first(mask):
    k = np.flatnonzero(mask)
    return int(k[0]) if len(k) else None


def _longest(mask):
    best = run = 0
    for m in mask:
        run = run + 1 if m else 0
        best = max(best, run)
    return best


def metrics(s, dsn=None, step_h=1.0):
    """Metrics over the whole series window (use 708 hourly steps = one lunar day).
    hours_to_* are None when the event does not happen inside the window."""
    lit, ev = s["sun_frac"] > 0, s["earth_visible"]
    f = lambda k: None if k is None else k * step_h
    out = {"sun_el_now": float(s["sun_el"][0]), "sun_frac_now": float(s["sun_frac"][0]),
           "earth_el_now": float(s["earth_el"][0]), "earth_visible_now": bool(ev[0]),
           "hours_to_sunset": f(_first(~lit)) if lit[0] else 0.0,
           "hours_to_sunrise": f(_first(lit)) if not lit[0] else 0.0,
           "hours_to_earthset": f(_first(~ev)) if ev[0] else 0.0,
           "hours_to_earthrise": f(_first(ev)) if not ev[0] else 0.0,
           "pct_lit": float(s["sun_frac"].mean()), "longest_dark_h": _longest(~lit) * step_h,
           "dte_hours": float(ev.sum() * step_h), "longest_no_earth_h": _longest(~ev) * step_h}
    if dsn is not None:
        out["comms_hours"] = float((ev & (dsn > 0)).sum() * step_h)
    return out


def horizon_draws(el, dist, sig, n=64, seed=0, smooth_deg=45.0):
    """n perturbed horizons (n, naz): Gaussian offsets, boxcar-smoothed over smooth_deg of azimuth,
    renormalised to unit variance, scaled by sigma_el = atan(sigma_h / dist).
    smooth_deg = 45 and the manifest sigma_h are calibrated on NASA DEM clones (prep/calib.py)."""
    naz = len(el)
    k = max(1, int(round(smooth_deg / (360.0 / naz))))
    g = np.random.default_rng(seed).standard_normal((n, naz))
    g = sum(np.roll(g, j - k // 2, axis=1) for j in range(k)) / np.sqrt(k)
    return el[None, :] + g * np.degrees(np.arctan2(sig, dist))[None, :]


def uncertainty(s, draws):
    """P(lit) per step and mean/std of pct_lit over horizon draws."""
    naz = draws.shape[1]
    i = s["sun_az"] / (360.0 / naz)
    i0 = np.floor(i).astype(int)
    f = i - i0
    hor = draws[:, i0 % naz] * (1 - f) + draws[:, (i0 + 1) % naz] * f  # (n, steps)
    frac = sun_frac(s["sun_el"][None, :], hor, s["sun_dist"][None, :]) * (1 - s["eclipse"][None, :])
    pct = frac.mean(1)
    return {"p_lit": (frac > 0).mean(0), "pct_lit_mean": float(pct.mean()), "pct_lit_std": float(pct.std())}


def battery(frac, panel_w=200.0, load_w=100.0, capacity_wh=1500.0, soc0=1.0, step_h=1.0):
    """State of charge (0..1) per step and hours until the battery is empty (None = survives the window).
    Power in = panel_w * visible Sun fraction (vertical, Sun-tracking panel: no cosine loss at the pole).
    ponytail: constant load, no thermal or hibernation logic; add a load profile if a mission needs one."""
    soc, e, dead = np.empty(len(frac)), soc0 * capacity_wh, None
    for i, f in enumerate(frac):
        e = min(capacity_wh, e + (panel_w * f - load_w) * step_h)
        if e <= 0 and dead is None:
            dead = (i + 1) * step_h
        e = max(e, 0.0)
        soc[i] = e / capacity_wh
    return soc, dead
