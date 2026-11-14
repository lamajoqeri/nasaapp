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


def write(name, t0, t1):
    et0, et1 = sp.str2et(t0), sp.str2et(t1)
    # ponytail: uniform ET == uniform UTC only inside a span with no leap second. True for 2024-2040 so far
    # (none since 2017). The Apollo block spans 1972's two leap seconds: up to 2 s = 0.0003 deg, ignored.
    et = et0 + np.arange(0, et1 - et0 + 1, STEP)
    v = vectors(et).astype("<f4")
    out = ROOT / "web/public/data"
    out.mkdir(parents=True, exist_ok=True)
    v.tofile(out / f"{name}.bin")
    (out / f"{name}.json").write_text(json.dumps(
        {"t0": t0 + "Z", "step_s": STEP, "n": len(et), "frame": "MOON_ME", "abcorr": "LT+S", "kernels": KERNELS}))
    sub = np.degrees(np.arcsin(v[:, 2] / np.linalg.norm(v[:, :3], axis=1)))
    assert abs(sub).max() < 1.6, sub  # sub-solar latitude bounded by lunar obliquity (1.54 deg)
    print(f"{name}: {len(et)} steps, {v.nbytes / 1e6:.1f} MB, sub-solar lat range {sub.min():.3f}..{sub.max():.3f} deg")


if __name__ == "__main__":
    load()
    write("ephem", T0, T1)
    write("ephem_apollo", "1969-07-01T00:00:00", "1973-01-01T00:00:00")  # optional table for the Apollo landings
