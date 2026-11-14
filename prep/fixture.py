"""Synthetic test data in the real artifact formats -> web/public/data/fixture/. Self-checks on run.

A Gaussian mountain on a flat sphere: the horizon from an off-pole site has a known shape (analytic
height function, no raster) and a known bearing (spherical trig), which pins projection, bilinear
sampling, curvature and the azimuth convention. Ephemeris samples come straight from SPICE.
"""
import json

import numpy as np
import spiceypy as sp

import ephem
from geom import DATA, Dem, R, azel, enu, horizon, sp_fwd, sp_inv, unit

OUT = DATA / "fixture"
SITE = {"lat": -89.5, "lon": 30.0, "mast": 2.0}
PX, N = 200.0, 600
X0, Y0 = -59900.0, 59900.0
MX, MY, MH, MS = 18300.0, -10700.0, 3000.0, 5000.0  # mountain centre (on a pixel centre), height, sigma


class Analytic:
    c = unit(*sp_inv(MX, MY))

    def sample(self, lat, lon):
        g = R * np.arccos(np.clip(unit(lat, lon) @ self.c, -1, 1))
        return MH * np.exp(-g * g / (2 * MS * MS))


if __name__ == "__main__":
    (OUT / "dem").mkdir(parents=True, exist_ok=True)
    x, y = np.meshgrid(X0 + PX * np.arange(N), Y0 - PX * np.arange(N))
    h = Analytic().sample(*sp_inv(x, y))
    np.round(h / 0.1).astype("<i2").tofile(OUT / "dem/gauss_200m.bin")
    (OUT / "dem/manifest.json").write_text(json.dumps({"tiles": [
        {"id": "gauss_200m", "file": "gauss_200m.bin", "proj": "spstere", "w": N, "h": N, "x0": X0, "y0": Y0,
         "px": PX, "dtype": "int16", "scale": 0.1, "offset": 0.0, "sigma_h": 1.0}]}))

    lat, lon, mast = SITE["lat"], SITE["lon"], SITE["mast"]
    ref, _, _ = horizon(Analytic(), lat, lon, mast)
    got, _, _ = horizon(Dem(OUT / "dem"), lat, lon, mast)
    e, n, u = enu(lat, lon)
    peak_az = float(np.degrees(np.arctan2(Analytic.c @ e, Analytic.c @ n)) % 360)
    assert abs(sp_fwd(*sp_inv(MX, MY))[0] - MX) < 1e-6
    assert np.abs(got - ref).max() < 0.05, np.abs(got - ref).max()
    assert abs(ref.argmax() * 0.5 - peak_az) < 0.5, (ref.argmax() * 0.5, peak_az)

    ephem.load()
    rows = []
    for t, la, lo, hh in [("2026-12-01T03:17:00", -89.45, -129.78, 1000.0), ("2027-06-15T11:42:30", -86.0, -0.2, 0.0),
                          ("2030-03-03T20:05:10", 0.6741, 23.473, 0.0), ("2035-09-09T09:09:09", 44.12, -19.51, -2500.0),
                          ("2039-12-30T23:30:00", -84.79, 29.2, 500.0)]:
        v = ephem.vectors(sp.str2et(t))[0]
        (saz, sel, _), (eaz, eel, _) = azel(la, lo, hh, v[:3]), azel(la, lo, hh, v[3:])
        rows.append({"t": t + "Z", "lat": la, "lon": lo, "h": hh, "sun_az": float(saz), "sun_el": float(sel),
                     "earth_az": float(eaz), "earth_el": float(eel)})
    (OUT / "fixture.json").write_text(json.dumps(
        {"site": SITE, "horizon_el": [round(float(v), 5) for v in ref], "peak_az": peak_az, "ephem": rows}))
    print(f"fixture ok: peak {ref.max():.3f} deg at az {peak_az:.2f}, raster vs analytic {np.abs(got - ref).max():.4f} deg")
    print(rows[0])
