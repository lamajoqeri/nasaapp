"""Permanently shadowed regions (PSRs) -> web/public/data/maps/sp_psr.png and web/public/data/psr_dist.{bin,json}.
Run: .venv/bin/python prep/psr.py

Source: NASA PGDA product 69 (Mazarico et al. 2011), LPSR_85S_060M_201608.TIF: 60 m grid poleward of 85S,
positive where the Sun is never visible in their long-term simulation. PSRs are where water ice can survive,
which is why missions go to the south pole, so "how far is the nearest one" is a site-selection number.

- sp_psr.png: same grid and bounds as sp_sun.png (120 m). Grey 0..255 = share of the cell in permanent shadow.
- psr_dist: distance in metres from each 240 m cell centre to the nearest PSR of at least MIN_AREA_KM2
  (0 inside one). Tiny pits are ignored: a few 60 m pixels are not a prospecting target. uint16, 2 m units.
"""
import json
import urllib.request
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image
from scipy import ndimage

from geom import DATA, sp_fwd

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "data/LPSR_85S_060M_201608.TIF"
URL = "https://pgda.gsfc.nasa.gov/data/MoonIllumination/LPSR_85S_060M_201608.TIF"
MIN_AREA_KM2 = 0.1
UNIT_M, STEP = 2.0, 4  # distance field: 2 m units, every 4th 60 m pixel = 240 m


def block(a, k):
    r, c = a.shape[0] // k * k, a.shape[1] // k * k
    return a[:r, :c].reshape(r // k, k, c // k, k).mean((1, 3))


if __name__ == "__main__":
    if not SRC.exists():
        urllib.request.urlretrieve(URL, SRC)
    with rasterio.open(SRC) as d:
        psr, b, px = d.read(1) > 0, d.bounds, d.res[0]
    print(f"{psr.shape} at {px} m, {psr.mean():.1%} of the area poleward of 85S is permanently shadowed")

    frac = block(psr.astype(float), 2)
    Image.fromarray((frac * 255).round().astype(np.uint8)).save(DATA / "maps/sp_psr.png", optimize=True)

    lab, n = ndimage.label(psr)
    area = np.bincount(lab.ravel()) * (px * px) / 1e6  # km^2 per component (index 0 = not PSR)
    big = (area >= MIN_AREA_KM2)
    big[0] = False
    target = big[lab]
    print(f"{n} PSR patches, {int(big.sum())} of at least {MIN_AREA_KM2} km2 (largest {area[1:].max():.0f} km2); "
          f"they hold {target.sum() / psr.sum():.1%} of all PSR area")
    dist = ndimage.distance_transform_edt(~target) * px  # metres to the nearest target pixel centre
    g = dist[STEP // 2::STEP, STEP // 2::STEP]
    assert g.max() / UNIT_M < 65535, g.max()
    np.round(g / UNIT_M).astype("<u2").tofile(DATA / "psr_dist.bin")
    meta = {"proj": "spstere", "w": g.shape[1], "h": g.shape[0], "px": px * STEP,
            "x0": b.left + (STEP // 2 + 0.5) * px, "y0": b.top - (STEP // 2 + 0.5) * px,  # centre of cell (0,0)
            "unit_m": UNIT_M, "min_area_km2": MIN_AREA_KM2,
            "source": "NASA PGDA product 69 (Mazarico et al. 2011), LPSR_85S_060M_201608",
            "coverage": "poleward of about 85S (+-151.7 km around the pole)"}
    (DATA / "psr_dist.json").write_text(json.dumps(meta))

    idx = json.loads((DATA / "maps/index.json").read_text())
    idx = [m for m in idx if m["id"] != "sp_psr"]
    k = 2 * px
    idx.insert(next(i for i, m in enumerate(idx) if m["id"] == "sp_earth") + 1,
               {"id": "sp_psr", "file": "sp_psr.png", "proj": "spstere", "kind": "permanent_shadow",
                "scale": "0..255 = 0..100% of the cell permanently shadowed",
                "source": "NASA PGDA product 69, Mazarico et al. 2011",
                "bounds": [b.left, b.top - frac.shape[0] * k, b.left + frac.shape[1] * k, b.top]})
    (DATA / "maps/index.json").write_text(json.dumps(idx, indent=1))

    # checks: the floor of Shackleton is a PSR; a sunlit ridge point is not, and is a short walk from one
    def at(lat, lon):
        x, y = sp_fwd(lat, lon)
        c, r = (x - meta["x0"]) / meta["px"], (meta["y0"] - y) / meta["px"]
        return float(g[int(round(r)), int(round(c))])
    floor, ridge, rim = at(-89.66, 129.2), at(-89.474, -137.414), at(-89.6861, -162.815)
    print(f"Shackleton floor {floor:.0f} m, Connecting Ridge site {ridge:.0f} m, Shackleton Rim site {rim:.0f} m")
    assert floor == 0 and 0 < ridge < 5000 and 0 < rim < 5000
    for name in ("maps/sp_psr.png", "psr_dist.bin"):
        print(name, f"{(DATA / name).stat().st_size / 1e6:.2f} MB")
