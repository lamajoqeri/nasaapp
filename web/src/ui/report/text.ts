// Sections of method and context: introduction, data, methods, discussion and limitations, references.
// Numbers come from the code's constants and the shipped data files (text-data.ts), so the text follows them.
import './text.css';
import { DEFAULT_POWER } from '../../core/extra';
import { NAZ, schedule } from '../../core/geom';
import { SMOOTH_DEG } from '../../core/mc';
import { COMMS_MAX_GAP_H, POWER_RESERVE } from '../charts';
import { coord, utc } from '../format';
import { chip, esc, section, table } from './dom';
import { cite, REFS } from './refs';
import { load, span, tileAt, tileRes, type Data, type Tile } from './text-data';
import type { ReportScenario, SectionFn } from './types';

const REGION: Record<string, string> = {
  shackleton_20m: 'Shackleton / Connecting Ridge', mouton_nobile_20m: 'Mons Mouton / Nobile', malapert_20m: 'Malapert',
  haworth_20m: 'Haworth', degerlache_20m: 'de Gerlache',
};
const DRAWS = 64;   // monteCarlo() default in core/mc.ts
const DSN_MASK = 10; // deg, prep/dsn.py

const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const pts = (x: number, d = 1) => (x * 100).toFixed(d); // fraction -> percentage points
const eq = (html: string) => `<p class="r-eq"><span>${html}</span></p>`;
const p = (html: string) => `<p>${html}</p>`;
const lead = (title: string, html: string) => `<p><strong>${title}.</strong> ${html}</p>`;
const v = (x: string) => `<b>${x}</b>`; // vector
const is20 = (t?: Tile) => t?.proj === 'spstere' && t.px === 20;

/** "Scenario A Name" / "Scenarios A Name and B Name", with chips. */
function scen(list: ReportScenario[]): string {
  const names = list.map((s) => `${chip(s.letter, s.color)}&nbsp;${esc(s.name)}`);
  const joined = names.length < 2 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${list.length > 1 ? 'Scenarios' : 'Scenario'} ${joined}`;
}
const verb = (list: unknown[], one: string, many: string) => (list.length > 1 ? many : one);

function terrainOf(t: Tile | undefined): string {
  if (!t) return 'no terrain tile';
  if (is20(t)) return `the 20 m ${esc(REGION[t.id] ?? t.id)} window`;
  if (t.proj === 'spstere') return `${t.px} m south-polar terrain`;
  return `global terrain only (${(tileRes(t) / 1000).toFixed(1)} km pixels)`;
}

function ranges(d: Data) {
  const [m0, m1] = span(d.ephem), a = d.apollo ? span(d.apollo) : null;
  return { m0, m1, a, text: `${day(m0)} to ${day(m1)}${a ? `, plus ${day(a[0])} to ${day(a[1])} for the Apollo landings` : ''}` };
}

/* ------------------------------------------------------------------ introduction */

export const introSection: SectionFn = async (ctx) => {
  const d = await load(ctx.dataBase), r = ranges(d), n = ctx.scenarios.length;
  const list = ctx.scenarios.map((s) => `${chip(s.letter, s.color)}&nbsp;${esc(s.name)} (landing ${utc(s.sc.spec.t)})`);
  const listed = list.length < 2 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  return section('intro', 'Introduction', [
    p(`A lander near the lunar south pole depends on two lines of sight: one to the Sun, for solar power, and one to Earth, for direct-to-Earth communication. NASA's Artemis programme plans crewed landings in this region and has named nine candidate landing regions for Artemis III ${cite('artemis2024')}. Some ridges and crater rims there see the Sun for most of the year, and the permanently shadowed craters next to them can hold water ice ${cite('mazarico2011')}.`),
    p(`The same geometry makes the pole hard to plan for. The Moon's equator is tilted only about 1.5° to the ecliptic, so near the pole the Sun never climbs more than a few degrees above a level horizon (about 1.6° at the pole itself) and circles the sky once every 29.5-day lunar day. A ridge tens of kilometres away can hide it for days. Earth stays low as well: the Moon's libration moves it several degrees up and down over each month, so at many polar sites it rises and sets on its own cycle. At such grazing angles small changes matter. Moving a site 100 m can change the share of time Earth is in view from 0% to 50%, and a delay of a few weeks can move a landing from a lit, Earth-facing stretch into darkness or radio silence.`),
    p(`Illumination at the lunar poles has been modelled from Lunar Orbiter Laser Altimeter (LOLA) topography ${cite('smith2010')} and compared with orbital images in several studies ${cite('mazarico2011', 'derosa2012', 'glaser2014')}. Southern-Luna applies the same kind of model as a planning tool. For any point on the Moon and any hour from ${r.text}, it finds where the Sun and Earth stand relative to the terrain horizon seen from a lander's mast. From that it derives the visible fraction of the solar disk (power), whether Earth is in view (direct-to-Earth communication), contact with the Deep Space Network, a battery state of charge, and an uncertainty from the terrain model. All computation runs in the browser, from files precomputed from NASA data.`),
    p(`This report applies the method to ${n === 1 ? 'one scenario' : `${n} scenarios`}: ${listed}. Each is followed hourly for 29.5 days from its landing time; the verdicts use the first ${ctx.missionDays} days${ctx.slip ? `, and every scenario is repeated with the landing delayed by ${ctx.slip} days` : ''}.${ctx.skipped.length ? ` ${ctx.skipped.length > 1 ? 'Scenarios' : 'Scenario'} ${esc(ctx.skipped.join(', '))} had no results when the report was generated and ${ctx.skipped.length > 1 ? 'are' : 'is'} left out.` : ''} The following sections describe the data and the method, present the results, compare the method with independent NASA sources and state what the numbers do not cover.`),
  ].join(''));
};

/* ------------------------------------------------------------------ data */

export const dataSection: SectionFn = async (ctx) => {
  const d = await load(ctx.dataBase), r = ranges(d);
  const t20 = d.tiles.filter(is20), sp = d.tiles.find((t) => t.proj === 'spstere' && !is20(t)), g = d.tiles.find((t) => t.proj === 'eqc');
  const wins = t20.map((t) => `${esc(REGION[t.id] ?? t.id)} (${(t.w * t.px!) / 1000} × ${(t.h * t.px!) / 1000} km)`).join(', ');
  const sig = t20.map((t) => t.sigma_h), polar = d.sites.filter((s) => /best-lit point/i.test(s.note)).length;
  const RES = 'results', CHK = 'check';
  const cal = d.cal, half = cal.window_half_m;
  const HEAD = ['Dataset', 'Provider', 'Resolution and coverage', 'Used here for'];
  const rows: string[][] = [
    [`LOLA south-pole elevation model, 20 m (LDEM_80S_20MPP_ADJ), with its height-error map ${cite('barker2023')}`, 'NASA GSFC PGDA, product 90',
      `20 m; ${t20.length} windows: ${wins}`, `Terrain near the site. The error map's median × 1.5 is the height uncertainty σ<sub>h</sub> (${Math.min(...sig)}–${Math.max(...sig)} m).`, RES],
    [`LOLA south-pole elevation model, 80 m (LDEM_80S_80MPP_ADJ) ${cite('barker2023')}`, 'NASA GSFC PGDA, product 90',
      `Averaged to ${sp?.px} m; 80°S to the pole`, `Terrain within 80°S outside the 20 m windows, including the far field of every polar site. σ<sub>h</sub> = ${sp?.sigma_h} m, assumed.`, RES],
    [`LOLA global elevation model LDEM_16 ${cite('ldem16', 'smith2010')}`, 'NASA PDS Geosciences Node',
      `16 px/deg averaged to ${g?.ppd} px/deg (${g ? (tileRes(g) / 1000).toFixed(1) : '?'} km); whole Moon`, `Terrain everywhere else. σ<sub>h</sub> = ${g?.sigma_h} m, assumed.`, RES],
    [`DE440 planetary ephemeris and lunar orientation, with frame and time kernels ${cite('de440', 'spice')}`, 'NASA JPL NAIF',
      `Kernels ${d.ephem.kernels.map((k) => `<code>${esc(k)}</code>`).join(', ')}. Tabulated hourly, ${r.text}`, 'Sun and Earth directions, including the Moon\'s libration', RES],
    [`Deep Space Network visibility table (this work, <code>prep/dsn.py</code>) ${cite('dsn')}`, 'Computed with SPICE from DE440 and the coordinates of the three complexes',
      `Hourly, ${day(r.m0)} to ${day(r.m1)}`, `Hours in which a complex sees the Moon more than ${DSN_MASK}° above its horizon`, RES],
    [`Permanently shadowed regions map, LPSR_85S_060M ${cite('mazarico2011')}`, 'NASA GSFC PGDA, product 69',
      '60 m; poleward of 85°S', `Distance from the site to the nearest permanently shadowed region of at least ${d.psr.min_area_km2} km²`, RES],
    ['Site catalogue (this work, <code>sites.json</code>)', 'Public mission records; polar points placed with PGDA product 69',
      `${d.sites.length} sites: south-pole Artemis candidate regions, CLPS landers (flown and planned), Chandrayaan-3, SLIM, Chang'e 3–6, Apollo 11–17`,
      `Named sites and touchdown times (UTC). The ${polar} polar points are the best-lit pixel within 3 km of each region's study tile, not official landing coordinates.`, RES],
    [`Average Sun and Earth visibility maps, AVGVISIB_85S_060M ${cite('mazarico2011')}`, 'NASA GSFC PGDA, product 69',
      '60 m; poleward of 85°S; hourly over 18.6 years; a body counts as visible when any part of its disk is', 'Validation of our visibility fractions. Also placed the polar catalogue sites and shades the map; never an input to a computed number.', CHK],
    [`LOLA 5 m site model and Monte Carlo realisations ("clones"), Site01 ${cite('barker2021')}`, 'NASA GSFC PGDA, product 78',
      `5 m; a ${(2 * half) / 1000} km square at the Connecting Ridge; 100 clones per site, ${cal.clone_ids[1]} used`,
      `Set the two constants of the uncertainty model (clones 1–30) and tested it (clones ${cal.clone_ids[0]}–${cal.clone_ids[1]})`, CHK],
    [`LROC Narrow Angle Camera DTM orthoimages: SHACKRDGE02 (3.5 m), ESALL_CR1 and ESALL_SR12 (2 m) ${cite('lroc')}`, 'NASA/GSFC/Arizona State University, LROC PDS archive',
      `${d.bench.images.length} images near Shackleton crater, 22 Sep to 11 Oct 2010`, 'Predicted shadows compared with the photos', CHK],
    [`JPL Horizons ${cite('horizons')}`, 'NASA JPL Solar System Dynamics',
      `${d.val.horizons.n} Sun and ${d.val.horizons.n} Earth directions (5 sites × 20 dates)`, 'Independent check of our Sun and Earth directions', CHK],
  ];
  const at = ctx.scenarios.map((s) => `<li>${chip(s.letter, s.color)}&nbsp;${esc(s.name)}: ${terrainOf(tileAt(d.tiles, s.sc.spec.lat, s.sc.spec.lon))}.</li>`).join('');
  return section('data', 'Data', [
    p('Two tables list every dataset this report relies on. The first holds the data that enter the computed numbers. The second holds data used only to check the method; their outcomes are in the Validation section. Of those, the 5 m realisations also set the two constants of the uncertainty model (Methods).'),
    table('Data used to compute the results.', HEAD, rows.filter((x) => x[4] === RES).map((x) => x.slice(0, 4)), 'r-datatab'),
    table('Data used only to check the method.', HEAD, rows.filter((x) => x[4] === CHK).map((x) => x.slice(0, 4)), 'r-datatab'),
    p('Not used as data: the LRO photos were found with the PDS Geosciences Orbital Data Explorer (<a class="r-link" href="https://ode.rsl.wustl.edu/moon/" target="_blank" rel="noopener">ode.rsl.wustl.edu</a>); the app links each scenario to the same spot in LROC QuickMap and NASA Moon Trek (<a class="r-link" href="https://trek.nasa.gov/moon/" target="_blank" rel="noopener">trek.nasa.gov</a>) for further exploration; and the Canadian Space Agency\'s Moon exploration pages (<a class="r-link" href="https://www.asc-csa.gc.ca/eng/astronomy/moon-exploration/" target="_blank" rel="noopener">asc-csa.gc.ca</a>) gave background on partner missions.'),
    p(`Heights come from the finest tile that contains each point. A site inside a 20 m window therefore still sees distant ridges through the ${sp?.px ?? 240} m and global terrain. The terrain at each scenario's site is:`),
    `<ul>${at}</ul>`,
    '<h3>Data and code availability</h3>',
    p(`This report was generated from the app state at <a class="r-link" href="${esc(ctx.link)}" target="_blank" rel="noopener">${esc(ctx.link)}</a>. Opening the link restores the same scenarios, dates, masts and settings, so every number here can be reproduced.`),
    p('Every data file the app reads is in <code>web/public/data/</code> and is regenerated from the original NASA files by the scripts in <code>prep/</code>: <code>download.sh</code> fetches the inputs; <code>ephem.py</code>, <code>dem.py</code>, <code>dsn.py</code>, <code>maps.py</code>, <code>psr.py</code> and <code>sites.py</code> write the tables, tiles and maps; <code>checks.py</code>, <code>validate.py</code>, <code>calib.py</code> and <code>bench.py</code> write the checks. The site list itself is curated by hand. <code>CONTRACT.md</code> specifies the frames, formulas and file formats, and <code>prep/geom.py</code> is the reference implementation that the browser code is tested against.'),
  ].join(''));
};

/* ------------------------------------------------------------------ methods */

export const methodsSection: SectionFn = async (ctx) => {
  const d = await load(ctx.dataBase), r = ranges(d), steps = schedule().length;
  const masts = [...new Set(ctx.scenarios.map((s) => s.sc.spec.mast))];
  const mastText = masts.length === 1 ? `${masts[0]} m for every scenario here` : ctx.scenarios.map((s) => `${s.letter}: ${s.sc.spec.mast} m`).join(', ');
  const t20 = d.tiles.filter(is20), sp = d.tiles.find((t) => t.proj === 'spstere' && !is20(t)), g = d.tiles.find((t) => t.proj === 'eqc');
  const sig = t20.map((t) => t.sigma_h), bins = Math.round(SMOOTH_DEG / (360 / NAZ));
  const lo = bins - 1 - Math.floor(bins / 2), hi = Math.floor(bins / 2);
  const P = DEFAULT_POWER;
  return section('methods', 'Methods', [
    '<h3>Terrain horizon</h3>',
    p(`For each site we compute the terrain horizon: the highest elevation angle of the terrain in each of ${NAZ} azimuths, every ${360 / NAZ}°, clockwise from local north. All geometry is done in 3D Moon-fixed coordinates (the MOON_ME frame of the LOLA products) on a sphere of radius <i>R</i> = 1737.4 km, with the LOLA height <i>h</i> above it. The observer stands on the terrain plus a mast of height <i>m</i> (${mastText}). Along each azimuth α the walk follows the great circle from the site and samples the terrain at distances`),
    eq('<i>d</i><sub>0</sub> = 10 m, &nbsp; <i>d</i><sub><i>k</i>+1</sub> = <i>d<sub>k</sub></i> + min(max(0.02 <i>d<sub>k</sub></i>, 10 m), 240 m), &nbsp; <i>d<sub>k</sub></i> ≤ 300 km'),
    p(`that is 10 m steps out to 500 m, steps of 2% of the distance out to 12 km and 240 m steps beyond: ${steps.toLocaleString('en-US')} samples per azimuth, about one million per site. With ${v('u')}, ${v('n')} and ${v('e')} the local up, north and east unit vectors at the site, the sample point and its elevation angle are`),
    eq(`${v('p')} = cos(<i>d</i>/<i>R</i>) ${v('u')} + sin(<i>d</i>/<i>R</i>) (cos α ${v('n')} + sin α ${v('e')}), &nbsp; ${v('P')} = (<i>R</i> + <i>h</i>(${v('p')})) ${v('p')}`),
    eq(`${v('S')} = (<i>R</i> + <i>h</i><sub>site</sub> + <i>m</i>) ${v('u')}, &nbsp; ${v('w')} = ${v('P')} − ${v('S')}, &nbsp; ε<sub><i>k</i></sub> = atan2(${v('w')}·${v('u')}, √(|${v('w')}|² − (${v('w')}·${v('u')})²)), &nbsp; <i>H</i>(α) = max<sub><i>k</i></sub> ε<sub><i>k</i></sub>`),
    p(`Heights are bilinear samples of the finest tile that contains the point (Data). Because the geometry is 3D, the Moon's curvature is exact. At 300 km the surface lies about 26 km below the site's level plane, more than the Moon's total relief of about 20 km, so no terrain beyond the walk can reach the horizon; extending the walk to 1,500 km at all 25 catalogue sites changed no horizon (0.0000°). The Moon has no atmosphere, so no refraction is applied. Between azimuths the horizon is interpolated linearly. A brute-force walk in 10 m steps all the way out finds at most ${d.val.dense_march.max_missed_deg.toFixed(2)}° of horizon that this schedule misses.`),

    '<h3>Sun and Earth positions</h3>',
    p(`Sun and Earth positions come from a table computed with NAIF SPICE ${cite('spice')} from the DE440 ephemeris and its lunar orientation model ${cite('de440')}. Each row holds the vectors from the Moon's centre to the Sun and to Earth in MOON_ME, corrected for light time and stellar aberration (LT+S), one row per hour from ${r.text}. Between rows the vectors are interpolated linearly. The orientation model includes the Moon's physical libration, which is what makes Earth rise and set at polar sites. For a body at Moon-centred position ${v('r')}<sub>b</sub>, the azimuth and elevation seen from the site are`),
    eq(`${v('w')}<sub>b</sub> = ${v('r')}<sub>b</sub> − ${v('S')}, &nbsp; <i>A</i><sub>b</sub> = atan2(${v('w')}<sub>b</sub>·${v('e')}, ${v('w')}<sub>b</sub>·${v('n')}), &nbsp; ε<sub>b</sub> = asin(${v('w')}<sub>b</sub>·${v('u')} / |${v('w')}<sub>b</sub>|)`),
    p(`Subtracting the site position matters for Earth, whose parallax is about 0.26°. The directions are checked against JPL Horizons ${cite('horizons')} in the Validation section.`),

    '<h3>Sunlight and power</h3>',
    p('The Sun is a disk of angular radius ρ, about 0.27°. Near the pole it moves almost parallel to the horizon, so the horizon is treated as a straight line across the disk at the height <i>H</i>(<i>A</i><sub>☉</sub>) interpolated at the Sun\'s centre. The visible fraction <i>f</i> of a uniform disk whose centre stands ε<sub>☉</sub> − <i>H</i>(<i>A</i><sub>☉</sub>) above that line is'),
    eq(`ρ = asin(<i>R</i><sub>☉</sub> / |${v('w')}<sub>☉</sub>|), &nbsp; <i>x</i> = clamp((ε<sub>☉</sub> − <i>H</i>(<i>A</i><sub>☉</sub>)) / ρ, −1, 1)`),
    eq('<i>f</i> = 1 − (arccos <i>x</i> − <i>x</i> √(1 − <i>x</i>²)) / π'),
    p('with <i>R</i><sub>☉</sub> = 695,700 km. <i>f</i> is 0 when the whole disk is hidden, ½ when its centre sits on the horizon and 1 when it is clear. Limb darkening is ignored. Power is taken as proportional to <i>f</i>, as for a solar panel that tracks the Sun: available power = <i>f</i> × rated output.'),

    '<h3>Earth visibility and Deep Space Network contact</h3>',
    p(`Earth counts as visible when its centre clears the terrain:`),
    eq('ε<sub>⊕</sub> − <i>H</i>(<i>A</i><sub>⊕</sub>) &gt; 0'),
    p(`Earth's disk is about 0.95° in radius, so this rule is stricter than the any-part-of-the-disk rule of NASA's published visibility maps ${cite('mazarico2011')}, and our Earth percentages are lower than theirs. A radio link also needs a ground station. For every hour from ${day(r.m0)} to ${day(r.m1)} a table records which Deep Space Network complexes ${cite('dsn')} (Goldstone, Madrid, Canberra) see the Moon's centre more than ${DSN_MASK}° above their local horizon, computed with SPICE in Earth's body-fixed frame from the stations' geodetic coordinates. At least one complex is up 98.7% of the time, so the table mostly says which one. An hour counts as contact when Earth is in view from the site and at least one complex sees the Moon. Outside the table, as for Apollo-era dates, there are no contact hours and the Comms verdict uses Earth in view alone.`),

    '<h3>Mission metrics and verdicts</h3>',
    p(`Each scenario is evaluated hourly for 29.5 days (708 steps) from its landing time. <em>Sunlit</em> is the mean of <i>f</i> over the window. <em>Longest dark</em> is the longest run of hours with <i>f</i> = 0. <em>Sunset in</em> is the time to the first hour with <i>f</i> = 0, or <em>sunrise in</em> the time to the first hour with <i>f</i> &gt; 0 if the site is dark at landing. <em>Earth in view</em> counts the hours with Earth visible, and <em>Earthset</em> and <em>Earthrise</em> are defined like sunset and sunrise. All times are resolved to the hour.`),
    p(`The battery model is a ${P.panelW} W Sun-tracking panel, a constant ${P.loadW} W load and a ${(P.capacityWh / 1000).toFixed(1)} kWh battery that starts full. Each hour <i>i</i>`),
    eq(`<i>E<sub>i</sub></i> = min(<i>C</i>, <i>E</i><sub><i>i</i>−1</sub> + (<i>P</i><sub>panel</sub> <i>f<sub>i</sub></i> − <i>P</i><sub>load</sub>) Δ<i>t</i>), &nbsp; <i>E</i><sub>0</sub> = <i>C</i> = ${P.capacityWh} Wh, &nbsp; Δ<i>t</i> = 1 h`),
    p(`and the lander is dead at the first hour with <i>E</i> ≤ 0. A full battery covers ${P.capacityWh / P.loadW} h of darkness, and it drains whenever less than ${Math.round((100 * P.loadW) / P.panelW)}% of the disk is visible.`),
    p(`Two verdicts summarise each scenario over the mission length chosen in the app (${ctx.missionDays} days here). <em>Power</em> is OK if the battery never falls below ${POWER_RESERVE * 100}% charge, Marginal if it dips below that but never empties, and No if it empties. <em>Comms</em> is OK if the longest stretch without contact is ${COMMS_MAX_GAP_H} h or less, Gaps if it is longer, and No if there is no contact at all. A stretch still running at either end of the mission counts with the length it has inside the mission.`),

    '<h3>Terrain-model uncertainty</h3>',
    p(`Elevation models have errors, and at grazing angles a small error in the height of a ridge moves the horizon. We propagate this in horizon space with a Monte Carlo of ${DRAWS} draws. The one-sigma error of the horizon at azimuth α is`),
    eq('σ<sub>ε</sub>(α) = atan(σ<sub><i>h</i></sub> / <i>d</i><sup>*</sup>(α))'),
    p(`where <i>d</i><sup>*</sup>(α) is the distance of the sample that set the horizon and σ<sub><i>h</i></sub> is the height error of the tile that sample came from: ${Math.min(...sig)}–${Math.max(...sig)} m for the 20 m windows (the median of the LOLA error map × 1.5), ${sp?.sigma_h} m for the ${sp?.px} m grid and ${g?.sigma_h} m for the global grid. Each draw <i>j</i> adds an offset that is correlated along the horizon:`),
    eq(`<i>H<sub>j</sub></i>(α<sub><i>i</i></sub>) = <i>H</i>(α<sub><i>i</i></sub>) + σ<sub>ε</sub>(α<sub><i>i</i></sub>) · (1/√${bins}) Σ<sub><i>k</i>=−${lo}…${hi}</sub> <i>g</i><sub><i>j</i>,<i>i</i>+<i>k</i></sub>, &nbsp; <i>g</i> ~ N(0, 1)`),
    p(`a moving sum of ${bins} independent unit normals (${SMOOTH_DEG}° of azimuth, wrapping at 360°), scaled to keep unit variance. The ${SMOOTH_DEG}° correlation length and the factor 1.5 were tuned so that both the per-azimuth horizon spread and the spread of yearly sunlit time match NASA's Monte Carlo terrain realisations at the Connecting Ridge (clones 1–30 of PGDA product 78 ${cite('barker2021')}), and were tested on clones ${d.cal.clone_ids[0]}–${d.cal.clone_ids[1]} (Validation). The height errors of the coarse grids are assumed, not calibrated. Every metric is recomputed for every draw. Tables give the mean over the draws ± their standard deviation; charts show the 10th to 90th percentile of <i>f</i> each hour, and the chance of light is the share of draws in which any of the Sun is visible. The random numbers are seeded, so a scenario always gives the same spread.`),

    '<h3>Distance to permanent shadow</h3>',
    p(`Permanently shadowed regions are where water ice can survive, so the distance to the nearest one is a site-selection number. We take NASA's 60 m map of permanent shadow poleward of 85°S ${cite('mazarico2011')}, group shadowed pixels into connected regions, keep those of at least ${d.psr.min_area_km2} km², and compute the straight-line distance from every point to the nearest kept region. The field is stored every 240 m and interpolated bilinearly, so distances are good to about 0.1 km. North of about 85°S there is no data.`),

    '<h3>Landing delay</h3>',
    p(`A landing delay of <i>N</i> days recomputes each scenario at the same site and mast from landing time + <i>N</i> days, without the Monte Carlo, and compares it with the deterministic values of the on-time run, so the two differ only in date. ${ctx.slip ? `This report uses <i>N</i> = ${ctx.slip}.` : 'No delay is set for this report.'}`),
  ].join(''));
};

/* ------------------------------------------------------------------ discussion and limitations */

export const limitsSection: SectionFn = async (ctx) => {
  const d = await load(ctx.dataBase), r = ranges(d), val = d.val, y = d.cal.pct_lit_year;
  const tile = (s: ReportScenario) => tileAt(d.tiles, s.sc.spec.lat, s.sc.spec.lon);
  const on240 = ctx.scenarios.filter((s) => tile(s)?.proj === 'spstere' && !is20(tile(s)));
  const onGlobal = ctx.scenarios.filter((s) => tile(s)?.proj === 'eqc');
  const coarse = [...on240, ...onGlobal];
  const fine = [val.pgda, ...Object.values(val.pgda_other_regions)].map((x) => x.sun.mae);
  const only240 = val.pgda_240m_only_region.sun;
  const apollo = r.a ? ctx.scenarios.filter((s) => s.sc.spec.t >= r.a![0] && s.sc.spec.t <= r.a![1]) : [];
  const noDsn = ctx.scenarios.filter((s) => s.sc.base?.mission.commsHours === null);
  const noPsr = ctx.scenarios.filter((s) => s.sc.base?.mission.psrM === null);
  const bare = ctx.scenarios.filter((s) => s.sc.spec.mast === 0);
  const slipFail = ctx.slip ? ctx.scenarios.filter((s) => s.sc.slipError) : [];
  const names = d.tiles.filter(is20).map((t) => esc(REGION[t.id] ?? t.id)).join(', ');
  const it = (l: unknown[]) => verb(l, 'it', 'them');

  return section('limits', 'Discussion and limitations', [
    p('The method is geometric. It says when the Sun and Earth stand above the terrain horizon of an elevation model. It does not say whether a lander stays warm, whether a radio link closes or whether the ground is safe to land on. Within that scope, these are the main limits.'),
    lead('Terrain detail', `20 m terrain exists for five south-pole windows (${names}). The rest of 80°S–90°S uses 240 m terrain and the rest of the Moon about 3.8 km, so horizons there are smoother than reality. Compared with NASA's maps, the fraction of time the Sun is visible differs by ${pts(Math.min(...fine))}–${pts(Math.max(...fine))} percentage points on average inside the 20 m windows, but by ${pts(only240.mae)} points (r = ${only240.r.toFixed(2)}) where only 240 m terrain is available.`
      + (on240.length ? ` ${scen(on240)} ${verb(on240, 'sits', 'sit')} on 240 m terrain, so ${verb(on240, 'its', 'their')} numbers carry this larger error.` : '')
      + (onGlobal.length ? ` ${scen(onGlobal)} ${verb(onGlobal, 'uses', 'use')} the global grid: hills and crater rims smaller than a few kilometres are missing, and the horizon there has not been checked against an independent source.` : '')),
    lead('Position', 'At the pole, results change over tens of metres. Moving a site 100 m can change Earth visibility from 0% to 50% of the time. A coordinate typed to two decimals (about 300 m in latitude) is not a landing site, and the catalogue\'s polar points are the best-lit pixels of a 60 m map, not official landing coordinates.'),
    lead('Earth visibility rule', `Earth counts as visible when its centre clears the terrain. NASA's published maps count any part of Earth's disk (0.95° radius) ${cite('mazarico2011')}, so their percentages are higher than ours.`),
    lead('Uncertainty bands', `The bands cover elevation-model error only. They were calibrated at one site, with only the terrain within ${d.cal.window_half_m / 1000} km of it perturbed, and on held-out realisations the spread of yearly sunlit time came out about ${(y.clones_std / y.model_mc_std).toFixed(1)}× narrower than NASA's (a standard deviation of ${pts(y.model_mc_std, 2)} against ${pts(y.clones_std, 2)} percentage points). Treat them as a lower bound. Resolution matters more: replacing our 20 m terrain near that site with the 5 m model moves yearly sunlit time by ${pts(Math.abs(y.shipped_20m - y.with_5m_detail))} points, and our 20 m result differs from the mean of NASA's realisations by ${pts(Math.abs(y.shipped_20m - y.clones_mean))} points, both more than the band. Where the horizon is set by distant terrain, even at a site inside a 20 m window, the height error is that of the coarse grid, which is assumed.`
      + (coarse.length ? ` For ${scen(coarse).replace(/^S/, 's')} this holds at the site itself, so ${verb(coarse, 'its', 'their')} bands are not calibrated at all.` : '')),
    lead('Dates', `The ephemeris covers ${r.text}; other dates cannot be computed.`
      + (apollo.length ? ` ${scen(apollo)} ${verb(apollo, 'is', 'are')} dated in the Apollo era. The Apollo table is uniform in ephemeris time across the two leap seconds of 1972, which shifts the Sun and Earth by at most about 0.0003°.` : '')
      + (noDsn.length ? ` The Deep Space Network table covers only ${day(r.m0)} to ${day(r.m1)}, so for ${scen(noDsn).replace(/^S/, 's')} contact hours are not available and the Comms verdict uses Earth in view alone.` : '')
      + slipFail.map((s) => ` ${chip(s.letter, s.color)}&nbsp;${esc(s.name)}: ${esc(s.sc.slipError)}`).join('')),
    lead('Time step', 'Series are hourly, so event times are good to about an hour and a glimpse of the Sun or Earth shorter than an hour can be missed. The horizon is sampled every 0.5° of azimuth, about the Sun\'s diameter, and interpolated in between.'),
    lead('Power and comms', `Power is the visible fraction of the solar disk for a Sun-tracking panel. There is no thermal model, panel geometry, dust or degradation. Comms is geometry only: Earth in view and a station above ${DSN_MASK}° make a link possible, not certain, and there is no link budget. The battery model and the Deep Space Network table are simple, have unit tests only and are not validated against an external source. The table uses a ${DSN_MASK}° elevation mask and Earth's rotation without polar-motion or UT1 corrections, good to about 0.01°.`),
    lead('Permanent shadow', `The data covers only the area poleward of about 85°S, counts regions of at least ${d.psr.min_area_km2} km² and comes from NASA's 60 m long-term simulation, not from our own horizon engine.`
      + (noPsr.length ? ` ${scen(noPsr)} ${verb(noPsr, 'lies', 'lie')} outside it, so ${verb(noPsr, 'it has', 'they have')} no distance to permanent shadow, and NASA's visibility maps used in the Validation section do not reach ${it(noPsr)} either.` : '')),
    ...(bare.length ? [lead('No mast', `${scen(bare)} ${verb(bare, 'has', 'have')} a 0 m mast. The horizon is then often set by the ground slope 10–20 m away, which is right for an eye on the ground but not for a solar panel or an antenna.`)] : []),
  ].join(''));
};

/* ------------------------------------------------------------------ references */

export const referencesSection: SectionFn = async () => section('refs', 'References', `<ol class="r-refs">${REFS.map((x) =>
  `<li id="ref-${x.key}">${esc(x.text)}${x.url ? ` <a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.url)}</a>` : ''}</li>`).join('')}</ol>`);
