import type { StripResult } from '../core/api';

export interface StripOptions {
  /** Highlight this time (ms) with a marker, e.g. the scenario's landing date. */
  markT?: number;
  /** Optional second highlight, e.g. the slipped landing date. */
  markT2?: number;
}

const BG = '#0b0e14', TEXT = '#cfd6e4', LABEL_W = 38, AXIS_H = 13, GAP = 2;
const MONTHS = 'JFMAMJJASOND';

const span = (s: StripResult) => s.sunFrac.length * s.stepMs;

/** Lerp between two RGB triples, t in 0..1. */
function ramp(a: number[], b: number[], t: number): string {
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`;
}
const DARK = [22, 26, 36], AMBER = [255, 176, 46], BLUE = [70, 150, 255];

/** Draws a year heat-strip (lit fraction + Earth-visible rows) into the canvas. */
export function drawStrip(canvas: HTMLCanvasElement, strip: StripResult, opts: StripOptions = {}): void {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(1, Math.round(r.width)), H = Math.max(1, Math.round(r.height));
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);

  const n = strip.sunFrac.length, plotW = W - LABEL_W;
  const rowH = Math.max(4, (H - AXIS_H - GAP) / 2);
  const sunY = 0, earthY = rowH + GAP;

  ctx.font = '10px system-ui, sans-serif';
  ctx.fillStyle = TEXT; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  ctx.fillText('Sun', 4, sunY + rowH / 2);
  ctx.fillText('Earth', 4, earthY + rowH / 2);
  if (n === 0 || plotW <= 0) return;

  // One column per CSS pixel; each takes the mean of the samples falling into it.
  for (let x = 0; x < plotW; x++) {
    const i0 = Math.floor((x * n) / plotW), i1 = Math.max(i0 + 1, Math.floor(((x + 1) * n) / plotW));
    let s = 0, e = 0;
    for (let i = i0; i < i1; i++) { s += strip.sunFrac[i]; e += strip.earthVis[i]; }
    const k = i1 - i0;
    ctx.fillStyle = ramp(DARK, AMBER, s / k); ctx.fillRect(LABEL_W + x, sunY, 1, rowH);
    ctx.fillStyle = ramp(DARK, BLUE, e / k); ctx.fillRect(LABEL_W + x, earthY, 1, rowH);
  }

  const xAt = (t: number) => LABEL_W + ((t - strip.t0) / span(strip)) * plotW;
  const bottom = earthY + rowH;

  // Month ticks (UTC), single-letter labels to stay compact on phones.
  ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.strokeStyle = 'rgba(207,214,228,0.35)'; ctx.lineWidth = 1;
  const d = new Date(strip.t0);
  let m = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  const end = strip.t0 + span(strip);
  for (; m < end; m = Date.UTC(new Date(m).getUTCFullYear(), new Date(m).getUTCMonth() + 1, 1)) {
    const x = Math.round(xAt(m)) + 0.5;
    ctx.beginPath(); ctx.moveTo(x, bottom); ctx.lineTo(x, bottom + 3); ctx.stroke();
    const mid = xAt(m + 15 * 864e5);
    if (mid < W - 3) { ctx.fillStyle = TEXT; ctx.fillText(MONTHS[new Date(m).getUTCMonth()], mid, bottom + 2); }
  }

  const mark = (t: number | undefined, color: string, dash: number[]) => {
    if (t === undefined || !(t >= strip.t0 && t <= end)) return;
    const x = Math.round(xAt(t)) + 0.5;
    ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.setLineDash(dash);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, bottom); ctx.stroke(); ctx.restore();
  };
  mark(opts.markT2, '#ff9b3d', [3, 2]);
  mark(opts.markT, '#ffffff', []);
}

/** Converts a pointer clientX over the canvas into a time (ms), clamped to the strip range. */
export function stripTimeAt(canvas: HTMLCanvasElement, strip: StripResult, clientX: number): number {
  const r = canvas.getBoundingClientRect();
  const f = Math.min(1, Math.max(0, (clientX - r.left - LABEL_W) / Math.max(1, r.width - LABEL_W)));
  return strip.t0 + f * span(strip);
}

export function stripSummary(strip: StripResult): { pctLit: number; pctEarth: number; longestDarkHours: number } {
  const n = strip.sunFrac.length;
  let s = 0, e = 0, run = 0, best = 0;
  for (let i = 0; i < n; i++) {
    s += strip.sunFrac[i]; e += strip.earthVis[i];
    run = strip.sunFrac[i] === 0 ? run + 1 : 0;
    if (run > best) best = run;
  }
  return {
    pctLit: n ? (s / n) * 100 : 0,
    pctEarth: n ? (e / n) * 100 : 0,
    longestDarkHours: (best * strip.stepMs) / 3600e3,
  };
}
