"""Base maps and overlays for the site picker -> web/public/data/maps/. Run: .venv/bin/python prep/maps.py

Hillshades are for orientation only (fixed artificial light from the upper left), not a lighting prediction.
sp_sun / sp_earth are NASA PGDA average visibility maps (Mazarico et al. 2011), 0..255 = 0..100% of the time.
sp_sun_wide / sp_earth_wide are the same maps from NASA's 75S 120 m product, cut to the 240 m polar map (±304 km) and
averaged to 240 m. The app draws them outside the finer 85S disc, so the layers cover the whole polar map.
"""
import json
from pathlib import Path

import numpy as np
import rasterio
import rasterio.windows
from PIL import Image

from geom import DATA, Dem

ROOT = Path(__file__).resolve().parent.parent
OUT = DATA / "maps"


def hillshade(h, px, z=1.0, az=315.0, alt=35.0):
    gy, gx = np.gradient(h * z, px)
    slope, aspect = np.arctan(np.hypot(gx, gy)), np.arctan2(gy, -gx)
    a, e = np.radians(360 - az + 90), np.radians(alt)
    s = np.sin(e) * np.cos(slope) + np.cos(e) * np.sin(slope) * np.cos(a - aspect)
    return (np.clip(s, 0, 1) * 255).astype(np.uint8)


def tile(dem, tid):
    t = next(t for t in dem.tiles if t["id"] == tid)
    return t, t["offset"] + t["scale"] * np.asarray(t["a"], float)


WIDE_HALF = 304080.0  # half-width of the wide maps: covers the sp_240m map, on the 75S product's 120 m grid


def wide(src, out, kind):
    with rasterio.open(src) as d:
        b, px = d.bounds, d.res[0]
        n, r0, c0 = round(2 * WIDE_HALF / px), round((b.top - WIDE_HALF) / px), round((-WIDE_HALF - b.left) / px)
        a = d.read(1, window=rasterio.windows.Window(c0, r0, n, n)).astype(float)
    a = block(np.clip(a, 0, None) * 4e-5, 2)  # inside 75S everywhere, so no nodata in the cut
    Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8)).save(out, optimize=True)
    return {"id": out.stem, "file": out.name, "proj": "spstere", "kind": kind, "scale": "0..255 = 0..100% of time",
            "source": "NASA PGDA product 69, Mazarico et al. 2011 (75S 120 m product, averaged to 240 m)",
            "bounds": [-WIDE_HALF, -WIDE_HALF, WIDE_HALF, WIDE_HALF]}


def block(a, k):
    r, c = a.shape[0] // k * k, a.shape[1] // k * k
    return a[:r, :c].reshape(r // k, k, c // k, k).mean((1, 3))


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    dem, idx = Dem(), []

    for tid, name, z in [("sp_240m", "sp_hillshade.png", 2.0), ("shackleton_20m", "shackleton_hillshade.png", 1.0)]:
        t, h = tile(dem, tid)
        Image.fromarray(hillshade(h, t["px"], z)).save(OUT / name, optimize=True)
        half = t["px"] / 2
        idx.append({"id": name.split(".")[0], "file": name, "proj": "spstere", "kind": "hillshade",
                    "bounds": [t["x0"] - half, t["y0"] - (t["h"] - 1) * t["px"] - half,
                               t["x0"] + (t["w"] - 1) * t["px"] + half, t["y0"] + half]})

    for src, name, kind in [("AVGVISIB_85S_060M_201608.TIF", "sp_sun.png", "avg_sun_visibility"),
                            ("AVGVISIB_85S_060M_201608_EARTH.TIF", "sp_earth.png", "avg_earth_visibility")]:
        with rasterio.open(ROOT / "data" / src) as d:
            a, b = d.read(1).astype(float), d.bounds
        a = block(np.clip(a, 0, None) * 4e-5, 2)
        Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8)).save(OUT / name, optimize=True)
        k = 2 * 60.0
        idx.append({"id": name.split(".")[0], "file": name, "proj": "spstere", "kind": kind, "scale": "0..255 = 0..100% of time",
                    "source": "NASA PGDA product 69, Mazarico et al. 2011",
                    "bounds": [b.left, b.top - a.shape[0] * k, b.left + a.shape[1] * k, b.top]})

    for src, name, kind in [("AVGVISIB_75S_120M_201608.TIF", "sp_sun_wide.png", "avg_sun_visibility"),
                            ("AVGVISIB_75S_120M_201608_EARTH.TIF", "sp_earth_wide.png", "avg_earth_visibility")]:
        idx.append(wide(ROOT / "data" / src, OUT / name, kind))

    g = np.fromfile(ROOT / "data/ldem_16_float.img", dtype="<f4").reshape(2880, 5760) * 1000.0
    Image.fromarray(hillshade(block(g, 2), 3790.0, 4.0)).save(OUT / "global_hillshade.jpg", quality=80)
    idx.append({"id": "global_hillshade", "file": "global_hillshade.jpg", "proj": "eqc", "kind": "hillshade",
                "bounds_deg": {"lon_min": 0, "lon_max": 360, "lat_min": -90, "lat_max": 90}})

    (OUT / "index.json").write_text(json.dumps(idx, indent=1))
    for i in idx:
        im = Image.open(OUT / i["file"])
        print(i["file"], im.size, f"{(OUT / i['file']).stat().st_size / 1e6:.1f} MB", i.get("bounds", ""))
