"""Which DSN complexes can see the Moon -> web/public/data/dsn.bin. Run: .venv/bin/python prep/dsn.py

Uint8 per ephem step (same t0/step/n as ephem.bin): bit 0 Goldstone, bit 1 Madrid, bit 2 Canberra,
set when the Moon's centre is more than 10 deg above that station's horizon.
"""
import json

import numpy as np
import spiceypy as sp

import ephem
from geom import DATA

STATIONS = [("Goldstone", 35.4259, 243.1105, 1.0), ("Madrid", 40.4314, 355.7520, 0.86), ("Canberra", -35.4024, 148.9813, 0.69)]
MASK_DEG = 10.0

if __name__ == "__main__":
    ephem.load()
    meta = json.loads((DATA / "ephem.json").read_text())
    et = sp.str2et(meta["t0"][:-1]) + np.arange(meta["n"]) * meta["step_s"]
    # ponytail: IAU_EARTH (no polar motion / UT1 corrections) is good to ~0.01 deg through 2040, plenty for a 10 deg mask;
    # the high-precision Earth kernel only predicts a few months ahead
    moon = np.array(sp.spkpos("MOON", et, "IAU_EARTH", "LT+S", "EARTH")[0])
    bits = np.zeros(meta["n"], np.uint8)
    for b, (name, lat, lon, alt) in enumerate(STATIONS):
        pos = sp.georec(np.radians(lon), np.radians(lat), alt, 6378.137, 1 / 298.257)
        la, lo = np.radians(lat), np.radians(lon)
        up = np.array([np.cos(la) * np.cos(lo), np.cos(la) * np.sin(lo), np.sin(la)])
        v = moon - pos
        el = np.degrees(np.arcsin(v @ up / np.linalg.norm(v, axis=1)))
        bits |= ((el > MASK_DEG).astype(np.uint8) << b)
        print(f"{name:10s} Moon above {MASK_DEG:.0f} deg {np.mean(el > MASK_DEG):.1%} of the time, max el {el.max():.1f}")
    bits.tofile(DATA / "dsn.bin")
    assert 0.9 < np.mean(bits > 0) <= 1.0  # three sites ~120 deg apart: near-continuous coverage
    print(f"any station: {np.mean(bits > 0):.1%}; wrote dsn.bin ({bits.nbytes / 1e3:.0f} kB)")
