# CONTRACT

Shared conventions between `prep/` (Python, offline) and `web/` (TypeScript, browser).
Change this file only after telling the other person. Reference implementation: `prep/geom.py`.

## Units and frames

- Angles in degrees at every interface (radians only inside functions). Distances in meters, except ephemeris vectors in **km**.
- Time: UTC. JS `Date` ms / unix seconds in code, ISO 8601 `Z` strings in JSON.
- Body frame: **MOON_ME** (mean Earth / polar axis, DE440), the frame of all LOLA products. Sphere radius `R = 1737400 m`.
- Latitude planetocentric, longitude **east-positive**, any of [-180,180] or [0,360) accepted.
- Height `h` = meters above the R sphere.

## Geometry

```
unit(lat,lon) = [cos lat cos lon, cos lat sin lon, sin lat]
position      = (R + h) * unit(lat,lon)

local basis at (lat,lon):
  up    = unit(lat,lon)
  east  = [-sin lon, cos lon, 0]
  north = [-sin lat cos lon, -sin lat sin lon, cos lat]

site  = (R + h_dem(lat,lon) + mast) * up
v     = target - site
az    = atan2(v.east, v.north)  mod 360     # clockwise from local north
el    = atan2(v.up, sqrt(|v|^2 - (v.up)^2))
```

Never use projected grid axes as north/east. Near the pole they are rotated by the longitude.

### South polar stereographic (`proj: "spstere"`)

lat0 = -90, lon0 = 0, k = 1, sphere R.

```
forward:  rho = 2R tan(pi/4 + lat/2)        # lat in radians, negative
          x = rho sin lon,  y = rho cos lon
inverse:  rho = hypot(x,y)
          lat = 2 atan(rho / 2R) - pi/2,  lon = atan2(x, y)
```

### Horizon

`horizon(site, mast)` returns, for `NAZ = 720` azimuths (`az_i = i * 0.5`):
`el[i]` (deg, max terrain elevation) and `dist[i]` (m, distance of the sample that set the max).

Distance schedule (identical in both languages):

```
d = 10;  while d <= 300000:  emit d;  d += clamp(0.02 * d, 10, 240)
```

Sample point at distance d, azimuth az (great circle from the site):

```
p = cos(d/R) * up + sin(d/R) * (cos az * north + sin az * east)     # unit vector
target = (R + h_dem(p)) * p
```

### Sun and Earth

```
v_body = ephem(t) * 1000 - site           # ephem = Moon centre -> body, MOON_ME, km
az, el as above                            # the site subtraction matters for Earth (0.26 deg)
sun_radius  = asin(695700e3 / |v_sun|)     # ~0.266 deg
x = clamp((el_sun - horizon_el(az_sun)) / sun_radius, -1, 1)
sunFrac = 1 - (acos(x) - x*sqrt(1 - x^2)) / pi      # share of the disk above the terrain, 0..1
earth_radius = asin(6371e3 / |v_earth|)              # ~0.95 deg
eclipse = share of the Sun's disk covered by Earth's disk (circle overlap, separation = angle between v_sun and v_earth)
sunFrac *= 1 - eclipse                               # lunar eclipses: Earth hides the Sun for a few hours
earthVisible = el_earth - horizon_el(az_earth) > margin   # margin default 0 deg, Earth centre
```

`horizon_el(az)` = linear interpolation between the two nearest azimuth bins (wraps at 360).

Definitions used by metrics: **dark** = `sunFrac == 0`; **sunset** = next time `sunFrac` reaches 0;
**% lit** over a window = mean `sunFrac`; **Earthset** = next time `earthVisible` turns false.

### Uncertainty (horizon space)

`sigma_el[i] = atan(sigma_h / dist[i])` with `sigma_h` from the manifest tile that set the max.
Draw N = 64 Gaussian offsets per azimuth, boxcar-smooth over **45 deg** of azimuth (90 bins, circular; divide by sqrt(90) to keep unit variance), add `offset * sigma_el`.
The 45 deg correlation length and the 20 m tiles' `sigma_h` (LOLA error map x 1.5) are calibrated so that both the per-azimuth horizon spread and the spread of yearly % lit match NASA's Monte-Carlo DEM clones at the Connecting Ridge (`prep/calib.py`, `calibration.json`). Only near-field terrain was perturbed in that calibration, so the bands are a lower bound.
`P(lit)(t)` = mean over draws of `sunFrac > 0`; report mean and std of every metric over draws.

## Artifacts (`web/public/data/`)

All binaries little-endian, row-major, no header. JSON sits next to them.

### `ephem.bin` + `ephem.json`

`Float32[n * 6]`: per step `[sun_x, sun_y, sun_z, earth_x, earth_y, earth_z]` km, MOON_ME, aberration `LT+S`, observer Moon centre.

```json
{"t0": "2024-01-01T00:00:00Z", "step_s": 3600, "n": 140256, "frame": "MOON_ME", "kernels": ["..."]}
```

Lookup: `i = (t - t0) / step_s`, linear interpolation of the 6 components between `floor(i)` and `floor(i)+1`.
Valid range is `[t0, t0 + (n-1)*step_s]`; the UI clamps dates to it.

### `dem/manifest.json` + `dem/*.bin`

```json
{"tiles": [
  {"id": "shackleton_20m", "file": "shackleton_20m.bin", "proj": "spstere",
   "w": 2000, "h": 2000, "x0": -24990, "y0": 9990, "px": 20,
   "dtype": "int16", "scale": 0.05, "offset": 1200.0, "sigma_h": 1.0},
  {"id": "global_8ppd", "file": "global_8ppd.bin", "proj": "eqc",
   "w": 2880, "h": 1440, "lon0": 0.0625, "lat0": 89.9375, "ppd": 8,
   "dtype": "int16", "scale": 0.5, "offset": 0, "sigma_h": 30}
]}
```

- Tiles are listed **finest first**. `h_dem(point)` = bilinear sample of the first tile that contains the point; 0 if none does.
- `height_m = offset + scale * raw`.
- `spstere`: `(x0, y0)` = projected coords of the **centre of pixel (row 0, col 0)**; row 0 is the top (max y).
  `col = (x - x0) / px`, `row = (y0 - y) / px`. Inside iff `0 <= col <= w-1` and `0 <= row <= h-1`.
- `eqc`: `(lon0, lat0)` = centre of pixel (0,0), `ppd` pixels per degree.
  `col = ((lon - lon0) mod 360) * ppd` wrapping in longitude, `row = (lat0 - lat) * ppd` clamped to `[0, h-1]`. Always "inside".
- Tiles are fetched lazily; a site only needs the tiles its rays can touch.

### `sites.json`

```json
[{"id": "apollo11", "name": "Apollo 11", "lat": 0.6741, "lon": 23.4730,
  "program": "Apollo", "date": "1969-07-20", "note": "Mare Tranquillitatis"}]
```

### `fixture/`

Synthetic test data in the same formats: `fixture/dem/manifest.json` (+ one tile with a Gaussian mountain on a flat sphere) and `fixture/fixture.json`:

```json
{"site": {"lat": -89.5, "lon": 30, "mast": 2},
 "horizon_el": [720 numbers],            // analytic reference, tolerance 0.05 deg
 "peak_az": 0.0,                         // spherical-trig bearing to the mountain, tolerance 0.5 deg
 "ephem": [{"t": "...Z", "lat": 0, "lon": 0, "h": 0,
            "sun_az": 0, "sun_el": 0, "earth_az": 0, "earth_el": 0}]}   // straight from SPICE, tolerance 0.005 deg
```

Both `prep/geom.py` and `web/src/core/` must reproduce these numbers from the artifacts.

### `dsn.bin`

`Uint8[n]`, one byte per ephem step (same `t0`, `step_s`, `n` as `ephem.bin`). Bit 0 Goldstone, bit 1 Madrid, bit 2 Canberra:
set when the Moon is more than 10 deg above that station's horizon. Use nearest step.
`commsWindow = earthVisible && dsn != 0`. At least one station is up 98.7% of the time, so this mostly tells the user *which* station.

### `validation.json`

Written by `prep/validate.py`, for the "how do we know" panel:
`horizons.max_sep_deg.{sun,earth}` (vs JPL Horizons, 100 samples each), `dense_march.max_missed_deg`,
`pgda.{sun,earth}.{mae,bias,r}` and `pgda.points` = `[ourSun, ourEarth, pgdaSun, pgdaEarth]` fractions at 300 random points (scatter plot).

### `bench/index.json`

`{source, method, baselines: {name: description}, summary: {known_time|matched_time: {n, flat|dem240|slope_only|ours: {iou, accuracy}}}, time_matching_check, images: [{id, group, source_image, utc, sun_az, sun_el, photo, model, bounds, shadow_fraction_photo, registration_shift_m, scores: {flat|slope_only|dem240|ours: {iou, f1, accuracy}}, scores_unregistered, time_matching?}]}`. `bounds` in spstere meters.
`photo` and `model` are same-extent grayscale PNGs for the draggable split view.

### `calibration.json`

Written by `prep/calib.py`: our uncertainty model vs 30 NASA Monte-Carlo DEM realisations (PGDA product 78) at the Connecting Ridge site.
`horizon_sigma_deg.{clones_median, model_median, ratio_clones_over_model}`, `pct_lit_year.{clones_std, model_mc_std, ...}`,
`horizon_5m_vs_20m_deg` (what the 20 m tile misses relative to the 5 m DEM).

### `ephem_apollo.bin` + `ephem_apollo.json` (optional)

Same format as `ephem.bin`, hourly 1969-07-01 .. 1973-01-01, for showing the Apollo landings on their real dates.

### `maps/index.json` + images

Base maps for the site picker: `{id, file, proj, kind, bounds}`; `bounds` = `[x_min, y_min, x_max, y_max]` in spstere meters
(or `bounds_deg` for the equirectangular global map, longitude 0..360 left to right). `sp_hillshade`, `shackleton_hillshade`, `global_hillshade`
are orientation hillshades (artificial light, not a prediction). `sp_sun` / `sp_earth` are NASA PGDA average visibility, 0..255 = 0..100% of the time. `sp_sun_wide` / `sp_earth_wide` are the same quantity from NASA's AVGVISIB_75S_120M product, cut to ±304,080 m and averaged to 240 m; the app draws and reads them outside the 150 km disc of the finer 85S maps.

### `psr_dist.bin` + `psr_dist.json`, `maps/sp_psr.png`

From `prep/psr.py` (NASA PGDA product 69, LPSR_85S_060M). `psr_dist.bin`: `Uint16[w*h]`, row 0 at the top, south polar stereographic; `(x0, y0)` = centre of cell (0,0), `px` = 240 m. Value x `unit_m` (2 m) = metres from the cell centre to the nearest permanently shadowed region of at least `min_area_km2` (0.1); 0 inside one. Bilinear sample; outside the grid (north of about 85°S) there is no data. `maps/sp_psr.png`: same grid as `sp_sun.png`, grey 0..255 = share of the 120 m cell that is permanently shadowed.

### `fixture/series_check.json`

Three real sites, one lunar day (708 hourly steps) each, from `prep/checks.py`: `sun_frac[708]`, `earth_el_minus_horizon[708]`,
`horizon_el_every_10deg[36]`, `metrics` (exact definitions: `metrics()` in `prep/geom.py`), `pct_lit_mean`, `pct_lit_std`.
The web core should reproduce `sun_frac` within 0.01 (0.05 for at most a few steps near sunrise/sunset), `metrics` hours within 1 h,
and `pct_lit_std` within a factor of 1.5 (different random numbers).

### Battery survival (optional metric)

`battery()` in `prep/geom.py`. Per step: `E = min(capacity_wh, E + (panel_w * sunFrac - load_w) * step_h)`; the lander is dead at the first step where `E <= 0`.
Defaults: `panel_w = 200`, `load_w = 100`, `capacity_wh = 1500`, start full. Outputs state of charge per step and `survival_h` (null = survives the window).
`fixture/series_check.json` has `battery_default.{survival_h, min_soc}` per site for cross-checking.
