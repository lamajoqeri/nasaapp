"""Fast regression checks on prep/geom.py and the shipped artifacts (~10 s), and the cross-check file
for the web core: web/public/data/fixture/series_check.json. Run: .venv/bin/python prep/checks.py
"""
import json

import numpy as np
import spiceypy as sp

import ephem
from geom import (DATA, Dem, R, azel, battery, enu, horizon, horizon_at, horizon_draws, load_ephem, metrics, schedule,
                  series, sp_fwd, sp_inv, sun_frac, uncertainty, unit)

FIX = DATA / "fixture"


def test_math():
    for lat, lon in [(-89.9, 12.0), (-80.0, -170.0), (-85.0, 359.0)]:
        la, lo = sp_inv(*sp_fwd(lat, lon))
        assert abs(la - lat) < 1e-9 and abs((lo - lon + 180) % 360 - 180) < 1e-9
    assert np.allclose(sp_fwd(-90 + 1e-9, 0)[1], 0, atol=1) and sp_fwd(-89, 0)[1] > 0 and sp_fwd(-89, 90)[0] > 0
    for lat, lon in [(-89.5, 30), (0.7, 23.5), (44, -19.5), (89.0, 200)]:
        e, n, u = enu(lat, lon)
        assert np.allclose([e @ n, e @ u, n @ u], 0, atol=1e-12) and np.allclose(np.cross(e, n), u)
        # a point slightly north of the site must be at azimuth 0, slightly east at azimuth 90
        north = azel(lat, lon, 0, R * unit(lat + 0.01, lon) / 1000)[0]
        assert abs((north + 180) % 360 - 180) < 1e-6, north
        east = azel(lat, lon, 0, R * unit(lat, lon + 0.01) / 1000)[0]
        assert abs(east - 90) < 0.01, east
    assert sun_frac(1.0, 0.0, 1.5e11) == 1 and sun_frac(-1.0, 0.0, 1.5e11) == 0
    assert abs(sun_frac(0.0, 0.0, 1.5e11) - 0.5) < 1e-12
    d = schedule()
    assert d[0] == 10 and d[-1] <= 300000 and np.diff(d).max() <= 240 + 1e-6 and np.diff(d).min() >= 10 - 1e-6 and len(d) == 1410
    h = np.array([0.0, 1.0])
    assert abs(horizon_at(h, 90.0) - 0.5) < 1e-12 and abs(horizon_at(h, 270.0) - 0.5) < 1e-12  # wraps


def test_fixture():
    fx = json.loads((FIX / "fixture.json").read_text())
    s = fx["site"]
    el, dist, _ = horizon(Dem(FIX / "dem"), s["lat"], s["lon"], s["mast"])
    assert np.abs(el - np.array(fx["horizon_el"])).max() < 0.05
    assert abs(el.argmax() * 0.5 - fx["peak_az"]) < 0.5
    meta, eph = load_ephem()
    t0 = np.datetime64(meta["t0"][:-1])
    for r in fx["ephem"]:
        i = (np.datetime64(r["t"][:-1]) - t0) / np.timedelta64(1, "s") / meta["step_s"]
        v = eph[int(i)] * (1 - i % 1) + eph[int(i) + 1] * (i % 1)
        for body, col in (("sun", v[:3]), ("earth", v[3:])):
            az, e, _ = azel(r["lat"], r["lon"], r["h"], col)
            assert abs(e - r[body + "_el"]) < 0.005 and abs((az - r[body + "_az"] + 180) % 360 - 180) < 0.005 / max(np.cos(np.radians(e)), 0.01)


def test_dem(dem):
    for p in json.loads((FIX / "dem_check.json").read_text()):
        assert abs(float(dem.sample(p["lat"], p["lon"])) - p["h"]) < 15
    g = Dem()
    g.tiles = [t for t in dem.tiles if t["proj"] == "eqc"]
    a, b = g.sample(np.array([10.0, 10.0]), np.array([359.999, 0.001]))
    assert abs(a - b) < 5, (a, b)  # no seam at the 0/360 meridian
    assert np.isfinite(g.sample(np.array([90.0, -90.0, 89.99]), np.array([0.0, 123.0, -45.0]))).all()
    t = next(t for t in dem.tiles if t["id"] == "shackleton_20m")
    one = Dem()
    one.tiles = [t]
    xs = np.array([t["x0"] + 1e-3, t["x0"] + (t["w"] - 1) * t["px"] - 1e-3, t["x0"] - 1, t["x0"] + (t["w"] - 1) * t["px"] + 1])
    hh = one.sample(*sp_inv(xs, np.full(4, t["y0"] - 500.0)))
    assert hh[0] != 0 and hh[1] != 0 and hh[2] == 0 and hh[3] == 0  # inclusive edges, 0 outside
    raw = t["a"]
    assert abs(hh[1] - (t["offset"] + t["scale"] * raw[25, t["w"] - 1])) < 0.01  # last column, not its neighbour
    # moon-wide sanity: heights within lunar extremes, mean near the reference sphere
    lat, lon = np.meshgrid(np.linspace(-89, 89, 60), np.linspace(0, 359, 120))
    hg = g.sample(lat, lon)
    assert -9500 < hg.min() and hg.max() < 11000 and abs(hg.mean()) < 1500


def test_apollo11():
    """Sun elevation at Apollo 11 touchdown (1969-07-20 20:17:40 UTC) was about 10.8 deg, in the east."""
    v = ephem.vectors(sp.str2et("1969-07-20T20:17:40"))[0]
    az, el, _ = azel(0.6741, 23.473, -1900.0, v[:3])
    eaz, eel, _ = azel(0.6741, 23.473, -1900.0, v[3:])
    assert 10.3 < el < 11.3 and 80 < az < 100, (az, el)
    assert 55 < eel < 75, eel  # Earth high in the sky at Tranquility Base (66 deg nominal +- libration)
    return float(az), float(el), float(eel)


def test_metrics():
    n = 48
    s = {"sun_el": np.ones(n), "sun_frac": np.r_[np.ones(10), np.zeros(20), np.ones(18)], "earth_el": np.ones(n),
         "earth_visible": np.r_[np.zeros(5, bool), np.ones(43, bool)]}
    m = metrics(s, dsn=np.r_[np.zeros(10, np.uint8), np.ones(38, np.uint8)])
    assert m["hours_to_sunset"] == 10 and m["hours_to_sunrise"] == 0 and m["longest_dark_h"] == 20
    assert abs(m["pct_lit"] - 28 / 48) < 1e-12 and m["hours_to_earthrise"] == 5 and m["dte_hours"] == 43
    assert m["comms_hours"] == 38 and m["longest_no_earth_h"] == 5 and m["hours_to_earthset"] == 0
    s["sun_frac"] = np.ones(n)
    assert metrics(s)["hours_to_sunset"] is None and metrics(s)["longest_dark_h"] == 0
    soc, dead = battery(np.r_[np.ones(5), np.zeros(20)], panel_w=200, load_w=100, capacity_wh=1000, soc0=0.5)
    assert soc[4] == 1.0 and dead == 15 and soc[-1] == 0  # charges to full in 5 h, then 1000 Wh / 100 W = 10 h
    assert battery(np.ones(10))[1] is None


def export_series(dem):
    """One lunar day at a real site, for web/src/core to reproduce from the same artifacts."""
    meta, eph = load_ephem()
    dsn = np.fromfile(DATA / "dsn.bin", dtype=np.uint8)
    out = []
    for sid, lat, lon, mast, t in [("connecting_ridge", -89.474, -137.414, 2.0, "2027-01-01T00:00:00"),
                                   ("malapert", -85.9891, 0.238, 2.0, "2028-06-10T00:00:00"),
                                   ("apollo11", 0.6741, 23.473, 2.0, "2030-03-01T00:00:00")]:
        i0 = int((np.datetime64(t) - np.datetime64(meta["t0"][:-1])) / np.timedelta64(1, "s") / meta["step_s"])
        s = series(dem, eph, i0, 708, lat, lon, mast)
        el, dist, sig = s["horizon"]
        u = uncertainty(s, horizon_draws(el, dist, sig, n=256))
        m = metrics(s, dsn[i0:i0 + 708])
        assert 0 <= m["pct_lit"] <= 1 and m["dte_hours"] <= 708
        out.append({"site": sid, "lat": lat, "lon": lon, "mast": mast, "t0": t + "Z", "step_s": 3600, "n": 708,
                    "horizon_el_every_10deg": [round(float(x), 3) for x in el[::20]],
                    "sun_frac": [round(float(x), 4) for x in s["sun_frac"]],
                    "earth_el_minus_horizon": [round(float(x), 3) for x in s["earth_el"] - horizon_at(el, s["earth_az"])],
                    "battery_default": {"survival_h": battery(s["sun_frac"])[1],
                                        "min_soc": round(float(battery(s["sun_frac"])[0].min()), 4)},
                    "metrics": m, "pct_lit_mean": round(u["pct_lit_mean"], 4), "pct_lit_std": round(u["pct_lit_std"], 4),
                    "p_lit_min_max": [round(float(u["p_lit"].min()), 3), round(float(u["p_lit"].max()), 3)]})
        print(f"  {sid:17s} lit {m['pct_lit']:.3f} +- {u['pct_lit_std']:.3f}  dark {m['longest_dark_h']:.0f} h  "
              f"DTE {m['dte_hours']:.0f} h  sunset in {m['hours_to_sunset']}")
    (FIX / "series_check.json").write_text(json.dumps(out))


if __name__ == "__main__":
    ephem.load()
    dem = Dem()
    test_math()
    test_fixture()
    test_dem(dem)
    test_metrics()
    print("apollo 11 touchdown: Sun az %.1f el %.2f, Earth el %.1f" % test_apollo11())
    export_series(dem)
    print("all checks passed")
