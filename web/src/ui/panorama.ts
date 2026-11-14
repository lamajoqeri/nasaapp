import type { ScenarioResult } from '../core/api';

export interface PanoramaOptions {
  /** Index into result.series for the "now" Sun/Earth markers. */
  idx: number;
  /** Optional label drawn in the corner (e.g. scenario name). */
  label?: string;
}

const BG = '#0b0e14', TEXT = '#cfd6e4', GRID = 'rgba(207,214,228,0.12)';
const SUN = '#ffb347', EARTH = '#5fa8ff', TERRAIN = '#2a2f3a', EDGE = '#8a93a6';
const EARTH_R = 0.95; // deg

// y-range only depends on the result, so compute once per result (redraws happen every frame).
const ranges = new WeakMap<ScenarioResult, [number, number]>();

function yRange(r: ScenarioResult): [number, number] {
  let cached = ranges.get(r);
  if (cached) return cached;
  const h = r.horizon.el, s = r.series;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < h.length; i++) { lo = Math.min(lo, h[i]); hi = Math.max(hi, h[i]); }
  // Tracks only count near/above the terrain, else night-side Sun at -80 deg would flatten everything.
  const floor = lo - 3;
  for (let i = 0; i < s.t.length; i++) {
    for (const e of [s.sunEl[i], s.earthEl[i]]) if (e >= floor) { lo = Math.min(lo, e); hi = Math.max(hi, e); }
  }
  const span = Math.max(hi - lo, 2), pad = span * 0.08 + 1;
  cached = [lo - pad, Math.min(hi + pad, 90)];
  ranges.set(r, cached);
  return cached;
}

function niceStep(span: number, n: number): number {
  const raw = span / n, p = 10 ** Math.floor(Math.log10(raw)), m = raw / p;
  return p * (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10);
}

/** Draws the horizon panorama for one scenario into the canvas. Must handle resize / devicePixelRatio. */
export function drawPanorama(canvas: HTMLCanvasElement, result: ScenarioResult, opts: PanoramaOptions): void {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const W = Math.max(1, rect.width), H = Math.max(1, rect.height);
  const bw = Math.round(W * dpr), bh = Math.round(H * dpr);
  if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  const font = W < 480 ? 10 : 12;
  ctx.font = `${font}px system-ui, sans-serif`;
  const L = font * 3.2, R = 6, T = font * 1.8, B = font * 2.2; // plot margins
  const pw = W - L - R, ph = H - T - B;
  if (pw < 20 || ph < 20) return;

  const [y0, y1] = yRange(result);
  const kx = pw / 360, ky = ph / (y1 - y0);
  const X = (az: number) => L + az * kx;
  const Y = (el: number) => T + (y1 - el) * ky;

  // grid + labels
  ctx.strokeStyle = GRID; ctx.lineWidth = 1; ctx.fillStyle = TEXT;
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  const step = niceStep(y1 - y0, Math.max(2, Math.floor(ph / 40)));
  ctx.beginPath();
  for (let e = Math.ceil(y0 / step) * step; e <= y1; e += step) {
    const y = Math.round(Y(e)) + 0.5;
    ctx.moveTo(L, y); ctx.lineTo(L + pw, y);
    ctx.fillText(`${+e.toFixed(2)}°`, L - 4, y);
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  const names = ['N', 'E', 'S', 'W', 'N'];
  for (let a = 0; a <= 360; a += 45) {
    const x = Math.round(X(a)) + 0.5;
    ctx.moveTo(x, T); ctx.lineTo(x, T + ph);
    ctx.fillText(a % 90 === 0 ? names[a / 90] : `${a}`, x, T + ph + 3);
  }
  ctx.stroke();
  if (y0 < 0 && y1 > 0) { // astronomical horizon
    ctx.strokeStyle = 'rgba(207,214,228,0.3)'; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(L, Y(0)); ctx.lineTo(L + pw, Y(0)); ctx.stroke(); ctx.setLineDash([]);
  }

  ctx.save();
  ctx.beginPath(); ctx.rect(L, T, pw, ph); ctx.clip();

  // terrain silhouette (closed with the first sample at 360 deg)
  const h = result.horizon.el, n = h.length, da = 360 / n;
  ctx.beginPath();
  ctx.moveTo(X(0), Y(h[0]));
  for (let i = 1; i <= n; i++) ctx.lineTo(X(i * da), Y(h[i % n]));
  ctx.strokeStyle = EDGE; ctx.lineWidth = 1.2; ctx.stroke();
  ctx.lineTo(L + pw, T + ph + 2); ctx.lineTo(L, T + ph + 2); ctx.closePath();
  ctx.fillStyle = TERRAIN; ctx.fill();
  ctx.stroke();

  // tracks: one path for visible segments, one for hidden, per body
  const s = result.series;
  const track = (az: Float32Array, el: Float32Array, vis: (i: number) => boolean, color: string) => {
    for (const want of [false, true]) {
      ctx.beginPath();
      for (let i = 1; i < az.length; i++) {
        if (vis(i) !== want || Math.abs(az[i] - az[i - 1]) > 180) continue; // skip wrap 359->0
        ctx.moveTo(X(az[i - 1]), Y(el[i - 1])); ctx.lineTo(X(az[i]), Y(el[i]));
      }
      ctx.strokeStyle = color; ctx.globalAlpha = want ? 0.9 : 0.25; ctx.lineWidth = want ? 1.5 : 1;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  };
  track(s.sunAz, s.sunEl, (i) => s.sunFrac[i] > 0, SUN);
  track(s.earthAz, s.earthEl, (i) => s.earthVis[i] > 0, EARTH);

  // current bodies; ellipse so the disk matches the angular radius on both (non-uniform) axes, min 3 px
  const i = Math.max(0, Math.min(s.t.length - 1, opts.idx | 0));
  const disk = (az: number, el: number, r: number, color: string, on: boolean) => {
    for (const off of [-360, 0, 360]) {
      ctx.beginPath();
      ctx.ellipse(X(az + off), Y(el), Math.max(3, r * kx), Math.max(3, r * ky), 0, 0, Math.PI * 2);
      ctx.fillStyle = color; ctx.globalAlpha = on ? 1 : 0.35; ctx.fill();
      ctx.globalAlpha = 1; ctx.strokeStyle = BG; ctx.lineWidth = 1; ctx.stroke();
    }
  };
  if (s.t.length) {
    disk(s.earthAz[i], s.earthEl[i], EARTH_R, EARTH, s.earthVis[i] > 0);
    disk(s.sunAz[i], s.sunEl[i], s.sunRadius[i], SUN, s.sunFrac[i] > 0);
  }
  ctx.restore();

  // label, exaggeration, legend
  ctx.fillStyle = TEXT; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  const ty = T / 2;
  if (opts.label) ctx.fillText(opts.label, L, ty);
  ctx.textAlign = 'right';
  const ex = ky / kx;
  ctx.fillText(`elev. ×${ex >= 10 ? ex.toFixed(0) : ex.toFixed(1)} vs az`, W - R, ty);
  ctx.textAlign = 'left';
  let lx = L + 6;
  const ly = T + font;
  ctx.fillStyle = 'rgba(11,14,20,0.7)';
  ctx.fillRect(L + 2, ly - font, 3 * 23 + ctx.measureText('SunEarthTerrain').width + 8, font * 2);
  for (const [name, c] of [['Sun', SUN], ['Earth', EARTH], ['Terrain', EDGE]]) {
    ctx.fillStyle = c; ctx.fillRect(lx, ly - 1.5, 10, 3);
    ctx.fillStyle = TEXT; ctx.fillText(name, lx + 13, ly);
    lx += 13 + ctx.measureText(name).width + 10;
  }
}
