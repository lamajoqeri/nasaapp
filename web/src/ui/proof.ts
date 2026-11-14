// "What am I looking at?" explainer, reality-check slider, and "How do we know?" (validation.json, calibration.json).
import { mountReality } from './reality';

interface Fit { mae: number; bias: number; r: number }
interface Pgda { n: number; note: string; sun: Fit; earth: Fit }
interface Validation {
  horizons: { n: number; max_sep_deg: { sun: number; earth: number } };
  dense_march: { max_missed_deg: number };
  pgda: Pgda & { points: [number, number, number, number][] };
  pgda_other_regions?: Record<string, Pgda>;
  pgda_240m_only_region?: Pgda;
}
interface Calibration {
  clones: number;
  horizon_sigma_deg: { clones_median: number; model_median: number };
  pct_lit_year: { clones_std: number; model_mc_std: number; clones_mean: number; model_mc_mean: number };
}

const SUN = '#ffb347', EARTH = '#5fa8ff', TEXT = '#cfd6e4', GRID = 'rgba(207,214,228,0.12)';
const pc1 = (x: number) => `${(x * 100).toFixed(1)}%`;
const sgn = (x: number) => (x > 0 ? '+' : x < 0 ? '−' : '') + pc1(Math.abs(x));
const pc2 = (x: number) => `${(x * 100).toFixed(2)}%`;
const range = (xs: number[]) => `${pc1(Math.min(...xs))}–${pc1(Math.max(...xs))}`;

const EXPLAIN = `
  <details class="explain"><summary>What am I looking at?</summary>
    <p><b>Why the south pole is hard.</b> The Moon's axis is tilted only 1.5°, so near the poles the Sun never climbs high: it circles
      the horizon once every 29.5 days (one lunar day), a degree or two up at most. A hill or crater rim many kilometres away can then
      block it for hours or days. Earth also sits low and bobs up and down a few degrees over the month, so terrain can hide it too, and with
      it direct radio contact. A step of 100 m can change the answer completely.</p>
    <p><b>The panorama.</b> Imagine standing at the site and turning around once. Left to right is compass direction (N, E, S, W),
      up is height above the horizon in degrees, stretched vertically so you can see it (the stretch is printed top right).
      The grey shape is the real terrain skyline. The orange line is the Sun's path over the next 29.5 days, the blue line is Earth's;
      they are bright where visible and faint where hidden behind terrain or below the horizon. The dots show where the Sun and Earth
      are at the time on the slider.</p>
    <p><b>The year strip.</b> Left to right is the year from the landing date. The top row is amber when the site is sunlit, the bottom row blue when Earth is in view. Tap it to pick a landing date.</p>
    <p><b>What “±” means.</b> The terrain maps have small measurement errors. We redraw the skyline many times within those errors and
      report how much the answer moves. It is a lower bound: it covers terrain error near the site only, and on NASA's own test data it
      came out about 1.5× too narrow. Moving the site 100 m changes the numbers far more. “P(lit)” is the chance the Sun is visible at that moment.</p>
  </details>`;

/** Mounts the proof section into `el` and the explainer under the page header. */
export function mountProof(el: HTMLElement) {
  document.querySelector('header')?.insertAdjacentHTML('beforeend', EXPLAIN);
  const data = import.meta.env.BASE_URL + 'data/';
  el.className = 'proof';
  el.innerHTML = `
    <section class="col"><h2>Reality check: our shadows vs real photos</h2><div class="reality"></div></section>
    <section class="col"><h2>How do we know?</h2><div class="how"><p class="note">Loading…</p></div></section>`;
  // ponytail: data and images load when the section nears the viewport; drop the observer if the section moves to the top.
  const io = new IntersectionObserver((es) => {
    if (!es.some((e) => e.isIntersecting)) return;
    io.disconnect();
    mountReality(el.querySelector('.reality')!, data + 'bench/');
    mountHow(el.querySelector('.how')!, data);
  }, { rootMargin: '400px' });
  io.observe(el);
}

async function mountHow(el: HTMLElement, data: string) {
  let v: Validation, c: Calibration;
  try {
    [v, c] = await Promise.all(['validation.json', 'calibration.json'].map((f) =>
      fetch(data + f).then((r) => { if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`); return r.json(); })));
  } catch (e) {
    el.innerHTML = `<p class="status err">Could not load validation data: ${(e as Error).message}</p>`;
    return;
  }
  const p = v.pgda, other = Object.values(v.pgda_other_regions ?? {}), coarse = v.pgda_240m_only_region;
  const h = c.horizon_sigma_deg, y = c.pct_lit_year;
  el.innerHTML = `
    <p>Validated against time-stamped LRO NAC scenes and NASA PGDA illumination maps, with error bars on every number.
      Every check below is reproducible with the scripts in <code>prep/</code>.</p>
    <table class="m how">
      <tr><th>Sun and Earth direction vs NASA JPL Horizons (${v.horizons.n} samples each)</th><td>max error ${v.horizons.max_sep_deg.sun}° Sun, ${v.horizons.max_sep_deg.earth}° Earth</td></tr>
      <tr><th>Our fast skyline search vs a slow brute-force search</th><td>misses at most ${v.dense_march.max_missed_deg.toFixed(2)}°</td></tr>
      <tr><th>Share of time Sun / Earth visible vs NASA PGDA maps, ${p.n} random points near Shackleton</th><td>
        Sun: mean error ${pc1(p.sun.mae)}, bias ${sgn(p.sun.bias)}, r ${p.sun.r.toFixed(2)}<br>
        Earth: mean error ${pc1(p.earth.mae)}, bias ${sgn(p.earth.bias)}, r ${p.earth.r.toFixed(2)}</td></tr>
      ${other.length ? `<tr><th>Same, ${other.length} other south-pole regions (${other[0].n} points each)</th><td>Sun ${range(other.map((o) => o.sun.mae))}, Earth ${range(other.map((o) => o.earth.mae))} mean error</td></tr>` : ''}
      ${coarse ? `<tr><th>Same, where only coarse 240 m terrain exists</th><td>Sun ${pc1(coarse.sun.mae)} (r ${coarse.sun.r.toFixed(2)}), Earth ${pc1(coarse.earth.mae)}</td></tr>` : ''}
    </table>
    <canvas class="scatter" role="img" aria-label="Scatter plot: our visible-time fraction vs NASA PGDA at ${p.points.length} points; points lie close to the 1:1 line"></canvas>
    <p class="note">Each dot is one point near Shackleton: NASA PGDA map (across) vs our model (up), share of time
      <span style="color:${SUN}">Sun</span> / <span style="color:${EARTH}">Earth</span> visible. On the diagonal = perfect agreement.
      Method: ${p.note.replace(/;/g, ',')}.</p>
    <h3>How good are the “±” bands?</h3>
    <p>We compared our uncertainty model with ${c.clones} NASA terrain realisations it was not tuned on (PGDA product 78).
      Skyline spread: ${h.clones_median.toFixed(3)}° NASA vs ${h.model_median.toFixed(3)}° ours. Spread of yearly sunlit time:
      ${pc2(y.clones_std)} NASA vs ${pc2(y.model_mc_std)} ours, so our bands are about ${(y.clones_std / y.model_mc_std).toFixed(1)}× too narrow.
      Treat them as a lower bound (terrain-model uncertainty only).</p>
    <p class="note">Comparing illumination models with LRO photos and PGDA maps is established practice (Mazarico et al. 2011,
      De Rosa et al. 2012, Gläser et al. 2014). This is our check of our own model, not a new benchmark.</p>`;
  const cv = el.querySelector<HTMLCanvasElement>('.scatter')!;
  const draw = () => scatter(cv, p.points);
  draw();
  let raf = 0;
  addEventListener('resize', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(draw); });
}

function scatter(cv: HTMLCanvasElement, pts: [number, number, number, number][]) {
  const dpr = devicePixelRatio || 1, W = Math.round(cv.getBoundingClientRect().width), H = W;
  if (!W) return;
  cv.width = W * dpr; cv.height = H * dpr; cv.style.height = `${H}px`;
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const L = 46, B = 30, T = 8, R = 18, pw = W - L - R, ph = H - T - B;
  const X = (f: number) => L + f * pw, Y = (f: number) => T + (1 - f) * ph;
  ctx.font = '11px system-ui, sans-serif'; ctx.fillStyle = TEXT; ctx.strokeStyle = GRID; ctx.lineWidth = 1;
  for (let f = 0; f <= 1.001; f += 0.25) {
    ctx.beginPath(); ctx.moveTo(X(f), Y(0)); ctx.lineTo(X(f), Y(1)); ctx.moveTo(X(0), Y(f)); ctx.lineTo(X(1), Y(f)); ctx.stroke();
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillText(`${f * 100}%`, X(f), Y(0) + 3);
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(`${f * 100}%`, X(0) - 3, Y(f));
  }
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  ctx.fillText('NASA PGDA map', L + pw / 2, H);
  ctx.save(); ctx.translate(9, T + ph / 2); ctx.rotate(-Math.PI / 2); ctx.textBaseline = 'middle'; ctx.fillText('ours', 0, 0); ctx.restore();
  ctx.strokeStyle = 'rgba(207,214,228,0.5)'; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(X(0), Y(0)); ctx.lineTo(X(1), Y(1)); ctx.stroke(); ctx.setLineDash([]);
  ctx.globalAlpha = 0.7;
  for (const [k, col] of [[0, SUN], [1, EARTH]] as const) {
    ctx.fillStyle = col;
    for (const q of pts) { ctx.beginPath(); ctx.arc(X(q[k + 2]), Y(q[k]), 2, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.globalAlpha = 1;
}
