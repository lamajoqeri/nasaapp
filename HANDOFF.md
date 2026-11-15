# HANDOFF — Account B (web product)

Written Sat Nov 14 2026, 12:30 PST by Account A's session. Read this, then `CONTRACT.md`, then skim `PLAN.md`.

## What we are building

NASA Space Apps challenge "Lunar Landing Site Navigator". A **static web app** that lets someone compare lunar landing sites and dates fast: where the Sun and Earth sit relative to the real terrain horizon, how long until sunset / Earthset, how much power and direct-to-Earth comms a site gets, and what happens when the landing date slips.

Decisions already made (do not reopen):
- **No backend.** All compute in the browser (Web Worker) from static binary files. Python is only offline data prep and validation.
- **Comparison tool first.** 3D view second. Lander, projector demo, thermal, multipath, Pareto optimizer are cut or stretch.
- **three.js WebGL2 + GLSL**, not WebGPU.
- **No "first open benchmark" claim.** 30+ teams pushed repos for this challenge today; several already do LOLA horizons + SPICE + NAC validation + uncertainty. That is table stakes. We win on comparison speed and clarity: slip slider, side-by-side scenarios, any coordinate, runs on a phone, plain language, "stand at the site" 3D view.

## Who does what

| | Account A (this handoff's author) | Account B (you) |
|---|---|---|
| Owns | `prep/`, `web/public/data/`, `CONTRACT.md` | `web/` except `web/public/data/` |
| Done | contract, reference geometry, ephemeris, DEM tiles, sites, fixture | nothing yet |
| Next | `prep/validate.py` (Horizons x100, PGDA map comparison, step-skip check), `prep/bench.py` (NAC photo reality check -> `web/public/data/bench/`), uncertainty calibration, DSN windows | B1 core + comparison UI, then B2 3D view, then reality-check slider UI, educator copy, deploy |

**Account A is NOT doing any of this — it is all yours:**
- `web/` scaffold (Vite + TypeScript), `src/core/` TS port of `prep/geom.py`, vitest
- All UI: site picker, date scrubber, horizon panorama, comparison columns, year heat-strips, slip slider
- Uncertainty in the browser (horizon-space Monte Carlo, spec in CONTRACT.md)
- 3D view and shadow shader
- Reality-check slider UI (A delivers images + scores in `bench/`, you display them)
- Deploy (Vercel / Netlify / GitHub Pages), phone check
- Nobody owns yet: demo video, pitch slides, submission form. Decide between the two of you by G3.

## Git workflow

- Remote: `https://github.com/lamajoqeri/nasaapp.git`, default branch `main`.
- You: branch `web-core` (session B1) and `web-3d` (session B2), each in its own worktree:
  `git worktree add ../nasaapp-web-core -b web-core` and `git worktree add ../nasaapp-web-3d -b web-3d`.
- A works on `main` / `science`, touching only `prep/` and `web/public/data/`. You never edit those, A never edits `web/src/`. That keeps merges conflict-free.
- Merge to main every ~2 h (`git pull --rebase origin main` first). Data artifacts will update on main; schemas will not change without a message to you.
- Need a contract change? Tell A first, then edit `CONTRACT.md`.

## What exists right now (all on `main`)

```
CONTRACT.md                 frames, projection, horizon march, formulas, artifact schemas  <- the spec
PLAN.md                     full plan: scope tiers, architecture, timeline, pitch, research findings
prep/geom.py                reference implementation (120 lines). Port this to TS.
prep/ephem.py dem.py sites.py fixture.py download.sh
web/public/data/
  ephem.bin  ephem.json     Float32 [n*6], hourly, 2024-01-01 .. 2040-01-01, n=140257, 3.4 MB
  sites.json                22 sites: 7 south-pole Artemis-type, IM-1, IM-2, Chandrayaan-3, Blue Ghost, SLIM, Chang'e 3-6, Apollo 11-17
  dem/manifest.json         7 tiles, finest first
  dem/shackleton_20m.bin    2000^2, 20 m, x -30..10 km, y -30..10 km   (7.6 MB)  <- also the 3D view's height texture
  dem/mouton_nobile_20m.bin 2000^2, 20 m, x 60..100 km, y 100..140 km  (7.6 MB)
  dem/malapert_20m.bin  haworth_20m.bin  degerlache_20m.bin   1000^2 each (1.9 MB)
  dem/sp_240m.bin           2533^2, 240 m, 80S-90S                     (12 MB)
  dem/global_8ppd.bin       2880x1440 equirectangular, whole Moon      (7.9 MB)
  fixture/dem/              synthetic Gaussian-mountain tile, same format
  fixture/fixture.json      expected horizon (720 values), peak azimuth, 5 Sun/Earth az/el samples
  fixture/dem_check.json    10 lat/lon with heights read from the source rasters
```

You do not need Python or the raw downloads. Everything the web app needs is in `web/public/data/`.

## Your tests (write these first)

Port `prep/geom.py` to `web/src/core/` and make vitest pass against `fixture/`:
1. `horizon(fixture site, mast 2)` using `fixture/dem/manifest.json` matches `horizon_el` within **0.05 deg** at all 720 azimuths; argmax azimuth within 0.5 deg of `peak_az`.
2. Each row of `fixture.ephem`: Sun and Earth az/el from `ephem.bin` at `(t, lat, lon, h)` within **0.005 deg**. Note `h` is given explicitly here (site height above the sphere), do not sample the DEM for this test.
3. `dem_check.json`: `h_dem(lat, lon)` through the real `dem/manifest.json` within **15 m** of `h` (source was nearest-pixel, ours is bilinear on steep slopes; typical diff is 1-5 m). This catches a flipped or shifted tile, which tests 1 and 2 cannot.

The Python reference passes all of these. Python Sun/Earth angles also match the JPL Horizons API at a south-pole site to 0.00003 deg, so if your TS matches the fixture, it matches JPL.

## Things that will bite you

- **Azimuth near the pole.** Never treat the stereographic grid's +y as north. Always build east/north/up from lat/lon (CONTRACT.md). At the Connecting Ridge site grid north and true north differ by ~137 deg.
- **int16 decode.** `height = offset + scale * raw`, per tile, from the manifest. Little-endian. `new Int16Array(buffer)` is fine on every real device.
- **Tile lookup order.** First tile in the manifest that contains the point wins. Outside every `spstere` tile you fall through to `global_8ppd`, which always contains the point. Longitude wraps in the global tile.
- **Lazy loading.** Do not fetch all 40 MB up front. A south-pole site needs its 20 m tile + `sp_240m`. A non-polar site (Apollo etc.) needs only `global_8ppd`. Rays from a site at 80-84S can leave `sp_240m` into the global tile.
- **Ephemeris.** Vectors are **km**, Moon centre -> body. Multiply by 1000 and subtract the site position before taking az/el (0.26 deg Earth parallax). Clamp the date picker to the table range. Apollo-era dates are out of range; show those sites for 2024-2040 dates.
- **Sun angular radius** comes from distance (`asin(695700e3 / dist)`), about 0.266 deg. Earth's is 0.948 deg; our rule uses Earth's centre with a margin knob.
- **Performance.** The march is 720 azimuths x 1410 distances = ~1 M samples per site. Python/numpy does it in 0.2-0.3 s; plain typed-array JS should be similar. Do it in the Worker, cache per (site, mast). A year at hourly steps is 8766 evaluations and is trivial after that.
- **Default mast height = 2 m.** At mast 0 the horizon is often set by the ground slope 10-20 m away, which is physically true for an eye on the ground but not for a lander's solar panel or antenna.
- **The south pole is genuinely this sensitive.** Measured today on real data: at the Connecting Ridge, moving 100 m changes Earth visibility from 0% to 50% of the time. That is not a bug, it is the headline of the demo ("small moves, big consequences"). Build the UI so nudging a site and seeing the change is easy.
- **3D view must use the same geometry.** Over the 40 km Shackleton tile the surface curves away by 0.46 km and the local Sun elevation varies by ~1.3 deg, as much as the Sun's whole range. A flat heightfield with one light direction will disagree with the panorama. Mesh vertices in Moon-fixed Cartesian `(R+h)*unit(lat,lon)`, Sun as one Moon-fixed vector, shader marches in 3D and converts each step back to stereographic xy to sample the DEM; continue into `sp_240m` after leaving the tile (occluders are often 50-100 km away). int16 textures are not filterable in WebGL2: upload as R32F and do bilinear by hand.

## Sanity numbers from real data (use to eyeball your output)

Mast 0, 4 years from 2026, at the old tile-centre points (before sites were moved to best-lit points):

| Point | Horizon range | Max Sun elevation | Time any Sun visible | PGDA published |
|---|---|---|---|---|
| (-89.46, -137.5) ridge | -2.6 .. 10.0 deg | 2.05 deg | 31.5% | 33.5% |
| (-89.77, -171.9) Shackleton rim | 0.1 .. 33.6 deg | 1.77 deg | 11.0% | 11.1% |
| (-88.68, -67.9) de Gerlache | -2.8 .. 4.5 deg | 2.88 deg | 51.9% | 47.3% |
| (-86.0, -0.2) Malapert | -4.5 .. 10.1 deg | 5.59 deg | 21.2% | 25.5% |

Horizons spot check: site lon -129.78, lat -89.45, alt 1.0 km, 2026-12-01 03:17:00 UTC -> Sun az 48.1922, el 1.8361; Earth az 136.4887, el -2.2180.
Sub-solar latitude over 2024-2040 stays within +-1.59 deg. Earth as seen from near the pole swings roughly -7.5 .. +6.2 deg in elevation over a month.

The current `sites.json` polar entries are the best-lit point within 3 km of each region (per PGDA average maps: e.g. Connecting Ridge Sun 88%, Earth 58%; Malapert Sun 59%, Earth 100%), so expect much better numbers there than in the table above.

## Scope for you, in order

MUST
1. Site picker: `sites.json` list grouped by program + custom lat/lon input.
2. Date/time picker, scrubber, play animation over a lunar day (29.5 d).
3. Horizon panorama (canvas): azimuth on x, elevation on y, terrain silhouette, Sun disk, Earth, both tracks over the next lunar day.
4. Metrics per scenario: Sun elevation, visible Sun fraction, time to sunset, time to Earthset, % lit and longest darkness over the next 29.5 d, direct-to-Earth hours, mast height knob (0/2/5/10 m).
5. Comparison: 2-4 scenarios (site + date + mast) side by side, year heat-strips (lit / Earth visible), and the **slip slider**: "landing delayed N days" with metric deltas.

SHOULD
6. Uncertainty bands: P(lit) from the horizon-space Monte Carlo in CONTRACT.md. Show "73% +- 6%" style numbers.
7. 3D view: Shackleton tile, ray-marched soft shadows that sweep with the scrubber, orbit camera + "stand at the site" camera with Sun and Earth on the horizon.
8. Reality-check slider: draggable split between a real LRO photo and our predicted shadow, with IoU. Data arrives in `web/public/data/bench/index.json` (schema in CONTRACT.md). Build the component against a placeholder until A pushes it.
9. Plain-language captions for educators/public ("Sun sets in 3 days 4 h", "Earth is hidden behind the ridge to the north").
10. "Nudge" control: move the site 50-500 m and show how metrics change.

STRETCH (only if everything above is done by G3): JSON endpoint reusing the TS core, Claude chat agent calling the core, battery survival days.

## Timeline (T0 = Sat 12:15 PST; shift if the real deadline differs — confirm it with the Local Lead)

| Gate | Clock | Must be true | If missed |
|---|---|---|---|
| G1 | Sat 16:15 | Pick site + date -> panorama with real horizon, Sun, Earth, metrics. Fixture tests green | Non-polar sites use smooth sphere |
| G2 | Sat 21:15 | Comparison columns, heat-strips, slip slider. 3D tile renders with moving shadows | 3D becomes a 2D top-down shadow map |
| G3 | Sun 02:15 | Uncertainty bands, reality-check slider, deployed URL | Drop all stretch |
| Freeze | Sun 06:15 | Bugs, copy, phone check only | |
| Video | Sun 08:15 | Demo video recorded | |
| Submit | Sun 10:15 | Submitted, 2 h buffer | |

## Session prompts (paste into Claude Code on Account B)

**B1 — core + comparison UI** (branch `web-core`, start now)

```
Read HANDOFF.md, then CONTRACT.md, then prep/geom.py (the reference implementation). Work only inside web/ and never edit web/public/data/. Scaffold web/ with Vite + TypeScript (no backend, no heavy UI framework unless needed). Build web/src/core/ as a faithful port of prep/geom.py: manifest-driven lazy DEM loading (first containing tile wins, bilinear, int16 with offset/scale), south polar stereographic and equirectangular transforms, horizon(site, mast) at 720 azimuths with the exact distance schedule from CONTRACT.md returning el, dist and sigma_h per azimuth, ephem.bin interpolation, Sun/Earth az/el in the local east/north/up basis (subtract the site vector), visible Sun-disk fraction, series(site, t0, t1, step), metrics (time to sunset, time to Earthset, % lit and longest darkness over the next 29.5 days, direct-to-Earth hours), and the horizon-space Monte Carlo P(lit). First write the three vitest tests described in HANDOFF.md "Your tests" and make them pass. Run the core in a Web Worker and cache horizons per (site, mast). Then build the UI in the order of HANDOFF.md "Scope": site picker, date scrubber with play, horizon panorama canvas, metrics, 2-4 scenario comparison columns, year heat-strips, and the "landing slips N days" slider with metric deltas. Default mast 2 m. Clamp dates to the ephemeris range. Commit small and often; tell me when G1 (one site, one date, real panorama and metrics, tests green) is reached.
```

**B2 — 3D view** (branch `web-3d`, start once B1's core API is stable, roughly after G1)

```
Read HANDOFF.md (especially "3D view must use the same geometry") and CONTRACT.md. Work only inside web/src/view3d/ plus the minimal wiring needed. Using three.js on WebGL2, build a terrain mesh from dem/shackleton_20m.bin with vertices in Moon-fixed Cartesian (R+h)*unit(lat,lon), recentred for precision. Fragment shader: from the surface point, march toward the Moon-fixed Sun vector in 3D; at each step convert the position to south-polar-stereographic xy and compare |p|-R with the DEM (R32F texture, manual bilinear); continue into dem/sp_240m.bin after leaving the tile; soft shadow using the Sun disk radius (0.266 deg); Lommel-Seeliger + Lambert shading. Sun and Earth vectors and time come from the shared core and scrubber. Two cameras: an orbit overview, and "stand at the site" at mast height showing the Sun disk and Earth at their true az/el above the terrain. Add a debug readout comparing the shader's lit/shadow state at the selected site with core's visible-Sun fraction for the same time; they must agree. Target 30 fps on a MacBook and degrade step count on slower devices.
```

## Pitch skeleton (3 min)

1. Hook: "At the south pole a hill can hide the Sun for days. Your launch slips three weeks. Is your site still alive?"
2. Drag the slip slider: site A dies, site B survives. Panorama and timelines update live.
3. Nudge the site 100 m: comms go from 0% to 50%.
4. Proof: reality-check slider over a real LRO photo; error bars on every number; matches JPL Horizons and NASA's published illumination maps.
5. Wow: shadows sweeping Shackleton in 3D; stand at the site and watch Earth bob on the horizon.
6. Close: open, static, runs on a phone, any coordinate on the Moon.

Honest wording for validation: "Validated against time-stamped LRO NAC scenes and NASA PGDA illumination maps, with error bars on every number." Never say "first".

## Update Sat 13:10 PST — new artifacts from Account A (all on `main`, schemas in CONTRACT.md)

- `web/public/data/bench/` — reality check is ready to display. `index.json` + two photo/model PNG pairs (584x478, same extent) of the Connecting Ridge on 2010-09-22, real LRO NAC orthoimage vs our predicted render. Shadow IoU per model:

  | Model | IoU | F1 | Pixel accuracy |
  |---|---|---|---|
  | Flat sphere (no terrain) | 0.00 | 0.00 | 87% |
  | 240 m DEM only | 0.51 | 0.68 | 94% |
  | Local slope only, no cast shadows | 0.60 | 0.75 | 95% |
  | **Ours: 20 m + far field to 300 km** | **0.70** | **0.82** | **96%** |

  Show the caveats from `index.json` `method` next to the numbers: only two images, same day, and the big southern shadow is assumed shadow (DN 0 is also the no-data value).
- `web/public/data/validation.json` — numbers for a "How do we know?" panel: JPL Horizons max error 0.00002 deg (Sun) / 0.00012 deg (Earth) over 100 samples each; fast vs brute-force horizon march max 0.04 deg; vs NASA PGDA maps at 300 random points: Sun MAE 1.5% (r 0.96), Earth MAE 0.9% (r 0.99). `pgda.points` is ready for a scatter plot.
- `web/public/data/dsn.bin` — Uint8 per ephem step, bits = Goldstone / Madrid / Canberra can see the Moon above 10 deg. `commsWindow = earthVisible && dsn != 0`.
- Not done by A: calibration of the uncertainty sigma against photos (two images are too few to calibrate on). Use the manifest `sigma_h` values as-is and label the bands "terrain-model uncertainty (LOLA error map)".

## Update Sat 13:15 PST — more from Account A (schemas in CONTRACT.md, bottom sections)

**One change you must mirror in the TS core:** uncertainty smoothing is now a **45 deg** boxcar (90 azimuth bins), not 5 deg, and the 20 m tiles' `sigma_h` in the manifest went from ~0.19 to ~0.29 m. Both were calibrated against NASA's own Monte-Carlo DEM realisations (`calibration.json`). If you already ported the 5 deg version, change the one constant; `sigma_h` is read from the manifest so it needs nothing.

New, all optional to use:
- `fixture/series_check.json` — three real sites, one lunar day each: `sun_frac[708]`, `earth_el_minus_horizon[708]`, `metrics`, `pct_lit_std`, `battery_default`. A fourth vitest: reproduce these from the real artifacts (tolerances in CONTRACT.md). Exact metric definitions: `metrics()` in `prep/geom.py` (hours_to_sunset/sunrise/earthset/earthrise, pct_lit, longest_dark_h, dte_hours, longest_no_earth_h, comms_hours).
- `maps/` — base maps for the "click on the map" site picker: `sp_hillshade.png` (80S-90S), `shackleton_hillshade.png`, `global_hillshade.jpg` (equirectangular, lon 0..360), plus `sp_sun.png` / `sp_earth.png` (NASA average Sun / Earth visibility, 0..255 = 0..100%), nice as a heat overlay to guide where to click. Bounds in `maps/index.json`.
- `ephem_apollo.bin/.json` — same format as `ephem.bin`, 1969-07-01 .. 1973-01-01, so Apollo sites can be shown on their real landing dates. Check value: Apollo 11 touchdown 1969-07-20T20:17:40Z -> Sun az 88.8, el 10.70 deg (historical value 10.8), Earth el 59.2.
- Battery survival: `battery()` in `prep/geom.py`, spec in CONTRACT.md. Defaults 200 W panel, 100 W load, 1500 Wh.
- `bench/` is being regenerated with 15 images instead of 2 (three different Sun directions). **File names changed**: read them from `bench/index.json` (`images[].photo`, `images[].model`), do not hard-code. `index.json` now also has `summary` (mean IoU per model per group) and each image has `group`: `known_time` (headline, 2 images) or `matched_time` (13 images whose capture time was identified by best match; disclosed in `method`).
- `prep/checks.py` — 10 s regression run for the Python side (math, fixture, DEM edges, metrics, battery, Apollo 11).

## Update Sat 13:50 PST — from Account A

- **Uncertainty bands are narrow.** Measured, calibrated values: yearly % lit at the Connecting Ridge is 86.5% +- 0.2%; per-lunar-day values in `series_check.json` are +- 0.2-0.3%. The "73% +- 6%" in older text was an invented example. Design the UI for bands of a few tenths of a percent near 20 m tiles: show them as "+- 0.2%" text and a thin band, and say what they cover (elevation-model error near the site, a lower bound). The much bigger sensitivity is position: nudge the site 100 m and numbers move by tens of percent. That is the thing to visualise.
- `fixture/series_check.json` regenerated: Connecting Ridge now uses a winter lunar day (t0 2027-06-20) so it contains sunsets (83% lit, 73 h longest darkness, sunset in 204 h). Re-run your cross-check test.
- `validation.json` gained `pgda_other_regions` (4 more regions) and `pgda_240m_only_region`. `bench/index.json` gained `time_matching_check`. `CONTRACT.md` now has a single `bench/index.json` schema.
- `README.md` on main is written (method, validation table, limits, data credits, AI disclosure). Add the live URL and screenshots when deployed; fix the "Run it" section if your commands differ.
- `calibration.json` is now in the repo (held-out clones 31-60): horizon spread 0.052 deg NASA vs 0.046 deg ours; yearly % lit spread 0.24% NASA vs 0.16% ours. Label the bands "terrain-model uncertainty, lower bound". No constant changed since the 45 deg update.

## Update Sat 16:10 PST — main now carries the cockpit UI

- `main` was rebuilt around a full-screen 3D cockpit (web/src/ui/app.ts, scenario.ts, timeline.ts, compare.ts, map.ts, evidence.ts, web/src/view3d/). The earlier column UI, `web-map`, `web-proof`, `web-comms` and the first `web-3d` implementation were merged for history but their files are superseded by the cockpit versions. Do not build on the old files; pull `main` first.
- Commit history on `main` was rewritten once (16:05) to drop co-author trailers. If you have a local clone from before that: `git fetch origin && git checkout main && git reset --hard origin/main` (after saving any unpushed work on a branch and rebasing it onto the new main).
- GitHub Pages: the deploy workflow builds and tests fine but cannot publish until a repo admin enables Pages (Settings > Pages > Source: GitHub Actions).

## v2, Effort 2 status (Sat 19:00 PST) — done on `main`

Implemented from `docs/V2-DESIGN.md` sections 3, 4, 5:
- **Inspector** (`web/src/ui/inspector.ts`, `charts.ts`): Power / Sun-elevation chart (all scenarios overlaid, 10-90% band, 7 / 14 / 29.5 d), windows bar (sunlit, Earth in view, DSN contact), viability badges with thresholds printed, Details (raw table + 12-month strip), Sky button.
- **Sky pop-up** (`web/src/ui/sky.ts`): all-sky view with "Horizon zoom" and "True sky" scales, tracks, true-size disks clipped by terrain, tied to the scrubber.
- **3D render modes** (`web/src/view3d/`): Realistic | Clear toggle, stored in the URL as `rm=clear`.
- **Actions registered** (via `register()` in `web/src/ui/actions.ts`): `inspector.details`, `sky.open`, `sky.close`, `chart.set`, `render.set`, `camera.set`. Every control calls `run(name, args)`.

For Effort 1:
- `web/src/ui/actions.ts` on main is a minimal stand-in with the doc's `Action` / `actions` / `register` plus `run(name, args)`. Replace it with your full version; keep those four exports source-compatible.
- State for your `snapshot()`: `inspectorState()` (ui/inspector.ts), `skyState()` (ui/sky.ts), `view3dState()` (view3d/actions.ts). All return plain JSON.
- Scenario colours A-D are `SCENARIO_COLORS` in ui/charts.ts (`#e8e6e1`, `#ee5b33`, `#5fd0a6`, `#d868b4`); use them for the scenario chips.
- Charts scrub time through the `time.set` action when it is registered, otherwise through the existing `setHours`.
- `app.ts`: the inspector is now mounted from inspector.ts; `paintHead` / `paintInspector` / `paintStrip` / `paintNow` only delegate. The left panel code (`makeCard`, `syncCard`, `paintCard`, rail markup) was not touched.
- URL hash params added: `cm` (chart metric), `cd` (duration), `det` (details), `sky`, `ss` (sky scale), `rm` (render mode).
- Decisions on the doc's open questions: Q3 power = visible fraction of the Sun's disk (vertical Sun-tracking panel), default mission 14 d. Badges: Power OK if the battery never drops below 20%, Marginal if it dips but does not empty, No if it empties; Comms OK if the longest gap without contact is 24 h or less, Gaps if longer, No if none.
