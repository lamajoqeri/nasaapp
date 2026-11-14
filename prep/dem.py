"""LOLA DEMs -> web/public/data/dem/{manifest.json,*.bin}. Run: .venv/bin/python prep/dem.py

20 m tiles are window-read over HTTP from the 2.7 GB PGDA file, nothing that big is downloaded.
Also writes data/dem_check.json (heights straight from the source rasters) for the georeferencing test.
"""
import json
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import from_bounds

from geom import DATA, Dem, sp_fwd, sp_inv

ROOT = Path(__file__).resolve().parent.parent
OUT = DATA / "dem"
SRC20 = "/vsicurl/https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LDEM_80S_20MPP_ADJ.TIF"
ERR20 = "/vsicurl/https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LDEM_80S_20MPP_ADJ_ERR.TIF"
# id: (xmin, ymin, xmax, ymax) in polar stereographic meters
TILES20 = {
    "shackleton_20m": (-30000, -30000, 10000, 10000),    # Shackleton, connecting ridge
    "mouton_nobile_20m": (60000, 100000, 100000, 140000),  # Mons Mouton, Leibnitz beta, Nobile rim 1, IM-2
    "malapert_20m": (-10000, 111000, 10000, 131000),
    "haworth_20m": (-48000, 80000, -28000, 100000),
    "degerlache_20m": (-47000, 5000, -27000, 25000),
}


def quantize(h, tid, extra):
    h = np.nan_to_num(h, nan=float(np.nanmedian(h)))
    off = float(np.round((h.max() + h.min()) / 2))
    scale = max(0.05, round(float(np.ceil((float(h.max()) - float(h.min())) / 65000 * 100)) / 100, 2))  # finest step that fits int16
    np.round((h - off) / scale).astype("<i2").tofile(OUT / f"{tid}.bin")
    return {"id": tid, "file": f"{tid}.bin", "w": h.shape[1], "h": h.shape[0], "dtype": "int16",
            "scale": scale, "offset": off, **extra}


def block_mean(a, k):
    r, c = a.shape[0] // k * k, a.shape[1] // k * k
    return np.nanmean(a[:r, :c].reshape(r // k, k, c // k, k), axis=(1, 3))


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    tiles = []
    with rasterio.open(SRC20) as d, rasterio.open(ERR20) as e:
        for tid, (x0, y0, x1, y1) in TILES20.items():
            win = from_bounds(x0, y0, x1, y1, d.transform)
            sig = float(np.nanmedian(e.read(1, window=win)))
            tiles.append(quantize(d.read(1, window=win), tid, {
                "proj": "spstere", "x0": x0 + 10, "y0": y1 - 10, "px": 20, "sigma_h": round(sig, 2)}))
            print(tid, tiles[-1]["w"], tiles[-1]["scale"], "sigma_h", tiles[-1]["sigma_h"])

    with rasterio.open(ROOT / "data/LDEM_80S_80MPP_ADJ.TIF") as d:
        # ponytail: sigma_h 10 m / 50 m for the coarse tiers = guess at sub-pixel relief, calibrate against NAC if it matters
        tiles.append(quantize(block_mean(d.read(1), 3), "sp_240m", {
            "proj": "spstere", "x0": -304000 + 120, "y0": 304000 - 120, "px": 240, "sigma_h": 10}))

    g = np.fromfile(ROOT / "data/ldem_16_float.img", dtype="<f4").reshape(2880, 5760) * 1000.0  # km -> m
    t = quantize(block_mean(g, 2), "global_8ppd", {"proj": "eqc", "lon0": 0.0625, "lat0": 89.9375, "ppd": 8, "sigma_h": 50})
    t["scale"], t["offset"] = 0.5, 0.0
    np.round(block_mean(g, 2) / 0.5).astype("<i2").tofile(OUT / "global_8ppd.bin")
    tiles.append(t)
    (OUT / "manifest.json").write_text(json.dumps({"tiles": tiles}, indent=1))

    # Georeferencing check: heights read from the source rasters at lat/lon must match the artifacts.
    dem, pts = Dem(OUT), []
    with rasterio.open(SRC20) as d:
        for lat, lon in [(-89.46, -137.5), (-89.77, -171.9), (-89.9, 0.0), (-89.3, 60.0), (-86.0, -0.2),
                         (-85.44, 37.4), (-84.79, 29.2), (-86.76, -22.8), (-88.68, -67.9), (-85.9, 2.0)]:
            src = float(next(d.sample([sp_fwd(lat, lon)]))[0])
            got = float(dem.sample(lat, lon))
            pts.append({"lat": lat, "lon": lon, "h": src})
            print(f"{lat:7.2f} {lon:7.1f} source {src:9.1f} artifact {got:9.1f}")
            assert abs(src - got) < 15, (lat, lon, src, got)  # nearest-pixel source vs bilinear artifact on slopes
    (ROOT / "web/public/data/fixture/dem_check.json").write_text(json.dumps(pts))
    print("apollo 11 site height (global tier):", float(dem.sample(0.6741, 23.473)), "| pole:", sp_inv(0, 1))
