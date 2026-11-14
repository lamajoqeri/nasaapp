"""Move the polar 'representative point' sites to the best-lit pixel within 3 km, using PGDA's
average Sun/Earth visibility maps (Mazarico et al. 2011). Tile centres are arbitrary and often sit
on a slope facing away from Earth. Run once: .venv/bin/python prep/sites.py"""
import json
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import from_bounds

from geom import DATA, sp_fwd, sp_inv

ROOT = Path(__file__).resolve().parent.parent
sites = json.loads((DATA / "sites.json").read_text())
with rasterio.open(ROOT / "data/AVGVISIB_85S_060M_201608.TIF") as s, \
        rasterio.open(ROOT / "data/AVGVISIB_85S_060M_201608_EARTH.TIF") as e:
    for site in sites:
        if "Representative point" not in site["note"]:
            continue
        x, y = sp_fwd(site["lat"], site["lon"])
        win = from_bounds(x - 3000, y - 3000, x + 3000, y + 3000, s.transform)
        sun, earth = s.read(1, window=win) * 4e-5, e.read(1, window=win) * 4e-5
        r, c = np.unravel_index(np.argmax(sun + 0.5 * earth), sun.shape)
        bx, by = rasterio.windows.transform(win, s.transform) * (c + 0.5, r + 0.5)
        lat, lon = sp_inv(bx, by)
        site["lat"], site["lon"] = round(float(lat), 4), round(float(lon), 3)
        site["note"] = site["note"].split(" Representative point")[0].rstrip() + \
            f" Best-lit point within 3 km (PGDA average: Sun {sun[r, c]:.0%}, Earth {earth[r, c]:.0%})."
        print(site["name"], site["lat"], site["lon"], site["note"])
(DATA / "sites.json").write_text(json.dumps(sites, indent=1))
