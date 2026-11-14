# Shackleton Live — 24h build plan

> Research done (terrain data, LROC NAC access, prior art, browser ephemeris). URLs and sizes below were checked live today.

## Context

NASA Space Apps "Lunar Landing Site Navigator". Clock is running: ~24h, 2 full-stack people, 2 Claude accounts (Fable 5.2), M4 Pro + M3 Max, empty repo (`/Users/aadit/Documents/GitHub/nasaapp`).

The existing breakdown (`~/Downloads/Shackleton Live Full Project Breakdown.md`) is strong on science but weak on the brief. The challenge asks for one thing: **compare landing sites and dates fast, showing Sun and Earth relative to the horizon, for power and direct-to-Earth comms**. In the doc that survives only as a "timeline panel". Six components + lander + projector in 24h with two people does not fit.

Decision (user confirmed): **comparison tool first**. Validation and uncertainty are the differentiators. 3D view is the wow. Lander and physical demo are stretch only.

## What changes from the original idea

| Original | Now | Why |
|---|---|---|
| No comparison UI | **Core product**: site x date comparison, horizon panorama, time-to-sunset/Earthset, "launch slipped N days" slider | It is the literal brief; Relevance + Impact criteria |
| FastAPI backend, cloud GPU, Cloud Run | **Static site, all compute in browser** (Web Worker). Python only for offline data prep + validation | Per-site horizon = 360 az x ~300 samples = ms in JS. No server, no quota risk, nothing to go down during judging |
| Full-grid horizon maps (180 MB per mast height) | **Per-site horizons computed on demand** from a shipped DEM (~20 MB total) | Works for any custom coordinate, no precompute wait |
| 10 km Shackleton tile only | South pole region hi-res + **whole Moon coarse** (Apollo, CLPS, Chang'e etc.) | Brief explicitly suggests those site lists |
| WebGPU / WGSL / clipmaps | **three.js WebGL2 + GLSL heightfield ray-march** on one tile | Same visual result, far less risk, runs on judges' laptops/phones |
| Monte Carlo over DEM realizations (fractal field) | **Monte Carlo over the horizon profile**: sigma_theta(az) = sigma_h / d_occluder, correlated in azimuth | 1000x cheaper, same output ("73% +- 6% lit"), still calibratable. Fractal DEM field = upgrade path |
| d^2/2R curvature approx, grid-north azimuths | **Exact 3D geometry in Moon-fixed Cartesian** + local ENU | Near the pole, stereographic grid north != local north; approximation silently rotates shadows |
| Lander, projector, thermal, multipath, radiosity, Pareto optimizer | Stretch / cut | Off-brief, high integration risk |
| Cloud credits (Azure/GCP) | Skip. Deploy static to Vercel/Netlify/GitHub Pages | Signup + quota friction buys nothing |

## Scope tiers

**MUST (the submission)**
1. Site picker: curated list (Artemis III regions, CLPS/IM, Chandrayaan-3, SLIM, Chang'e, Apollo) + custom lat/lon + click on map.
2. Date/time picker + scrubber + play animation over a lunar day.
3. Horizon panorama: azimuth x elevation, real terrain silhouette, Sun disk + Earth, their tracks over the next lunar day.
4. Metrics per site-date: Sun elevation, visible Sun fraction, time to sunset, time to Earthset, % lit and longest darkness over next 29.5 d, DTE comms hours, mast height knob (0/2/5/10 m).
5. Comparison: 2-4 site-date scenarios side by side + year heat-strips (lit / Earth visible) + **slip slider** ("landing delayed N days" -> deltas).
6. Validation: ephemeris vs JPL Horizons, synthetic cone DEM test, comparison vs published PGDA illumination map.

**SHOULD (differentiators, in this order)**
7. Uncertainty: P(lit) band on every timeline and metric.
8. 3D view: terrain tile with ray-marched soft shadows sweeping with time; "stand at the site" camera showing Sun and Earth on the real horizon.
9. Reality check: our shadow render vs real LRO NAC photo, draggable slider + IoU score. Feasible without ISIS, see "Reality-check data". Timebox 3h.
10. Mini benchmark table: flat horizon vs coarse DEM vs ours, scored on the NAC set.
11. DSN station visibility (Goldstone/Madrid/Canberra > 10 deg) layered on Earth-visible windows.
12. Plain-language mode for educators ("Why is this hard?" captions, Earth-vs-Moon contrast).

**STRETCH (only if Gate 3 is met on time)**
13. Public JSON endpoint: one serverless function reusing the same TS core.
14. Claude agent with tool calls into the core (find site/date, fly camera).
15. Battery state-of-charge survival days.
16. Lander. Realistically cut; at most a scripted descent camera fly-in to the chosen site.

Never cut: 1-6.

## Architecture

```
offline (Python, run locally once)            browser (static, no backend)
----------------------------------            -----------------------------------
LOLA DEMs  --prep-->  dem_*.bin + .json  -->  core/ (TS, Web Worker)
SPICE      --table->  ephem.bin + .json  -->    horizon(site, mast)      360 az
site lists ------->   sites.json         -->    sunEarthAzEl(site, t)    from table
NAC images --bench->  bench/*.png + json -->    series(site, t0..t1)     lit, earth, P(lit)
                                                metrics(series)
                                              ui/  compare grid, panorama, strips, slip slider
                                              view3d/  three.js terrain + GLSL shadow march
```

**Geometry (single source of truth, pin in CONTRACT.md)**
- Frame: Moon mean-Earth/polar-axis (MOON_ME), same as LOLA. R = 1737.4 km. Heights = meters above that sphere.
- Sample point -> Cartesian `(R+h) * [cos lat cos lon, cos lat sin lon, sin lat]`.
- Site ENU basis from lat/lon. Azimuth clockwise from local north. Elevation = angle of (target - site) above local horizontal. Site position includes mast height.
- Horizon: for each of **720 azimuths (0.5 deg; Sun disk is 0.53 deg wide)**, walk the great circle from the site out to 300 km. Step grows with distance but is **capped at the pixel size of the tier being sampled** (20 m tile -> 240 m regional -> global), so ridges are never skipped. Elevation angle of each sample from the site, keep max and **distance of the max** (needed for uncertainty). Still ms per site.
- **3D view uses the same geometry, not a flat heightfield.** Over a 40 km tile curvature drops 0.46 km and local Sun elevation varies ~1.3 deg, as much as the Sun's whole range; a flat tile with one light direction would contradict the panorama. Mesh vertices at Moon-fixed Cartesian `(R+h)*n`; Sun = one Moon-fixed vector; shader marches `p + s*sunDir` in 3D, converts p -> stereo xy, compares `|p|-R` to the DEM, and **continues into `sp_240m` after leaving the tile** (occluders are often 50-100 km away). Height textures as R32F with manual bilinear.
- Sun/Earth: table vectors (Moon center -> body, MOON_ME, km) minus site vector -> ENU -> az/el. Subtracting the site vector matters for Earth (0.26 deg parallax).
- Sun visible fraction: circular-segment formula from the doc, x = (el_sun - horizon(az_sun)) / 0.266 deg.
- Earth visible: el_earth_center - horizon(az_earth) > margin (default 0; expose 2 deg knob).
- Uncertainty: N=64 draws of horizon offset, sigma_theta(az) = sigma_h / d_max(az), smoothed over ~5 deg azimuth; P(lit)(t) = mean over draws. sigma_h per DEM tier from its documented error. `// ponytail: horizon-space MC; fractal DEM field if calibration vs NAC is poor`.

**Data artifacts (written by Python, read by TS)** — sizes are targets
- `ephem.bin`: Float32, hourly UTC steps, 2024-2040, [sun xyz, earth xyz] km in MOON_ME. ~3.4 MB. Linear interpolation error < 0.001 deg. `ephem.json`: t0, step, n, frame, kernel list.
- Out-of-range dates: `bench.py` calls spiceypy directly for the 2010 NAC scenes and stores the Sun vector per image. UI date picker is clamped to 2024-2040; Apollo sites are shown for future dates only (`// ponytail: add a 1969-72 block (0.8 MB) if we want "relive Apollo 11"`).
- `dem/manifest.json`: list of tiles, finest first: `{file, proj: "spstere"|"eqc", x0, y0, px_m | ppd, w, h, scale, sigma_h_m}`. Core samples the finest tile containing the point. Lazy-loaded. Coarse tiers int16 at 0.5 m. **20 m tiles: int16 with per-tile offset and 0.05 m scale (or Float32)** — 0.5 m steps at 20 m spacing put up to ~1.4 deg of noise into the near-field horizon.
- `dem/global_8ppd.bin`: whole Moon equirectangular 2880x1440 (~8 MB). Loaded only for non-polar sites.
- `dem/sp_240m.bin`: polar stereo 80S-90S, 2534^2 (~13 MB).
- `dem/site_<name>_20m.bin`: 20 m tiles, ~2 MB per 20x20 km: Shackleton + connecting ridge (40x40 km, 8 MB, also the 3D height texture), Malapert, Mons Mouton, Nobile rim, Haworth, de Gerlache.
- `sites.json`: name, lat, lon, program, date, blurb.
- `bench/`: per NAC image: photo crop, our shadow mask, metadata (UTC, sun az/el), scores.

**Sources (verified today, no logins, HTTP range requests work so GDAL `/vsicurl/` windowed reads avoid multi-GB downloads)**

| Use | File | Size |
|---|---|---|
| 20 m tiles + sp_240m | `https://pgda.gsfc.nasa.gov/data/LOLA_20mpp/LDEM_80S_20MPP_ADJ.TIF` (Barker 2023; 30400^2 Float32, +-304 km) | 2.7 GB; windowed read. Or `LDEM_80S_80MPP_ADJ.TIF` 181 MB for sp_240m |
| sigma_h | `..._ADJ_ERR.TIF` (same grid), and `LOLA_5mpp/{SITE}/{SITE}_final_adj_5mpp_toterr.tif` | windowed read, store median per tile |
| Optional 5 m detail | `https://pgda.gsfc.nasa.gov/data/LOLA_5mpp/Site01/Site01_final_adj_5mpp_surf.tif` (connecting ridge), `Site04` (Shackleton rim) | 41 MB each |
| Global | `https://pds-geosciences.wustl.edu/lro/lro-l-lola-3-rdr-v1/lrolol_1xxx/data/lola_gdr/cylindrical/float_img/ldem_16_float.img` (float32 5760x2880, **km** units) -> downsample to 8 ppd | 66 MB |
| Validation target | `https://pgda.gsfc.nasa.gov/data/MoonIllumination/AVGVISIB_85S_060M_201608.TIF` (Sun) and `..._EARTH.TIF`; DN x 0.00004 = fraction. Use plain .TIF, the COG links are broken | 34 + 25 MB |

- Projection for all PGDA polar grids: polar stereographic, lat0 -90, lon0 0, k=1, sphere R=1,737,400 m, MOON_ME. Inverse in TS is 5 lines; no proj library.
- PGDA is slow at times: **start downloads first**, mirror at `imbrium.mit.edu` for PDS products.
- No precomputed horizon maps exist anywhere: we compute them (already the plan).
- Bonus: `LOLA_5mpp/{SITE}/Clones/` has 100 Monte-Carlo DEM realizations per site. Use one site to sanity-check our horizon-space uncertainty (should-tier).

**Curated sites (check against agency sources where time allows)**
- Apollo 11 (0.6741, 23.4730), 12 (-3.0124, -23.4216), 14 (-3.6453, -17.4714), 15 (26.1322, 3.6339), 16 (-8.9730, 15.5002), 17 (20.1908, 30.7717).
- IM-1 Odysseus (-80.13, 1.44), IM-2 Athena (-84.7906, 29.1957), Blue Ghost M1 (18.5623, 61.8103).
- Chandrayaan-3 (-69.373, 32.319), SLIM (-13.316, 25.251), Chang'e-3 (44.12, -19.51), -4 (-45.4561, 177.5885), -5 (43.0576, -51.9161), -6 (-41.6385, -153.9852).
- Artemis III regions (NASA publishes names only, no coordinates): use PGDA tile centres as representative points — Connecting ridge (-89.46, -137.5), Shackleton rim (-89.77, -171.9), de Gerlache rim (-88.68, -67.9), Malapert massif (-86.00, -0.2), Nobile rim 1 (-85.44, 37.4), Haworth (-86.76, -22.8), Mons Mouton / Leibnitz beta (-85.43, 31.7). Label "representative point". Better: pick the best-lit point in each tile with our own engine.

**Ephemeris source (researched)**: spiceypy-precomputed table. JS libs are worse: astronomy-engine has optical libration only (~0.02 deg), SPICE-in-WASM needs 43 MB of kernels.
- Kernels from `https://naif.jpl.nasa.gov/pub/naif/generic_kernels/`: `spk/planets/de440s.bsp` (31 MB), `pck/moon_pa_de440_200625.bpc` (12 MB), `fk/satellites/moon_de440_250416.tf`, `pck/pck00011.tpc`, `lsk/naif0012.tls`. DSN only: `spk/stations/earthstns_itrf93_260814.bsp`, `fk/stations/earth_topo_260814.tf`, `pck/earth_latest_high_prec.bpc`.
- `spkpos('SUN'|'EARTH', et, 'MOON_ME', 'LT+S', 'MOON')`. Must be MOON_ME (LOLA frame); IAU_MOON is off by up to 0.005 deg, MOON_PA by 0.029 deg. Keep Earth as full km vector.
- Horizons has no CORS header: oracle from Python only, never from the browser.

## Reality-check data (NAC photos, no ISIS)

Raw NAC frames are camera-space and need ISIS (hours of install, unconfirmed). Skip. Use **NAC DTM orthoimages**: already polar stereographic, orthorectified, single-time, ~24 MB each at 1 m.

- Base: `https://pds.mcp.nasa.gov/data/store/img/lunar_reconnaissance_orbiter/pds4/lroc/lro-l-lroc-5-rdr/LROLRC_2001/DATA/SDP/NAC_DTM/<SITE>/`
- Finder: `https://oderest.rsl.wustl.edu/live2/?query=product&target=moon&ihid=LRO&iid=LROC&pt=SDNDTM&minlat=-90&maxlat=-89&westlon=0&eastlon=360&results=fp&output=JSON`
- **Step 1 (sure thing): `SHACKRDGE02`** — 2 orthoimages named by image ID (M139797542, M139811097). Look up each ID's start time on its LROC page (`https://data.lroc.im-ldi.com/lroc/view_lroc/LRO-L-LROC-2-EDR-V1.0/<ID>LE`), compute Sun with our own SPICE table.
- **Step 2 (if time): `ESALL_SR12` (6) and `ESALL_CR1` (7)** — labels do not say which source image each orthoimage came from. Match by trying each candidate observation time (SR12: M139872173, M139878946, M140890072, M140903652, M140917211, M141378588, M141385360) and keeping the one whose predicted shadow mask scores best. Disclose that this matching uses the model.
- Pipeline (`prep/bench.py`): read orthoimage -> downsample to 20 m -> shadow mask = DN below 5% of max (De Rosa's rule) -> our mask = Sun visible fraction < 0.5 on the same grid (march only along the Sun azimuth per cell, numpy) -> phase-correlate to remove the documented "several meters or more" offset -> IoU, F1.
- Baselines for the table: flat sphere, 240 m DEM, 20 m DEM.
- **Headline numbers come from SHACKRDGE02 only** (known times). ESALL candidates differ by ~1 deg of Sun azimuth and best-of-7 inflates scores; if ESALL is used, give every baseline the same best-of-7 and report it separately.
- Check each orthoimage label's projection parameters (lat0, lon0, R, corner x/y) before overlaying.
- Caveats to state on the slide: all images are from 22 Sep - 11 Oct 2010 (no seasonal spread); take times from source image records, not DTM labels (they disagree by 7 h).
- Fallback if this slips past its timebox: reality check = our multi-year average vs the PGDA `AVGVISIB` map side by side. Still a real validation, zero NAC work.

## Repo layout

```
nasaapp/
  CONTRACT.md        frames, units, azimuth convention, artifact schemas
  data/              raw downloads (gitignored)
  prep/              Python: ephem.py, dem.py, sites.py, bench.py, validate.py
  web/               Vite + TS
    public/data/     artifacts
    src/core/        horizon.ts, ephem.ts, series.ts, metrics.ts, core.test.ts
    src/ui/          compare, panorama, strips, pickers
    src/view3d/      three.js scene + shadow shader
```

Python: numpy, spiceypy, rasterio, scikit-image. Web: Vite, TypeScript, three.js, one small chart approach (plain canvas for panorama/strips). No UI framework beyond what Vite scaffolds unless a person strongly prefers React.

## Split across the two accounts

Split at the artifact contract so neither blocks the other.

**Hour 0, together (30 min):** write `CONTRACT.md`; generate a **synthetic fixture** (cone-shaped DEM + fake ephem table in the real binary format) so the web side builds against real file formats immediately; start all downloads.

**Account A — data + science (M3 Max)**
- A1: downloads, `dem.py` (reproject/crop/quantize), `ephem.py`, `sites.json`.
- A2: `validate.py` (Horizons check, cone test, PGDA map comparison), then NAC benchmark, then uncertainty calibration.
- Later: DSN windows, benchmark table, stretch API.

**Account B — product (M4 Pro)**
- B1: `src/core/` against fixture (horizon, ephem, series, metrics, tests), then compare UI + panorama + strips + slip slider.
- B2 (parallel worktree, starts once core API is stable): `view3d/` terrain + shadow shader + site-level camera.
- Later: reality-check slider, educator mode, polish, deploy.

Rules
- Max 2 concurrent sessions per account, each in its own git worktree, merge to main every ~2h. More sessions = merge pain, not speed.
- Fable 5.2 for everything that touches geometry, shaders, validation. Heavy compute runs as local scripts, not in-session.
- Each session prompt starts with "Read CONTRACT.md". Contract changes: tell the other person first.
- Python and TS each implement the horizon march (~40 lines). Both must pass the same cone fixture; that is the cross-check.

## Kickoff

**On approval, this session (Account A, session A1) does, in order:**
1. `CONTRACT.md` (frames, azimuth convention, projection formulas, artifact schemas above).
2. `prep/fixture.py`: cone DEM + fake ephem in the real binary formats -> `web/public/data/`. Commit, push. Account B is unblocked from here.
3. Start downloads in background (kernels, `LDEM_80S_80MPP_ADJ.TIF`, `ldem_16_float.img`, AVGVISIB maps, SHACKRDGE02 orthoimages); windowed read of the 20 m tiles.
4. `prep/ephem.py`, `prep/dem.py`, `prep/sites.py` -> real artifacts.

**Prompts for the other sessions** (each in its own worktree, after step 2 is pushed):

A2 — validation
```
Read CONTRACT.md and the plan's Verification and Reality-check sections. Build prep/validate.py: (1) Sun and Earth az/el vs the JPL Horizons API at 5 sites x 20 times using the query in the plan, target < 0.01 deg; (2) analytic cone horizon vs prep's Python horizon march; (3) export rasterio height samples at 10 lat/lons for the web georeferencing test; (4) brute-force dense march vs fast march at one connecting-ridge site; (5) average illumination at 500 random tile points vs PGDA AVGVISIB_85S_060M. Then build prep/bench.py for the two SHACKRDGE02 NAC orthoimages: shadow mask, our predicted mask, phase-correlation registration, IoU/F1 for flat, 240 m, 20 m. Write results as JSON + PNG crops into web/public/data/bench/. Run heavy compute as scripts, report numbers honestly including failures.
```

B1 — core + comparison UI
```
Read CONTRACT.md. In web/ (Vite + TypeScript, no backend), build src/core/: manifest-driven DEM sampling (finest tile wins, bilinear), polar-stereographic and equirectangular transforms, horizon(site, mast) at 720 azimuths with step capped at tier pixel size and distance-of-max recorded, ephem table interpolation, Sun/Earth az/el in local ENU (subtract site vector), visible Sun-disk fraction, series(site, t0, t1, step), metrics (time to sunset, time to Earthset, % lit and longest darkness over next 29.5 d, DTE hours), horizon-space Monte Carlo P(lit). Run it in a Web Worker. Vitest against the cone fixture with the analytic answer. Then the UI: site picker (sites.json + custom lat/lon), date/time scrubber with play, horizon panorama canvas (terrain silhouette, Sun disk, Earth, their tracks over the next lunar day), 2-4 scenario comparison columns, year heat-strips, and a "landing slips N days" slider showing metric deltas. Develop against the fixture in public/data; real data drops in with the same schema.
```

B2 — 3D view (start once B1's core API is stable)
```
Read CONTRACT.md and the plan's 3D view bullet. Build web/src/view3d/ with three.js WebGL2. Terrain mesh from the 20 m Shackleton tile with vertices in Moon-fixed Cartesian (R+h)*n. Fragment shader: march from the surface point toward the Moon-fixed Sun vector in 3D, convert each step to polar-stereographic xy, compare |p|-R with the DEM (R32F texture, manual bilinear), continue into the 240 m regional texture after leaving the tile; soft shadow from Sun-disk radius 0.266 deg; Lommel-Seeliger/Lambert shading. Time comes from the shared scrubber. Two cameras: orbit overview, and "stand at the site" at mast height showing the Sun disk and Earth at their true positions on the horizon. Shadow at a site must agree with core's visible-Sun fraction for the same time; add a debug readout that shows both. Target 30 fps on a MacBook, degrade step count on slow devices.
```

## Timeline (T = now)

| Gate | By | Must be true | If missed |
|---|---|---|---|
| G0 | T+0:30 | Contract + fixture committed, downloads running | - |
| G1 | T+4 | Vertical slice on real data: pick site + date -> panorama with real horizon, Sun, Earth, metrics. Sun/Earth angles match Horizons | Drop global DEM (smooth sphere for non-polar sites) |
| G2 | T+9 | Compare grid, strips, slip slider working. 3D tile renders with moving shadows. First NAC overlay looks right | 3D falls back to precomputed shadow texture, or 2D shadow map only |
| G3 | T+14 | Uncertainty bands, benchmark table, reality-check slider, deployed URL | Skip all stretch |
| Freeze | T+18 | No new features. Bugs, copy, mobile check | - |
| Video | T+20 | Demo video recorded | - |
| Submit | T+22 | Submitted with 2h buffer. Confirm real deadline with Local Lead | - |

Sleep in shifts after G2, not before.

## Verification

- `prep/validate.py`
  - Sun and Earth az/el at 5 sites x 20 times vs JPL Horizons, target < 0.01 deg (other teams report 0.005). Query (URL-encode): `https://ssd.jpl.nasa.gov/api/horizons.api?format=text&COMMAND='10'` (`'399'` for Earth) `&EPHEM_TYPE='OBSERVER'&CENTER='coord@301'&COORD_TYPE='GEODETIC'&SITE_COORD='<Elon>,<lat>,<alt km>'&START_TIME=..&STOP_TIME=..&STEP_SIZE='1h'&QUANTITIES='4'&ANG_FORMAT='DEG'&EXTRA_PREC='YES'&CSV_FORMAT='YES'`. Returns airless az/el on the R=1737.4 sphere in MEAN_ME, no terrain.
  - Cone DEM: analytic horizon vs Python march, < 0.05 deg.
  - **Georeferencing check (G1 blocker):** Horizons and cone tests both pass with a flipped or shifted real DEM. Export rasterio height samples at ~10 lat/lons from the source GeoTIFFs; TS must read the same heights through the manifest (< 1 m).
  - **Step-skip check:** brute-force dense march (every pixel along the ray) at one real connecting-ridge site vs the fast march, < 0.02 deg at every azimuth.
  - PGDA `AVGVISIB_85S_060M` Sun and Earth maps vs ours at ~500 random points in the Shackleton tile (multi-year average, any-part-of-disc-visible rule to match theirs): scatter plot + mean abs diff for the pitch.
  - Sanity: polar Sun elevation never exceeds ~1.6 deg; Earth stays within ~7 deg of the polar horizon; a connecting-ridge site is lit > 70% of a year.
- `web/src/core/core.test.ts` (vitest): same cone fixture, TS vs analytic; TS series vs Python-exported series for one real site, equal to tolerance.
- Benchmark: IoU / F1 of predicted shadow vs NAC mask for flat, coarse, ours.
- Manual end-to-end: open deployed URL on laptop + phone, run the demo script once.

## Pitch (3 min)

1. Hook: "At the south pole a hill can hide the Sun for days. Launch slips three weeks. Is your site still alive?"
2. Drag the slip slider: site A dies, site B survives. Timelines and panorama update live.
3. Proof: reality-check slider over a real LRO photo, benchmark table, "73% +- 6%".
4. Wow: 3D shadows sweeping Shackleton; stand at the site, watch Earth bob on the horizon.
5. Close: open, static, runs on a phone, any coordinate on the Moon.

## Novelty: what research killed

- **Drop "first open benchmark" and "first uncertainty-aware API".** 30+ repos for this challenge were pushed today. `TheRatLord/lunar-landing-site-navigator` (MIT) already scores shadows against 10 LRO NAC scenes with IoU, boundary distance, uncertainty bracket, and a FastAPI service. `NetRunnerXD/lunar-horizon-wheel` has P10-P90 bands. Many teams report 0.005 deg vs Horizons and PGDA map comparisons. Academic precedent: Gläser 2014, Mazarico 2011.
- So LOLA horizons + SPICE + Horizons check + PGDA comparison = **table stakes**, not differentiators. Do them, state them in one slide, move on.
- **Where we can still win**: the thing the brief asks for and science-heavy teams under-build — speed of comparison and clarity. Slip slider, side-by-side scenarios, any coordinate with zero backend, runs on a phone, reads in plain language, plus the 3D "stand at the site" view. Validation is the credibility layer under it, not the headline.
- Honest wording: "Validated against time-stamped LRO NAC scenes and published PGDA illumination maps, with error bars on every number." No "first".
