"""Calibrate the horizon-space uncertainty model against NASA's own Monte-Carlo DEM realisations.
Run: .venv/bin/python prep/calib.py   -> web/public/data/calibration.json

Barker et al. 2021 (PGDA product 78) publish, per 5 m site DEM, 100 "clones": DEM realisations drawn from
the LOLA track geolocation error model. For one site we recompute the horizon on N clones and compare
  (a) the real spread of horizon elevation per azimuth  vs  our model  sigma_el = atan(sigma_h / dist),
  (b) the spread of '% lit over a year'                 vs  our Monte-Carlo over horizon draws,
  (c) the horizon from the 5 m DEM                      vs  our shipped 20 m tile (resolution error).
Only terrain within HALF m of the site is perturbed (window read over HTTP); beyond it the shipped DEM is used.
"""
import json
import subprocess
import sys

import numpy as np
import rasterio
from rasterio.windows import from_bounds

from geom import DATA, Dem, horizon, horizon_draws, load_ephem, series, sp_fwd, uncertainty

BASE = "/vsicurl/https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/Site01/"
ROOT = DATA.parent.parent.parent
LAT, LON, MAST = -89.474, -137.414, 2.0  # Connecting Ridge site from sites.json
HALF = 1500.0
# sigma_h scale (x1.5) and the 45 deg correlation length were tuned on clones 1-30; this run reports on 31-60
CLONES = range(31, 61)
N = len(CLONES)


class Patched:
    """Shipped DEM plus a 5 m correction field inside a window around the site."""

    def __init__(self, dem, field, x0, y0, px):
        self.dem, self.f, self.x0, self.y0, self.px = dem, np.nan_to_num(field), x0, y0, px

    def sample(self, lat, lon):
        h = self.dem.sample(lat, lon)
        x, y = sp_fwd(np.asarray(lat, float), np.asarray(lon, float))
        c, r = (x - self.x0) / self.px, (self.y0 - y) / self.px
        ok = (c >= 0) & (c <= self.f.shape[1] - 1) & (r >= 0) & (r <= self.f.shape[0] - 1)
        c, r = c[ok], r[ok]
        c0, r0 = np.minimum(c.astype(int), self.f.shape[1] - 2), np.minimum(r.astype(int), self.f.shape[0] - 2)
        fc, fr = c - c0, r - r0
        f = self.f
        d = (f[r0, c0] * (1 - fc) + f[r0, c0 + 1] * fc) * (1 - fr) + (f[r0 + 1, c0] * (1 - fc) + f[r0 + 1, c0 + 1] * fc) * fr
        # fade the correction to zero at the window edge so no artificial cliff is created
        edge = np.minimum.reduce([c, r, self.f.shape[1] - 1 - c, self.f.shape[0] - 1 - r]) * self.px
        h = np.array(h, float)
        h[ok] += d * np.clip(edge / 200.0, 0, 1)
        return h


def read(name, x, y):
    """Window read from a local copy (data/clones/); ranged HTTP reads from PGDA truncate too often."""
    local = ROOT / "data/clones" / name.split("/")[-1]
    if not local.exists():
        local.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["curl", "-sfL", "-C", "-", "--retry", "8", "--retry-delay", "3", "--retry-all-errors",
                        "-o", str(local), BASE.replace("/vsicurl/", "") + name], check=True)
    return _read(local, x, y)


def _read(path, x, y):
    with rasterio.open(path) as d:
        win = from_bounds(x - HALF, y - HALF, x + HALF, y + HALF, d.transform)
        a = d.read(1, window=win).astype(float)
        t = rasterio.windows.transform(win, d.transform)
        return a, t.c + t.a / 2, t.f + t.e / 2, t.a  # array, x/y of pixel (0,0) centre, pixel size


if __name__ == "__main__":
    dem = Dem()
    meta, eph = load_ephem()
    x, y = sp_fwd(LAT, LON)
    surf, x0, y0, px = read("Site01_final_adj_5mpp_surf.tif", x, y)
    toterr, *_ = read("Site01_final_adj_5mpp_toterr.tif", x, y)
    yy, xx = np.mgrid[0:surf.shape[0], 0:surf.shape[1]]
    lat5, lon5 = __import__("geom").sp_inv(x0 + xx * px, y0 - yy * px)
    base20 = dem.sample(lat5, lon5)
    res = surf - base20  # 5 m DEM minus shipped 20 m tile
    print(f"window {surf.shape} px at {px} m; 5 m minus 20 m tile: mean {np.nanmean(res):+.2f} m, rms {np.nanstd(res):.2f} m; "
          f"toterr median {np.nanmedian(toterr):.2f} m")

    el20, dist20, sig20 = horizon(dem, LAT, LON, MAST)
    el5, _, _ = horizon(Patched(dem, res, x0, y0, px), LAT, LON, MAST)
    near = dist20 < HALF - 300  # azimuths whose horizon is set inside the perturbed window

    i0 = int((np.datetime64("2027-01-01") - np.datetime64(meta["t0"][:-1])) / np.timedelta64(1, "s") / meta["step_s"])
    year = lambda hor: float(series(dem, eph, i0, 8766, LAT, LON, MAST, hor=hor)["sun_frac"].mean())

    els, lit = [], []
    for k in CLONES:
        clone, *_ = read(f"Clones/Site01_final_adj_5mpp_{k:04d}_err.tif", x, y)
        field = clone - base20 if abs(np.nanmedian(clone)) > 100 else res + clone  # clone is a DEM, or an error field
        e, d, s = horizon(Patched(dem, field, x0, y0, px), LAT, LON, MAST)
        els.append(e)
        lit.append(year((e, d, s)))
        if k == CLONES[0]:
            print(f"first clone: median {np.nanmedian(clone):.1f} m, rms vs 5 m surf {np.nanstd(field - res):.2f} m")
        print(f"  clone {k}/{N}", file=sys.stderr)
    els, lit = np.array(els), np.array(lit)

    emp = els.std(0)
    mod = np.degrees(np.arctan2(sig20, dist20))
    ratio = float(np.median(emp[near] / mod[near])) if near.any() else None
    s = series(dem, eph, i0, 8766, LAT, LON, MAST, hor=(el20, dist20, sig20))
    mc = uncertainty(s, horizon_draws(el20, dist20, sig20, n=256))
    out = {
        "site": {"lat": LAT, "lon": LON, "mast": MAST}, "clones": N, "clone_ids": [CLONES[0], CLONES[-1]],
        "note": "model constants were tuned on clones 1-30; these numbers are from held-out clones", "window_half_m": HALF,
        "source": "NASA PGDA product 78 (Barker et al. 2021), Site01 5 m DEM and Monte-Carlo clones",
        "dem_5m_minus_20m_rms_m": round(float(np.nanstd(res)), 2), "toterr_median_m": round(float(np.nanmedian(toterr)), 2),
        "azimuths_set_in_window": int(near.sum()),
        "horizon_sigma_deg": {"clones_median": round(float(np.median(emp[near])), 4) if near.any() else None,
                              "model_median": round(float(np.median(mod[near])), 4) if near.any() else None,
                              "ratio_clones_over_model": round(ratio, 2) if ratio else None},
        "horizon_5m_vs_20m_deg": {"mean": round(float((el5 - el20).mean()), 4), "rms": round(float((el5 - el20).std()), 4),
                                  "max_abs": round(float(np.abs(el5 - el20).max()), 3)},
        "pct_lit_year": {"shipped_20m": round(year((el20, dist20, sig20)), 4), "with_5m_detail": round(year((el5, dist20, sig20)), 4),
                         "clones_mean": round(float(lit.mean()), 4), "clones_std": round(float(lit.std()), 4),
                         "model_mc_mean": round(mc["pct_lit_mean"], 4), "model_mc_std": round(mc["pct_lit_std"], 4)},
    }
    (DATA / "calibration.json").write_text(json.dumps(out, indent=1))
    print(json.dumps(out, indent=1))
