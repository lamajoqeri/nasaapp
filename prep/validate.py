"""Validation of the shipped artifacts -> web/public/data/validation.json. Run: .venv/bin/python prep/validate.py

1. Sun/Earth az/el from ephem.bin vs the JPL Horizons API (5 sites x 20 times x 2 bodies).
2. Fast horizon march vs a brute-force 10 m march at a real site (does the step schedule skip ridges?).
3. Multi-year Sun/Earth visibility at random Shackleton-tile points vs NASA PGDA maps (Mazarico et al. 2011).
"""
import json
import sys

import numpy as np
import rasterio
import requests

from geom import DATA, Dem, azel, horizon, horizon_at, schedule, sp_fwd, sp_inv, SUN_R

ROOT = DATA.parent.parent.parent
META = json.loads((DATA / "ephem.json").read_text())
EPH = np.fromfile(DATA / "ephem.bin", dtype="<f4").reshape(-1, 6).astype(float)
T0 = np.datetime64(META["t0"][:-1])
EARTH_R = 6371e3


def ephem_at(t):
    """Linear interpolation of the table at numpy datetime64 time(s)."""
    i = (np.asarray(t, "datetime64[s]") - T0).astype(float) / META["step_s"]
    i0 = np.floor(i).astype(int)
    f = (i - i0)[..., None]
    return EPH[i0] * (1 - f) + EPH[i0 + 1] * f


def horizons(body, lat, lon, start, step_d, n):
    stop = str(np.datetime64(start) + np.timedelta64(step_d * (n - 1), "D")).replace("T", " ")
    q = {"format": "text", "COMMAND": f"'{body}'", "EPHEM_TYPE": "'OBSERVER'", "CENTER": "'coord@301'",
         "COORD_TYPE": "'GEODETIC'", "SITE_COORD": f"'{lon},{lat},0'", "START_TIME": f"'{start.replace('T', ' ')}'",
         "STOP_TIME": f"'{stop}'", "STEP_SIZE": f"'{step_d}d'", "QUANTITIES": "'4'", "ANG_FORMAT": "'DEG'",
         "EXTRA_PREC": "'YES'", "CSV_FORMAT": "'YES'"}
    txt = requests.get("https://ssd.jpl.nasa.gov/api/horizons.api", params=q, timeout=120).text
    rows = txt.split("$$SOE")[1].split("$$EOE")[0].strip().splitlines()
    return np.array([[float(x) for x in r.split(",")[3:5]] for r in rows])


def check_horizons():
    worst = {"sun": 0.0, "earth": 0.0}
    start, step_d, n = "2026-01-01T00:30", 37, 20  # half past: exercises table interpolation
    t = np.datetime64(start) + np.arange(n) * np.timedelta64(step_d, "D")
    v = ephem_at(t)
    for lat, lon in [(-89.474, -137.414), (-85.9891, 0.238), (-84.7906, 29.1957), (0.6741, 23.473), (44.12, -19.51)]:
        for name, body, col in [("sun", 10, slice(0, 3)), ("earth", 399, slice(3, 6))]:
            ref = horizons(body, lat, lon, start, step_d, n)
            az, el, _ = azel(lat, lon, 0.0, v[:, col])
            # compare as angular separation so azimuth near the zenith/wrap does not blow up
            daz = (az - ref[:, 0] + 180) % 360 - 180
            sep = np.hypot(daz * np.cos(np.radians(el)), el - ref[:, 1]).max()
            worst[name] = max(worst[name], float(sep))
            print(f"  horizons {name:5s} ({lat:8.3f},{lon:8.3f}) max sep {sep:.5f} deg")
    assert max(worst.values()) < 0.01, worst
    return {"n": 5 * n, "max_sep_deg": {k: round(v, 5) for k, v in worst.items()}}


def check_dense(dem, lat=-89.474, lon=-137.414):
    fast, _, _ = horizon(dem, lat, lon, 2.0)
    azs = np.arange(0, 360, 5.0)  # every 10th azimuth, 10 m steps all the way out
    dense = np.concatenate([horizon(dem, lat, lon, 2.0, d=np.arange(10.0, 300000.0, 10.0), azs=azs[i:i + 6])[0]
                            for i in range(0, len(azs), 6)])
    diff = dense - fast[::10]  # positive = fast march missed something
    print(f"  dense vs fast march: max missed {diff.max():.4f} deg, mean {diff.mean():.4f} deg")
    assert diff.max() < 0.05, diff.max()
    return {"site": [lat, lon], "max_missed_deg": round(float(diff.max()), 4), "mean_missed_deg": round(float(diff.mean()), 5)}


def check_pgda(dem, n=300, seed=0):
    rng = np.random.default_rng(seed)
    xs, ys = rng.uniform(-28000, 8000, n), rng.uniform(-28000, 8000, n)
    v = EPH[::4]  # every 4 h over the whole 16-year table (PGDA: hourly over 18.6 years)
    ours, theirs = [], []
    with rasterio.open(ROOT / "data/AVGVISIB_85S_060M_201608.TIF") as ps, \
            rasterio.open(ROOT / "data/AVGVISIB_85S_060M_201608_EARTH.TIF") as pe:
        for k, (x, y) in enumerate(zip(xs, ys)):
            lat, lon = sp_inv(x, y)
            el, _, _ = horizon(dem, lat, lon, 0.0)
            h0 = float(dem.sample(lat, lon))
            saz, sel, sd = azel(lat, lon, h0, v[:, :3])
            eaz, eel, ed = azel(lat, lon, h0, v[:, 3:])
            # PGDA rule: any part of the disc above the horizon
            s = (sel + np.degrees(np.arcsin(SUN_R / sd)) > horizon_at(el, saz)).mean()
            e = (eel + np.degrees(np.arcsin(EARTH_R / ed)) > horizon_at(el, eaz)).mean()
            ours.append((s, e))
            theirs.append((next(ps.sample([(x, y)]))[0] * 4e-5, next(pe.sample([(x, y)]))[0] * 4e-5))
            if k % 50 == 0:
                print(f"  pgda {k}/{n}", file=sys.stderr)
    ours, theirs = np.array(ours), np.array(theirs)
    out = {"n": n, "note": "point samples of our 20 m model vs PGDA 60 m pixels; any-part-of-disc rule; mast 0"}
    for i, name in enumerate(["sun", "earth"]):
        d = ours[:, i] - theirs[:, i]
        out[name] = {"mae": round(float(np.abs(d).mean()), 4), "bias": round(float(d.mean()), 4),
                     "r": round(float(np.corrcoef(ours[:, i], theirs[:, i])[0, 1]), 4)}
        print(f"  pgda {name}: MAE {out[name]['mae']:.3f} bias {out[name]['bias']:+.3f} r {out[name]['r']:.3f}")
    out["points"] = [[round(float(a), 3) for a in (*o, *t)] for o, t in zip(ours, theirs)]  # ourSun, ourEarth, pgdaSun, pgdaEarth
    return out


if __name__ == "__main__":
    dem = Dem()
    res = {"horizons": check_horizons(), "dense_march": check_dense(dem), "pgda": check_pgda(dem)}
    (DATA / "validation.json").write_text(json.dumps(res))
    print("wrote validation.json")
