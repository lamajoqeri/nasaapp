// Canvas site picker: south-polar stereographic view + whole-Moon equirectangular view.
// Map units: metres (spstere, y up) in the polar view; degrees (lon 0..360, lat) in the global view.
import './map.css';
import { spFwd, spInv } from '../core/geom';

export interface MapSite { id: string; name: string; lat: number; lon: number; program: string }
export interface MapMarker { lat: number; lon: number; label: string }
export interface MapHandle {
  setMarkers(m: MapMarker[]): void; focus(lat: number, lon: number): void; destroy(): void;
  setMode(m: Mode): void; setOverlay(o: OverlayId): void; state(): { mode: Mode; overlay: OverlayId };
}

// ---------- pure helpers (unit-tested in map.test.ts) ----------

/** [x_min, y_min, x_max, y_max] in map units, y up. */
export type Bounds = [number, number, number, number];
/** Map point (cx, cy) sits at the centre of a w x h CSS-pixel viewport; scale = px per map unit. */
export interface View { cx: number; cy: number; scale: number; w: number; h: number }
export interface Rect { x: number; y: number; w: number; h: number }
export type Mode = 'polar' | 'global';

export function toScreen(v: View, x: number, y: number): [number, number] {
  return [v.w / 2 + (x - v.cx) * v.scale, v.h / 2 - (y - v.cy) * v.scale];
}

export function toMap(v: View, sx: number, sy: number): [number, number] {
  return [v.cx + (sx - v.w / 2) / v.scale, v.cy - (sy - v.h / 2) / v.scale];
}

/** Largest scale at which the whole of `b` fits in the viewport. */
export function fitScale(b: Bounds, w: number, h: number): number {
  return Math.min(w / (b[2] - b[0]), h / (b[3] - b[1]));
}

/** Keep the view inside `b`; an axis on which the map is smaller than the viewport is centred. */
export function clampView(v: View, b: Bounds): View {
  const axis = (c: number, lo: number, hi: number, px: number) => {
    const half = px / 2 / v.scale;
    return (hi - lo) * v.scale <= px ? (lo + hi) / 2 : Math.min(hi - half, Math.max(lo + half, c));
  };
  return { ...v, cx: axis(v.cx, b[0], b[2], v.w), cy: axis(v.cy, b[1], b[3], v.h) };
}

/** Change scale keeping the map point under screen point (sx, sy) fixed. */
export function zoomAt(v: View, sx: number, sy: number, scale: number): View {
  const [mx, my] = toMap(v, sx, sy);
  return { ...v, scale, cx: mx - (sx - v.w / 2) / scale, cy: my + (sy - v.h / 2) / scale };
}

export const lon360 = (lon: number) => ((lon % 360) + 360) % 360;
export const lon180 = (lon: number) => lon360(lon + 180) - 180;

/** lat/lon (lon any convention) -> map units of the given view. */
export function llToMap(mode: Mode, lat: number, lon: number): [number, number] {
  return mode === 'polar' ? spFwd(lat, lon) : [lon360(lon), lat];
}

/** Map units -> [lat, lon] with lon in -180..180. */
export function mapToLl(mode: Mode, x: number, y: number): [number, number] {
  if (mode === 'polar') return spInv(x, y);
  return [y, lon180(x)];
}

export const inBounds = (b: Bounds, x: number, y: number) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];

/** Pixel [col, row] of map point (x, y) in a w x h image covering `b` (row 0 = y_max), or null outside. */
export function imgPixel(b: Bounds, w: number, h: number, x: number, y: number): [number, number] | null {
  if (!inBounds(b, x, y)) return null;
  return [
    Math.min(w - 1, Math.floor(((x - b[0]) / (b[2] - b[0])) * w)),
    Math.min(h - 1, Math.floor(((b[3] - y) / (b[3] - b[1])) * h)),
  ];
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** True when the view is narrow enough (< maxWidth map units) and touches the detail image. */
export function detailVisible(v: View, b: Bounds, maxWidth = 80000): boolean {
  if (v.w / v.scale >= maxWidth) return false;
  const [x0, y1] = toMap(v, 0, 0), [x1, y0] = toMap(v, v.w, v.h);
  return x0 < b[2] && x1 > b[0] && y0 < b[3] && y1 > b[1];
}

export function formatLatLon(lat: number, lon: number): string {
  const l = lon180(lon);
  return `${Math.abs(lat).toFixed(2)}°${lat < 0 ? 'S' : 'N'} ${Math.abs(l).toFixed(2)}°${l < 0 ? 'W' : 'E'}`;
}

/** Scale-bar length: largest 1/2/5 x 10^n km that is at most maxPx wide. */
export function niceScaleKm(pxPerMetre: number, maxPx: number): number {
  const km = maxPx / pxPerMetre / 1000;
  const p = 10 ** Math.floor(Math.log10(km));
  return (km / p >= 5 ? 5 : km / p >= 2 ? 2 : 1) * p;
}

/** Smooth 0..1 fade: 0 at d <= 0, 1 at d >= width. */
export function feather(d: number, width: number): number {
  const t = Math.min(1, Math.max(0, d / width));
  return t * t * (3 - 2 * t);
}

/** Gain/offset that maps values with mean/std `from` onto mean/std `to`. */
export function matchStats(from: [number, number], to: [number, number]): [number, number] {
  const gain = from[1] > 0 ? to[1] / from[1] : 1;
  return [gain, to[0] - gain * from[0]];
}

/** [mean, std] of every 4th byte (the R channel of RGBA pixels). */
function grayStats(px: Uint8ClampedArray): [number, number] {
  let s = 0, s2 = 0;
  const n = px.length / 4;
  for (let j = 0; j < px.length; j += 4) { s += px[j]; s2 += px[j] * px[j]; }
  const m = s / n;
  return [m, Math.sqrt(Math.max(0, s2 / n - m * m))];
}

type RGB = [number, number, number];
/** 256-entry RGB ramp from the background colour to `end`. */
export function rampLut(end: RGB, start: RGB = BG_RGB): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(768);
  for (let i = 0; i < 256; i++) for (let c = 0; c < 3; c++) lut[i * 3 + c] = start[c] + ((end[c] - start[c]) * i) / 255;
  return lut;
}

// ---------- canvas colours (match the tokens in style.css) ----------

const BG = '#0a0b0d', FG = '#e8e6e1', MUTED = '#8e939c';
const BG_RGB: RGB = [10, 11, 13], SUN_RGB: RGB = [242, 181, 68], EARTH_RGB: RGB = [91, 156, 245];
const OVERLAY_ALPHA = 0.7;
const OVERLAY_R = 150000, OVERLAY_FEATHER = 10000;   // PGDA data disc (≈85°S) and its fade, metres
const DETAIL_FEATHER = 0.15;                          // detail map fades out over its outer 15%
const MIN_VIEW_M = 5000;       // polar max zoom: a 5 km area fills the view
const GLOBAL_MAX_ZOOM = 40;    // global max zoom, relative to fit
const FOCUS_VIEW_M = 60000;
const CLICK_SLOP = 4, HIT_R = 9;
const FONT = '11px system-ui, -apple-system, "Segoe UI", sans-serif';

const DEFAULT_BOUNDS: Record<string, Bounds> = {
  sp_hillshade: [-304000, -303920, 303920, 304000],
  shackleton_hillshade: [-30000, -30000, 10000, 10000],
  sp_sun: [-151740, -151740, 151740, 151740],
  sp_earth: [-151740, -151740, 151740, 151740],
  global_hillshade: [0, -90, 360, 90],
};
const FILES: Record<string, string> = {
  sp_hillshade: 'sp_hillshade.png', shackleton_hillshade: 'shackleton_hillshade.png',
  sp_sun: 'sp_sun.png', sp_earth: 'sp_earth.png', global_hillshade: 'global_hillshade.jpg',
};
const NAMES: Record<string, string> = {
  sp_hillshade: 'south pole map', shackleton_hillshade: 'Shackleton detail map',
  sp_sun: 'sunlight overlay', sp_earth: 'Earth-view overlay', global_hillshade: 'whole-Moon map',
};

export type OverlayId = 'none' | 'sp_sun' | 'sp_earth';
interface Overlay { canvas: HTMLCanvasElement; data: Uint8Array; w: number; h: number }

// ---------- component ----------

export function mountMap(el: HTMLElement, opts: {
  dataBase: string;
  sites: MapSite[];
  onPick(lat: number, lon: number, siteId?: string): void;
  /** Region/overlay toolbar clicks go here when given (so the app can route them through its actions). */
  onBar?(c: { mode?: Mode; overlay?: OverlayId }): void;
}): MapHandle {
  const root = document.createElement('div');
  root.className = 'lmap';
  root.innerHTML = `
    <div class="lmap-bar">
      <div class="lmap-seg" role="group" aria-label="Map view">
        <button type="button" data-mode="polar" aria-pressed="true">South Pole</button>
        <button type="button" data-mode="global" aria-pressed="false">Whole Moon</button>
      </div>
      <div class="lmap-seg lmap-ov" role="group" aria-label="Overlay">
        <button type="button" data-ov="none" aria-pressed="true">Terrain</button>
        <button type="button" data-ov="sp_sun" aria-pressed="false">Sunlight</button>
        <button type="button" data-ov="sp_earth" aria-pressed="false">Earth view</button>
      </div>
      <div class="lmap-legend" hidden><span>0%</span><canvas width="256" height="1"></canvas><span>100% of the time</span><span class="lmap-legend-note">· NASA data covers poleward of ~85°S</span></div>
      <div class="lmap-seg lmap-zoom" role="group" aria-label="Zoom">
        <button type="button" data-zoom="out" aria-label="Zoom out">&minus;</button>
        <button type="button" data-zoom="in" aria-label="Zoom in">+</button>
      </div>
    </div>
    <div class="lmap-stage">
      <canvas class="lmap-canvas" role="img" tabindex="0"></canvas>
      <p class="lmap-loading">Loading map…</p>
    </div>
    <p class="lmap-readout"></p>
    <p class="lmap-err" role="status"></p>`;
  el.append(root);

  const q = <T extends HTMLElement>(s: string) => root.querySelector(s) as T;
  const canvas = q<HTMLCanvasElement>('.lmap-canvas');
  const ctx = canvas.getContext('2d')!;
  const loadingEl = q('.lmap-loading'), readoutEl = q('.lmap-readout'), errEl = q('.lmap-err');
  const legendEl = q('.lmap-legend'), ovGroup = q('.lmap-ov');
  const HINT = 'Drag to pan, scroll to zoom, click to choose a point.';
  readoutEl.textContent = HINT;

  const ac = new AbortController();
  const on = { signal: ac.signal };
  let dead = false;

  const bounds: Record<string, Bounds> = { ...DEFAULT_BOUNDS };
  const images: Record<string, HTMLImageElement> = {};
  const requested = new Set<string>();
  const overlays: Partial<Record<OverlayId, Overlay>> = {};
  let detail: CanvasImageSource | null = null;   // Shackleton map, matched + feathered into the base
  const luts = { sp_sun: rampLut(SUN_RGB), sp_earth: rampLut(EARTH_RGB) };
  const errors = new Set<string>();

  let mode: Mode = 'polar';
  let overlay: OverlayId = 'none';
  let view: View = { cx: 0, cy: 0, scale: 1, w: 0, h: 0 };
  const saved: Partial<Record<Mode, { cx: number; cy: number; scale: number }>> = {};
  let pendingFocus: [number, number] | null = null;
  let markers: MapMarker[] = [];
  let hoverSite: MapSite | null = null;
  let cross: [number, number] | null = null;   // map units
  let crossTimer = 0, raf = 0, indexReady = false;

  const baseId = () => (mode === 'polar' ? 'sp_hillshade' : 'global_hillshade');
  const baseBounds = () => bounds[baseId()];
  const minScale = () => fitScale(baseBounds(), view.w, view.h);
  const maxScale = () => (mode === 'polar' ? Math.max(minScale(), view.w / MIN_VIEW_M) : minScale() * GLOBAL_MAX_ZOOM);
  const clampScale = (s: number) => Math.min(maxScale(), Math.max(minScale(), s));

  function fail(what: string) {
    errors.add(what);
    errEl.textContent = `Could not load: ${[...errors].join(', ')}.`;
  }

  function load(id: string) {
    if (requested.has(id) || dead) return;
    requested.add(id);
    const img = new Image();
    img.onload = () => {
      if (dead) return;
      images[id] = img;
      if (id === 'sp_sun' || id === 'sp_earth') {
        try { overlays[id] = buildOverlay(img, luts[id], bounds[id]); } catch { fail(NAMES[id]); }
      }
      refreshLoading(); draw();
    };
    img.onerror = () => { if (!dead) { fail(NAMES[id]); refreshLoading(); } };
    img.src = opts.dataBase + 'maps/' + FILES[id];
  }

  function refreshLoading() {
    const failed = errors.has(NAMES[baseId()]);
    loadingEl.hidden = !!images[baseId()] || failed;
  }

  fetch(opts.dataBase + 'maps/index.json', on)
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((list: { id: string; file: string; bounds?: number[]; bounds_deg?: { lon_min: number; lon_max: number; lat_min: number; lat_max: number } }[]) => {
      for (const m of list) {
        if (m.file) FILES[m.id] = m.file;
        if (m.bounds?.length === 4) bounds[m.id] = m.bounds as Bounds;
        else if (m.bounds_deg) bounds[m.id] = [m.bounds_deg.lon_min, m.bounds_deg.lat_min, m.bounds_deg.lon_max, m.bounds_deg.lat_max];
      }
    })
    .catch(() => { if (!dead) fail('map index (using default bounds)'); })
    .finally(() => {
      if (dead) return;
      indexReady = true;
      load('sp_hillshade'); load('sp_sun'); load('sp_earth');
      if (mode === 'global') load('global_hillshade');
      layout();
    });

  // ----- view state -----

  function setView(v: View) { view = clampView({ ...v, scale: clampScale(v.scale) }, baseBounds()); draw(); }

  function resetView() {
    const b = baseBounds(), s = saved[mode];
    view = { ...view, cx: (b[0] + b[2]) / 2, cy: (b[1] + b[3]) / 2, scale: minScale(), ...s };
    setView(view);
  }

  function applyFocus(lat: number, lon: number) {
    const [cx, cy] = llToMap(mode, lat, lon);
    setView({ ...view, cx, cy, scale: mode === 'polar' ? view.w / FOCUS_VIEW_M : minScale() * 6 });
  }

  function layout() {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height || !indexReady) return;
    const dpr = window.devicePixelRatio || 1;
    const first = view.w === 0, atFit = !first && view.scale <= minScale() * 1.001;
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    view = { ...view, w: r.width, h: r.height };
    if (pendingFocus) { applyFocus(...pendingFocus); pendingFocus = null; }
    else if (first) resetView();
    else setView(atFit ? { ...view, scale: minScale() } : view);
    drawNow();
  }

  function setMode(m: Mode) {
    if (m === mode) return;
    if (view.w) saved[mode] = { cx: view.cx, cy: view.cy, scale: view.scale };
    mode = m;
    hoverSite = null; cross = null;
    for (const b of root.querySelectorAll<HTMLButtonElement>('[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === m));
    ovGroup.hidden = m !== 'polar';
    syncChrome();
    if (m === 'global') load('global_hillshade');
    refreshLoading();
    if (view.w) resetView();
  }

  function setOverlay(o: OverlayId) {
    overlay = o;
    for (const b of root.querySelectorAll<HTMLButtonElement>('[data-ov]')) b.setAttribute('aria-pressed', String(b.dataset.ov === o));
    syncChrome(); draw();
  }

  function syncChrome() {
    const show = mode === 'polar' && overlay !== 'none';
    legendEl.hidden = !show;
    if (show) {
      const c = legendEl.querySelector('canvas')!, g = c.getContext('2d')!, lut = luts[overlay as 'sp_sun'];
      const im = g.createImageData(256, 1);
      for (let i = 0; i < 256; i++) im.data.set([lut[i * 3], lut[i * 3 + 1], lut[i * 3 + 2], 255], i * 4);
      g.putImageData(im, 0, 0);
    }
    canvas.setAttribute('aria-label', (mode === 'polar'
      ? 'Map of the lunar south pole, 80 to 90 degrees south'
      + (overlay === 'sp_sun' ? ', coloured by how often the Sun is visible' : overlay === 'sp_earth' ? ', coloured by how often Earth is visible' : '')
      : 'Map of the whole Moon')
      + `, showing ${opts.sites.length} catalogue sites. ${HINT} Arrow keys pan, plus and minus zoom.`);
  }
  syncChrome();

  // ----- drawing -----

  function draw() { if (!raf && !dead) raf = requestAnimationFrame(drawNow); }

  function drawGeo(img: CanvasImageSource, iw: number, ih: number, b: Bounds) {
    // Crop to the visible part so the destination rect stays small at high zoom.
    const [vx0, vy1] = toMap(view, 0, 0), [vx1, vy0] = toMap(view, view.w, view.h);
    const x0 = Math.max(b[0], vx0), x1 = Math.min(b[2], vx1), y0 = Math.max(b[1], vy0), y1 = Math.min(b[3], vy1);
    if (x1 <= x0 || y1 <= y0) return;
    const kx = iw / (b[2] - b[0]), ky = ih / (b[3] - b[1]);
    const [dx, dy] = toScreen(view, x0, y1);
    ctx.drawImage(img, (x0 - b[0]) * kx, (b[3] - y1) * ky, (x1 - x0) * kx, (y1 - y0) * ky, dx, dy, (x1 - x0) * view.scale, (y1 - y0) * view.scale);
  }

  function text(s: string, x: number, y: number, color = FG, align: CanvasTextAlign = 'left') {
    ctx.textAlign = align;
    ctx.lineWidth = 3; ctx.strokeStyle = BG; ctx.lineJoin = 'round';
    ctx.strokeText(s, x, y);
    ctx.fillStyle = color;
    ctx.fillText(s, x, y);
  }

  function visibleSites(): { s: MapSite; x: number; y: number }[] {
    const b = baseBounds(), out = [];
    for (const s of opts.sites) {
      if (mode === 'polar' && s.lat > -60) continue;
      const [mx, my] = llToMap(mode, s.lat, s.lon);
      if (!inBounds(b, mx, my)) continue;
      const [x, y] = toScreen(view, mx, my);
      out.push({ s, x, y });
    }
    return out;
  }

  function drawNow() {
    raf = 0;
    if (dead || !view.w) return;
    const dpr = canvas.width / view.w;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, view.w, view.h);
    ctx.imageSmoothingQuality = 'high';

    const base = images[baseId()], b = baseBounds();
    if (base) drawGeo(base, base.naturalWidth, base.naturalHeight, b);
    if (mode === 'polar') {
      const sb = bounds.shackleton_hillshade;
      if (detailVisible(view, sb)) {
        load('shackleton_hillshade');
        const d = images.shackleton_hillshade;
        if (d && base && !detail) {
          try { detail = buildDetail(d, sb, base, b); } catch { detail = d; }
        }
        if (detail) drawGeo(detail, d.naturalWidth, d.naturalHeight, sb);
      }
      const ov = overlay !== 'none' ? overlays[overlay] : undefined;
      if (ov) {
        ctx.globalAlpha = OVERLAY_ALPHA;
        drawGeo(ov.canvas, ov.w, ov.h, bounds[overlay]);
        ctx.globalAlpha = 1;
      }
    }

    ctx.font = FONT;
    ctx.textBaseline = 'middle';
    if (mode === 'polar') drawPolarFurniture(b);

    // Catalogue sites: dots, then labels placed greedily (hovered site first).
    const pts = visibleSites().filter((p) => p.x > -20 && p.x < view.w + 20 && p.y > -20 && p.y < view.h + 20);
    for (const { s, x, y } of pts) {
      const hot = s === hoverSite;
      ctx.beginPath(); ctx.arc(x, y, hot ? 5 : 3.5, 0, 7);
      ctx.fillStyle = FG; ctx.fill();
      ctx.lineWidth = 1.5; ctx.strokeStyle = BG; ctx.stroke();
      if (hot) { ctx.beginPath(); ctx.arc(x, y, 9, 0, 7); ctx.lineWidth = 1.5; ctx.strokeStyle = FG; ctx.stroke(); }
    }
    const placed: Rect[] = markers.map((m) => {
      const [x, y] = toScreen(view, ...llToMap(mode, m.lat, m.lon));
      return { x: x - 10, y: y - 20, w: 28, h: 30 };
    });
    for (const p of [...pts].sort((a, c) => +(c.s === hoverSite) - +(a.s === hoverSite))) {
      const w = ctx.measureText(p.s.name).width;
      const right = p.x + 9 + w < view.w - 4;
      const r: Rect = { x: right ? p.x + 7 : p.x - 9 - w, y: p.y - 8, w: w + 4, h: 16 };
      if (p.s !== hoverSite && placed.some((o) => rectsOverlap(o, r))) continue;
      placed.push(r);
      text(p.s.name, r.x + 2, p.y, p.s === hoverSite ? FG : '#c9c8c4');
    }

    if (cross) {
      const [x, y] = toScreen(view, cross[0], cross[1]);
      ctx.beginPath();
      for (const [ax, ay] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { ctx.moveTo(x + ax * 4, y + ay * 4); ctx.lineTo(x + ax * 13, y + ay * 13); }
      ctx.lineWidth = 3; ctx.strokeStyle = BG; ctx.stroke();
      ctx.lineWidth = 1.25; ctx.strokeStyle = FG; ctx.stroke();
    }

    // Scenario markers: ring + letter badge, above everything.
    ctx.font = '600 ' + FONT;
    for (const m of markers) {
      const [mx, my] = llToMap(mode, m.lat, m.lon);
      if (!inBounds(b, mx, my)) continue;
      const [x, y] = toScreen(view, mx, my);
      if (x < -20 || x > view.w + 20 || y < -20 || y > view.h + 20) continue;
      ctx.beginPath(); ctx.arc(x, y, 7, 0, 7);
      ctx.lineWidth = 4; ctx.strokeStyle = BG; ctx.stroke();
      ctx.lineWidth = 2; ctx.strokeStyle = FG; ctx.stroke();
      const bw = Math.max(15, ctx.measureText(m.label).width + 8);
      ctx.beginPath(); ctx.roundRect(x + 6, y - 20, bw, 15, 3);
      ctx.fillStyle = FG; ctx.fill();
      ctx.lineWidth = 1; ctx.strokeStyle = BG; ctx.stroke();
      ctx.fillStyle = BG; ctx.textAlign = 'center';
      ctx.fillText(m.label, x + 6 + bw / 2, y - 12);
    }
  }

  function drawPolarFurniture(b: Bounds) {
    // Longitude labels + Earth direction, only near the default zoom where the whole disc is visible.
    if (view.scale <= minScale() * 1.05) {
      const [l, t] = toScreen(view, b[0], b[3]), [r, bt] = toScreen(view, b[2], b[1]);
      const [px, py] = toScreen(view, 0, 0);
      text('0°', px, t + 12, FG, 'center');
      text('to Earth ↑', px, t + 27, MUTED, 'center');
      text('180°', px, bt - 12, FG, 'center');
      text('90°E', r - 8, py, FG, 'right');
      text('90°W', l + 8, py, FG, 'left');
    }
    // Scale bar, bottom-left.
    const km = niceScaleKm(view.scale, 120), len = km * 1000 * view.scale;
    const x = 12, y = view.h - 14;
    ctx.beginPath();
    ctx.moveTo(x, y - 4); ctx.lineTo(x, y); ctx.lineTo(x + len, y); ctx.lineTo(x + len, y - 4);
    ctx.lineWidth = 3; ctx.strokeStyle = BG; ctx.stroke();
    ctx.lineWidth = 1; ctx.strokeStyle = FG; ctx.stroke();
    text(`${km} km`, x + len + 6, y - 2);
  }

  // ----- readout -----

  function pct(id: 'sp_sun' | 'sp_earth', x: number, y: number): number | null {
    const o = overlays[id];
    const p = o && imgPixel(bounds[id], o.w, o.h, x, y);
    return o && p ? Math.round((o.data[p[1] * o.w + p[0]] / 255) * 100) : null;
  }

  function readout(sx: number, sy: number) {
    const [mx, my] = toMap(view, sx, sy);
    if (!inBounds(baseBounds(), mx, my)) { readoutEl.textContent = HINT; return; }
    const [lat, lon] = hoverSite ? [hoverSite.lat, hoverSite.lon] : mapToLl(mode, mx, my);
    let s = (hoverSite ? hoverSite.name + ' · ' : '') + formatLatLon(lat, lon);
    if (mode === 'polar') {
      const [ox, oy] = hoverSite ? spFwd(lat, lon) : [mx, my];
      const sun = pct('sp_sun', ox, oy), earth = pct('sp_earth', ox, oy);
      const parts = [sun != null && `Sun visible ${sun}%`, earth != null && `Earth visible ${earth}%`].filter(Boolean);
      if (parts.length) s += ` · ${parts.join(' · ')} of the time (NASA average)`;
    }
    readoutEl.textContent = s;
  }

  function siteAt(sx: number, sy: number): MapSite | null {
    let best: MapSite | null = null, bd = HIT_R * HIT_R;
    for (const { s, x, y } of visibleSites()) {
      const d = (x - sx) ** 2 + (y - sy) ** 2;
      if (d <= bd) { bd = d; best = s; }
    }
    return best;
  }

  // ----- input -----

  const pointers = new Map<number, [number, number]>();
  let downAt: [number, number] = [0, 0], moved = false, multi = false, pinch = 0;
  const pos = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const two = () => {
    const [a, b] = [...pointers.values()];
    return { d: Math.hypot(a[0] - b[0], a[1] - b[1]), mx: (a[0] + b[0]) / 2, my: (a[1] + b[1]) / 2 };
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const p = pos(e);
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, p);
    if (pointers.size === 1) { downAt = p; moved = false; multi = false; }
    else if (pointers.size === 2) { multi = true; pinch = two().d; }
  }, on);

  canvas.addEventListener('pointermove', (e) => {
    const p = pos(e), prev = pointers.get(e.pointerId);
    if (!prev) {
      if (pointers.size || !view.w) return;
      const s = siteAt(p[0], p[1]);
      if (s !== hoverSite) { hoverSite = s; draw(); }
      canvas.style.cursor = s ? 'pointer' : '';
      readout(p[0], p[1]);
      return;
    }
    if (pointers.size === 1) {
      if (!moved && Math.hypot(p[0] - downAt[0], p[1] - downAt[1]) < CLICK_SLOP) return;
      if (!moved) { moved = true; canvas.classList.add('lmap-dragging'); }
      pointers.set(e.pointerId, p);
      setView({ ...view, cx: view.cx - (p[0] - prev[0]) / view.scale, cy: view.cy + (p[1] - prev[1]) / view.scale });
    } else if (pointers.size === 2) {
      const before = two();
      pointers.set(e.pointerId, p);
      const after = two();
      let v = { ...view, cx: view.cx - (after.mx - before.mx) / view.scale, cy: view.cy + (after.my - before.my) / view.scale };
      if (pinch > 0 && after.d > 0) v = zoomAt(v, after.mx, after.my, clampScale(view.scale * (after.d / pinch)));
      pinch = after.d;
      setView(v);
    }
  }, on);

  const up = (e: PointerEvent, cancelled: boolean) => {
    if (!pointers.delete(e.pointerId)) return;
    if (pointers.size) return;
    canvas.classList.remove('lmap-dragging');
    if (cancelled || moved || multi || !view.w) return;
    const [sx, sy] = pos(e);
    const site = siteAt(sx, sy);
    const [mx, my] = toMap(view, sx, sy);
    if (site) {
      cross = llToMap(mode, site.lat, site.lon);
      opts.onPick(site.lat, site.lon, site.id);
    } else {
      if (!inBounds(baseBounds(), mx, my)) return;
      cross = [mx, my];
      const [lat, lon] = mapToLl(mode, mx, my);
      opts.onPick(lat, lon);
    }
    if (e.pointerType !== 'mouse') { hoverSite = site; readout(sx, sy); hoverSite = null; }
    clearTimeout(crossTimer);
    crossTimer = window.setTimeout(() => { cross = null; draw(); }, 1200);
    draw();
  };
  canvas.addEventListener('pointerup', (e) => up(e, false), on);
  canvas.addEventListener('pointercancel', (e) => up(e, true), on);
  canvas.addEventListener('pointerleave', () => {
    if (pointers.size) return;
    if (hoverSite) { hoverSite = null; draw(); }
    canvas.style.cursor = '';
    readoutEl.textContent = HINT;
  }, on);

  canvas.addEventListener('wheel', (e) => {
    if (!view.w) return;
    e.preventDefault();
    const [sx, sy] = pos(e);
    const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? view.h : 1);
    setView(zoomAt(view, sx, sy, clampScale(view.scale * Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.002)))));
    readout(sx, sy);
  }, { signal: ac.signal, passive: false });

  const zoomBy = (f: number) => { if (view.w) setView(zoomAt(view, view.w / 2, view.h / 2, clampScale(view.scale * f))); };

  canvas.addEventListener('keydown', (e) => {
    const step = 48 / view.scale;
    const pan: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (pan[e.key]) setView({ ...view, cx: view.cx + pan[e.key][0], cy: view.cy + pan[e.key][1] });
    else if (e.key === '+' || e.key === '=') zoomBy(1.5);
    else if (e.key === '-' || e.key === '_') zoomBy(1 / 1.5);
    else return;
    e.preventDefault();
  }, on);

  root.querySelector('.lmap-bar')!.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    if (b.dataset.mode) opts.onBar ? opts.onBar({ mode: b.dataset.mode as Mode }) : setMode(b.dataset.mode as Mode);
    else if (b.dataset.ov) opts.onBar ? opts.onBar({ overlay: b.dataset.ov as OverlayId }) : setOverlay(b.dataset.ov as OverlayId);
    else if (b.dataset.zoom) zoomBy(b.dataset.zoom === 'in' ? 1.5 : 1 / 1.5);
  }, on);

  const ro = new ResizeObserver(layout);
  ro.observe(canvas);

  return {
    setMarkers(m) { markers = m.slice(); draw(); },
    setMode, setOverlay,
    state: () => ({ mode, overlay }),
    focus(lat, lon) {
      setMode(lat < -80 ? 'polar' : 'global');
      if (view.w) applyFocus(lat, lon); else pendingFocus = [lat, lon];
    },
    destroy() {
      dead = true;
      ac.abort(); ro.disconnect();
      cancelAnimationFrame(raf); clearTimeout(crossTimer);
      root.remove();
    },
  };
}

function canvasOf(src: CanvasImageSource, w: number, h: number, sx = 0, sy = 0, sw = w, sh = h) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, sx, sy, sw, sh, 0, 0, w, h);
  return { canvas, g, im: g.getImageData(0, 0, w, h) };
}

/**
 * Recolour an overlay's gray channel through `lut`, once, and mask it to a feathered disc of
 * radius OVERLAY_R around the pole (the PGDA square's corners would otherwise end in a hard edge).
 * Gray 0 is real data (never lit / never sees Earth), not nodata — the PGDA PNGs have no nodata.
 */
function buildOverlay(img: HTMLImageElement, lut: Uint8ClampedArray, b: Bounds): Overlay {
  const w = img.naturalWidth, h = img.naturalHeight;
  const { canvas, g, im } = canvasOf(img, w, h), px = im.data;
  const kx = (b[2] - b[0]) / w, ky = (b[3] - b[1]) / h;
  const data = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    const v = (data[i] = px[j]);
    px[j] = lut[v * 3]; px[j + 1] = lut[v * 3 + 1]; px[j + 2] = lut[v * 3 + 2];
    const x = b[0] + ((i % w) + 0.5) * kx, y = b[3] - (Math.floor(i / w) + 0.5) * ky;
    px[j + 3] = 255 * feather(OVERLAY_R - Math.hypot(x, y), OVERLAY_FEATHER);
  }
  g.putImageData(im, 0, 0);
  return { canvas, data, w, h };
}

/**
 * Detail hillshade blended into the base: gray gain/offset matched to the base over the same
 * footprint (compared at base resolution, so the detail's extra sharpness doesn't skew the std),
 * and alpha feathered to 0 over the outer DETAIL_FEATHER of the tile.
 */
function buildDetail(img: HTMLImageElement, db: Bounds, base: HTMLImageElement, bb: Bounds): HTMLCanvasElement {
  const bw = base.naturalWidth, bh = base.naturalHeight;
  const kx = bw / (bb[2] - bb[0]), ky = bh / (bb[3] - bb[1]);
  const n = Math.max(8, Math.round((db[2] - db[0]) * kx));
  const baseLow = canvasOf(base, n, n, (db[0] - bb[0]) * kx, (bb[3] - db[3]) * ky, (db[2] - db[0]) * kx, (db[3] - db[1]) * ky);
  const detLow = canvasOf(img, n, n, 0, 0, img.naturalWidth, img.naturalHeight);
  const [gain, off] = matchStats(grayStats(detLow.im.data), grayStats(baseLow.im.data));

  const w = img.naturalWidth, h = img.naturalHeight, fw = DETAIL_FEATHER * Math.min(w, h);
  const { canvas, g, im } = canvasOf(img, w, h), px = im.data;
  for (let i = 0, j = 0; j < px.length; i++, j += 4) {
    const v = gain * px[j] + off, c = i % w, r = Math.floor(i / w);
    px[j] = px[j + 1] = px[j + 2] = v;
    px[j + 3] = 255 * feather(Math.min(c, w - 1 - c, r, h - 1 - r), fw);
  }
  g.putImageData(im, 0, 0);
  return canvas;
}
