// Sections built from the user's scenarios: abstract, study sites, results, site-specific confidence, conclusion.
// Owner: results agent. Every number comes from the worker results in ctx or from the data files; the wording is
// generated from them (pure parts in results-logic.ts).
import './results.css';
import { core, type ScenarioResult, type TerrainPoint } from '../../core/api';
import type { Tile } from '../../core/dem';
import { DEFAULT_POWER } from '../../core/extra';
import { DEG, R, spFwd } from '../../core/geom';
import { COMMS_MAX_GAP_H, drawChart, POWER_RESERVE, type ChartModel } from '../charts';
import { coord, DAY, dist, dur, landingT, utc } from '../format';
import { drawPanorama } from '../panorama';
import { drawStrip, stripSummary } from '../strips';
import { drawLanes, lanesHeight, PITCH, TOP, xAt } from '../timeline';
import { canvas, chip, esc, figure, section, table } from './dom';
import { cite } from './refs';
import {
  abstractHtml, agreementFor, and, bestWindow, byVerdict, count, EARTH_DISK_DEG, failures, hours, longTerm, pct, pm, pool, ranked,
  recommendation, summarize, tileAt, versus, who, type Summary, type ValidationJson,
} from './results-logic';
import type { ReportCtx, ReportScenario, SectionFn } from './types';

const BG = '#0a0b0d';
const MAX_SLOPE = 8;   // the app's flat-spot search limit (core/terrain.ts terrainSearch default)
const LIVE_STEP_H = 4; // as prep/validate.py, which sampled the ephemeris table every 4 h

/* ------------------------------------------------------------------ data, fetched once per report */

function memo<T>(f: (ctx: ReportCtx) => Promise<T>): (ctx: ReportCtx) => Promise<T> {
  const m = new WeakMap<ReportCtx, Promise<T>>();
  return (ctx) => { let p = m.get(ctx); if (!p) m.set(ctx, (p = f(ctx))); return p; };
}

const files = new Map<string, Promise<unknown>>();
function getJson<T>(url: string): Promise<T> {
  let p = files.get(url);
  if (!p) {
    p = fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${url.split('/').pop()}: HTTP ${r.status}`))));
    files.set(url, p);
    p.catch(() => files.delete(url));
  }
  return p as Promise<T>;
}
const validation = (ctx: ReportCtx) => getJson<ValidationJson>(ctx.dataBase + 'validation.json');
const tiles = (ctx: ReportCtx) => getJson<{ tiles: Tile[] }>(ctx.dataBase + 'dem/manifest.json').then((m) => m.tiles);

/** One scenario over the mission length chosen in the app. */
interface Win {
  x: ReportScenario;
  r: ScenarioResult;       // the mission window, with Monte Carlo
  s: Summary;              // Monte Carlo means
  det: Summary;            // deterministic, compared with the delayed landing
  slipS?: Summary;         // the delayed landing over the same length, deterministic
}

const idOf = (x: ReportScenario) => ({ letter: x.letter, name: x.name, t: x.sc.spec.t, lat: x.sc.spec.lat, lon: x.sc.spec.lon });

const windows = memo((ctx) => Promise.all(ctx.scenarios.map(async (x): Promise<Win> => {
  const sc = x.sc, d = ctx.missionDays, full = d >= 29.5; // sc.base already is the 29.5-day window
  const r = full ? sc.base! : await core.scenario(sc.site(), sc.spec.t, { days: d });
  const slip = ctx.slip && sc.slipped ? (full ? sc.slipped : await core.scenario(sc.site(), sc.spec.t + ctx.slip * DAY, { days: d, mc: false })) : undefined;
  return { x, r, s: summarize(idOf(x), r, d), det: summarize(idOf(x), r, d, false), slipS: slip && summarize(idOf(x), slip, d, false) };
})));

const terrain = memo((ctx) => Promise.all(ctx.scenarios.map((x) => core.terrain(x.sc.spec.lat, x.sc.spec.lon).catch((): TerrainPoint | null => null))));

interface Share { sun: number; earth: number }
interface Live { ground: Share; mast: Share; nasaSun: number; nasaEarth: number; t0: number; t1: number }
/** Our long-term Sun / Earth visibility at each site NASA's map covers, over the main ephemeris table: at ground level,
 *  as prep/validate.py compared with NASA, and at the scenario's mast. One run at a time, so closing the report stops
 *  the queue. */
const live = memo(async (ctx) => {
  const [terr, rng] = await Promise.all([terrain(ctx), core.range()]);
  const out: (Live | null)[] = [];
  for (const [i, x] of ctx.scenarios.entries()) {
    if (ctx.signal.aborted) throw new Error('report closed');
    const t = terr[i];
    if (!t || t.sunPct === null || t.earthPct === null) { out.push(null); continue; }
    const run = (mast: number) => core.strip({ lat: x.sc.spec.lat, lon: x.sc.spec.lon, mast }, rng.t0, rng.t1, { stepMs: LIVE_STEP_H * 3600e3, earthMargin: -EARTH_DISK_DEG });
    const g = await run(0);
    if (ctx.signal.aborted) throw new Error('report closed');
    const m = x.sc.spec.mast ? await run(x.sc.spec.mast) : g;
    out.push({ ground: longTerm(g.sunFrac, g.earthVis), mast: longTerm(m.sunFrac, m.earthVis), nasaSun: t.sunPct, nasaEarth: t.earthPct, t0: g.t0, t1: g.t0 + g.sunFrac.length * g.stepMs });
  }
  return out;
});

/* ------------------------------------------------------------------ small helpers */

const name = (x: ReportScenario) => `${chip(x.letter, x.color)} ${esc(x.name)}`;
const head = (ctx: ReportCtx) => ['', ...ctx.scenarios.map(name)];
const day = (t: number) => utc(t).slice(0, 10);
const signed = (v: number, digits = 1) => `${v < 0 ? '−' : ''}${Math.abs(v).toFixed(digits)}`;
const pts = (d: number) => (Math.round(d) ? `${d > 0 ? '+' : '−'}${Math.abs(Math.round(d))} pts` : '0 pts');
const resLabel = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `≈${(m / 1000).toFixed(1)} km`);
const tileRes = (t: Tile) => (t.proj === 'spstere' ? t.px! : (R * DEG) / t.ppd!);
const maxBy = <T>(xs: T[], f: (x: T) => number) => xs.reduce((a, b) => (f(b) > f(a) ? b : a));
const minBy = <T>(xs: T[], f: (x: T) => number) => xs.reduce((a, b) => (f(b) < f(a) ? b : a));
const LEVEL_CLS: Record<string, string> = { ok: 'r-ok', marginal: 'r-warn', gaps: 'r-warn', no: 'r-no' };
const badge = (v: { level: string; label: string }) => `<b class="${LEVEL_CLS[v.level]}">${v.label}</b>`;
const first = (s: string) => s.split(',')[0]; // "+0.8 pts" out of versus().text

/** Row of a scenario table with the best cell bold, when at least two scenarios have a value (not NaN) and they differ. */
function bestRow(label: string, xs: Win[], get: (w: Win) => number, show: (w: Win) => string, higher: boolean): string[] {
  const v = xs.map((w) => Math.round(get(w))), ok = v.filter(Number.isFinite), top = higher ? Math.max(...ok) : Math.min(...ok);
  const mark = ok.length > 1 && ok.some((y) => y !== top);
  return [label, ...xs.map((w, i) => (mark && v[i] === top ? `<span class="r-best">${show(w)}</span>` : show(w)))];
}

/** Draw with an app function that sizes itself from the layout: the canvas is attached off-screen for the call. */
function offscreen(w: number, h: number, draw: (c: HTMLCanvasElement) => void): HTMLCanvasElement {
  const c = canvas(w, h);
  Object.assign(c.style, { position: 'fixed', left: '-10000px', top: '0', visibility: 'hidden' });
  document.body.append(c);
  try { draw(c); } finally { c.remove(); }
  return c;
}

/** Canvases of one CSS size w x h stacked into a dark panel with a gutter of scenario letters at the given y. */
function panel(parts: HTMLCanvasElement[], w: number, h: number, gap: number, labels: [ReportScenario, number][]): HTMLCanvasElement {
  const gutter = 26, H = parts.length * h + (parts.length - 1) * gap, out = canvas(w + gutter, H), g = out.getContext('2d')!;
  g.scale(2, 2);
  g.fillStyle = BG; g.fillRect(0, 0, w + gutter, H);
  parts.forEach((c, k) => g.drawImage(c, gutter, k * (h + gap), w, h));
  g.font = '600 12px system-ui, sans-serif'; g.textBaseline = 'middle';
  for (const [x, y] of labels) { g.fillStyle = x.color; g.fillText(x.letter, 8, y); }
  return out;
}

/* ------------------------------------------------------------------ abstract */

export const abstractSection: SectionFn = async (ctx) => {
  const [ws, v] = await Promise.all([windows(ctx), validation(ctx).catch(() => null)]);
  return section('abstract', 'Abstract', abstractHtml(ws.map((w) => w.s), ctx.missionDays, v, ctx.generatedAt));
};

/* ------------------------------------------------------------------ study sites */

interface MapRec { id: string; file: string; proj: string; kind: string; bounds?: number[] }

/** Locator maps: polar sites on the finest polar hillshade that holds them all, the others on the global one. */
async function locator(ctx: ReportCtx): Promise<string> {
  const maps = (await getJson<MapRec[]>(ctx.dataBase + 'maps/index.json')).filter((m) => m.kind === 'hillshade');
  const PAD = 5000, area = (m: MapRec) => (m.bounds![2] - m.bounds![0]) * (m.bounds![3] - m.bounds![1]);
  const inside = (m: MapRec, p: [number, number]) => p[0] - PAD >= m.bounds![0] && p[0] + PAD <= m.bounds![2] && p[1] - PAD >= m.bounds![1] && p[1] + PAD <= m.bounds![3];
  const polarMaps = maps.filter((m) => m.proj === 'spstere' && m.bounds).sort((a, b) => area(a) - area(b));
  const xy = new Map(ctx.scenarios.map((x) => [x, spFwd(x.sc.spec.lat, x.sc.spec.lon)]));
  const polar = ctx.scenarios.filter((x) => x.sc.spec.lat < 0 && polarMaps.some((m) => inside(m, xy.get(x)!)));
  const rest = ctx.scenarios.filter((x) => !polar.includes(x));
  const load = async (m: MapRec) => { const img = new Image(); img.src = ctx.dataBase + 'maps/' + m.file; await img.decode(); return img; };
  const W = 720, figs: string[] = [];

  const draw = (H: number, place: (g: CanvasRenderingContext2D) => (x: ReportScenario) => [number, number], list: ReportScenario[]) => {
    const c = canvas(W, H), g = c.getContext('2d')!;
    g.scale(2, 2);
    g.fillStyle = BG; g.fillRect(0, 0, W, H);
    const at = place(g);
    g.font = '600 12px system-ui, sans-serif'; g.textBaseline = 'middle';
    for (const x of list) {
      const [px, py] = at(x);
      g.beginPath(); g.arc(px, py, 5, 0, Math.PI * 2);
      g.fillStyle = x.color; g.fill(); g.lineWidth = 2; g.strokeStyle = BG; g.stroke();
      g.lineWidth = 3; g.strokeText(x.letter, px + 8, py); g.fillText(x.letter, px + 8, py);
    }
    return c;
  };

  if (polar.length) {
    const m = polarMaps.find((mm) => polar.every((x) => inside(mm, xy.get(x)!)))!, b = m.bounds!, img = await load(m), H = 400;
    const xs = polar.map((x) => xy.get(x)![0]), ys = polar.map((x) => xy.get(x)![1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const sx = Math.max(Math.max(...xs) - Math.min(...xs), ((Math.max(...ys) - Math.min(...ys)) * W) / H, 20000) * 1.4, sy = (sx * H) / W;
    const x0 = cx - sx / 2, y1 = cy + sy / 2, kx = img.naturalWidth / (b[2] - b[0]), ky = img.naturalHeight / (b[3] - b[1]);
    const km = [1, 2, 5, 10, 20, 50, 100].find((k) => k * 1000 >= sx / 6) ?? 100;
    const c = draw(H, (g) => {
      g.drawImage(img, (x0 - b[0]) * kx, (b[3] - y1) * ky, sx * kx, sy * ky, 0, 0, W, H);
      g.fillStyle = '#fff'; g.fillRect(16, H - 20, ((km * 1000) / sx) * W, 3);
      g.font = '11px system-ui, sans-serif'; g.textBaseline = 'bottom'; g.fillText(`${km} km`, 16, H - 24);
      return (x) => { const [X, Y] = xy.get(x)!; return [((X - x0) / sx) * W, ((y1 - Y) / sy) * H]; };
    }, polar);
    figs.push(figure(c, `${rest.length ? `Site${polar.length > 1 ? 's' : ''} ${and(polar.map((x) => x.letter))}` : 'Scenario sites'} on a LOLA hillshade of the south polar region ${cite('barker2023')}, `
      + `polar stereographic with 0° longitude up. Scale bar ${km} km.`, 'Polar map with the scenario landing sites marked'));
  }
  const glob = maps.find((x) => x.proj === 'eqc');
  if (rest.length && glob) {
    const img = await load(glob), H = 360;
    const c = draw(H, (g) => {
      g.drawImage(img, 0, 0, W, H);
      return (x) => [((((x.sc.spec.lon % 360) + 360) % 360) / 360) * W, ((90 - x.sc.spec.lat) / 180) * H];
    }, rest);
    figs.push(figure(c, `${polar.length ? `Site${rest.length > 1 ? 's' : ''} ${and(rest.map((x) => x.letter))}` : 'Scenario sites'} on a LOLA global hillshade ${cite('ldem16')}, longitude 0–360° E left to right, 90° N at the top.`,
      'Global map with the scenario landing sites marked'));
  }
  return figs.join('');
}

export const sitesSection: SectionFn = async (ctx) => {
  const [terr, ts, psr, loc] = await Promise.all([
    terrain(ctx), tiles(ctx), getJson<{ min_area_km2: number }>(ctx.dataBase + 'psr_dist.json').catch(() => null),
    locator(ctx).catch(() => ''),
  ]);
  const xs = ctx.scenarios;
  const tile = xs.map((x) => tileAt(ts, x.sc.spec.lat, x.sc.spec.lon));
  const actual = (x: ReportScenario) => !!x.site?.date && Math.abs(landingT(x.site.date) - x.sc.spec.t) < 60e3;
  const cell = (i: number, f: (t: TerrainPoint) => string) => { const t = terr[i]; return t ? f(t) : 'no terrain data'; };
  const rows = [
    ['Programme', ...xs.map((x) => esc(x.site?.program ?? 'Custom point'))],
    ['Coordinates', ...xs.map((x) => coord(x.sc.spec.lat, x.sc.spec.lon, 4))],
    ['Landing', ...xs.map((x) => `${utc(x.sc.spec.t)}${actual(x) ? '<small>actual landing time</small>' : ''}`)],
    ['Mast height', ...xs.map((x) => `${x.sc.spec.mast} m`)],
    ['Terrain grid at the site', ...tile.map((t) => (t ? resLabel(tileRes(t)) : '–'))],
    [`Elevation<small>above the ${R / 1000} km sphere</small>`, ...xs.map((_, i) => cell(i, (t) => `${signed(t.elevation_m, 0)} m`))],
    ['Local slope<small>one grid cell either side</small>', ...xs.map((_, i) => cell(i, (t) => `${t.slope_deg.toFixed(1)}°`))],
    [`Nearest permanent shadow${psr ? `<small>regions of ${psr.min_area_km2} km² or more</small>` : ''}`, ...xs.map((x) => {
      const m = x.sc.base!.mission.psrM;
      return m === null ? 'no data north of about 85°S' : m < 1 ? 'inside one' : dist(m);
    })],
    ['NASA long-term Sun<small>share of time, PGDA map</small>', ...xs.map((_, i) => cell(i, (t) => (t.sunPct === null ? 'not covered' : `${t.sunPct.toFixed(1)}%`)))],
    ['NASA long-term Earth<small>share of time, PGDA map</small>', ...xs.map((_, i) => cell(i, (t) => (t.earthPct === null ? 'not covered' : `${t.earthPct.toFixed(1)}%`)))],
  ];

  // Prose: how many scenarios, on which terrain, and what is missing.
  const byRes = new Map<string, string[]>();
  xs.forEach((x, i) => { const t = tile[i], k = t ? resLabel(tileRes(t)) : 'no'; byRes.set(k, [...(byRes.get(k) ?? []), x.letter]); });
  const resText = [...byRes].map(([k, l]) => `${and(l)} on ${k} terrain`).join(', ');
  const plural = (l: string[], one: string, many: string) => (l.length > 1 ? many : one);
  const noMap = xs.filter((_, i) => terr[i]?.sunPct == null).map((x) => x.letter);
  const noDsn = xs.filter((x) => x.sc.base!.mission.commsHours === null).map((x) => x.letter);
  let p = `We study ${xs.length === 1 ? 'one scenario' : `${count(xs.length)} scenarios`}: ${resText}. `;
  if (noMap.length) p += `${and(noMap)} ${plural(noMap, 'lies', 'lie')} outside NASA's long-term illumination maps, which stop near 85°S ${cite('mazarico2011')}, so there is no NASA value to compare with. `;
  if (noDsn.length) p += `${and(noDsn)} ${plural(noDsn, 'lands', 'land')} on dates our Deep Space Network table does not cover, so comms there are judged on Earth visibility alone. `;
  if (ctx.skipped.length) p += `Scenario${ctx.skipped.length > 1 ? 's' : ''} ${and(ctx.skipped)} ${plural(ctx.skipped, 'was', 'were')} still computing or failed and ${plural(ctx.skipped, 'is', 'are')} left out.`;

  const notes = xs.map((x) => `<li>${name(x)}: ${x.site ? esc(x.site.note) : 'a point picked on the map, not a catalogue site.'}</li>`).join('');
  const cap = `Study sites. Terrain values are read at the point from the finest LOLA model that covers it ${cite('barker2023', 'ldem16')}. `
    + `NASA long-term values are the share of time any part of the Sun's or Earth's disk is above the terrain in the PGDA maps ${cite('mazarico2011')}, nearest pixel.`;
  return section('sites', 'Study sites and scenarios', `<p>${p}</p>${table(cap, head(ctx), rows)}${loc}<h3>Site notes</h3><ul class="r-notes">${notes}</ul>`);
};

/* ------------------------------------------------------------------ results */

function metricsPart(ctx: ReportCtx, ws: Win[]): string {
  const d = ctx.missionDays, H = d * 24, s = ws.map((w) => w.s);
  const rows = [
    bestRow('Mean solar power<small>% of rated, Sun-tracking panel</small>', ws, (w) => w.s.power, (w) => pm(w.s.power, w.s.powerSd, pct), true),
    bestRow('Sun at least partly up<small>share of time</small>', ws, (w) => w.s.anyLit, (w) => pm(w.s.anyLit, w.s.anyLitSd, pct), true),
    bestRow('Longest dark period', ws, (w) => w.s.dark, (w) => pm(w.s.dark, w.s.darkSd, hours), false),
    bestRow('Earth in view<small>share of time</small>', ws, (w) => w.s.earth, (w) => pm(w.s.earth, w.s.earthSd, pct), true),
    bestRow('Longest without Earth', ws, (w) => w.s.noEarth, (w) => pm(w.s.noEarth, w.s.noEarthSd, hours), false),
    bestRow('Deep Space Network contact<small>Earth in view and a station sees the Moon</small>', ws, (w) => w.r.mission.commsHours ?? NaN,
      (w) => { const c = w.r.mission.commsHours; return c === null ? 'no station data for these dates' : `${dur(c)} (${pct((100 * c) / H)})`; }, true),
    ['Battery', ...ws.map((w) => { const b = w.r.mission.battery; return b.survivalH === null ? `never empty, lowest ${pct(b.minSoc * 100)}` : `empty after ${dur(b.survivalH)}`; })],
  ];
  const cap = `Mission metrics over the ${d} days after landing. Values are Monte Carlo means ± one standard deviation over terrain-error draws; `
    + `Deep Space Network ${cite('dsn')} and battery figures use the nominal terrain. Bold: best in the row.`;

  let p: string;
  if (s.length === 1) {
    const a = s[0];
    p = `Over the ${d} days after landing, ${a.letter} averages ${pm(a.power, a.powerSd, pct)} of rated solar power, and some of the Sun is up ${pct(a.anyLit)} of the time. `
      + (a.dark >= 0.5 ? `Its longest dark period is ${hours(a.dark)}. ` : 'It never goes fully dark. ')
      + (a.earth > 0 ? `Earth is in view ${pm(a.earth, a.earthSd, pct)} of the time${a.noEarth >= 0.5 ? `; the longest stretch without it is ${hours(a.noEarth)}` : ', without a break'}.` : 'Earth is never in view, so direct-to-Earth comms are impossible.');
  } else {
    const hp = maxBy(s, (x) => x.power), lp = minBy(s, (x) => x.power), he = maxBy(s, (x) => x.earth), le = minBy(s, (x) => x.earth);
    p = Math.round(hp.power) === Math.round(lp.power)
      ? `All scenarios average ${pct(hp.power)} of rated solar power. `
      : `${who(hp)} gets the most solar power, ${pct(hp.power)} of rated on average, and ${who(lp)} the least, ${pct(lp.power)} (${Math.round(hp.power) - Math.round(lp.power)} points less). `;
    const lit = s.filter((x) => x.dark < 0.5), long = maxBy(s, (x) => x.dark);
    if (lit.length === s.length) p += 'No scenario goes fully dark. ';
    else p += `The longest dark period is ${hours(long.dark)}, at ${long.letter}${lit.length ? `; ${and(lit.map((x) => x.letter))} never ${lit.length > 1 ? 'go' : 'goes'} fully dark` : ''}. `;
    p += Math.round(he.earth) === Math.round(le.earth)
      ? `Earth is in view ${pct(he.earth)} of the time at every site.`
      : `Earth is in view longest at ${he.letter} (${pct(he.earth)}) and least at ${le.letter} (${pct(le.earth)}).`;
    const never = s.filter((x) => x.earth === 0).map((x) => x.letter);
    if (never.length) p += ` ${and(never)} never ${never.length > 1 ? 'see' : 'sees'} Earth, so direct-to-Earth comms are impossible there.`;
  }
  const spread = s.filter((x) => x.powerSd !== null);
  if (spread.length) {
    const w = maxBy(spread, (x) => x.powerSd!);
    if (Math.round(w.powerSd!) >= 1) p += ` Terrain uncertainty matters most at ${w.letter}, where mean power varies by ± ${pct(w.powerSd!)} across the Monte Carlo draws.`;
  }

  // Power chart: every scenario overlaid; the selected one with its Monte Carlo band and, with a delay, its delayed run.
  const model: ChartModel = {
    metric: 'power', durationDays: d, selected: ctx.selected,
    items: ctx.scenarios.map((x) => ({ letter: x.letter, color: x.color, result: x.sc.base, slipped: ctx.slip ? x.sc.slipped : undefined })),
  };
  const cw = 720, ch = 260, chart = canvas(cw, ch), g = chart.getContext('2d')!;
  g.scale(2, 2);
  drawChart(g, cw, ch, model);
  const sel = ctx.scenarios[ctx.selected];
  const legend = ctx.scenarios.map((x) => `${chip(x.letter, x.color)}&nbsp;${esc(x.name)}`).join(', ');
  const chartCap = `Available solar power, % of the rated output of a Sun-tracking panel, over the ${d} days after landing: ${legend}. `
    + `The band around ${sel.letter} is the 10–90% range over the Monte Carlo draws${ctx.slip && sel.sc.slipped ? `; the dashed line is ${sel.letter} landing ${ctx.slip} d later` : ''}.`;

  // Timeline lanes over the 29.5-day window, the part past the mission shaded.
  const n = ctx.scenarios.length, slip = !!ctx.slip, lw = 694, lh = lanesHeight(n), bandsH = TOP + n * PITCH - 6;
  const lanes = offscreen(lw, lh, (c) => {
    drawLanes(c, ctx.scenarios.map((x) => ({ series: x.sc.base!.series, ghost: slip ? x.sc.slipped?.series : undefined })), slip);
    if (d >= 29.5) return;
    const lg = c.getContext('2d')!, x0 = xAt(d * 24, lw);
    lg.fillStyle = 'rgba(10,11,13,0.62)'; lg.fillRect(x0, 0, lw - x0, bandsH);
    lg.fillStyle = '#e8e6e1'; lg.fillRect(Math.round(x0), 0, 1, bandsH);
  });
  const lanesFig = panel([lanes], lw, lh, 0, ctx.scenarios.map((x, i) => [x, TOP + i * PITCH + 9]));
  const lanesCap = `Sunlight (amber; brighter = more of the Sun's disk visible) and Earth in view (blue) at each site over the 29.5 days after landing`
    + `${d < 29.5 ? `; the shaded part is past the ${d}-day mission` : ''}${slip ? `. The fainter lower pair in each lane is the landing delayed by ${ctx.slip} d` : ''}.`;

  return `<h3>Sunlight and Earth over the mission</h3><p>${p}</p>${table(cap, head(ctx), rows)}`
    + figure(chart, chartCap, `Line chart of solar power over ${d} days for scenarios ${and(ctx.scenarios.map((x) => x.letter))}`)
    + figure(lanesFig, lanesCap, 'Timeline of sunlight and Earth visibility per scenario');
}

function horizonPart(ctx: ReportCtx, ws: Win[]): string {
  const d = ctx.missionDays;
  const parts = ws.map((w) => {
    const { horizon: h, series: s } = w.r, x = w.x;
    let hi = 0;
    for (let i = 1; i < h.el.length; i++) if (h.el[i] > h.el[hi]) hi = i;
    // Hidden although above the level horizon (terrain), and seen although below it (the site stands high).
    let sLo = Infinity, sHi = -Infinity, eLo = Infinity, eHi = -Infinity, sunHid = 0, earthHid = 0, sunLow = 0, earthLow = 0;
    for (let i = 0; i < s.t.length; i++) {
      sLo = Math.min(sLo, s.sunEl[i]); sHi = Math.max(sHi, s.sunEl[i]); eLo = Math.min(eLo, s.earthEl[i]); eHi = Math.max(eHi, s.earthEl[i]);
      if (s.sunEl[i] > 0 && s.sunFrac[i] === 0) sunHid++;
      if (s.sunEl[i] <= 0 && s.sunFrac[i] > 0) sunLow++;
      if (s.earthEl[i] > 0 && !s.earthVis[i]) earthHid++;
      if (s.earthEl[i] <= 0 && s.earthVis[i]) earthLow++;
    }
    const stepH = s.stepMs / 3600e3, deg = (v: number) => `${signed(v)}°`;
    const both = (a: number, b: number) => [a && `the Sun for ${dur(a * stepH)}`, b && `Earth for ${dur(b * stepH)}`].filter(Boolean) as string[];
    const hid = both(sunHid, earthHid), low = both(sunLow, earthLow);
    const text = `At ${x.letter} the terrain horizon peaks at ${deg(h.el[hi])} (azimuth ${Math.round((hi * 360) / h.el.length)}°). `
      + `Over the mission the Sun moves between ${deg(sLo)} and ${deg(sHi)} elevation and Earth between ${deg(eLo)} and ${deg(eHi)}. `
      + (hid.length ? `Terrain hides ${and(hid)} while ${hid.length > 1 ? 'they are' : 'it is'} above the level horizon. ` : '')
      + (low.length ? `The site stands high enough to see ${and(low)} while ${low.length > 1 ? 'they are' : 'it is'} below the level horizon.` : '');
    const c = offscreen(720, 210, (cv) => drawPanorama(cv, w.r, { idx: 0, label: `${x.letter} · ${x.name}` }));
    const cap = `Horizon seen from ${chip(x.letter, x.color)} ${esc(x.name)} (mast ${x.sc.spec.mast} m): terrain silhouette and the paths of the Sun (amber) and Earth (blue) over the ${d}-day mission. `
      + 'Faint segments are hidden by terrain; disks mark the positions at landing. The vertical scale is exaggerated as marked.';
    return { text, fig: figure(c, cap, `Horizon panorama for scenario ${x.letter}`) };
  });
  return `<h3>Horizons and the paths of the Sun and Earth</h3>${parts.map((p) => `<p>${p.text}</p>${p.fig}`).join('')}`;
}

/** Year statistics of a scenario's 12-month strip and its best mission-length window. */
function season(w: Win, missionDays: number) {
  const st = w.x.sc.strip;
  if (!st) return null;
  const y = stripSummary(st), b = bestWindow(st.sunFrac, Math.round((missionDays * 24 * 3600e3) / st.stepMs));
  return { st, y, bestT: st.t0 + b.i * st.stepMs, bestPower: b.mean * 100 };
}

function seasonPart(ctx: ReportCtx, ws: Win[]): string {
  const d = ctx.missionDays;
  const have = ws.flatMap((w) => { const z = season(w, d); return z ? [{ w, z }] : []; });
  if (!have.length) return '<h3>Seasonal variation</h3><p>No 12-month strip was computed for these scenarios.</p>';
  const text = have.map(({ w, z }) => {
    const diff = Math.round(w.det.power) - Math.round(z.y.pctLit);
    return `Over the 12 months from ${day(z.st.t0)}, ${w.x.letter} averages ${pct(z.y.pctLit)} of rated power with Earth in view ${pct(z.y.pctEarth)} of the time, and its longest dark period is ${hours(z.y.longestDarkHours)}. `
      + `The chosen ${d}-day mission gets ${pct(w.det.power)}, ${diff ? `${Math.abs(diff)} points ${diff > 0 ? 'above' : 'below'}` : 'the same as'} the yearly mean; `
      + `the best ${d}-day window in the year starts ${day(z.bestT)} and gets ${pct(z.bestPower)}.`;
  }).join(' ');
  const sw = 680, sh = 44;
  const strips = have.map(({ w, z }) => offscreen(sw, sh, (c) => drawStrip(c, z.st, { markT: w.x.sc.spec.t, markT2: ctx.slip ? w.x.sc.spec.t + ctx.slip * DAY : undefined })));
  const fig = panel(strips, sw, sh, 8, have.map(({ w }, k): [ReportScenario, number] => [w.x, k * (sh + 8) + sh / 2]));
  const cap = 'Twelve months from each landing date, one row per scenario: Sun (amber; brighter = more of the disk visible) and Earth in view (blue), hourly. '
    + `The white line marks the landing${ctx.slip ? `, the red dashed line the landing delayed by ${ctx.slip} d` : ''}. Month initials below each row.`;
  return `<h3>Seasonal variation</h3><p>${text}</p>${figure(fig, cap, 'Twelve-month sunlight and Earth visibility strips')}`;
}

function verdictPart(ctx: ReportCtx, ws: Win[]): string {
  const d = ctx.missionDays, P = DEFAULT_POWER;
  const rules = `Power assumes a ${P.panelW} W Sun-tracking panel, a constant ${P.loadW} W load and a ${P.capacityWh / 1000} kWh battery that starts full. `
    + `Power is OK when the charge never falls below ${POWER_RESERVE * 100}%, Marginal when it dips below that but never empties, and No when it empties. `
    + `Comms counts contact when Earth is in view and a Deep Space Network station can see the Moon ${cite('dsn')}, or Earth in view alone where our station table does not cover the dates. `
    + `Comms is OK when the longest gap without contact is ${COMMS_MAX_GAP_H} h or less, Gaps when it is longer, and No when there is no contact at all.`;
  const all = ws.map((w) => w.s);
  let p = `Over the ${d}-day mission, power is ${byVerdict(all, (s) => s.pv)}; comms is ${byVerdict(all, (s) => s.cv)}.`;
  const empty = ws.filter((w) => w.s.pv.survivalHours !== null);
  if (empty.length) p += ` The battery empties at ${and(empty.map((w) => `${w.s.letter} after ${dur(w.s.pv.survivalHours!)}`))}.`;
  const worstGap = maxBy(ws, (w) => w.s.cv.longestGapHours);
  if (worstGap.s.cv.longestGapHours > COMMS_MAX_GAP_H) p += ` The longest comms gap is ${dur(worstGap.s.cv.longestGapHours)}, at ${worstGap.s.letter}.`;
  const rows = ws.map((w) => [name(w.x), `${badge(w.s.pv)}<small>${esc(w.s.pv.detail)}</small>`, `${badge(w.s.cv)}<small>${esc(w.s.cv.detail)}</small>`,
    w.s.cv.basis === 'dsn' ? 'Deep Space Network' : 'Earth in view only']);
  return `<h3>Power and comms verdicts</h3><p>${rules}</p><p>${p}</p>`
    + table(`Power and comms verdicts over the ${d} days after landing (nominal terrain).`, ['Scenario', 'Power', 'Comms', 'Contact counted as'], rows);
}

function slipPart(ctx: ReportCtx, ws: Win[]): string {
  const d = ctx.missionDays, k = ctx.slip;
  const done = ws.filter((w) => w.slipS);
  const arrow = (a: string, b: string) => (a === b ? `${a} (=)` : `${a} → ${b}`);
  const rows = ws.map((w) => {
    const a = w.det, b = w.slipS;
    if (!b) return [name(w.x), `n/a<small>${esc(w.x.sc.slipError || 'not computed')}</small>`, '', '', '', ''];
    return [name(w.x),
      `${pct(a.power)} → ${pct(b.power)}<small>${pts(b.power - a.power)}</small>`,
      `${pct(a.earth)} → ${pct(b.earth)}<small>${pts(b.earth - a.earth)}</small>`,
      arrow(hours(a.dark), hours(b.dark)), arrow(a.pv.label, b.pv.label), arrow(a.cv.label, b.cv.label)];
  });
  let p: string;
  if (!done.length) p = `The landing delayed by ${k} d could not be computed for any scenario.`;
  else {
    const dp = done.map((w) => w.slipS!.power - w.det.power), de = done.map((w) => w.slipS!.earth - w.det.earth);
    const bi = dp.reduce((b, v, i) => (Math.abs(v) > Math.abs(dp[b]) ? i : b), 0), big = done[bi];
    const range = (what: string, v: number[]) => {
      const lo = Math.round(Math.min(...v)), hi = Math.round(Math.max(...v));
      return !lo && !hi ? `leaves ${what} unchanged` : `changes ${what} by ${lo === hi ? pts(lo) : `between ${pts(lo)} and ${pts(hi)}`}`;
    };
    const same = (v: number[]) => v.every((x) => !Math.round(x));
    p = same(dp) && same(de) ? `Landing ${k} d later leaves mean solar power and Earth-in-view time unchanged`
      : `Landing ${k} d later ${range('mean solar power', dp)} and ${range('Earth-in-view time', de)}`
      + (Math.round(Math.abs(dp[bi])) ? `; the largest power change is at ${big.x.letter}, from ${pct(big.det.power)} to ${pct(big.slipS!.power)}. ` : '. ');
    const ch = done.flatMap((w) => [
      w.det.pv.level !== w.slipS!.pv.level ? `${w.x.letter} power ${w.det.pv.label} → ${w.slipS!.pv.label}` : '',
      w.det.cv.level !== w.slipS!.cv.level ? `${w.x.letter} comms ${w.det.cv.label} → ${w.slipS!.cv.label}` : '',
    ]).filter(Boolean);
    p += ch.length ? `Verdicts that change: ${and(ch)}.` : 'No verdict changes.';
  }
  const cap = `Sensitivity to a landing delay of ${k} d over the ${d}-day mission: nominal landing → delayed landing, both on the nominal terrain (no Monte Carlo).`;
  return `<h3>Sensitivity to a landing delay</h3><p>${p}</p>${table(cap, ['Scenario', 'Mean solar power', 'Earth in view', 'Longest dark', 'Power', 'Comms'], rows)}`;
}

export const resultsSection: SectionFn = async (ctx) => {
  const ws = await windows(ctx);
  const html = metricsPart(ctx, ws) + horizonPart(ctx, ws) + seasonPart(ctx, ws) + verdictPart(ctx, ws) + (ctx.slip ? slipPart(ctx, ws) : '');
  return section('results', 'Results', html);
};

/* ------------------------------------------------------------------ site-specific confidence */

export const confidenceSection: SectionFn = async (ctx) => {
  const [ws, ts, v, lv] = await Promise.all([windows(ctx), tiles(ctx), validation(ctx), live(ctx).catch(() => null)]);
  const xs = ctx.scenarios, main = v.pgda;
  const tile = xs.map((x) => tileAt(ts, x.sc.spec.lat, x.sc.spec.lon));
  const agr = tile.map((t) => agreementFor(v, t));
  const f1 = (x: number) => signed(x * 100);
  const model = (t: Tile | undefined) => !t ? '–'
    : t.proj === 'eqc' ? `${resLabel(tileRes(t))}, LOLA global ${cite('ldem16')}`
      : t.px! > 20 ? `${resLabel(t.px!)}, LOLA polar, averaged from 80 m ${cite('barker2023')}` : `${t.px} m, LOLA south pole ${cite('barker2023')}`;
  const liveCell = (i: number, k: 'sun' | 'earth') => {
    const l = lv?.[i], a = agr[i];
    if (!l) return lv ? 'not possible: no NASA map here' : 'could not run';
    const ours = l.ground[k], nasa = k === 'sun' ? l.nasaSun : l.nasaEarth;
    const c = a ? versus(ours, nasa, a.a[k].mae * 100) : null;
    return `${ours.toFixed(1)}% vs ${nasa.toFixed(1)}%${c ? `<small class="${c.within ? 'r-ok' : 'r-warn'}">${c.text}</small>` : ''}`;
  };
  const rows = [
    ['Terrain model at the site', ...tile.map(model)],
    ['Height error used in the Monte Carlo', ...tile.map((t) => (t ? `${t.sigma_h} m` : '–'))],
    ['Validation region', ...agr.map((a) => (a ? `${esc(a.name)}<small>${a.a.n} random points</small>` : 'none: NASA maps stop near 85°S'))],
    ['Region mean error vs NASA<small>Sun / Earth, percentage points</small>', ...agr.map((a) => (a ? `${f1(a.a.sun.mae)} / ${f1(a.a.earth.mae)}<small>bias ${f1(a.a.sun.bias)} / ${f1(a.a.earth.bias)}</small>` : '–'))],
    [`Monte Carlo spread over ${ctx.missionDays} d<small>power / Earth in view</small>`, ...ws.map((w) => (w.s.powerSd === null ? 'not run'
      : `± ${w.s.powerSd.toFixed(1)} / ± ${w.s.earthSd!.toFixed(1)} pts<small>longest dark ± ${dur(w.s.darkSd ?? 0)}</small>`))],
    ['Live check, Sun<small>ours at ground level vs NASA, long-term share of time</small>', ...xs.map((_, i) => liveCell(i, 'sun'))],
    ['Live check, Earth<small>ours at ground level vs NASA, long-term share of time</small>', ...xs.map((_, i) => liveCell(i, 'earth'))],
    ['Ours at the mast<small>Sun / Earth, long-term share of time</small>', ...xs.map((x, i) => {
      const l = lv?.[i];
      return l ? `${l.mast.sun.toFixed(1)}% / ${l.mast.earth.toFixed(1)}%<small>${x.sc.spec.mast} m above the ground</small>` : '–';
    })],
  ];

  const paras = ws.map((w, i) => {
    const t = tile[i], a = agr[i], l = lv?.[i], x = w.x;
    let s = '';
    if (t?.proj === 'spstere' && t.px === 20) s += `${x.letter} sits on the 20 m model, fine enough to resolve crater rims and ridges near the site. `;
    else if (t?.proj === 'spstere') s += `${x.letter} has only ${resLabel(t.px!)} terrain, which smooths out ridges and rims smaller than a few hundred metres. `;
    else if (t) {
      let eLo = Infinity, hMax = -Infinity;
      for (const e of w.r.series.earthEl) eLo = Math.min(eLo, e);
      for (const e of w.r.horizon.el) hMax = Math.max(hMax, e);
      s += `${x.letter} has only the ${resLabel(tileRes(t))} global model, and no NASA map covers it, so its horizon is not validated. Hills smaller than a few kilometres are missing; `
        + `here the terrain horizon reaches at most ${hMax.toFixed(1)}°, while Earth stays at ${eLo.toFixed(1)}° elevation or higher over the mission, so the missing detail matters mostly around sunrise and sunset. `;
    }
    if (a) s += `In ${a.name}, ${a.a.n} random points agreed with NASA's maps to a mean ${f1(a.a.sun.mae)} points for the Sun and ${f1(a.a.earth.mae)} for Earth`
      + `${a.a !== main && t!.px! > 20 ? `, against ${f1(main.sun.mae)} and ${f1(main.earth.mae)} on 20 m terrain at Shackleton` : ''}. `;
    if (w.s.powerSd !== null) s += `Across the Monte Carlo draws, mean power at ${x.letter} varies by ± ${w.s.powerSd.toFixed(1)} points and Earth time by ± ${w.s.earthSd!.toFixed(1)}. `;
    if (l && a) {
      const cs = versus(l.ground.sun, l.nasaSun, a.a.sun.mae * 100), ce = versus(l.ground.earth, l.nasaEarth, a.a.earth.mae * 100);
      s += `At ground level at this exact point we get ${l.ground.sun.toFixed(1)}% Sun and ${l.ground.earth.toFixed(1)}% Earth against NASA's ${l.nasaSun.toFixed(1)}% and ${l.nasaEarth.toFixed(1)}%: `
        + (cs.within && ce.within ? 'both within the region\'s typical error. '
          : `${cs.within ? 'the Sun is within the region\'s typical error' : `the Sun differs by ${first(cs.text)}, more than the region's typical error`}, `
            + `${ce.within ? 'Earth is within it' : `Earth differs by ${first(ce.text)}, more than typical`}. `);
      const dm = l.mast.sun - l.ground.sun;
      if (x.sc.spec.mast && Math.abs(dm) > a.a.sun.mae * 100) {
        s += `Raising the observer to the ${x.sc.spec.mast} m mast changes our Sun value by ${pts(dm)}, to ${l.mast.sun.toFixed(1)}%, so here the result depends strongly on observer height `
          + 'and on terrain within a few tens of metres, finer than NASA\'s map resolves; the scenario figures use the mast height.';
      }
    }
    return `<p>${s}</p>`;
  }).join('');

  const l0 = lv?.find((x) => x);
  const how = l0
    ? `<p>Live check: for each site inside NASA's maps we recompute the long-term share of time that any part of the Sun's disk, and any part of Earth's disk, is above the terrain, `
      + `at ground level as NASA's maps, every ${LIVE_STEP_H} h from ${day(l0.t0)} to ${day(l0.t1)}, and compare it with the PGDA value at the same point ${cite('mazarico2011')}. `
      + `Earth's disk is counted with its mean angular radius, ${EARTH_DISK_DEG.toFixed(2)}°. The difference is set against the mean error of the region's validation points, which were compared the same way. `
      + 'NASA\'s value is read from our copy of the map, averaged to 120 m from NASA\'s 60 m product, which smooths sharp ridge tops. We also give our value at the scenario\'s mast height.</p>'

    : '';
  const cap = 'Site-specific confidence. Validation numbers are from our comparison with NASA PGDA maps at random points in each terrain region; the live check is computed now at each scenario\'s point.';
  return section('confidence', 'Site-specific confidence', how + table(cap, head(ctx), rows) + paras);
};

/* ------------------------------------------------------------------ conclusion */

export const conclusionSection: SectionFn = async (ctx) => {
  const [ws, terr, ts, v, lv] = await Promise.all([windows(ctx), terrain(ctx), tiles(ctx), validation(ctx).catch(() => null), live(ctx).catch(() => null)]);
  const d = ctx.missionDays, all = ws.map((w) => w.s), s = pool(all, ctx.generatedAt), top = ranked(s)[0], tw = ws.find((w) => w.s === top)!, P = DEFAULT_POWER;
  const tileOf = (w: Win) => tileAt(ts, w.x.sc.spec.lat, w.x.sc.spec.lon);

  // Trade-offs: where the recommended scenario is not the best on a single measure.
  const trade: string[] = [];
  if (s.length > 1) {
    const hp = maxBy(s, (x) => x.power), he = maxBy(s, (x) => x.earth), sd = minBy(s, (x) => x.dark);
    if (Math.round(hp.power) > Math.round(top.power)) trade.push(`${who(hp)} has more solar power (${pct(hp.power)} against ${pct(top.power)})${failures(hp).length ? ` but ${and(failures(hp))}` : ''}.`);
    if (Math.round(he.earth) > Math.round(top.earth)) trade.push(`${who(he)} keeps Earth in view longer (${pct(he.earth)} against ${pct(top.earth)}).`);
    if (Math.round(sd.dark) < Math.round(top.dark)) trade.push(`${who(sd)} has a shorter longest dark period (${hours(sd.dark)} against ${hours(top.dark)}).`);
    if (!trade.length) trade.push(`${top.letter} is also the best or equal best on mean power, Earth-in-view time and the longest dark period.`);
  }

  // Risks, per scenario, from the numbers.
  const risks = ws.map((w, i) => {
    const x = w.s, out: string[] = [], t = terr[i], tile = tileOf(w), a = v && agreementFor(v, tile), l = lv?.[i];
    if (x.pv.level === 'no') out.push(`the battery empties after ${dur(x.pv.survivalHours!)} (longest dark period ${hours(w.det.dark)})`);
    else if (x.pv.level === 'marginal') out.push(`the battery falls to ${pct(x.pv.minSoc * 100)} during a dark period of up to ${hours(w.det.dark)}`);
    if (x.cv.level === 'no') out.push('no direct contact with Earth during the mission, so a relay is needed');
    else if (x.cv.level === 'gaps') out.push(`no contact for up to ${dur(x.cv.longestGapHours)} at a time`);
    if (x.cv.basis === 'earth') out.push('no Deep Space Network data for these dates, so comms are judged on Earth visibility alone');
    if (t && t.slope_deg > MAX_SLOPE) out.push(`local slope ${t.slope_deg.toFixed(1)}° on the ${resLabel(t.resolution_m)} grid, steeper than the ${MAX_SLOPE}° the app's flat-spot search accepts`);
    if (tile && tileRes(tile) > 20) out.push(`terrain known only at ${resLabel(tileRes(tile))}`);
    if (w.r.mission.psrM !== null && w.r.mission.psrM < 1) out.push('the site is inside a permanently shadowed region');
    if (l && a) {
      const cs = versus(l.ground.sun, l.nasaSun, a.a.sun.mae * 100);
      if (!cs.within) out.push(`at ground level our long-term Sun visibility differs from NASA's map by ${first(cs.text)}, more than the region's typical error`);
    }
    if (w.slipS) {
      if (w.slipS.pv.level !== w.det.pv.level) out.push(`landing ${ctx.slip} d later changes power from ${w.det.pv.label} to ${w.slipS.pv.label}`);
      if (w.slipS.cv.level !== w.det.cv.level) out.push(`landing ${ctx.slip} d later changes comms from ${w.det.cv.label} to ${w.slipS.cv.label}`);
    }
    const txt = out.length ? out.join('; ') : 'none flagged by these checks';
    return `<li>${name(w.x)}: ${txt.charAt(0).toUpperCase() + txt.slice(1)}.</li>`;
  }).join('');

  // Next steps, concrete and from the numbers.
  const steps: string[] = [];
  const z = top.t >= ctx.generatedAt ? season(tw, d) : null; // a past landing cannot be moved
  if (z && z.bestPower - tw.det.power >= 1) steps.push(`Consider moving ${top.letter}'s landing to the best ${d}-day window in its 12-month strip, starting ${day(z.bestT)}: ${pct(z.bestPower)} mean power instead of ${pct(tw.det.power)}. Re-run the scenario at that date to confirm the verdicts.`);
  else if (z) steps.push(`Keep ${top.letter}'s landing date: its ${d}-day mission is within a point of the best window in its 12-month strip (${pct(z.bestPower)}).`);
  if (tw.det.dark >= 0.5) steps.push(`Size ${top.letter}'s battery for its longest dark period: ${hours(tw.det.dark)} at ${P.loadW} W needs ${((tw.det.dark * P.loadW) / 1000).toFixed(1)} kWh, against the ${P.capacityWh / 1000} kWh assumed here.`);
  if (top.cv.level !== 'ok') steps.push(`Plan relay coverage, or schedule critical operations inside the contact windows, for ${top.letter}'s gaps of up to ${dur(top.cv.longestGapHours)}.`);
  const coarse = ws.filter((w) => { const t = tileOf(w); return s.includes(w.s) && t && tileRes(t) > 20; }).map((w) => w.x.letter);
  if (coarse.length) steps.push(`Get finer terrain for ${and(coarse)}, for example from LROC NAC stereo models ${cite('lroc')}, before relying on ${coarse.length > 1 ? 'their' : 'its'} horizon.`);
  const tt = tileOf(tw);
  if (tt && tileRes(tt) <= 20) steps.push(`Check ${top.letter} against NASA's 5 m site models and their Monte Carlo realisations where they exist ${cite('barker2021')}.`);
  if (ws.some((w) => w.slipS && (w.slipS.pv.level !== w.det.pv.level || w.slipS.cv.level !== w.det.cv.level))) steps.push(`Treat the landing date as a hard constraint: a ${ctx.slip}-day delay changes at least one verdict.`);
  steps.push(`Replace the idealised power model (Sun-tracking ${P.panelW} W panel, constant ${P.loadW} W load) with the lander's own panel geometry and load profile.`);

  const html = `<h3>Recommendation</h3><p>${recommendation(all, d, ctx.generatedAt)}${trade.length ? ' ' + trade.join(' ') : ''}</p>`
    + `<h3>Risks</h3><ul class="r-notes">${risks}</ul><h3>Next steps</h3><ol class="r-notes">${steps.map((x) => `<li>${x}</li>`).join('')}</ol>`;
  return section('conclusion', 'Conclusion', html);
};
