import './evidence.css';

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
/** Everything the page reads from bench/index.json. Throws on a missing or non-finite field. */
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
/** Everything the page reads from validation.json. Throws on a missing or non-finite field. */
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
/** Everything the page reads from calibration.json. Throws on a missing or non-finite field. */
export function shapeCalibration(raw: unknown): Calibration {
  const f = 'calibration.json';
  return {
    horizonSigma: { clones: num(raw, 'horizon_sigma_deg.clones_median', f), model: num(raw, 'horizon_sigma_deg.model_median', f) },
    litStd: { clones: num(raw, 'pct_lit_year.clones_std', f), model: num(raw, 'pct_lit_year.model_mc_std', f) },
    litMean: { clones: num(raw, 'pct_lit_year.clones_mean', f), model: num(raw, 'pct_lit_year.shipped_20m', f) },
  };
}

/* ------------------------------------------------------------------ static content (wording from README.md) */

const PHOTO_CAVEATS = [
  'All photos are from 22 Sep to 11 Oct 2010 near Shackleton crater: one season, three Sun directions.',
  'For the 2 known-time photos, the product uses the same pixel value for "no data" and "deep shadow". We had to assume the large dark area on the southern edge is shadow. That set is mostly sunlit ground with small shadows, which is why its scores are lower.',
  'For the other 13, the archive does not record which of 7-8 listed observations each photo came from. We picked the best-matching one for every model separately. Tested on the 2 known-time photos, that selection finds the right date decisively but cannot tell observations on the same day apart. So the date is established, the exact observation is not; the same-day choice moves IoU by about 0.01.',
  'Comparing illumination models with LRO photos is established practice (Mazarico et al. 2011, De Rosa et al. 2012, Gläser et al. 2014). This is our check of our own model, not a new benchmark.',
];
const LIMITS = [
  '20 m terrain exists for five south-pole regions (Shackleton / Connecting Ridge, Mons Mouton / Nobile, Malapert, Haworth, de Gerlache). The rest of 80S-90S uses 240 m terrain, and the rest of the Moon about 3.8 km, so horizons there are smoother than reality.',
  'At the pole, results change over tens of meters. Moving a site 100 m can change Earth visibility from 0% to 50% of the time. A coordinate typed to two decimals is not a landing site.',
  "Earth visibility uses Earth's centre. NASA's published maps count any part of Earth's disk (0.95° radius), so their percentages are higher.",
  "The uncertainty bands cover elevation-model error near the site only, were calibrated at one site, and came out about 1.5x narrower than NASA's own terrain realisations imply on held-out data. Treat them as a lower bound. The offset between our 20 m result and the 5 m terrain (0.1-0.4% of yearly illumination here) is larger than the band itself.",
  'The ephemeris table covers 2024-2040 (plus 1969-1972 for the Apollo landings).',
  'Power is the visible fraction of the solar disk for a Sun-tracking panel. No thermal model, no link budget.',
  'The battery model and the Deep Space Network table are simple and have unit tests only; they are not validated against an external source. The DSN table uses a 10° elevation mask and a simplified Earth rotation model.',
];
const CREDITS: { data: string; use: string; source: string; url: string }[] = [
  { data: 'LOLA south pole elevation models, 20 m and 80 m, with error maps (Barker et al. 2023)', use: 'Terrain, uncertainty', source: 'NASA GSFC PGDA, product 90', url: 'https://pgda.gsfc.nasa.gov/products/90' },
  { data: 'LOLA 5 m site models and Monte-Carlo realisations (Barker et al. 2021)', use: 'Uncertainty calibration', source: 'NASA GSFC PGDA, product 78', url: 'https://pgda.gsfc.nasa.gov/products/78' },
  { data: 'LOLA global elevation model LDEM_16', use: 'Terrain outside the south pole', source: 'NASA PDS Geosciences Node', url: 'https://pds-geosciences.wustl.edu/missions/lro/lola.htm' },
  { data: 'Average illumination and Earth visibility maps (Mazarico et al. 2011)', use: 'Validation, site suggestions, map overlays', source: 'NASA GSFC PGDA, product 69', url: 'https://pgda.gsfc.nasa.gov/products/69' },
  { data: 'LROC NAC DTM orthoimages (SHACKRDGE02, ESALL_CR1, ESALL_SR12)', use: 'Shadow comparison', source: 'NASA/GSFC/Arizona State University, LROC PDS archive', url: 'https://data.lroc.im-ldi.com/' },
  { data: 'DE440 ephemeris, lunar orientation and frame kernels', use: 'Sun and Earth positions', source: 'NASA JPL NAIF', url: 'https://naif.jpl.nasa.gov/naif/data.html' },
  { data: 'JPL Horizons', use: 'Validation of Sun and Earth directions', source: 'NASA JPL SSD', url: 'https://ssd.jpl.nasa.gov/horizons/' },
  { data: 'PDS Geosciences Orbital Data Explorer', use: 'Finding the orthoimages', source: 'ode.rsl.wustl.edu', url: 'https://ode.rsl.wustl.edu/moon/' },
];

/* ------------------------------------------------------------------ DOM */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const li = (items: string[]) => items.map((t) => `<li>${esc(t)}</li>`).join('');

const C = { sun: '#f2b544', earth: '#5b9cf5', fg: '#e8e6e1', muted: '#8e939c', line: '#24282f' };

function drawScatter(cv: HTMLCanvasElement, v: Validation) {
  const size = Math.round(cv.clientWidth);
  if (!size) return;
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(size * dpr);
  cv.height = Math.round(size * dpr);
  const g = cv.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, size, size);
  const L = 60, R = 12, T = 12, B = 46, w = size - L - R, h = size - T - B;
  const X = (f: number) => L + f * w, Y = (f: number) => T + (1 - f) * h;
  const font = (px: number) => `${px}px system-ui, -apple-system, "Segoe UI", sans-serif`;

  g.lineWidth = 1;
  g.strokeStyle = C.line;
  g.fillStyle = C.muted;
  g.font = font(11);
  for (let i = 0; i <= 4; i++) {
    const f = i / 4, x = Math.round(X(f)) + 0.5, y = Math.round(Y(f)) + 0.5;
    g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + h); g.moveTo(L, y); g.lineTo(L + w, y); g.stroke();
    g.textAlign = 'center'; g.textBaseline = 'top';
    g.fillText(`${i * 25}%`, X(f), T + h + 6);
    g.textAlign = 'right'; g.textBaseline = 'middle';
    g.fillText(`${i * 25}%`, L - 6, Y(f));
  }
  g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  g.font = font(12);
  g.fillText('NASA PGDA map (% of time visible)', L + w / 2, size - 6);
  g.save(); g.translate(10, T + h / 2); g.rotate(-Math.PI / 2); g.textBaseline = 'middle';
  g.fillText('This tool', 0, 0); g.restore();

  g.strokeStyle = C.muted; g.setLineDash([4, 4]);
  g.beginPath(); g.moveTo(X(0), Y(0)); g.lineTo(X(1), Y(1)); g.stroke(); g.setLineDash([]);

  const s = scatterSeries(v.pgda.points);
  g.globalAlpha = 0.7;
  for (const [pts, col] of [[s.sun, C.sun], [s.earth, C.earth]] as const) {
    g.fillStyle = col;
    for (const [x, y] of pts) { g.beginPath(); g.arc(X(x), Y(y), 2.2, 0, 2 * Math.PI); g.fill(); }
  }
  g.globalAlpha = 1;
}

export function mountEvidence(el: HTMLElement, opts: { dataBase: string }): { destroy(): void } {
  const ac = new AbortController();
  const signal = ac.signal;
  let ro: ResizeObserver | undefined;

  const root = document.createElement('article');
  root.className = 'evidence';
  const loading = (id: string) => `<div class="ev-body" data-ev="${id}"><p class="ev-status">Loading…</p></div>`;
  root.innerHTML = `
    <header class="ev-head">
      <h2>How the predictions were checked</h2>
      <p class="ev-lead">Every prediction here rests on three things: where the Sun and Earth are, what the terrain horizon looks like from the site, and whether the two combine into the right shadows. Each was checked against an independent NASA source, and every check can be re-run with the scripts in this project.</p>
    </header>
    <section>
      <h3>Shadows vs real photos</h3>
      <p>We predict the shadow map at the moment each Lunar Reconnaissance Orbiter (LRO) Narrow Angle Camera photo was taken and compare it with the photo. Drag the divider to compare.</p>
      ${loading('bench')}
    </section>
    <section>
      <h3>Sun and Earth position</h3>
      <p>Sun and Earth directions as seen from the site, compared with NASA JPL Horizons.</p>
      ${loading('position')}
    </section>
    <section>
      <h3>Terrain horizon and long-term visibility</h3>
      <p>The fraction of time the Sun and Earth are visible, compared with NASA's published PGDA maps (Mazarico et al. 2011). Each dot is the Sun or Earth value at one random point near Shackleton; dots on the diagonal agree exactly.</p>
      ${loading('terrain')}
    </section>
    <section>
      <h3>How sure are the numbers</h3>
      <p>The elevation model has errors, so every result carries a spread. We compared our uncertainty model with NASA's own Monte-Carlo terrain realisations: tuned on 30, tested on 30 others. The numbers below are from the held-out set.</p>
      ${loading('calibration')}
      <p>Our bands are about 1.5x too narrow on held-out data. They cover elevation-model error near the site only and were calibrated at one site, so treat them as a lower bound.</p>
      <p>Position matters far more than this uncertainty: at the pole, moving a site 100 m can change Earth visibility from 0% to 50% of the time.</p>
    </section>
    <section>
      <h3>Known limits</h3>
      <ul class="ev-list">${li(LIMITS)}</ul>
    </section>
    <section>
      <h3>Data</h3>
      <ul class="ev-credits">${CREDITS.map((c) => `<li><span class="ev-credit-data">${esc(c.data)}</span><span class="ev-credit-use">${esc(c.use)}</span><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.source)}</a></li>`).join('')}</ul>
      <p class="ev-fine">NASA does not endorse this project.</p>
    </section>`;
  el.appendChild(root);

  const body = (id: string) => root.querySelector<HTMLElement>(`[data-ev="${id}"]`)!;
  const fail = (ids: string[], file: string, e: unknown) => {
    if (signal.aborted) return;
    const msg = e instanceof Error ? e.message : String(e);
    for (const id of ids) body(id).innerHTML = `<p class="ev-status ev-err" role="alert">Could not load ${esc(file)}: ${esc(msg)}</p>`;
  };
  async function load<T>(file: string, shape: (raw: unknown) => T, ids: string[], render: (d: T) => void) {
    try {
      const res = await fetch(opts.dataBase + file, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      let raw: unknown;
      try { raw = await res.json(); } catch { throw new Error('not valid JSON'); }
      const d = shape(raw);
      if (!signal.aborted) render(d);
    } catch (e) { fail(ids, file, e); }
  }

  /* ---- 2. shadows vs photos ---- */
  function renderBench(b: Bench) {
    const base = `${opts.dataBase}bench/`;
    const host = body('bench');
    const scoreRows = (cells: (m: ModelKey) => string, inLabel: (m: ModelKey) => string = () => '') =>
      MODELS.map(({ key, label }) => `<tr${key === 'ours' ? ' class="ev-ours"' : ''}><th scope="row">${label}${inLabel(key)}</th>${cells(key)}</tr>`).join('');
    host.innerHTML = `
      <div class="ev-compare">
        <div class="ev-stage">
          <div class="ev-frame">
            <img class="ev-img-model" alt="" draggable="false">
            <img class="ev-img-photo" alt="" draggable="false">
            <span class="ev-tag ev-tag-l">LRO photo</span>
            <span class="ev-tag ev-tag-r">Our prediction</span>
            <div class="ev-handle" role="slider" tabindex="0" aria-orientation="horizontal" aria-label="Divider between LRO photo and our prediction" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"><span></span></div>
          </div>
        </div>
        <div class="ev-detail"></div>
      </div>
      <div class="ev-thumbs" role="group" aria-label="Choose a photo">
        ${b.images.map((im, i) => `<button type="button" data-i="${i}" title="${esc(im.id)}" aria-label="${esc(im.id)}, ${groupLabel(im.group)}" aria-pressed="false"><img src="${esc(base + im.photo)}" alt="" loading="lazy" draggable="false"><span>${groupLabel(im.group)}</span></button>`).join('')}
      </div>
      <h4>All ${b.images.length} photos, average shadow overlap (IoU)</h4>
      <div class="ev-scroll"><table class="ev-table">
        <thead><tr><th scope="col">Model</th><th scope="col">${b.summary.known.n} photos, capture time known</th><th scope="col">${b.summary.matched.n} photos, time matched</th></tr></thead>
        <tbody>${scoreRows((m) => `<td>${fmtIoU(b.summary.known.scores[m].iou)}</td><td>${fmtIoU(b.summary.matched.scores[m].iou)}</td>`)}</tbody>
      </table></div>
      <p class="ev-note">IoU (intersection over union) is the overlap between the predicted and the photographed shadow: 1 means identical, 0 means no overlap at all.</p>
      <h4>Read this with care</h4>
      <ul class="ev-list">${li(PHOTO_CAVEATS)}</ul>`;

    const frame = host.querySelector<HTMLElement>('.ev-frame')!;
    const photo = host.querySelector<HTMLImageElement>('.ev-img-photo')!;
    const model = host.querySelector<HTMLImageElement>('.ev-img-model')!;
    const handle = host.querySelector<HTMLElement>('.ev-handle')!;
    const detail = host.querySelector<HTMLElement>('.ev-detail')!;
    const thumbs = host.querySelector<HTMLElement>('.ev-thumbs')!;
    const buttons = [...thumbs.querySelectorAll<HTMLButtonElement>('button')];

    let pos = 50;
    const setPos = (p: number) => {
      pos = Math.min(100, Math.max(0, p));
      photo.style.clipPath = `inset(0 ${100 - pos}% 0 0)`;
      handle.style.left = `${pos}%`;
      handle.setAttribute('aria-valuenow', String(Math.round(pos)));
      handle.setAttribute('aria-valuetext', `${Math.round(pos)}% LRO photo, ${100 - Math.round(pos)}% prediction`);
    };
    const posFromEvent = (e: PointerEvent) => {
      const r = frame.getBoundingClientRect();
      if (r.width) setPos(((e.clientX - r.left) / r.width) * 100);
    };
    let dragging = false;
    frame.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      frame.setPointerCapture(e.pointerId);
      posFromEvent(e);
      handle.focus({ preventScroll: true });
      e.preventDefault();
    }, { signal });
    frame.addEventListener('pointermove', (e) => { if (dragging) posFromEvent(e); }, { signal });
    const stop = () => { dragging = false; };
    frame.addEventListener('pointerup', stop, { signal });
    frame.addEventListener('pointercancel', stop, { signal });
    handle.addEventListener('keydown', (e) => {
      const to: Record<string, number> = { ArrowLeft: pos - 2, ArrowDown: pos - 2, ArrowRight: pos + 2, ArrowUp: pos + 2, Home: 0, End: 100 };
      if (!(e.key in to)) return;
      e.preventDefault();
      setPos(to[e.key]);
    }, { signal });

    const select = (i: number) => {
      const im = b.images[i];
      buttons.forEach((bt, j) => {
        bt.setAttribute('aria-pressed', String(j === i));
        bt.classList.toggle('on', j === i);
      });
      model.src = base + im.model;
      photo.src = base + im.photo;
      model.alt = `Predicted shadows for ${im.id}`;
      photo.alt = `LRO photo ${im.id}`;
      detail.innerHTML = `
        <p class="ev-id">${esc(im.id)}</p>
        <dl class="ev-facts">
          <div><dt>${im.group === 'known_time' ? 'Captured' : 'Captured (best match)'}</dt><dd>${fmtUtc(im.utc)}</dd></div>
          <div><dt>Sun elevation</dt><dd>${fmtDeg(im.sunEl)}</dd></div>
          <div><dt>Sun azimuth</dt><dd>${fmtDeg(im.sunAz, 1)}</dd></div>
          <div><dt>Shadow share of the photo</dt><dd>${fmtPct(im.shadowFraction, 0)}</dd></div>
        </dl>
        <table class="ev-table ev-scores">
          <thead><tr><th scope="col">Model, this photo</th><th scope="col">IoU</th><th scope="col">Pixel accuracy</th></tr></thead>
          <tbody>${scoreRows(
            (m) => `<td>${fmtIoU(im.scores[m].iou)}</td><td>${fmtPct(im.scores[m].accuracy)}</td>`,
            (m) => `<span class="ev-bar"><i style="width:${(Math.min(1, Math.max(0, im.scores[m].iou)) * 100).toFixed(1)}%"></i></span>`,
          )}</tbody>
        </table>`;
    };
    thumbs.addEventListener('click', (e) => {
      const bt = (e.target as Element).closest<HTMLButtonElement>('button[data-i]');
      if (bt) select(Number(bt.dataset.i));
    }, { signal });

    const start = Math.max(0, b.images.findIndex((im) => im.id === DEFAULT_IMAGE));
    setPos(pos);
    select(start);
    const bt = buttons[start];
    thumbs.scrollLeft = bt.offsetLeft - thumbs.offsetLeft - (thumbs.clientWidth - bt.offsetWidth) / 2;
  }

  /* ---- 3 + 4. validation ---- */
  function renderValidation(v: Validation) {
    body('position').innerHTML = `
      <dl class="ev-stats">
        <div><dt>Sun, largest error</dt><dd>${fmtDeg(v.horizons.sun, 5)}</dd></div>
        <div><dt>Earth, largest error</dt><dd>${fmtDeg(v.horizons.earth, 5)}</dd></div>
        <div><dt>Samples compared</dt><dd>${v.horizons.n}</dd></div>
        <div><dt>Apollo 11, Sun elevation at touchdown</dt><dd>10.70°</dd><dd class="ev-sub">historical value 10.8°</dd></div>
      </dl>`;

    const fitRow = (name: string, r: RegionFit, cls = '') =>
      `<tr${cls}><th scope="row">${name}</th><td>${fmtPct(r.sun.mae)}</td><td>${fmtPct(r.earth.mae)}</td></tr>`;
    const host = body('terrain');
    host.innerHTML = `
      <div class="ev-plotrow">
        <figure class="ev-plot">
          <canvas role="img" aria-label="Scatter plot of this tool against the NASA PGDA maps, ${v.pgda.points.length} points each for Sun and Earth, clustered along the 1:1 line"></canvas>
          <figcaption><span class="ev-key ev-key-sun">Sun</span><span class="ev-key ev-key-earth">Earth</span><span class="ev-key ev-key-diag">Exact agreement</span></figcaption>
        </figure>
        <div class="ev-plotside">
          <dl class="ev-stats ev-stats-2">
            <div><dt>Sun, mean error</dt><dd>${fmtPct(v.pgda.sun.mae)}</dd><dd class="ev-sub">correlation r = ${v.pgda.sun.r.toFixed(2)}</dd></div>
            <div><dt>Earth, mean error</dt><dd>${fmtPct(v.pgda.earth.mae)}</dd><dd class="ev-sub">correlation r = ${v.pgda.earth.r.toFixed(2)}</dd></div>
          </dl>
          <p class="ev-note">${v.pgda.n} random points near Shackleton. Errors are in percentage points of time visible. For this comparison the tool applied NASA's rule for Earth (any part of the disk counts).</p>
          <h4>Other regions</h4>
          <div class="ev-scroll"><table class="ev-table">
            <thead><tr><th scope="col">Region</th><th scope="col">Sun error</th><th scope="col">Earth error</th></tr></thead>
            <tbody>
              ${v.otherRegions.map((r) => fitRow(esc(prettyRegion(r.id)), r)).join('')}
              ${fitRow('No 20 m coverage <span class="ev-flag">coarse terrain only</span>', v.coarseRegion)}
            </tbody>
          </table></div>
          <p class="ev-note">In the other 20 m regions the rays cross into the coarse far-field terrain. The last row is a region where only 240 m terrain is available.</p>
          <p class="ev-note">Brute-force check: against a brute-force 10 m search, the fast horizon search misses at most <span class="ev-num">${fmtDeg(v.denseMarchMaxMissedDeg)}</span>.</p>
        </div>
      </div>`;
    const cv = host.querySelector('canvas')!;
    drawScatter(cv, v);
    ro = new ResizeObserver(() => drawScatter(cv, v));
    ro.observe(cv);
  }

  /* ---- 5. calibration ---- */
  function renderCalibration(c: Calibration) {
    body('calibration').innerHTML = `
      <div class="ev-scroll"><table class="ev-table ev-narrow">
        <thead><tr><th scope="col">Held-out comparison</th><th scope="col">NASA realisations</th><th scope="col">This tool</th></tr></thead>
        <tbody>
          <tr><th scope="row">Horizon spread (median)</th><td>${fmtDeg(c.horizonSigma.clones, 3)}</td><td>${fmtDeg(c.horizonSigma.model, 3)}</td></tr>
          <tr><th scope="row">Spread of yearly % sunlit</th><td>${fmtPct(c.litStd.clones, 2)}</td><td>${fmtPct(c.litStd.model, 2)}</td></tr>
          <tr><th scope="row">Mean yearly % sunlit</th><td>${fmtPct(c.litMean.clones)}</td><td>${fmtPct(c.litMean.model)}</td></tr>
        </tbody>
      </table></div>`;
  }

  void load('bench/index.json', shapeBench, ['bench'], renderBench);
  void load('validation.json', shapeValidation, ['position', 'terrain'], renderValidation);
  void load('calibration.json', shapeCalibration, ['calibration'], renderCalibration);

  return {
    destroy() {
      ac.abort();
      ro?.disconnect();
      root.remove();
    },
  };
}
