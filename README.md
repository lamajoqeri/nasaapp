# Southern-Luna

**Compare lunar landing sites and dates in seconds.** Pick a site and a date and see where the Sun and Earth sit relative to the real terrain horizon, how long until sunset and Earthset, how much power and direct-to-Earth communication the site gets, and what happens when the landing slips by a few weeks.

Built for the NASA Space Apps Challenge 2026, *Lunar Landing Site Navigator*.

- Runs entirely in the browser. No account, and no backend except one optional function that relays the assistant's calls on Vercel.
- Any coordinate on the Moon. 20 m terrain at the south pole's candidate regions, coarser terrain elsewhere.
- The Sun and Earth geometry, the terrain horizons and the shadow predictions are checked against NASA sources, and the checks are in this repo.

## What is in the app

- **3D terrain stage.** Five south-pole regions rendered in real 3D from 20 m LOLA terrain, with shadows traced toward the Sun through the terrain out to 300 km. Press play and the shadows sweep across a lunar day. Two render modes: Realistic (black shadows) and Clear (shadows lifted so relief stays readable). "Stand at site" puts the camera on the mast with the Sun and Earth on the real horizon. Click the terrain to place a site.
- **Scenarios.** Up to four site-and-date combinations, A to D: any catalogue site (Artemis candidate regions, flown and planned CLPS landers, Chandrayaan-3, SLIM, Chang'e 3 to 6, Apollo 11 to 17) or any coordinate, picked from a list, typed, clicked on the map or the 3D terrain, or nudged 50 to 500 m at a time.
- **Assistant.** A chat panel where Claude operates the app through the same controls a person uses: it can add and move scenarios, change dates, set a schedule slip, open the comparison and read the results back. On Vercel it uses the site owner's key through a small function; elsewhere it needs the user's own Anthropic API key, kept only in the browser. Everything else works without it.
- **Timeline.** One lane per scenario on a shared 29.5-day axis: sunlight above, Earth visibility below. A schedule slip of up to 60 days recomputes every scenario for the later date and draws it as a ghost lane.
- **Inspector.** Horizon panorama (terrain silhouette with Sun and Earth tracks); a chart of solar power or Sun elevation above the terrain for every scenario; a windows bar showing when each site is sunlit, has Earth in view, and has Deep Space Network contact; a Power and a Comms verdict with the thresholds stated; and the raw figures (time to sunset and Earthset, sunlit share, longest darkness, battery survival) behind a Details button.
- **Sky view.** An all-sky chart from the site: the terrain as a band around the edge, the Sun's and Earth's paths over the mission, dashed where terrain hides them, with a "horizon zoom" scale because at the pole everything happens within a few degrees of the horizon.
- **Compare.** One table, scenarios side by side, best value marked in each row, with the change under each value when a slip is set.
- **Map.** South-pole and whole-Moon maps with shading layers for NASA's average sunlight and Earth visibility, permanently shadowed regions, elevation and slope.
- **Science context.** Each scenario reports the distance to the nearest permanently shadowed region, the cold traps where water ice can survive and the reason missions go to the south pole.
- **Hand-off to the expert tools.** Each scenario links to the same spot in LROC QuickMap and NASA Moon Trek.
- **Report.** "Generate report" writes up the current scenarios as a research paper: data, methods, results, a comparison of real LRO photos against our predicted shadows, every validation number below, and the known limits. It prints or saves as PDF.
- Scenarios, slip, view and chart settings are stored in the URL, so a link reproduces the screen.

### How this answers the challenge

| The brief asks for | Where it is |
|---|---|
| Curated sites (Apollo, CLPS, other programmes) and custom coordinates | Scenario editor, map, 3D click-to-place; 25 catalogue sites |
| Side-by-side comparison of sites and dates | Up to four scenarios; timeline lanes, overlaid charts, Compare table |
| Date and time flexibility; seasons | Landing date per scenario, 12-month strip, schedule-slip slider |
| Sun and Earth relative to the horizon; time to sunset and Earthset | Horizon panorama, sky view, "Stand at site" 3D camera, status sentence and Details |
| Solar elevation, duration of sunlight, Earth visibility windows; is it viable | Sun-elevation and power charts, windows bar, Power and Comms verdicts |
| 2D maps and 3D surface | Map with shading layers; 3D terrain with traced shadows |
| Animation over a lunar day | Play button drives shadows, panorama, sky view and playhead together |
| Mission planners, educators and the public | Numbers with uncertainty and validation for planners; plain-language explainer, status sentences and the assistant for everyone else |
| Real topography, no atmosphere, libration | LOLA terrain horizon with exact curvature and no refraction; Earth's libration comes from the JPL lunar orientation model |
| Why small location or date changes matter | 100 m nudge buttons and the slip slider show it directly |

### Resources named in the challenge

| Resource | How this project uses it |
|---|---|
| Lunar Orbiter Laser Altimeter (LOLA) | The terrain behind every number. The horizon at any point is traced through LOLA elevation models: 20 m and 80 m grids at the south pole, the global LDEM elsewhere. |
| JPL Horizons | Independent check of our Sun and Earth directions (5 sites x 20 dates, max error 0.00012 deg). Positions themselves come from the same DE440 ephemeris through SPICE. |
| LROC QuickMap | Linked, not a data source. Details has an "Explore this spot in LROC QuickMap" link that opens the selected site there; the LRO photos in our shadow comparison come from the same LROC archive. |
| NASA Moon Trek | Linked, not a data source. The same Details line opens the selected site in Moon Trek for further exploration once the comparison here has narrowed the choice. |
| CSA Moon exploration | Background on partner missions. CSA's first lunar rover was aimed at the south pole (its page now lists the project as ended) and no landing coordinates were published, so it is not in the site catalogue. The lander it was booked on, Firefly Blue Ghost Mission 4, targets the Haworth rim area, which the catalogue's Haworth site covers. |

## How it works

```
offline (Python, prep/)                         browser (TypeScript, web/)
LOLA elevation models  -> terrain tiles    ->   horizon from the site in 720 directions, out to 300 km
JPL DE440 ephemeris    -> Sun/Earth table  ->   Sun and Earth azimuth/elevation at any time, 2024-2040
LRO photos, NASA maps  -> validation files ->   visible Sun fraction, Earth visibility, timelines, comparisons
```

1. **Terrain horizon.** From the site (plus mast height) we walk outward along 720 azimuths, sampling the elevation model, and keep the highest terrain angle in each direction. Geometry is done in 3D Moon-fixed coordinates, so lunar curvature and the "which way is north at the pole" problem are handled exactly.
2. **Sun and Earth.** Positions come from a table computed with NAIF SPICE (DE440, lunar mean-Earth frame), which includes the Moon's libration: this is what makes Earth rise and set at polar sites. The site's own position is subtracted, which matters for Earth (0.26 deg of parallax).
3. **Power and comms.** The Sun is a disk, not a point: we report the visible fraction of the disk above the terrain. Earth counts as visible when its centre clears the terrain. Deep Space Network station visibility is layered on top.
4. **Uncertainty.** The elevation model has errors. We perturb the horizon accordingly and report a spread on the results. The size and correlation of the perturbation are calibrated against NASA's own Monte-Carlo terrain realisations.

`CONTRACT.md` is the exact specification (frames, formulas, file formats). `prep/geom.py` is the reference implementation that the web app mirrors.

## How do we know it is right

All of this is reproducible with the scripts in `prep/`; results are stored in `web/public/data/`.

| Check | Result | Script |
|---|---|---|
| Sun and Earth direction vs JPL Horizons, 5 sites x 20 dates | max error 0.00002 deg (Sun), 0.00012 deg (Earth) | `validate.py` |
| Fast horizon search vs brute-force 10 m search | misses at most 0.04 deg | `validate.py` |
| Fraction of time Sun / Earth visible vs NASA PGDA maps (Mazarico et al. 2011), 300 random points near Shackleton | mean error 1.5% (Sun, r = 0.96), 0.9% (Earth, r = 0.99) | `validate.py` |
| Same, 60 points in each of the other four 20 m regions (rays cross into the coarse far-field terrain) | Sun 1.0-1.5%, Earth 0.6-2.4% | `validate.py` |
| Same, 60 points where only 240 m terrain is available | Sun 3.3% (r = 0.83), Earth 1.6% | `validate.py` |
| Sun elevation at the Apollo 11 touchdown | 10.70 deg (historical value 10.8 deg) | `checks.py` |
| Predicted shadows vs real LRO NAC photos | see below | `bench.py` |
| Uncertainty model vs NASA Monte-Carlo terrain realisations (tuned on 30, tested on 30 others) | on the held-out set: horizon spread 0.052 deg (NASA) vs 0.046 deg (ours); spread of yearly % lit 0.24% (NASA) vs 0.16% (ours), so our bands are about 1.5x too narrow; mean yearly % lit 86.1% (NASA) vs 86.5% (ours) | `calib.py` |

### Shadows against real photos

We predict the shadow map at the moment each LRO Narrow Angle Camera photo was taken and compare it with the photo (shadow intersection-over-union, IoU).

| Model | 2 photos with known capture time | 13 photos, capture time identified by best match |
|---|---|---|
| Smooth sphere (no terrain) | 0.00 | 0.00 |
| 240 m terrain only | 0.51 | 0.89 |
| Local slope only, no cast shadows | 0.60 | 0.79 |
| **This project: 20 m terrain + far field to 300 km** | **0.70** | **0.96** |

Read these with their limits:
- All photos are from 22 Sep to 11 Oct 2010 near Shackleton crater: one season, three Sun directions.
- For the 2 known-time photos, the product uses the same pixel value for "no data" and "deep shadow". We had to assume the large dark area on the southern edge is shadow. That set is mostly sunlit ground with small shadows, which is why its scores are lower.
- For the other 13, the archive does not record which of 7-8 listed observations each photo came from. We picked the best-matching one for every model separately. We tested that selection on the 2 known-time photos: it finds the right date decisively (IoU 0.46 vs 0.10-0.13 for wrong dates) but cannot tell observations on the same day apart, and picked the wrong same-day observation for one of the two. So the date is established, the exact observation is not; the same-day choice moves IoU by about 0.01.
- Comparing illumination models with LRO photos is established practice (Mazarico et al. 2011, De Rosa et al. 2012, Gläser et al. 2014). This is our check of our own model, not a new benchmark.

## Known limits

- 20 m terrain exists for five south-pole regions (Shackleton / Connecting Ridge, Mons Mouton / Nobile, Malapert, Haworth, de Gerlache). The rest of 80S-90S uses 240 m terrain, and the rest of the Moon about 3.8 km, so horizons there are smoother than reality.
- At the pole, results change over tens of meters. Moving a site 100 m can change Earth visibility from 0% to 50% of the time. A coordinate typed to two decimals is not a landing site.
- Earth visibility uses Earth's centre. NASA's published maps count any part of Earth's disk (0.95 deg radius), so their percentages are higher.
- The uncertainty bands cover elevation-model error near the site only, were calibrated at one site, and came out about 1.5x narrower than NASA's own terrain realisations imply on held-out data. Treat them as a lower bound. The offset between our 20 m result and the 5 m terrain (0.1-0.4% of yearly illumination here) is larger than the band itself.
- Permanent-shadow data covers only the area poleward of about 85°S, counts regions of at least 0.1 km², and comes from NASA's 60 m long-term simulation, not from our own horizon engine. Distances are good to about 0.1 km.
- The ephemeris table covers 2024-2040 (plus 1969-1972 for the Apollo landings).
- Power is the visible fraction of the solar disk (terrain and Earth eclipses taken out) for a Sun-tracking panel. No thermal model, no link budget.
- The battery model and the Deep Space Network table are simple and have unit tests only; they are not validated against an external source. The DSN table uses a 10 deg elevation mask and a simplified Earth rotation model.

## Run it

Web app (needs Node 20+):

```
cd web
npm install
npm run dev      # local dev server
npm test         # core tests against the fixtures
npm run build    # static site in web/dist
```

The site is static: `web/dist` can be hosted anywhere. `.github/workflows/pages.yml` builds, tests and deploys it to GitHub Pages on every push to `main` once a repo admin sets Settings > Pages > Source to "GitHub Actions".

### Deploy on Vercel

On Vercel, visitors can use the assistant without a key: `web/api/v1/messages.ts` is a Vercel Function that forwards the app's Claude calls with the owner's key. The app checks for it on first use (`GET /api/v1/messages`). Where it is missing (GitHub Pages, `npm run dev`) the app falls back to the paste-a-key form. A visitor who already saved a key of their own keeps using it.

1. Import the repo in Vercel with Root Directory `web`. Vercel detects the Vite preset (`npm run build`, output `dist`).
2. Settings > Environment Variables: add `ANTHROPIC_API_KEY` for Production (and Preview if you want it there), then redeploy. Do not add a `VITE_` prefix: Vite copies `VITE_*` variables into the public JavaScript.
3. In the Anthropic Console, create the key in a workspace of its own and set a monthly spend limit on that workspace. The limits below make abuse slower; that spend limit is the real hard cap.

The function forwards only `POST /v1/messages` with `claude-opus-5-5`, `max_tokens` up to 16000, the fields and tools the app sends (no server tools, no fast mode) and bodies up to 1 MB. It allows 60 calls per IP address per hour (an agent turn is one call per round of tool calls). The count is kept in memory, so the limit applies per function instance: traffic spread over several instances, or a redeploy, starts new counts. For one global limit, add a Vercel Firewall rate-limit rule on `/api/v1/messages`, or keep the counter in Upstash Redis from the Vercel Marketplace. `web/vercel.json` sets the function's maximum duration to 300 s (the Hobby maximum; Pro allows up to 800) and stops the upstream call when the visitor presses Stop.

Everything the app needs is already in `web/public/data/`. To rebuild the data from the original NASA files (needs [uv](https://docs.astral.sh/uv/), about 350 MB of downloads):

```
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python numpy scipy spiceypy rasterio scikit-image pillow requests
sh prep/download.sh                 # SPICE kernels, LOLA DEMs, PGDA maps
.venv/bin/python prep/ephem.py      # Sun/Earth tables
.venv/bin/python prep/dem.py        # terrain tiles (reads 20 m windows over HTTP)
.venv/bin/python prep/dsn.py        # Deep Space Network visibility
.venv/bin/python prep/maps.py       # base maps
.venv/bin/python prep/psr.py        # permanently shadowed regions layer and distance field
.venv/bin/python prep/fixture.py    # synthetic test fixture
.venv/bin/python prep/checks.py     # 10 s regression checks
.venv/bin/python prep/validate.py   # Horizons + PGDA validation (3 min)
.venv/bin/python prep/calib.py      # uncertainty calibration (5 min, network)
.venv/bin/python prep/bench.py      # LRO photo comparison (15 min; photos listed in the script)
```

## Data and credits

| Data | Used for | Source |
|---|---|---|
| LOLA south pole elevation models, 20 m and 80 m, with error maps (Barker et al. 2023) | Terrain, uncertainty | NASA GSFC PGDA, product 90: https://pgda.gsfc.nasa.gov/products/90 |
| LOLA 5 m site models and Monte-Carlo realisations (Barker et al. 2021) | Uncertainty calibration | NASA GSFC PGDA, product 78: https://pgda.gsfc.nasa.gov/products/78 |
| LOLA global elevation model LDEM_16 | Terrain outside the south pole | NASA PDS Geosciences Node: https://pds-geosciences.wustl.edu/missions/lro/lola.htm |
| Average illumination and Earth visibility maps (Mazarico et al. 2011) | Validation, site suggestions, map overlays | NASA GSFC PGDA, product 69: https://pgda.gsfc.nasa.gov/products/69 |
| Permanently shadowed regions map (Mazarico et al. 2011) | Permanent-shadow map layer; distance from each site to the nearest shadowed region of at least 0.1 km² | NASA GSFC PGDA, product 69 (LPSR_85S_060M) |
| LROC NAC DTM orthoimages (SHACKRDGE02, ESALL_CR1, ESALL_SR12) | Shadow comparison | NASA/GSFC/Arizona State University, LROC PDS archive: https://data.lroc.im-ldi.com/ |
| DE440 ephemeris, lunar orientation and frame kernels | Sun and Earth positions | NASA JPL NAIF: https://naif.jpl.nasa.gov/naif/data.html |
| JPL Horizons | Validation of Sun and Earth directions | NASA JPL SSD: https://ssd.jpl.nasa.gov/horizons/ |
| PDS Geosciences Orbital Data Explorer | Finding the orthoimages | https://ode.rsl.wustl.edu/moon/ |

Site coordinates: Apollo and robotic landers from NASA/LROC and public mission records; Artemis-type south-pole sites are the best-lit point within 3 km of each region's PGDA study tile, not official landing coordinates.

NASA does not endorse this project.

## Use of AI

This project was built with AI coding assistance (Claude, via Claude Code) for planning, code and documentation. All numerical results above come from running the scripts in this repository against the listed NASA data.
