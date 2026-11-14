"""Sun and Earth vectors in MOON_ME -> web/public/data/ephem.{bin,json}. Run: .venv/bin/python prep/ephem.py"""
import json
from pathlib import Path

import numpy as np
import spiceypy as sp

ROOT = Path(__file__).resolve().parent.parent
KERNELS = ["naif0012.tls", "pck00011.tpc", "moon_de440_250416.tf", "moon_pa_de440_200625.bpc", "de440s.bsp"]
T0, T1, STEP = "2024-01-01T00:00:00", "2040-01-01T00:00:00", 3600


def load():
    for k in KERNELS:
        sp.furnsh(str(ROOT / "data/kernels" / k))


def vectors(et):
    """-> (n,6) km: Sun xyz, Earth xyz, Moon centre -> body, MOON_ME, LT+S."""
    et = np.atleast_1d(et)
    return np.hstack([np.array(sp.spkpos(b, et, "MOON_ME", "LT+S", "MOON")[0]) for b in ("SUN", "EARTH")])


if __name__ == "__main__":
    load()
    et0, et1 = sp.str2et(T0), sp.str2et(T1)
    # ponytail: uniform ET == uniform UTC only while no leap second is added (none since 2017); 1 s = 0.0001 deg if one is
    et = et0 + np.arange(0, et1 - et0 + 1, STEP)
    v = vectors(et).astype("<f4")
    out = ROOT / "web/public/data"
    out.mkdir(parents=True, exist_ok=True)
    v.tofile(out / "ephem.bin")
    (out / "ephem.json").write_text(json.dumps(
        {"t0": T0 + "Z", "step_s": STEP, "n": len(et), "frame": "MOON_ME", "abcorr": "LT+S", "kernels": KERNELS}))
    sub = np.degrees(np.arcsin(v[:, 2] / np.linalg.norm(v[:, :3], axis=1)))
    assert abs(sub).max() < 1.6, sub  # sub-solar latitude bounded by lunar obliquity (1.54 deg)
    print(f"{len(et)} steps, {v.nbytes / 1e6:.1f} MB, sub-solar lat range {sub.min():.3f}..{sub.max():.3f} deg")
