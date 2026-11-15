// Pure logic behind the results sections (no DOM, no worker): scenario summaries over the mission, the ranking
// and recommendation, the abstract's wording, and which validation row applies to a site. Tested in
// results-logic.test.ts.
import type { Tile } from '../../core/dem';
import type { Metrics, ScenarioResult } from '../../core/api';
import { DEG, spFwd } from '../../core/geom';
import { commsVerdict, powerVerdict, type CommsVerdict, type PowerVerdict } from '../charts';
import { dur, utc } from '../format';
import { esc } from './dom';
import { cite } from './refs';

/* ---- one scenario over the mission ---- */

export interface Summary {
  letter: string; name: string; t: number; lat: number; lon: number;
  power: number; powerSd: number | null;  // mean % of rated solar power (Monte Carlo mean where available)
  anyLit: number; anyLitSd: number | null; // % of the time some of the Sun's disk is visible
  dark: number; darkSd: number | null;    // longest dark stretch, h
  earth: number; earthSd: number | null;  // % of the mission with Earth in view
  noEarth: number; noEarthSd: number | null; // longest stretch without Earth, h
  pv: PowerVerdict; cv: CommsVerdict;     // deterministic, as in the app
}

/** `r` must cover exactly the mission (core.scenario with days = mission length). Pass mc = false for like-for-like
 *  deterministic numbers (the delayed landing has no Monte Carlo). */
export function summarize(id: { letter: string; name: string; t: number; lat: number; lon: number }, r: ScenarioResult, days: number, mc = true): Summary {
  const u = mc ? r.uncertainty : null, m = r.metrics;
  const v = (k: keyof Metrics) => (u && Number.isFinite(u.mean[k]) ? u.mean[k] : Number(m[k]));
  const sd = (k: keyof Metrics) => (u && Number.isFinite(u.std[k]) ? u.std[k] : null);
  return {
    ...id,
    power: v('pctLit'), powerSd: sd('pctLit'), anyLit: v('pctAnyLit'), anyLitSd: sd('pctAnyLit'),
    dark: v('longestDarkHours'), darkSd: sd('longestDarkHours'),
    earth: v('pctEarth'), earthSd: sd('pctEarth'), noEarth: v('longestNoEarthHours'), noEarthSd: sd('longestNoEarthHours'),
    pv: powerVerdict(r.series, days * 24), cv: commsVerdict(r.series, r.mission, days * 24),
  };
}

export const pct = (x: number) => `${Math.round(x)}%`;
export const hours = (h: number) => (h < 0.5 ? 'none' : dur(h));
/** "92% ± 1%"; the ± is left out when it rounds to nothing. */
export const pm = (x: number, sd: number | null, f: (v: number) => string) => f(x) + (sd !== null && f(sd) !== f(0) ? ` ± ${f(sd)}` : '');
export const days = (d: number) => `${d}-day`;
const COUNT = ['no', 'one', 'two', 'three', 'four', 'five'];
export const count = (n: number) => COUNT[n] ?? String(n);
export const who = (s: Pick<Summary, 'letter' | 'name'>) => `${s.letter} (${esc(s.name)})`;
/** "A", "A and B", "A, B and C" */
export const and = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/* ---- ranking and recommendation ---- */

const LEVEL: Record<string, number> = { no: 0, marginal: 1, gaps: 1, ok: 2 };
export const score = (s: Summary) => LEVEL[s.pv.level] + LEVEL[s.cv.level];
const key = (s: Summary) => [score(s), Math.round(s.power), Math.round(s.earth)];

/** Best first: summed verdict score (OK 2, Marginal or Gaps 1, No 0), then mean power, then Earth in view (whole %). */
export function ranked(xs: Summary[]): Summary[] {
  return [...xs].sort((a, b) => { const ka = key(a), kb = key(b); return kb[0] - ka[0] || kb[1] - ka[1] || kb[2] - ka[2]; });
}

/** What keeps a scenario from passing both checks, e.g. ["power Marginal (lowest charge 12%)"]. */
export function failures(s: Summary): string[] {
  const out: string[] = [];
  if (s.pv.level !== 'ok') out.push(`power ${s.pv.label} (${s.pv.detail})`);
  if (s.cv.level !== 'ok') out.push(`comms ${s.cv.label} (${s.cv.detail})`);
  return out;
}

/** What a recommendation chooses from: the landings still to come when there are any; past ones are references. */
export function pool(xs: Summary[], now: number): Summary[] {
  const f = xs.filter((x) => x.t >= now);
  return f.length ? f : xs;
}

/** The recommendation, with its criterion, as HTML. `now` (ms) separates planned landings from past ones. */
export function recommendation(all: Summary[], missionDays: number, now: number): string {
  const xs = pool(all, now), past = all.filter((x) => !xs.includes(x));
  const ref = past.length ? ` ${and(past.map(who))} landed in the past and ${past.length > 1 ? 'serve only as references' : 'serves only as a reference'}.` : '';
  return choose(xs, missionDays, past.length ? 'future landings' : 'scenarios') + ref;
}

function choose(xs: Summary[], missionDays: number, noun: string): string {
  const r = ranked(xs), top = r[0], k = key(top).join();
  const ties = r.filter((x) => key(x).join() === k), f = failures(top), d = days(missionDays);
  if (xs.length === 1) {
    return f.length
      ? `We do not recommend scenario ${who(top)} as planned: our criterion is that power and comms are both OK over the ${d} mission, and it has ${and(f)}.`
      : `We recommend scenario ${who(top)}: it meets our criterion that power and comms are both OK over the ${d} mission.`;
  }
  const crit = `when the ${count(xs.length)} ${noun} are ranked by their summed power and comms verdicts over the ${d} mission (OK 2, Marginal or Gaps 1, No 0), then by mean solar power, then by time with Earth in view`;
  const s = ties.length > 1
    ? `We recommend scenarios ${and(ties.map(who))} equally: they tie for first ${crit}.`
    : `We recommend scenario ${who(top)}: it comes first ${crit}.`;
  return f.length ? `${s} No ${noun.slice(0, -1)} passes both checks; ${top.letter} has ${and(f)}.` : s;
}

/* ---- validation data (validation.json) ---- */

export interface Agreement { n: number; note: string; sun: { mae: number; bias: number; r: number }; earth: { mae: number; bias: number; r: number } }
export interface ValidationJson {
  horizons: { n: number; max_sep_deg: { sun: number; earth: number } };
  pgda: Agreement;
  pgda_other_regions: Record<string, Agreement>;
  pgda_240m_only_region: Agreement;
}

const REGION_NAMES: Record<string, string> = {
  shackleton: 'Shackleton and Connecting Ridge', mouton_nobile: 'Mons Mouton and Nobile', malapert: 'Malapert', haworth: 'Haworth', degerlache: 'de Gerlache',
};

/** Every 20 m test region with its agreement, Shackleton (the main, 300-point test) first. */
export function regions20(v: ValidationJson): { name: string; a: Agreement }[] {
  return [{ name: REGION_NAMES.shackleton, a: v.pgda }, ...Object.entries(v.pgda_other_regions).map(([k, a]) => ({ name: REGION_NAMES[k] ?? k, a }))];
}

/** The DEM tile that serves a point: the first (finest) tile containing it, as core/dem.ts picks. */
export function tileAt(tiles: Tile[], lat: number, lon: number): Tile | undefined {
  const [x, y] = spFwd(lat, lon);
  return tiles.find((t) => t.proj === 'eqc'
    || (lat < 0 && x >= t.x0! && x <= t.x0! + (t.w - 1) * t.px! && y <= t.y0! && y >= t.y0! - (t.h - 1) * t.px!));
}

/** The validation row that applies to a tile: its own 20 m region, the 240 m-only test for the coarse polar tier,
 *  none for the global model (NASA's maps stop at about 85°S). */
export function agreementFor(v: ValidationJson, tile: Tile | undefined): { name: string; a: Agreement } | null {
  if (!tile || tile.proj !== 'spstere') return null;
  const id = tile.id.replace(/_20m$/, '');
  if (id === 'shackleton') return { name: REGION_NAMES.shackleton, a: v.pgda };
  if (v.pgda_other_regions[id]) return { name: REGION_NAMES[id] ?? id, a: v.pgda_other_regions[id] };
  return tile.px! > 20 ? { name: 'the 240 m-only test region', a: v.pgda_240m_only_region } : null;
}

/* ---- live check: our long-term visibility at the exact point vs NASA's map ---- */

/** Earth's mean angular radius seen from the Moon (Earth radius 6371 km, mean distance 384 400 km), deg. Passed as a
 *  negative earthMargin it makes "any part of Earth's disk above the terrain" count, NASA's rule (prep/validate.py). */
export const EARTH_DISK_DEG = Math.asin(6371 / 384400) / DEG;

/** Share of samples (%) with any of the Sun's disk up, and with Earth in view. */
export function longTerm(sunFrac: ArrayLike<number>, earthVis: ArrayLike<number>): { sun: number; earth: number } {
  let s = 0, e = 0;
  for (let i = 0; i < sunFrac.length; i++) { if (sunFrac[i] > 0) s++; e += earthVis[i]; }
  const n = sunFrac.length || 1;
  return { sun: (100 * s) / n, earth: (100 * e) / n };
}

/** "+0.8 pts, within the region's mean error of 1.5 pts" / "+4.1 pts, 2.7× the region's mean error of 1.5 pts". */
export function versus(ours: number, nasa: number, maePts: number): { text: string; within: boolean } {
  const d = ours - nasa, within = Math.abs(d) <= maePts;
  const ds = `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)} pts`;
  return { within, text: within ? `${ds}, within the region's mean error of ${maePts.toFixed(1)} pts` : `${ds}, ${(Math.abs(d) / maePts).toFixed(1)}× the region's mean error of ${maePts.toFixed(1)} pts` };
}

/** Start index and mean of the best window of n samples (sliding mean); the whole array when it is shorter. */
export function bestWindow(v: ArrayLike<number>, n: number): { i: number; mean: number } {
  n = Math.max(1, Math.min(n, v.length));
  let s = 0;
  for (let i = 0; i < n; i++) s += v[i];
  let best = s, bi = 0;
  for (let i = n; i < v.length; i++) { s += v[i] - v[i - n]; if (s > best) { best = s; bi = i - n + 1; } }
  return { i: bi, mean: best / n };
}

/* ---- abstract ---- */

/** Letters sharing each verdict, e.g. "No at A, B and C, OK at D". */
export function byVerdict(xs: Summary[], get: (s: Summary) => { label: string }): string {
  const m = new Map<string, string[]>();
  for (const x of xs) { const l = get(x).label; m.set(l, [...(m.get(l) ?? []), x.letter]); }
  return [...m].map(([l, ls]) => `${l} at ${and(ls)}`).join(', ');
}

/** "45% ± 1% (C)" to "99% (B, D)": the lowest and highest value with the scenarios that have it; null when all agree. */
function extremes(xs: Summary[], get: (s: Summary) => number, sd: (s: Summary) => number | null, f: (v: number) => string): [string, string] | null {
  const lo = xs.reduce((a, b) => (get(b) < get(a) ? b : a)), hi = xs.reduce((a, b) => (get(b) > get(a) ? b : a));
  if (f(get(lo)) === f(get(hi))) return null;
  const at = (s: Summary) => `${pm(get(s), sd(s), f)} (${xs.filter((x) => f(get(x)) === f(get(s))).map((x) => x.letter).join(', ')})`;
  return [at(lo), at(hi)];
}

/** The abstract as HTML, from the mission summaries and validation.json (null when it could not be loaded). */
export function abstractHtml(xs: Summary[], missionDays: number, v: ValidationJson | null, now: number): string {
  const n = xs.length, d = days(missionDays), dates = new Map<string, Summary[]>();
  for (const x of xs) { const k = utc(x.t).slice(0, 10); dates.set(k, [...(dates.get(k) ?? []), x]); }
  const aim = `We compare ${n === 1 ? 'one landing scenario' : `${count(n)} landing scenarios`} for a solar-powered lander that talks directly to Earth: `
    + `${[...dates].map(([day, ss]) => `${and(ss.map(who))}, landing ${day}`).join('; ')}. `
    + `We trace the Sun and Earth over each site's terrain horizon for the first ${missionDays} days after landing, from NASA LOLA terrain ${cite('barker2023', 'ldem16')} `
    + `and the JPL DE440 ephemeris ${cite('de440')}; ± is one standard deviation over Monte Carlo terrain-error draws.`;
  let res: string;
  if (n <= 2) {
    const one = (s: Summary) => `mean solar power ${pm(s.power, s.powerSd, pct)} of rated, Earth in view ${pm(s.earth, s.earthSd, pct)} of the time, longest dark period ${pm(s.dark, s.darkSd, hours)}; power ${s.pv.label}, comms ${s.cv.label}`;
    res = n === 1 ? `Over the ${d} mission, ${xs[0].letter} has ${one(xs[0])}.` : xs.map((s) => `${s.letter}: ${one(s)}.`).join(' ');
  } else {
    const p = extremes(xs, (s) => s.power, (s) => s.powerSd, pct), e = extremes(xs, (s) => s.earth, (s) => s.earthSd, pct), k = extremes(xs, (s) => s.dark, (s) => s.darkSd, hours);
    res = `Over the ${d} mission, ${p ? `mean solar power runs from ${p[0]} to ${p[1]} of rated` : `mean solar power is ${pct(xs[0].power)} of rated everywhere`}, `
      + `${e ? `Earth is in view from ${e[0]} to ${e[1]} of the time` : `Earth is in view ${pct(xs[0].earth)} of the time everywhere`}, `
      + `and ${k ? `the longest dark period runs from ${k[0]} to ${k[1]}` : `the longest dark period is ${hours(xs[0].dark)} everywhere`}. `
      + `Power is ${byVerdict(xs, (s) => s.pv)}; comms is ${byVerdict(xs, (s) => s.cv)}.`;
  }
  let check = '';
  if (v) {
    const r = regions20(v), mm = (k: 'sun' | 'earth') => {
      const a = r.map((x) => x.a[k].mae * 100), lo = Math.min(...a).toFixed(1), hi = Math.max(...a).toFixed(1);
      return lo === hi ? lo : `${lo}–${hi}`;
    };
    const arcsec = (deg: number) => `${+(deg * 3600).toPrecision(2)}″`;
    check = ` Sun and Earth directions match JPL Horizons ${cite('horizons')} to ${arcsec(v.horizons.max_sep_deg.sun)} and ${arcsec(v.horizons.max_sep_deg.earth)} at worst, `
      + `and long-term visibility matches NASA's PGDA maps ${cite('mazarico2011')} to a mean ${mm('sun')} (Sun) and ${mm('earth')} (Earth) percentage points in ${count(r.length)} 20 m test regions.`;
  }
  return `<p>${aim}</p><p>${res}${check} ${recommendation(xs, missionDays, now)}</p>`;
}
