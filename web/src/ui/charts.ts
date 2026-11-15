// Inspector charts: the pure maths (unit-tested, no DOM) and the canvas drawing for the power / Sun-elevation
// chart and the windows bar. Nothing here touches `window` or `document` at import time.
import type { Mission, ScenarioResult, Series } from '../core/api';
import { battery } from '../core/extra';
import { horizonAt } from '../core/geom';
import { dur } from './format';
import { STEPS } from './timeline';

/* ------------------------------------------------------------------ constants */

/**
 * Scenario A–D colours. Checked with the dataviz palette validator against #0a0b0d together with the Sun amber
 * (#f2b544) and Earth blue (#5b9cf5): every pair is at least ΔE 10.9 apart under protan / deutan simulation,
 * 9.2 under tritan and 16.5 in normal vision; contrast against the background is above 5:1.
 * A is the neutral foreground, so "the first scenario" reads as the default ink.
 */
export const SCENARIO_COLORS = ['#e8e6e1', '#ee5b33', '#5fd0a6', '#d868b4'] as const;
export const LETTERS = 'ABCD';

export type Metric = 'power' | 'elevation';
export const METRICS: readonly Metric[] = ['power', 'elevation'];
export const DURATIONS = [7, 14, 29.5] as const;
export type DurationDays = (typeof DURATIONS)[number];

const BG = '#0a0b0d', FG = '#e8e6e1', MUTED = '#8e939c', FAINT = '#686d77', TRACK = '#14171b';
const GRID = 'rgba(232,230,225,0.08)', AXIS = '#343a44';
export const SUN = '#f2b544', EARTH = '#5b9cf5', DSN = '#b9d5fb';
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/* ------------------------------------------------------------------ pure maths */

export interface Window { start: number; end: number }

/** Runs of truthy samples as [start, end) in hours. Sample i covers [i, i + 1) * stepHours. */
export function windows(mask: ArrayLike<number>, stepHours = 1): Window[] {
  const out: Window[] = [];
  let s = -1;
  for (let i = 0; i <= mask.length; i++) {
    const on = i < mask.length && mask[i] > 0;
    if (on && s < 0) s = i;
    if (!on && s >= 0) { out.push({ start: s * stepHours, end: i * stepHours }); s = -1; }
  }
  return out;
}

/** The run of equal truthiness that contains sample i: [start, end) in samples, and whether it is an "on" run. */
export function runAt(mask: ArrayLike<number>, i: number): { start: number; end: number; on: boolean } | null {
  const n = mask.length;
  if (!n || !(i >= 0 && i < n)) return null;
  const on = mask[i] > 0;
  let a = i, b = i + 1;
  while (a > 0 && mask[a - 1] > 0 === on) a--;
  while (b < n && mask[b] > 0 === on) b++;
  return { start: a, end: b, on };
}

/** Smallest of 1, 2, 5 x 10^k that is >= raw. */
export function niceStep(raw: number): number {
  if (!(raw > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(raw)), m = raw / p;
  return p * (m <= 1.0000001 ? 1 : m <= 2.0000001 ? 2 : m <= 5.0000001 ? 5 : 10);
}

/** Round ticks covering [lo, hi]: the first is <= lo and the last is >= hi. About `target` intervals. */
export function niceTicks(lo: number, hi: number, target = 4): number[] {
  if (!(hi > lo)) hi = lo + 1;
  const step = niceStep((hi - lo) / Math.max(1, target));
  const a = Math.floor(lo / step + 1e-9), b = Math.ceil(hi / step - 1e-9);
  const out: number[] = [];
  for (let k = a; k <= b; k++) out.push(+(k * step).toFixed(10));
  return out;
}

/** x-axis ticks in days after landing: every day for a week, every 2 d for 14 d, every 5 d for a lunar day. */
export function dayTicks(durationDays: number): number[] {
  const step = durationDays <= 7 ? 1 : durationDays <= 14 ? 2 : 5;
  const out: number[] = [];
  for (let d = 0; d <= durationDays + 1e-9; d += step) out.push(d);
  return out;
}

/** Number of series samples inside a mission of `durationHours` (at least 1, at most the series). */
export function samplesIn(s: { t: ArrayLike<number>; stepMs: number }, durationHours: number): number {
  return Math.min(s.t.length, Math.max(1, Math.round(durationHours / (s.stepMs / 3600e3))));
}

const powerCache = new WeakMap<ScenarioResult, Float32Array>(), clearCache = new WeakMap<ScenarioResult, Float32Array>();

/** Available solar power as % of rated output: a Sun-tracking panel makes power in proportion to the visible disk. */
export function powerPct(r: ScenarioResult): Float32Array {
  let v = powerCache.get(r);
  if (!v) { v = Float32Array.from(r.series.sunFrac, (f) => f * 100); powerCache.set(r, v); }
  return v;
}

/** Sun elevation minus the terrain horizon in the Sun's direction, deg. Above 0 = the centre of the disk is clear. */
export function sunClearance(r: ScenarioResult): Float32Array {
  let v = clearCache.get(r);
  if (!v) {
    const s = r.series, el = r.horizon.el;
    v = new Float32Array(s.t.length);
    for (let i = 0; i < v.length; i++) v[i] = s.sunEl[i] - horizonAt(el, s.sunAz[i]);
    clearCache.set(r, v);
  }
  return v;
}

export interface YScale { lo: number; hi: number; ticks: number[] }

/**
 * y range of the elevation chart over the first n samples. ±6° when everything fits (polar sites). Otherwise a
 * round range that holds the highest value; below the horizon it shows at most half as far down as it goes up
 * (never less than 6°), because how far under the horizon the Sun is at night does not matter for planning.
 */
export function elevationRange(list: ArrayLike<number>[], n: number): YScale {
  let mn = 0, mx = 0;
  for (const v of list) for (let i = 0; i < Math.min(n, v.length); i++) { if (v[i] < mn) mn = v[i]; if (v[i] > mx) mx = v[i]; }
  if (mx <= 6) return { lo: -6, hi: 6, ticks: [-6, -3, 0, 3, 6] };
  const bot = Math.max(mn, -Math.max(6, mx / 2));
  const ticks = niceTicks(bot, mx, 5).filter((t) => t <= 90); // nothing is higher than the zenith
  return { lo: ticks[0], hi: Math.max(ticks[ticks.length - 1], Math.min(90, mx)), ticks };
}

export const POWER_SCALE: YScale = { lo: 0, hi: 100, ticks: [0, 50, 100] };

/* ---- verdicts ---- */

export type PowerLevel = 'ok' | 'marginal' | 'no';
export type CommsLevel = 'ok' | 'gaps' | 'no';
export interface Verdict<L extends string = string> { level: L; label: string; detail: string }
export interface CommsVerdict extends Verdict<CommsLevel> { basis: 'dsn' | 'earth'; longestGapHours: number }
export interface PowerVerdict extends Verdict<PowerLevel> { minSoc: number; survivalHours: number | null }

/** Printed under the badges: the whole rule, nothing hidden. */
export const POWER_RESERVE = 0.2, COMMS_MAX_GAP_H = 24;

const days = (h: number) => `${+(h / 24).toFixed(1)} d`;

/**
 * Power over the mission: the default battery model (200 W Sun-tracking panel, 100 W load, 1.5 kWh, starts full).
 * OK = charge never below 20%; Marginal = dips below 20% but never empties; No = empties.
 */
export function powerVerdict(s: Pick<Series, 't' | 'stepMs' | 'sunFrac'>, durationHours: number): PowerVerdict {
  const n = samplesIn(s, durationHours), stepH = s.stepMs / 3600e3;
  const b = battery(s.sunFrac.subarray(0, n), stepH);
  const low = `lowest charge ${Math.round(b.minSoc * 100)}%`;
  if (b.survivalH !== null) return { level: 'no', label: 'No', detail: `empty after ${dur(b.survivalH)}`, minSoc: 0, survivalHours: b.survivalH };
  if (b.minSoc < POWER_RESERVE - 1e-9) return { level: 'marginal', label: 'Marginal', detail: low, minSoc: b.minSoc, survivalHours: null };
  return { level: 'ok', label: 'OK', detail: low, minSoc: b.minSoc, survivalHours: null };
}

/** Per-sample contact: Earth in view and a DSN station seeing the Moon; Earth in view alone when there is no station data. */
export function contactMask(s: Pick<Series, 'earthVis'>, mission: Pick<Mission, 'commsHours' | 'dsn'>): Uint8Array {
  if (mission.commsHours === null) return s.earthVis;
  return Uint8Array.from(s.earthVis, (v, i) => (v && mission.dsn[i] ? 1 : 0));
}

/**
 * Comms over the mission. OK = the longest stretch without contact is 24 h or less; Gaps = there is contact but
 * the longest stretch without it is more than 24 h; No = no contact at all. A stretch that is still running at
 * either end of the mission counts with the length it has inside the mission.
 */
export function commsVerdict(s: Pick<Series, 't' | 'stepMs' | 'earthVis'>, mission: Pick<Mission, 'commsHours' | 'dsn'>, durationHours: number): CommsVerdict {
  const n = samplesIn(s, durationHours), stepH = s.stepMs / 3600e3;
  const mask = contactMask(s, mission), basis = mission.commsHours === null ? 'earth' : 'dsn';
  let run = 0, longest = 0, any = false;
  for (let i = 0; i < n; i++) {
    if (mask[i]) { any = true; run = 0; } else { run++; if (run > longest) longest = run; }
  }
  const gap = longest * stepH;
  if (!any) return { level: 'no', label: 'No', detail: `no contact in ${days(n * stepH)}`, basis, longestGapHours: gap };
  const detail = gap ? `longest gap ${dur(gap)}` : 'no gaps';
  return gap <= COMMS_MAX_GAP_H
    ? { level: 'ok', label: 'OK', detail, basis, longestGapHours: gap }
    : { level: 'gaps', label: 'Gaps', detail, basis, longestGapHours: gap };
}

/* ---- windows bar ---- */

export const WINDOW_ROWS = ['Sunlit', 'Earth in view', 'DSN contact'] as const;
const OFF_NAMES = ['Dark', 'Earth hidden', 'No DSN contact'];

/** The mask a windows row draws; null for the DSN row when no station table covers the dates. */
export function rowMask(r: ScenarioResult, row: number): ArrayLike<number> | null {
  if (row === 0) return r.series.sunFrac;
  if (row === 1) return r.series.earthVis;
  return r.mission.commsHours === null ? null : contactMask(r.series, r.mission);
}

const dayNo = (h: number) => (h / 24).toFixed(1);

/** "Sunlit for 6 d 13 h, ends day 6.5" for the run under the cursor; runs are measured on the whole 29.5 d series. */
export function windowText(row: number, run: { start: number; end: number; on: boolean }, total: number, stepHours = 1): string {
  const name = run.on ? WINDOW_ROWS[row] : OFF_NAMES[row];
  const a = run.start * stepHours, b = run.end * stepHours, len = dur(b - a);
  if (run.start === 0 && run.end >= total) return `${name} for all ${days(total * stepHours)}`;
  if (run.end >= total) return `${name} for ${len} from day ${dayNo(a)}, continues past day ${dayNo(b)}`;
  return `${name} for ${len}, ends day ${dayNo(b)}`;
}

export const WIN = { row: 6, gap: 2, pitch: 30, top: 6, axis: 20 };
const GROUP_H = 3 * WIN.row + 2 * WIN.gap;
export const windowsHeight = (n: number) => WIN.top + Math.max(1, n) * WIN.pitch - (WIN.pitch - GROUP_H) + 4 + WIN.axis;

/* ---- shared plot geometry ---- */

export const PAD = { l: 34, r: 12, t: 9, b: 20 };

/** Hours after landing under plot x (CSS px from the canvas's left edge), clamped to the mission and the series. */
export function hourAtX(x: number, width: number, durationDays: number): number {
  const pw = Math.max(1, width - PAD.l - PAD.r);
  return Math.min(STEPS - 1, Math.min(1, Math.max(0, (x - PAD.l) / pw)) * durationDays * 24);
}
export const xAtHour = (h: number, width: number, durationDays: number) => PAD.l + (h / (durationDays * 24)) * (width - PAD.l - PAD.r);

/** Which scenario group and row a point of the windows bar is in; null between rows. */
export function windowsHit(y: number, count: number): { scenario: number; row: number } | null {
  const g = Math.floor((y - WIN.top) / WIN.pitch), dy = y - WIN.top - g * WIN.pitch;
  if (g < 0 || g >= count || dy < -1 || dy > GROUP_H + 1) return null;
  return { scenario: g, row: Math.min(2, Math.max(0, Math.floor(dy / (WIN.row + WIN.gap)))) };
}

/* ---- readout ---- */

export function formatValue(metric: Metric, v: number): string {
  if (metric === 'power') return `${v > 0 && v < 0.5 ? '<1' : Math.round(v)}%`;
  const a = Math.abs(v).toFixed(1);
  return `${a === '0.0' ? '' : v > 0 ? '+' : '−'}${a}°`;
}

export interface ChartItem { letter: string; color: string; result?: ScenarioResult; slipped?: ScenarioResult }
export interface ChartModel { metric: Metric; durationDays: number; items: ChartItem[]; selected: number }

const valuesOf = (metric: Metric, r: ScenarioResult) => (metric === 'power' ? powerPct(r) : sunClearance(r));

/** Value of every scenario at an hour (nearest sample); null where there is no result yet. */
export function chartValues(m: ChartModel, hour: number): (number | null)[] {
  return m.items.map((it) => {
    if (!it.result) return null;
    const v = valuesOf(m.metric, it.result);
    return v[Math.min(v.length - 1, Math.max(0, Math.round(hour)))];
  });
}

/* ------------------------------------------------------------------ drawing */

/**
 * A canvas with a cached static layer. `render()` blits the layer and draws the overlay (playhead, hover) on
 * top, so a scrub frame costs one drawImage and a few lines. `invalidate()` after the data or options change.
 */
export class Plot {
  private layer: HTMLCanvasElement;
  private dirty = true;
  W = 0; H = 0;
  constructor(
    readonly canvas: HTMLCanvasElement,
    private drawStatic: (g: CanvasRenderingContext2D, W: number, H: number) => void,
    private drawOver: (g: CanvasRenderingContext2D, W: number, H: number) => void,
  ) { this.layer = document.createElement('canvas'); }

  invalidate() { this.dirty = true; }

  render() {
    const c = this.canvas, dpr = window.devicePixelRatio || 1;
    const W = c.clientWidth, H = c.clientHeight;
    if (!W || !H) return; // hidden (other tab, closed dialog): keep the dirty flag for later
    const bw = Math.round(W * dpr), bh = Math.round(H * dpr);
    if (c.width !== bw || c.height !== bh) { c.width = bw; c.height = bh; this.dirty = true; }
    const g = c.getContext('2d');
    if (!g) return;
    if (this.dirty) {
      const l = this.layer;
      if (l.width !== bw || l.height !== bh) { l.width = bw; l.height = bh; }
      const lg = l.getContext('2d')!;
      lg.setTransform(dpr, 0, 0, dpr, 0, 0);
      lg.clearRect(0, 0, W, H);
      this.W = W; this.H = H;
      this.drawStatic(lg, W, H);
      this.dirty = false;
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, bw, bh);
    g.drawImage(this.layer, 0, 0);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawOver(g, W, H);
  }
}

type G = CanvasRenderingContext2D;
const snap = (v: number) => Math.round(v) + 0.5;

function dayAxis(g: G, W: number, y: number, durationDays: number, gridTop?: number) {
  const ticks = dayTicks(durationDays), right = W - PAD.r;
  g.font = `10px ${MONO}`; g.textBaseline = 'top'; g.lineWidth = 1;
  if (gridTop !== undefined) {
    g.strokeStyle = GRID; g.beginPath();
    for (const d of ticks) { if (!d) continue; const x = snap(xAtHour(d * 24, W, durationDays)); g.moveTo(x, gridTop); g.lineTo(x, y); }
    g.stroke();
  }
  g.strokeStyle = AXIS; g.fillStyle = MUTED; g.beginPath();
  g.moveTo(PAD.l, snap(y)); g.lineTo(right, snap(y));
  ticks.forEach((d, k) => {
    const x = snap(xAtHour(d * 24, W, durationDays)), last = k === ticks.length - 1;
    g.moveTo(x, y); g.lineTo(x, y + 4);
    const label = last ? `${d} d` : String(d);
    const w = g.measureText(label).width;
    g.textAlign = 'left';
    g.fillText(label, Math.min(W - 1 - w, Math.max(PAD.l - 2, x - w / 2)), y + 7);
  });
  g.stroke();
}

export interface ChartScale { X(h: number): number; Y(v: number): number; top: number; bottom: number; left: number; right: number; durH: number; values: (Float32Array | undefined)[] }

/** The static layer of the power / elevation chart. Returns the scale the overlay needs. */
export function drawChart(g: G, W: number, H: number, m: ChartModel): ChartScale {
  const left = PAD.l, right = W - PAD.r, top = PAD.t, bottom = H - PAD.b;
  const durH = m.durationDays * 24, n = Math.min(STEPS, Math.floor(durH) + 1);
  const values = m.items.map((it) => (it.result ? valuesOf(m.metric, it.result) : undefined));
  // Elevation: the range fits the selected scenario, so a polar site keeps its ±6° detail next to a mid-latitude one
  // (whose line then leaves the top of the chart; the readout still gives its value).
  const selValues = values[m.selected];
  const ys = m.metric === 'power' ? POWER_SCALE : elevationRange(selValues ? [selValues] : values.filter((v): v is Float32Array => !!v), n);
  const X = (h: number) => left + (h / durH) * (right - left);
  const Y = (v: number) => top + ((ys.hi - v) / (ys.hi - ys.lo)) * (bottom - top);
  const scale: ChartScale = { X, Y, top, bottom, left, right, durH, values };

  g.fillStyle = BG; g.fillRect(0, 0, W, H);
  if (right - left < 40 || bottom - top < 30) return scale;

  // grid and y labels
  g.font = `10px ${MONO}`; g.textAlign = 'right'; g.textBaseline = 'middle'; g.lineWidth = 1;
  g.strokeStyle = GRID; g.fillStyle = MUTED; g.beginPath();
  for (const t of ys.ticks) {
    const y = snap(Y(t));
    if (t !== ys.lo) { g.moveTo(left, y); g.lineTo(right, y); }
    const label = m.metric === 'power' ? (t === 100 ? '100%' : String(t)) : `${t > 0 ? '+' : t < 0 ? '−' : ''}${Math.abs(t)}°`;
    g.fillText(label, left - 6, y);
  }
  g.stroke();
  dayAxis(g, W, bottom, m.durationDays, top);

  g.save();
  g.beginPath(); g.rect(left, top - 3, right - left + 1, bottom - top + 5); g.clip();
  g.lineJoin = 'round'; g.lineCap = 'butt';

  const path = (v: ArrayLike<number>, scaleBy = 1) => {
    g.beginPath();
    for (let i = 0; i < Math.min(n, v.length); i++) { const x = X(i), y = Y(v[i] * scaleBy); i ? g.lineTo(x, y) : g.moveTo(x, y); }
  };
  const sel = m.items[m.selected], selV = values[m.selected];

  if (m.metric === 'elevation') {
    const y0 = Y(0);
    if (selV) { // faint sunlight above the terrain horizon, for the selected scenario
      g.save();
      g.beginPath(); g.rect(left, top - 3, right - left + 1, y0 - top + 3); g.clip();
      path(selV);
      g.lineTo(X(Math.min(n, selV.length) - 1), y0); g.lineTo(X(0), y0); g.closePath();
      g.fillStyle = SUN; g.globalAlpha = 0.14; g.fill();
      g.restore();
    }
    g.strokeStyle = 'rgba(232,230,225,0.34)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(left, snap(y0)); g.lineTo(right, snap(y0)); g.stroke();

  } else if (sel?.result?.uncertainty && selV) { // Monte Carlo 10–90% band around the selected line
    const u = sel.result.uncertainty, k = Math.min(n, selV.length);
    if (u.fracLo && u.fracHi) {
      g.beginPath();
      for (let i = 0; i < k; i++) { const x = X(i), y = Y(u.fracHi[i] * 100); i ? g.lineTo(x, y) : g.moveTo(x, y); }
      for (let i = k - 1; i >= 0; i--) g.lineTo(X(i), Y(u.fracLo[i] * 100));
      g.closePath();
      g.fillStyle = sel.color; g.globalAlpha = 0.24; g.fill(); g.globalAlpha = 1;
    }
  }

  // other scenarios, then the selected one's delayed series (dashed), then the selected one on top
  g.lineWidth = 1.25; g.globalAlpha = 0.7;
  m.items.forEach((it, i) => {
    const v = values[i];
    if (!v || i === m.selected) return;
    path(v); g.strokeStyle = it.color; g.stroke();
  });
  g.globalAlpha = 1;
  if (sel?.slipped) {
    path(valuesOf(m.metric, sel.slipped));
    g.strokeStyle = sel.color; g.lineWidth = 1.25; g.setLineDash([4, 3]); g.stroke(); g.setLineDash([]);
  }
  if (selV) {
    path(selV);
    g.strokeStyle = BG; g.lineWidth = 4; g.globalAlpha = 0.55; g.stroke(); // separates it from the lines underneath
    g.globalAlpha = 1; g.strokeStyle = sel.color; g.lineWidth = 2; g.stroke();
  }
  if (m.metric === 'elevation') { // label last, on a patch of background, so the lines never run through it
    const text = 'terrain horizon', y0 = Y(0);
    g.font = `10px ${MONO}`; g.textAlign = 'right'; g.textBaseline = 'top';
    const w = g.measureText(text).width;
    g.fillStyle = BG; g.globalAlpha = 0.8; g.fillRect(right - w - 6, y0 + 3, w + 5, 13); g.globalAlpha = 1;
    g.fillStyle = MUTED; g.fillText(text, right - 3, y0 + 5);
  }
  g.restore();
  return scale;
}

function playhead(g: G, x: number, top: number, bottom: number) {
  const px = snap(x);
  g.strokeStyle = FG; g.lineWidth = 1;
  g.beginPath(); g.moveTo(px, top); g.lineTo(px, bottom); g.stroke();
  g.fillStyle = FG; g.fillRect(px - 3.5, top, 7, 3);
}
/** The playhead is later than the mission shown: a small arrow at the right edge instead of a line. */
function beyond(g: G, right: number, top: number) {
  g.fillStyle = FG;
  g.beginPath(); g.moveTo(right + 3, top); g.lineTo(right + 9, top + 4); g.lineTo(right + 3, top + 8); g.closePath(); g.fill();
}
function crosshair(g: G, x: number, top: number, bottom: number) {
  g.strokeStyle = MUTED; g.lineWidth = 1; g.setLineDash([2, 3]);
  g.beginPath(); g.moveTo(snap(x), top); g.lineTo(snap(x), bottom); g.stroke(); g.setLineDash([]);
}

/** Playhead, and the hover crosshair with a dot on every line. `play` and `hover` are hours after landing. */
export function drawChartOverlay(g: G, sc: ChartScale, m: ChartModel, play: number, hover: number | null) {
  if (sc.right - sc.left < 40) return;
  if (play <= sc.durH) playhead(g, sc.X(play), sc.top - 3, sc.bottom);
  else beyond(g, sc.right - 10, sc.top - 3);
  if (hover === null) return;
  crosshair(g, sc.X(hover), sc.top - 3, sc.bottom);
  const i = Math.round(hover);
  const order = m.items.map((_, k) => k).filter((k) => k !== m.selected).concat(m.selected);
  for (const k of order) {
    const v = sc.values[k];
    if (!v || i >= v.length) continue;
    const y = Math.min(sc.bottom, Math.max(sc.top - 2, sc.Y(v[i])));
    g.beginPath(); g.arc(sc.X(i), y, 3, 0, Math.PI * 2);
    g.fillStyle = m.items[k].color; g.fill();
    g.strokeStyle = BG; g.lineWidth = 1.5; g.stroke();
  }
}

/** The static layer of the windows bar: per scenario, rows for sunlight, Earth in view and DSN contact. */
export function drawWindows(g: G, W: number, H: number, m: ChartModel) {
  const left = PAD.l, right = W - PAD.r, pw = right - left;
  const durH = m.durationDays * 24;
  g.fillStyle = BG; g.fillRect(0, 0, W, H);
  if (pw < 40) return;
  const X = (h: number) => left + (Math.min(h, durH) / durH) * pw;
  const axisY = H - WIN.axis;

  m.items.forEach((it, k) => {
    const y0 = WIN.top + k * WIN.pitch, on = k === m.selected;
    g.font = `600 11px ${MONO}`; g.textAlign = 'left'; g.textBaseline = 'middle';
    g.fillStyle = it.color; g.globalAlpha = on ? 1 : 0.8;
    g.fillText(it.letter, 6, y0 + GROUP_H / 2 + 0.5);
    g.globalAlpha = 1;
    if (on) { g.fillStyle = it.color; g.fillRect(left - 7, y0, 2, GROUP_H); }
    for (let row = 0; row < 3; row++) {
      const y = y0 + row * (WIN.row + WIN.gap);
      const mask = it.result ? rowMask(it.result, row) : undefined;
      if (mask === null) { // Apollo-era dates
        g.font = `9px ${MONO}`; g.fillStyle = FAINT; g.textBaseline = 'middle';
        g.fillText('no station data', left + 1, y + WIN.row / 2 + 0.5);
        continue;
      }
      g.fillStyle = TRACK; g.fillRect(left, y, pw, WIN.row);
      if (!mask) continue;
      const n = Math.min(mask.length, Math.ceil(durH));
      if (row === 0) { // sunlight: one column per CSS pixel, dimmer where only part of the disk shows
        g.fillStyle = SUN;
        for (let x = 0; x < pw; x++) {
          const i0 = Math.min(n - 1, Math.floor((x / pw) * durH)), i1 = Math.min(n, Math.max(i0 + 1, Math.floor(((x + 1) / pw) * durH)));
          let s = 0;
          for (let i = i0; i < i1; i++) s += mask[i];
          if (s <= 0) continue;
          g.globalAlpha = 0.28 + 0.72 * Math.min(1, s / (i1 - i0));
          g.fillRect(left + x, y, 1, WIN.row);
        }
        g.globalAlpha = 1;
      } else {
        g.fillStyle = row === 1 ? EARTH : DSN;
        for (const w of windows(Array.prototype.slice.call(mask, 0, n) as number[])) {
          const a = Math.round(X(w.start)), b = Math.max(a + 1, Math.round(X(w.end)));
          g.fillRect(a, y, Math.min(b, right) - a, WIN.row);
        }
      }
    }
  });
  dayAxis(g, W, axisY, m.durationDays);
}

/** Shared playhead and the hover line. */
export function drawWindowsOverlay(g: G, W: number, H: number, m: ChartModel, play: number, hover: number | null) {
  const durH = m.durationDays * 24, bottom = H - WIN.axis;
  if (W - PAD.l - PAD.r < 40) return;
  if (play <= durH) playhead(g, xAtHour(play, W, m.durationDays), WIN.top - 4, bottom);
  else beyond(g, W - PAD.r - 10, WIN.top - 5);
  if (hover !== null) crosshair(g, xAtHour(hover, W, m.durationDays), WIN.top - 4, bottom);
}
