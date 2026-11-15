// Timeline dock: one lane per scenario on a shared "hours after landing" axis.
// Pure layout maths (unit-tested) + one canvas draw. No worker calls, no DOM beyond the canvas.

export const STEPS = 708;            // 29.5 d hourly, as the scenario series
export const PITCH = 26;             // px per scenario lane, constant so the dock never jumps when a slip is set
export const TOP = 8, AXIS_H = 22;

/** The two arrays a lane draws; structurally a core Series. */
export interface LaneSeries { sunFrac: ArrayLike<number>; earthVis: ArrayLike<number> }
export interface Lane { series?: LaneSeries; ghost?: LaneSeries }
export type Band = [y: number, h: number];
export interface LaneBox { y: number; sun: Band; earth: Band; ghostSun?: Band; ghostEarth?: Band }

export const lanesHeight = (n: number) => TOP + n * PITCH + AXIS_H;

/** Band rectangles for n lanes. With a slip, the main bands slim down to make room for the ghost pair. */
export function laneBoxes(n: number, slip: boolean): LaneBox[] {
  return Array.from({ length: n }, (_, i) => {
    const y = TOP + i * PITCH;
    return slip
      ? { y, sun: [y, 7], earth: [y + 8, 4], ghostSun: [y + 14, 4], ghostEarth: [y + 19, 3] }
      : { y, sun: [y, 10], earth: [y + 12, 7] };
  });
}

/** Mean of `v` in each of `cols` equal bins (one bin per CSS pixel column). */
export function binMean(v: ArrayLike<number>, cols: number): Float32Array {
  const out = new Float32Array(Math.max(0, cols)), n = v.length;
  if (!n) return out;
  for (let x = 0; x < cols; x++) {
    const i0 = Math.min(n - 1, Math.floor((x * n) / cols)), i1 = Math.min(n, Math.max(i0 + 1, Math.floor(((x + 1) * n) / cols)));
    let s = 0;
    for (let i = i0; i < i1; i++) s += v[i];
    out[x] = s / (i1 - i0);
  }
  return out;
}

/** Plot x (px) of an offset in hours; the last sample sits on the right edge. */
export const xAt = (hours: number, w: number) => (hours / (STEPS - 1)) * w;
/** Whole hours after landing under plot x, clamped to the window. */
export const hourAt = (x: number, w: number) => Math.min(STEPS - 1, Math.max(0, Math.round((x / Math.max(1, w)) * (STEPS - 1))));

/** Axis ticks every 5 days. */
export function ticks(): { h: number; label: string }[] {
  return [0, 5, 10, 15, 20, 25].map((d) => ({ h: d * 24, label: d ? `${d} d` : '0' }));
}

const DARK = [22, 25, 30], AMBER = [242, 181, 68], BLUE = [91, 156, 245];
const mix = (a: number[], b: number[], t: number) => `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`;

/** Draws every lane and the axis. The canvas CSS height must already be lanesHeight(n). */
export function drawLanes(canvas: HTMLCanvasElement, lanes: Lane[], slip: boolean): void {
  const dpr = window.devicePixelRatio || 1;
  const W = Math.round(canvas.clientWidth), H = Math.round(canvas.clientHeight);
  if (!W || !H) return;
  const bw = Math.round(W * dpr), bh = Math.round(H * dpr);
  if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
  const g = canvas.getContext('2d');
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);

  const band = (v: ArrayLike<number>, [y, h]: Band, to: number[], alpha: number) => {
    const b = binMean(v, W);
    g.globalAlpha = alpha;
    for (let x = 0; x < W; x++) { g.fillStyle = mix(DARK, to, b[x]); g.fillRect(x, y, 1, h); }
    g.globalAlpha = 1;
  };
  const empty = ([y, h]: Band) => { g.fillStyle = 'rgb(18,20,24)'; g.fillRect(0, y, W, h); };

  laneBoxes(lanes.length, slip).forEach((box, i) => {
    const { series, ghost } = lanes[i];
    if (series) { band(series.sunFrac, box.sun, AMBER, 1); band(series.earthVis, box.earth, BLUE, 1); }
    else { empty(box.sun); empty(box.earth); }
    if (box.ghostSun && box.ghostEarth) {
      if (ghost) { band(ghost.sunFrac, box.ghostSun, AMBER, 0.5); band(ghost.earthVis, box.ghostEarth, BLUE, 0.5); }
      else { empty(box.ghostSun); empty(box.ghostEarth); }
    }
  });

  // axis
  const y0 = TOP + lanes.length * PITCH - 4;
  g.font = '10px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
  g.textBaseline = 'top';
  g.fillStyle = '#8e939c'; g.strokeStyle = '#343a44'; g.lineWidth = 1;
  g.beginPath();
  for (const t of ticks()) {
    const x = Math.min(W - 0.5, Math.round(xAt(t.h, W)) + 0.5);
    g.moveTo(x, y0); g.lineTo(x, y0 + 4);
    if (x > W - 64) continue; // keep clear of the end label on narrow screens
    g.textAlign = t.h ? 'center' : 'left';
    g.fillText(t.label, t.h ? x : 0, y0 + 7);
  }
  g.moveTo(W - 0.5, y0); g.lineTo(W - 0.5, y0 + 4);
  g.stroke();
  g.textAlign = 'right';
  g.fillText('29.5 d', W, y0 + 7);
}
