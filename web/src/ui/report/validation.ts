// Validation section (was the Evidence page): each link of the prediction chain checked against an independent NASA
// source. Sun and Earth positions vs JPL Horizons, the brute-force horizon check and long-term visibility vs the PGDA
// maps (validation.json, prep/validate.py); shadows vs LRO photos (bench/index.json + bench/*.png, prep/bench.py);
// uncertainty bands vs NASA's 5 m Monte Carlo terrain (calibration.json, prep/calib.py). The Apollo 11 value and the
// photo caveats are quoted from README.md. Owner: shell agent.
import { canvas, esc, figure, section, table } from './dom';
import { cite } from './refs';
import type { SectionFn } from './types';

/* ------------------------------------------------------------------ pure helpers (unit-tested, no DOM) */

export type ModelKey = 'flat' | 'dem240' | 'slope_only' | 'ours';
/** Display order of the four shadow models, baselines first. */
export const MODELS: { key: ModelKey; label: string }[] = [
  { key: 'flat', label: 'No terrain (smooth sphere)' },
  { key: 'dem240', label: '240 m terrain only' },
  { key: 'slope_only', label: 'Local slope only, no cast shadows' },
  { key: 'ours', label: 'This tool (20 m + far field)' },
];
export const DEFAULT_IMAGE = 'ESALL_SR12_NACORT03_2M';

/** 0.00002 -> "0.00002°" (fixed decimals, never exponent notation). */
export const fmtDeg = (v: number, decimals = 2) => `${v.toFixed(decimals)}°`;
/** Fraction 0..1 -> percent: 0.0152 -> "1.5%". */
export const fmtPct = (frac: number, decimals = 1) => `${(frac * 100).toFixed(decimals)}%`;
export const fmtIoU = (v: number) => v.toFixed(2);
/** "2010-10-05T11:25:59Z" -> "2010-10-05 11:26 UTC" (rounded to the nearest minute). */
export function fmtUtc(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const s = new Date(Math.round(ms / 60000) * 60000).toISOString();
  return `${s.slice(0, 10)} ${s.slice(11, 16)} UTC`;
}

const REGION_NAMES: Record<string, string> = {
  shackleton: 'Shackleton / Connecting Ridge',
  mouton_nobile: 'Mons Mouton / Nobile',
  malapert: 'Malapert',
  haworth: 'Haworth',
  degerlache: 'de Gerlache',
};
/** "mouton_nobile" -> "Mons Mouton / Nobile"; unknown ids are title-cased. */
export function prettyRegion(id: string): string {
  return REGION_NAMES[id] ?? id.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
export const groupLabel = (g: string) => (g === 'known_time' ? 'known time' : 'matched time');

/** validation.pgda.points rows are [ourSun, ourEarth, nasaSun, nasaEarth]; returns [x = NASA, y = ours] pairs. */
export function scatterSeries(points: number[][]): { sun: [number, number][]; earth: [number, number][] } {
  return {
    sun: points.map((p) => [p[2], p[0]] as [number, number]),
    earth: points.map((p) => [p[3], p[1]] as [number, number]),
  };
}

const at = (o: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((a, k) => (a && typeof a === 'object' ? (a as Record<string, unknown>)[k] : undefined), o);
function num(o: unknown, path: string, file: string): number {
  const v = at(o, path);
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${file}: "${path}" is missing or not a finite number`);
  return v;
}
function str(o: unknown, path: string, file: string): string {
  const v = at(o, path);
  if (typeof v !== 'string' || !v) throw new Error(`${file}: "${path}" is missing`);
  return v;
}

export interface Score { iou: number; accuracy: number }
export type Scores = Record<ModelKey, Score>;
export interface BenchImage {
  id: string; group: 'known_time' | 'matched_time'; utc: string;
  sunAz: number; sunEl: number; photo: string; model: string; shadowFraction: number; scores: Scores;
}
export interface Bench {
  images: BenchImage[];
  summary: { known: { n: number; scores: Scores }; matched: { n: number; scores: Scores } };
}
function scoresAt(o: unknown, path: string, file: string): Scores {
  const out = {} as Scores;
  for (const { key } of MODELS) out[key] = { iou: num(o, `${path}.${key}.iou`, file), accuracy: num(o, `${path}.${key}.accuracy`, file) };
  return out;
}
/** Everything the section reads from bench/index.json. Throws on a missing or non-finite field. */
export function shapeBench(raw: unknown): Bench {
  const f = 'bench/index.json';
  const list = at(raw, 'images');
  if (!Array.isArray(list) || !list.length) throw new Error(`${f}: "images" is missing or empty`);
  const images = list.map((im, i): BenchImage => {
    const p = `images[${i}]`;
    const wrap = { [p]: im };
    const group = str(wrap, `${p}.group`, f);
    if (group !== 'known_time' && group !== 'matched_time') throw new Error(`${f}: "${p}.group" is "${group}"`);
    const utc = str(wrap, `${p}.utc`, f);
    if (!Number.isFinite(Date.parse(utc))) throw new Error(`${f}: "${p}.utc" is not a date`);
    return {
      id: str(wrap, `${p}.id`, f), group, utc,
      sunAz: num(wrap, `${p}.sun_az`, f), sunEl: num(wrap, `${p}.sun_el`, f),
      photo: str(wrap, `${p}.photo`, f), model: str(wrap, `${p}.model`, f),
      shadowFraction: num(wrap, `${p}.shadow_fraction_photo`, f),
      scores: scoresAt(wrap, `${p}.scores`, f),
    };
  });
  return {
    images,
    summary: {
      known: { n: num(raw, 'summary.known_time.n', f), scores: scoresAt(raw, 'summary.known_time', f) },
      matched: { n: num(raw, 'summary.matched_time.n', f), scores: scoresAt(raw, 'summary.matched_time', f) },
    },
  };
}

export interface Fit { mae: number; r: number }
export interface RegionFit { n: number; sun: Fit; earth: Fit }
export interface Validation {
  horizons: { n: number; sun: number; earth: number };
  denseMarchMaxMissedDeg: number;
  pgda: RegionFit & { points: number[][] };
  otherRegions: (RegionFit & { id: string })[];
  coarseRegion: RegionFit;
}
function regionAt(o: unknown, path: string, file: string): RegionFit {
  const fit = (b: string): Fit => ({ mae: num(o, `${path}.${b}.mae`, file), r: num(o, `${path}.${b}.r`, file) });
  return { n: num(o, `${path}.n`, file), sun: fit('sun'), earth: fit('earth') };
}
/** Everything the section reads from validation.json. Throws on a missing or non-finite field. */
export function shapeValidation(raw: unknown): Validation {
  const f = 'validation.json';
  const points = at(raw, 'pgda.points');
  if (!Array.isArray(points) || !points.length) throw new Error(`${f}: "pgda.points" is missing or empty`);
  points.forEach((p, i) => {
    if (!Array.isArray(p) || p.length < 4 || !p.slice(0, 4).every((v) => typeof v === 'number' && Number.isFinite(v)))
      throw new Error(`${f}: "pgda.points[${i}]" is not four finite numbers`);
  });
  const others = at(raw, 'pgda_other_regions');
  if (!others || typeof others !== 'object') throw new Error(`${f}: "pgda_other_regions" is missing`);
  return {
    horizons: { n: num(raw, 'horizons.n', f), sun: num(raw, 'horizons.max_sep_deg.sun', f), earth: num(raw, 'horizons.max_sep_deg.earth', f) },
    denseMarchMaxMissedDeg: num(raw, 'dense_march.max_missed_deg', f),
    pgda: { ...regionAt(raw, 'pgda', f), points: points as number[][] },
    otherRegions: Object.keys(others).map((id) => ({ id, ...regionAt(raw, `pgda_other_regions.${id}`, f) })),
    coarseRegion: regionAt(raw, 'pgda_240m_only_region', f),
  };
}

export interface Calibration {
  horizonSigma: { clones: number; model: number };
  litStd: { clones: number; model: number };
  litMean: { clones: number; model: number };
}
/** Everything the section reads from calibration.json. Throws on a missing or non-finite field. */
export function shapeCalibration(raw: unknown): Calibration {
  const f = 'calibration.json';
  return {
    horizonSigma: { clones: num(raw, 'horizon_sigma_deg.clones_median', f), model: num(raw, 'horizon_sigma_deg.model_median', f) },
    litStd: { clones: num(raw, 'pct_lit_year.clones_std', f), model: num(raw, 'pct_lit_year.model_mc_std', f) },
    litMean: { clones: num(raw, 'pct_lit_year.clones_mean', f), model: num(raw, 'pct_lit_year.shipped_20m', f) },
  };
}

/* ------------------------------------------------------------------ writing */

const INK = { bg: '#111318', grid: '#2a2e36', text: '#a7abb3', fg: '#e8e6e1', sun: '#f2b544', earth: '#5b9cf5' };

/** Two square panels, Sun and Earth: this tool (y) against the PGDA map (x), with the 1:1 line. */
function scatterCanvas(v: Validation): HTMLCanvasElement {
  const W = 720, H = 384, cv = canvas(W, H), g = cv.getContext('2d')!;
  g.scale(cv.width / W, cv.height / H);
  g.fillStyle = INK.bg; g.fillRect(0, 0, W, H);
  const L = 58, T = 36, B = 50, gap = 64, size = Math.min(H - T - B, (W - L - gap - 24) / 2);
  const font = (px: number, w = '') => `${w} ${px}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  const s = scatterSeries(v.pgda.points);
  ([['Sun', s.sun, INK.sun, v.pgda.sun], ['Earth', s.earth, INK.earth, v.pgda.earth]] as const).forEach(([name, pts, col, fit], i) => {
    const x0 = L + i * (size + gap), X = (f: number) => x0 + f * size, Y = (f: number) => T + (1 - f) * size;
    g.lineWidth = 1; g.strokeStyle = INK.grid; g.fillStyle = INK.text; g.font = font(11);
    for (let k = 0; k <= 4; k++) {
      const f = k / 4, x = Math.round(X(f)) + 0.5, y = Math.round(Y(f)) + 0.5;
      g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + size); g.moveTo(x0, y); g.lineTo(x0 + size, y); g.stroke();
      g.textAlign = 'center'; g.textBaseline = 'top'; g.fillText(`${k * 25}%`, X(f), T + size + 6);
      g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillText(`${k * 25}%`, x0 - 6, Y(f));
    }
    g.font = font(12); g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    g.fillText('NASA PGDA map, % of time visible', x0 + size / 2, T + size + 40);
    g.save(); g.translate(x0 - 44, T + size / 2); g.rotate(-Math.PI / 2); g.fillText('This tool, % of time visible', 0, 0); g.restore();
    g.fillStyle = INK.fg; g.font = font(13, '600'); g.textAlign = 'left';
    g.fillText(`(${'ab'[i]}) ${name}`, x0, T - 12);
    g.fillStyle = INK.text; g.font = font(12); g.textAlign = 'right';
    g.fillText(`mean error ${fmtPct(fit.mae)}, r = ${fit.r.toFixed(2)}`, x0 + size, T - 12);
    g.strokeStyle = INK.text; g.setLineDash([4, 4]);
    g.beginPath(); g.moveTo(X(0), Y(0)); g.lineTo(X(1), Y(1)); g.stroke(); g.setLineDash([]);
    g.globalAlpha = 0.75; g.fillStyle = col;
    for (const [x, y] of pts) { g.beginPath(); g.arc(X(x), Y(y), 2.3, 0, 2 * Math.PI); g.fill(); }
    g.globalAlpha = 1;
  });
  return cv;
}

const kv = (rows: [string, string][]) => `<dl class="r-kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;

function positions(v: Validation): string {
  return `<p>Sun and Earth positions come from a table computed with NAIF SPICE ${cite('spice')} from the DE440
    ephemeris ${cite('de440')}. We compared the directions seen from the surface with NASA JPL Horizons ${cite('horizons')}
    at ${v.horizons.n} site and date pairs.</p>
    ${kv([
      ['Sun, largest difference', fmtDeg(v.horizons.sun, 5)],
      ['Earth, largest difference', fmtDeg(v.horizons.earth, 5)],
      ['Apollo 11 touchdown, Sun elevation', '10.70° (historical value 10.8°)'],
    ])}
    <p>The Apollo 11 value checks time, ephemeris and frames end to end against a historical record.</p>`;
}

function visibility(v: Validation): string {
  const fit = (r: RegionFit) => [String(r.n), fmtPct(r.sun.mae), r.sun.r.toFixed(2), fmtPct(r.earth.mae), r.earth.r.toFixed(2)];
  const p = v.pgda;
  return `<p>The terrain horizon decides how often the Sun and the Earth are in view. We compared the fraction of time
    each is visible with NASA's published average illumination and Earth visibility maps ${cite('mazarico2011')}, at
    ${p.n} random points near Shackleton. Our 20 m model is sampled at each point; the NASA maps have 60 m pixels. For
    this comparison only, Earth counts as visible when any part of its disk clears the terrain, as in NASA's maps, and
    there is no mast. The mean absolute error is ${fmtPct(p.sun.mae)} of the time for the Sun (r = ${p.sun.r.toFixed(2)})
    and ${fmtPct(p.earth.mae)} for the Earth (r = ${p.earth.r.toFixed(2)}).</p>
    ${figure(scatterCanvas(v), `Fraction of time the Sun (a) and the Earth (b) are visible at ${p.n} random points near
      Shackleton: this tool against the NASA PGDA maps ${cite('mazarico2011')}. Dashed line: exact agreement.`,
      `Two scatter plots, ${p.n} points each, clustered along the 1:1 line`)}
    ${table('Mean absolute error of the visible fraction against the NASA PGDA maps, by region; r is the correlation.',
      ['Region', 'Points', 'Sun error', 'Sun r', 'Earth error', 'Earth r'], [
        [esc(prettyRegion('shackleton')), ...fit(p)],
        ...v.otherRegions.map((r) => [esc(prettyRegion(r.id)), ...fit(r)]),
        ['No 20 m coverage (240 m terrain only)', ...fit(v.coarseRegion)],
      ])}
    <p class="r-note">In the other 20 m regions the rays cross into the coarse far-field terrain. The last row is a
    region where only 240 m terrain is available.</p>
    <p>The fast horizon search was also checked against a brute-force search with 10 m steps: it misses the true
    horizon by at most ${fmtDeg(v.denseMarchMaxMissedDeg)}.</p>`;
}

function shadows(b: Bench, base: string): string {
  const { known, matched } = b.summary;
  const pick = b.images.find((im) => im.id === DEFAULT_IMAGE) ?? b.images[0];
  const kt = b.images.find((im) => im.group === 'known_time' && im !== pick);
  const pair = (im: BenchImage, a: string, z: string) =>
    `<div><img src="${esc(base + im.photo)}" alt="LRO photo ${esc(im.id)}"><span>(${a}) LRO photo</span></div>`
    + `<div><img src="${esc(base + im.model)}" alt="Predicted shadows for ${esc(im.id)}"><span>(${z}) This tool</span></div>`;
  const desc = (im: BenchImage) => `${esc(im.id)}, ${im.group === 'known_time' ? 'capture time known' : 'time by best match'},
    ${fmtUtc(im.utc)}, Sun ${fmtDeg(im.sunEl)} above the horizon at azimuth ${fmtDeg(im.sunAz, 1)}, IoU ${fmtIoU(im.scores.ours.iou)}`;
  const bold = (m: ModelKey, s: string) => (m === 'ours' ? `<b>${s}</b>` : s);
  return `<p>We predicted the shadow map at the moment each of ${b.images.length} LRO Narrow Angle Camera orthoimages
    near Shackleton ${cite('lroc')} was taken and compared it with the photo. A photo pixel is in shadow when its
    block-mean brightness is below 5% of full scale, as in ${cite('derosa2012')}; a predicted pixel is in shadow when
    less than half of the solar disk is visible. The score is the intersection over union (IoU) of the two shadow
    masks: 1 means identical, 0 means no overlap.</p>
    <p>Four models were scored: a smooth sphere with no terrain, the 240 m terrain alone, the local slope within 60 m
    with no cast shadows, and this tool (20 m terrain plus 240 m far field out to 300 km). For ${known.n} photos the
    capture time is known; for the other ${matched.n} it was identified by best match (see the caveats below).</p>
    <figure class="r-fig r-photos"><div class="r-grid">${pair(pick, 'a', 'b')}${kt ? pair(kt, 'c', 'd') : ''}</div>
      <figcaption>LRO photos (a, c) and this tool's rendering of the same moment (b, d): terrain shading times the
      visible fraction of the Sun, so black is predicted shadow. Top: ${desc(pick)}.
      ${kt ? `Bottom: ${desc(kt)}.` : ''} Photos: NASA/GSFC/Arizona State University ${cite('lroc')}.</figcaption></figure>
    ${table('Shadow IoU and pixel accuracy of four models against the LRO photos, averaged over each group.',
      ['Model', `IoU, time known (${known.n})`, `IoU, time matched (${matched.n})`, 'Accuracy, time known', 'Accuracy, time matched'],
      MODELS.map(({ key, label }) => [label, fmtIoU(known.scores[key].iou), fmtIoU(matched.scores[key].iou),
        fmtPct(known.scores[key].accuracy), fmtPct(matched.scores[key].accuracy)].map((c) => bold(key, c))))}
    ${table(`All ${b.images.length} photos: Sun position at the capture time (the best match in the matched group),
      share of the photo in shadow, and the IoU of this tool.`,
      ['Photo', 'Captured', 'Sun elevation', 'Sun azimuth', 'Shadow share', 'IoU'],
      b.images.map((im) => [`${esc(im.id)}<br><small>${groupLabel(im.group)}</small>`, fmtUtc(im.utc), fmtDeg(im.sunEl),
        fmtDeg(im.sunAz, 1), fmtPct(im.shadowFraction, 0), fmtIoU(im.scores.ours.iou)]))}
    <p><b>Caveats.</b></p>
    <ul>
      <li>All photos are from 22 Sep to 11 Oct 2010 near Shackleton crater: one season, three Sun directions.</li>
      <li>For the ${known.n} known-time photos, the product uses the same pixel value for "no data" and "deep shadow".
        We had to assume the large dark area on the southern edge is shadow. That set is mostly sunlit ground with small
        shadows, which is why its scores are lower.</li>
      <li>For the other ${matched.n}, the archive does not record which of 7-8 listed observations each photo came from.
        We picked the best-matching one for every model separately. Tested on the ${known.n} known-time photos, that
        selection finds the right date decisively (IoU 0.46 against 0.10-0.13 for wrong dates) but cannot tell
        observations on the same day apart, and picked the wrong same-day observation for one of the two. So the date is
        established, the exact observation is not; the same-day choice moves IoU by about 0.01.</li>
      <li>Comparing illumination models with LRO photos is established practice ${cite('mazarico2011', 'derosa2012', 'glaser2014')}.
        This is a check of our own model, not a new benchmark.</li>
    </ul>`;
}

function calibration(c: Calibration): string {
  const ratio = (c.litStd.clones / c.litStd.model).toFixed(1);
  return `<p>The elevation model has errors ${cite('barker2023')}, so every result carries a spread: we perturb the
    horizon according to those errors and recompute. We compared this uncertainty model with NASA's own Monte Carlo
    realisations of the 5 m terrain at one site ${cite('barker2021')}. The model constants were tuned on 30 realisations
    and tested on 30 others; the table shows the held-out set.</p>
    ${table('Our uncertainty model against NASA Monte Carlo terrain realisations, held-out set.',
      ['Quantity', 'NASA realisations', 'This tool'], [
        ['Horizon spread (median)', fmtDeg(c.horizonSigma.clones, 3), fmtDeg(c.horizonSigma.model, 3)],
        ['Spread of yearly % sunlit', fmtPct(c.litStd.clones, 2), fmtPct(c.litStd.model, 2)],
        ['Mean yearly % sunlit', fmtPct(c.litMean.clones), fmtPct(c.litMean.model)],
      ])}
    <p>The spread of the yearly sunlit share is ${ratio} times larger in NASA's realisations than in our model, so our
    bands are about ${ratio}x too narrow. They cover elevation-model error near the site only and were calibrated at
    one site: treat them as a lower bound.</p>`;
}

export const validationSection: SectionFn = async (ctx) => {
  const get = async <T>(file: string, shape: (raw: unknown) => T): Promise<T> => {
    const res = await fetch(ctx.dataBase + file, { signal: ctx.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return shape(await res.json());
  };
  const [v, b, c] = await Promise.allSettled([
    get('validation.json', shapeValidation), get('bench/index.json', shapeBench), get('calibration.json', shapeCalibration),
  ]);
  const part = <T>(r: PromiseSettledResult<T>, file: string, write: (d: T) => string) => (r.status === 'fulfilled'
    ? write(r.value)
    : `<p class="r-status r-err" role="alert">Could not load ${file}: ${esc((r.reason as Error)?.message ?? String(r.reason))}</p>`);
  return section('validation', 'Validation', `
    <p>Each link of the prediction chain was checked against an independent NASA source: the Sun and Earth directions,
    the terrain horizon through the long-term visibility it produces, the shadows it casts, and the size of the
    uncertainty bands. The checks are scripts in the project repository (prep/validate.py, checks.py, bench.py,
    calib.py); their results ship with the app.</p>
    <h3>Sun and Earth positions</h3>${part(v, 'validation.json', positions)}
    <h3>Long-term visibility and the terrain horizon</h3>${part(v, 'validation.json', visibility)}
    <h3>Shadows against LRO photos</h3>${part(b, 'bench/index.json', (d) => shadows(d, `${ctx.dataBase}bench/`))}
    <h3>Uncertainty calibration</h3>${part(c, 'calibration.json', calibration)}`);
};
