// Site-picker map: south-polar stereographic (CONTRACT.md) or global equirectangular hillshade.
import { spFwd, spInv } from '../core/geom';

export interface MapSite { id: string; name: string; lat: number; lon: number }
/** A scenario column's current site; `active` = the column the map edits. */
export interface Marker { lat: number; lon: number; label: string; active: boolean }
interface MapEntry { id: string; file: string; proj: 'spstere' | 'eqc'; bounds?: [number, number, number, number] }

const VIEWS = [
  { id: 'sp_hillshade', label: 'South pole' },
  { id: 'shackleton_hillshade', label: 'Shackleton (zoom)' },
  { id: 'global_hillshade', label: 'Whole Moon' },
];
const OVERLAYS: Record<string, { label: string; tint: [number, number, number] }> = {
  sp_sun: { label: 'Avg Sun visibility (NASA PGDA)', tint: [255, 200, 80] },
  sp_earth: { label: 'Avg Earth visibility (NASA PGDA)', tint: [95, 168, 255] },
};
const HIT = 14; // px, tap tolerance for site dots

export function createMap(el: HTMLElement, sites: MapSite[], markers: () => Marker[], onPick: (id: string | null, lat: number, lon: number) => void) {
  const base = import.meta.env.BASE_URL + 'data/maps/';
  el.innerHTML = `
    <div class="maphead">
      <span class="for"></span>
      <select class="view" aria-label="Map view">${VIEWS.map((v) => `<option value="${v.id}">${v.label}</option>`).join('')}</select>
      <select class="ovl" aria-label="Map overlay"><option value="">Terrain (hillshade)</option>${Object.entries(OVERLAYS).map(([k, o]) => `<option value="${k}">${o.label}</option>`).join('')}</select>
    </div>
    <canvas class="map"></canvas>
    <p class="maplegend"></p>`;
  const canvas = el.querySelector('canvas')!, view = el.querySelector<HTMLSelectElement>('.view')!, ovl = el.querySelector<HTMLSelectElement>('.ovl')!;
  let index: MapEntry[] = [];
  let hover: MapSite | null = null;
  const imgs = new Map<string, Promise<CanvasImageSource>>();

  // Lazy: an image is fetched the first time its view/overlay is shown.
  const load = (id: string) => {
    let p = imgs.get(id);
    if (!p) {
      const e = index.find((m) => m.id === id)!;
      p = new Promise<HTMLImageElement>((res, rej) => {
        const im = new Image();
        im.onload = () => res(im); im.onerror = () => rej(new Error(e.file));
        im.src = base + e.file;
      }).then((im) => (OVERLAYS[id] ? tint(im, OVERLAYS[id].tint) : im));
      imgs.set(id, p);
      p.catch(() => imgs.delete(id));
    }
    return p;
  };

  const entry = () => index.find((m) => m.id === view.value)!;
  const size = () => [canvas.clientWidth, canvas.clientHeight];
  /** lat/lon -> CSS px, or null when off the map. */
  function toPx(lat: number, lon: number): [number, number] | null {
    const e = entry(), [W, H] = size();
    if (e.proj === 'eqc') return [(((lon % 360) + 360) % 360) / 360 * W, (90 - lat) / 180 * H];
    if (lat > -60) return null;
    const [x, y] = spFwd(lat, lon), b = e.bounds!;
    const p: [number, number] = [(x - b[0]) / (b[2] - b[0]) * W, (b[3] - y) / (b[3] - b[1]) * H];
    return p[0] < 0 || p[1] < 0 || p[0] > W || p[1] > H ? null : p;
  }
  function toLatLon(px: number, py: number): [number, number] {
    const e = entry(), [W, H] = size();
    if (e.proj === 'eqc') { const lon = px / W * 360; return [90 - py / H * 180, lon > 180 ? lon - 360 : lon]; }
    const b = e.bounds!;
    return spInv(b[0] + px / W * (b[2] - b[0]), b[3] - py / H * (b[3] - b[1]));
  }
  function nearest(px: number, py: number): MapSite | null {
    let best: MapSite | null = null, bd = HIT;
    for (const s of sites) {
      const p = toPx(s.lat, s.lon);
      const d = p ? Math.hypot(p[0] - px, p[1] - py) : Infinity;
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  let token = 0;
  async function draw() {
    if (!index.length) return;
    const tok = ++token, e = entry();
    canvas.style.aspectRatio = e.proj === 'eqc' ? '2' : '1';
    ovl.disabled = e.id !== 'sp_hillshade';
    const ov = ovl.disabled ? '' : ovl.value;
    const marks = markers(), act = marks.find((m) => m.active);
    el.querySelector('.for')!.innerHTML = act ? `Tap to move <b></b>` : '';
    if (act) el.querySelector('.for b')!.textContent = act.label;
    el.querySelector('.maplegend')!.textContent = ov
      ? `NASA PGDA average ${ov === 'sp_sun' ? 'Sun' : 'Earth'} visibility (Mazarico et al. 2011, % of time over many years; bright = more). Only the inner ±150 km is covered.`
      : e.proj === 'eqc' ? 'LOLA terrain, artificial lighting. Longitude 0–360° east, left to right.' : 'LOLA terrain, artificial lighting (orientation only, not a Sun prediction). Grid: 1° latitude.';

    const dpr = window.devicePixelRatio || 1, [W, H] = size();
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#07090d'; ctx.fillRect(0, 0, W, H);
    let bg: CanvasImageSource, over: CanvasImageSource | null = null;
    try {
      const pending = !imgs.has(e.id) || (ov && !imgs.has(ov));
      if (pending) { ctx.fillStyle = '#8b93a7'; ctx.font = '13px system-ui'; ctx.fillText('Loading map…', 10, 20); }
      [bg, over] = await Promise.all([load(e.id), ov ? load(ov) : null]);
    } catch (err) {
      ctx.fillStyle = '#f87171'; ctx.fillText(`Could not load ${(err as Error).message}`, 10, 40);
      return;
    }
    if (tok !== token) return;
    ctx.drawImage(bg, 0, 0, W, H);
    if (over) {
      const ob = index.find((m) => m.id === ov)!.bounds!, b = e.bounds!;
      const sx = W / (b[2] - b[0]), sy = H / (b[3] - b[1]);
      ctx.drawImage(over, (ob[0] - b[0]) * sx, (b[3] - ob[3]) * sy, (ob[2] - ob[0]) * sx, (ob[3] - ob[1]) * sy);
    }
    if (e.proj === 'spstere') { // latitude rings
      ctx.strokeStyle = 'rgba(96,165,250,.45)'; ctx.lineWidth = 1;
      const c = toPxRaw(-90, 0);
      for (let lat = -89; lat <= -80; lat++) {
        const r = Math.hypot(...sub(toPxRaw(lat, 0), c));
        ctx.beginPath(); ctx.arc(c[0], c[1], r, 0, 2 * Math.PI); ctx.stroke();
      }
    }
    ctx.font = '12px system-ui'; ctx.lineJoin = 'round';
    const label = (text: string, p: [number, number], color: string) => {
      const right = p[0] > W - 120, x = right ? p[0] - 9 : p[0] + 9;
      ctx.textAlign = right ? 'right' : 'left';
      ctx.strokeStyle = '#000'; ctx.lineWidth = 3; ctx.strokeText(text, x, p[1] + 4);
      ctx.fillStyle = color; ctx.fillText(text, x, p[1] + 4);
    };
    for (const s of sites) {
      const p = toPx(s.lat, s.lon);
      if (!p) continue;
      ctx.fillStyle = '#e6e9ef'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(p[0], p[1], 3, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    }
    for (const m of [...marks.filter((x) => !x.active), ...marks.filter((x) => x.active)]) { // active on top
      const p = toPx(m.lat, m.lon);
      if (!p) continue;
      ctx.strokeStyle = m.active ? '#f5c542' : '#e6e9ef'; ctx.lineWidth = m.active ? 3 : 2;
      ctx.beginPath(); ctx.arc(p[0], p[1], m.active ? 8 : 6, 0, 2 * Math.PI); ctx.stroke();
      label(m.label, p, m.active ? '#f5c542' : '#e6e9ef');
    }
    const hp = hover && toPx(hover.lat, hover.lon);
    if (hover && hp) label(hover.name, hp, '#fff');
  }
  // Unclipped spstere projection (for the latitude rings).
  function toPxRaw(lat: number, lon: number): [number, number] {
    const b = entry().bounds!, [W, H] = size(), [x, y] = spFwd(lat, lon);
    return [(x - b[0]) / (b[2] - b[0]) * W, (b[3] - y) / (b[3] - b[1]) * H];
  }

  const local = (e: MouseEvent) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top] as const; };
  canvas.onpointermove = (e) => {
    if (e.pointerType !== 'mouse') return;
    const h = nearest(...local(e));
    canvas.style.cursor = h ? 'pointer' : 'crosshair';
    if (h !== hover) { hover = h; draw(); }
  };
  canvas.onpointerleave = () => { if (hover) { hover = null; draw(); } };
  canvas.onclick = (e) => {
    const [px, py] = local(e), s = nearest(px, py);
    if (s) return onPick(s.id, s.lat, s.lon);
    const [lat, lon] = toLatLon(px, py);
    onPick(null, +lat.toFixed(4), +lon.toFixed(4));
  };
  view.onchange = ovl.onchange = () => { hover = null; draw(); };

  fetch(base + 'index.json').then((r) => r.json()).then((j: MapEntry[]) => {
    index = j;
    const act = markers().find((m) => m.active);
    view.value = act && act.lat > -80 ? 'global_hillshade' : 'sp_hillshade';
    draw();
  }).catch(() => { el.querySelector('.maplegend')!.textContent = 'Could not load maps/index.json.'; });

  return { draw };
}

const sub = (a: [number, number], b: [number, number]) => [a[0] - b[0], a[1] - b[1]] as [number, number];

/** Grayscale visibility (0..255 = 0..100% of time) -> tint * value, mostly opaque. */
function tint(im: HTMLImageElement, [r, g, b]: [number, number, number]): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = im.naturalWidth; c.height = im.naturalHeight;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(im, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height), a = d.data;
  for (let i = 0; i < a.length; i += 4) {
    const v = a[i] / 255;
    a[i] = r * v; a[i + 1] = g * v; a[i + 2] = b * v; a[i + 3] = 215;
  }
  ctx.putImageData(d, 0, 0);
  return c;
}
