// Real-time 3D view of the lunar south pole with ray-marched shadows. Geometry: CONTRACT.md.
// Scene coordinates = Moon-fixed MOON_ME metres relative to the centre of the shown region (see shaders.ts).
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Dem, type Tile } from '../core/dem';
import { Ephem } from '../core/ephem';
import { azel, DEG, enu, R, spFwd, spInv, unit, type V3 } from '../core/geom';
import { demMax, EARTH_RADIUS_DEG, SUN_RADIUS_DEG, sunFractionAt } from './march';
import { BLOCK_HI, BLOCK_LO, BLOCK_MID, DEPTH_FRAG, GBUF_FRAG, PROBE_FRAG, RESOLVE_FRAG, SCREEN_VERT, TERRAIN_FRAG, TERRAIN_VERT, DETAIL, LITMAP_FRAG, EARTH_FRAG, GLARE_FRAG, SKY_VERT } from './shaders';
import { regionTiles } from './regions';
import { run } from '../ui/actions';
import { bindView3D, wantedRenderMode, type CameraState, type RenderMode } from './actions';
import './view3d.css';

export { sunFractionAt } from './march';
export { regionAt, regionTiles } from './regions';
export type { RenderMode } from './actions';

export interface View3DSite { lat: number; lon: number; mast: number; label: string }
export interface View3DHandle {
  setTime(tMs: number): void;                 // UTC ms; clamps to the ephemeris range
  setSites(sites: View3DSite[]): void;        // scenario markers (label "A", "B", …)
  setCamera(mode: 'orbit' | 'site', siteIndex?: number): void;
  resize(): void; destroy(): void;
  /** Show the 20 m tile `tileId` (a manifest id, see regions.ts). Resolves when it is on screen; the latest call wins. */
  setRegion(tileId: string): Promise<void>;
  /** Id of the region shown, or being loaded. */
  region(): string;
  /** 'realistic' (Sun only, black shadows) or 'clear' (relief-map colours over the same shadows). Cheap: a uniform. */
  setRenderMode(mode: RenderMode): void;
  renderMode(): RenderMode;
  /** Camera as shown: preset and, when standing at a site, that scenario's label. */
  cameraState(): CameraState;
  /** The sites passed to setSites, in order, and whether each lies in the region shown. */
  siteStates(): { label: string; inRegion: boolean }[];
}
export interface View3DOptions {
  dataBase: string;
  onReady?(): void;
  onError?(msg: string): void;
  /** Scales the starting overview distance (1 = default, smaller = closer). */
  startZoom?: number;
  /** Region to start in (default shackleton_20m). */
  region?: string;
  /** Render mode to start in (default: the last one requested through the `render.set` action, else realistic). */
  renderMode?: RenderMode;
  /** Overview: the user clicked (not dragged) the terrain of the shown region at this surface point. */
  onPick?(lat: number, lon: number): void;
}
/** Not part of the host API: self-check hooks (`(handle as View3DDebugHandle).debug`). */
export interface View3DDebugHandle extends View3DHandle {
  debug: {
    gpu(): string;
    /** Sun fraction at the surface from the GLSL march (1x1 render target) and from the CPU reference. */
    probe(lat: number, lon: number): { gpu: number; cpu: number };
    /** Average ms per full-resolution frame (GPU-synchronised) over n frames. */
    bench(n?: number): { ms: number; fps: number; width: number; height: number };
    /** Frame times (ms, GPU-synchronised) of the most recent interactive frames, e.g. during playback. */
    stats(): { n: number; mean: number; p95: number; max: number; scale: number; width: number; height: number };
    camera(): { mode: string; pos: number[]; dist: number; finite: boolean };
    /** Canvas wheel / pointerdown events seen (type, isTrusted), newest last. */
    events(): string[];
    /** Override the base pixel ratio (undefined = device, capped). For measuring DPR 1.5 on a DPR 1 screen. */
    setPixelRatio(pr?: number): void;
    /** Overview camera for repeatable screenshots: orbit target (lat, lon), distance (m), bearing of the camera from the target and its elevation (deg). */
    pose(lat: number, lon: number, dist: number, az: number, el: number): void;
    /** Site view direction (deg) and horizontal field of view; turns Follow Sun off. */
    look(az: number, pitch: number, hfov: number): void;
    /** Displayed RGB (0..255) of the canvas at a CSS pixel, from a fresh frame. */
    pixel(x: number, y: number): number[];
    /** Set a float shading uniform (uDetail, uScatter, uExposure, uAmbient) for tuning and timing. */
    tune(name: string, value: number): void;
  };
}

/** March step multiplier: 1 = the reference schedule of march.ts. Raise (e.g. 1.5, 2) on slow GPUs. */
export const STEP_SCALE = 1;
const MAX_PIXEL_RATIO = 1.5;
const DEFAULT_REGION = 'shackleton_20m', LO_ID = 'sp_240m';
const IDLE_MAX_PX = 6.5e6;    // idle frames are supersampled up to 2x per axis, within this many buffer pixels
const PICK_INSET_M = 1000;    // clicks count this far inside the region tile (the host's own margin)
const GLARE_RADIUS_DEG = 6;
const MIN_ORBIT_M = 150;       // closest orbit distance: the illustrative detail still holds up there
const MIN_ALT_M = 40;         // the overview camera stays at least this far above the terrain
const FOLLOW_PITCH = 3;       // deg above level when the site camera follows the Sun
const HI_STEP = 2;            // mesh decimation of the 20 m tile (shadows always use full resolution)
const PIN_M = 700;
const MIN_EYE_M = 2;
const SKY_M = 400e3;          // distance of the Sun / Earth disks (inside the far plane)
const FAR_M = 1200e3;
const BG = 0x0a0b0d, EARTH_HEX = 0x5b9cf5, SUN_HEX = 0xfff4dc, PIN_HEX = 0xe8e6e1;

/** Moon-fixed position of stereographic (x, y) at height h: (R + h) * unit(lat, lon). */
function posQ(x: number, y: number, h: number): V3 {
  const [lat, lon] = spInv(x, y);
  const u = unit(lat, lon), r = R + h;
  return [r * u[0], r * u[1], r * u[2]];
}
const v3 = (a: ArrayLike<number>) => new THREE.Vector3(a[0], a[1], a[2]);

/** Decimated grid over a tile: mesh vertices sit on tile samples cols[i], rows[j]. */
interface Grid { tile: Tile; cols: Int32Array; rows: Int32Array; sink?: (x: number, y: number) => number }
const tileH = (t: Tile, c: number, r: number) => t.offset + t.scale * t.data![r * t.w + c];

function buildMesh(g: Grid, centre: V3, xy0: [number, number], skip?: (x0: number, x1: number, y0: number, y1: number) => boolean): THREE.BufferGeometry {
  const { tile: t, cols, rows } = g, nc = cols.length, nr = rows.length;
  const pos = new Float32Array(nc * nr * 3), xy = new Float32Array(nc * nr * 2);
  for (let j = 0, k = 0; j < nr; j++) {
    const y = t.y0! - rows[j] * t.px!;
    for (let i = 0; i < nc; i++, k++) {
      const x = t.x0! + cols[i] * t.px!;
      const p = posQ(x, y, tileH(t, cols[i], rows[j]) - (g.sink ? g.sink(x, y) : 0));
      pos[k * 3] = p[0] - centre[0]; pos[k * 3 + 1] = p[1] - centre[1]; pos[k * 3 + 2] = p[2] - centre[2]; // float64 subtraction
      xy[k * 2] = x - xy0[0]; xy[k * 2 + 1] = y - xy0[1];
    }
  }
  const idx = new Uint32Array((nc - 1) * (nr - 1) * 6);
  let n = 0;
  for (let j = 0; j < nr - 1; j++) {
    const ya = t.y0! - rows[j] * t.px!, yb = t.y0! - rows[j + 1] * t.px!;
    for (let i = 0; i < nc - 1; i++) {
      if (skip && skip(t.x0! + cols[i] * t.px!, t.x0! + cols[i + 1] * t.px!, yb, ya)) continue;
      const a = j * nc + i, b = a + 1, c = a + nc, d = c + 1;
      idx[n++] = a; idx[n++] = c; idx[n++] = b; idx[n++] = b; idx[n++] = c; idx[n++] = d;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('xy', new THREE.BufferAttribute(xy, 2));
  geo.setIndex(new THREE.BufferAttribute(idx.subarray(0, n), 1));
  return geo;
}

/** Height of the rendered (decimated, triangulated) mesh at (x, y), or -Infinity outside the grid. */
function meshHeight(g: Grid, x: number, y: number): number {
  const t = g.tile, c = (x - t.x0!) / t.px!, r = (t.y0! - y) / t.px!;
  const find = (a: Int32Array, v: number) => {
    if (!(v >= a[0] && v <= a[a.length - 1])) return -1;
    let lo = 0, hi = a.length - 2;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (a[m] <= v) lo = m; else hi = m - 1; }
    return lo;
  };
  const i = find(g.cols, c), j = find(g.rows, r);
  if (i < 0 || j < 0) return -Infinity;
  const fx = (c - g.cols[i]) / (g.cols[i + 1] - g.cols[i]), fy = (r - g.rows[j]) / (g.rows[j + 1] - g.rows[j]);
  const a = tileH(t, g.cols[i], g.rows[j]), b = tileH(t, g.cols[i + 1], g.rows[j]);
  const cc = tileH(t, g.cols[i], g.rows[j + 1]), d = tileH(t, g.cols[i + 1], g.rows[j + 1]);
  return fx + fy <= 1 ? a + (b - a) * fx + (cc - a) * fy : d + (cc - d) * (1 - fx) + (b - d) * (1 - fy);
}

export function mount3D(el: HTMLElement, opts: View3DOptions): View3DHandle {
  const base = opts.dataBase.endsWith('/') ? opts.dataBase : opts.dataBase + '/';
  const root = document.createElement('div');
  root.className = 'v3';
  root.innerHTML = `<div class="v3-msg">Loading terrain…</div>
    <div class="v3-ui" hidden role="group" aria-label="Camera">
      <button type="button" data-mode="orbit" aria-pressed="true">Overview</button>
      <button type="button" data-mode="site" aria-pressed="false">Stand at site</button>
      <span class="sep"></span><span class="v3-sites" style="display:contents"></span>
      <span class="sep v3-site-only"></span><button type="button" class="v3-site-only" data-follow aria-pressed="true" title="Keep the camera aimed at the Sun's azimuth as time changes">Follow Sun</button>
      <span class="sep"></span>
      <button type="button" data-render="realistic" aria-pressed="true" title="Lit only by the Sun; shadows are black">Realistic</button>
      <button type="button" data-render="clear" aria-pressed="false" title="Relief-map colours: sunlit warm, shadow cool, same shadows">Clear</button>
    </div>
    <div class="v3-legend" hidden><span class="v3-key"><i class="lit"></i>sunlit</span><span class="v3-key"><i class="shade"></i>in shadow</span><span class="v3-note" title="Craters and regolith grain below the resolution of the elevation data (20 m in the region, 240 m around it) are procedural. Shadows and every number come from the data only.">Surface texture finer than 20 m is illustrative.</span></div>
    <canvas class="v3-az" hidden aria-hidden="true"></canvas>
    <div class="v3-readout" hidden></div>
    <div class="v3-dir sun" hidden><i></i><span>Sun</span></div>
    <div class="v3-dir earth" hidden><i></i><span>to Earth</span></div>
    <div class="v3-body sun" hidden>Sun</div>
    <div class="v3-body earth" hidden>Earth</div>`;
  el.append(root);
  const q = <T extends HTMLElement>(s: string) => root.querySelector(s) as T;
  const msg = q('.v3-msg'), ui = q('.v3-ui'), readout = q('.v3-readout'), siteBtns = q('.v3-sites');
  const dirSun = q('.v3-dir.sun'), dirEarth = q('.v3-dir.earth'), bodySun = q('.v3-body.sun'), bodyEarth = q('.v3-body.earth');
  const azCanvas = q<HTMLCanvasElement>('.v3-az'), followBtn = q<HTMLButtonElement>('[data-follow]');

  let dead = false;
  let tMs = Date.now();
  let sites: View3DSite[] = [];
  let mode: 'orbit' | 'site' = 'orbit';
  let siteIdx = 0;
  let follow = true;
  let renderMode: RenderMode = opts.renderMode ?? wantedRenderMode();
  let live: Live | undefined; // everything that exists only after the data is loaded
  let want = opts.region ?? DEFAULT_REGION, shown = '', ready = false;
  const cleanup: (() => void)[] = [];

  const fail = (m: string) => {
    if (dead) return;
    msg.textContent = m; msg.classList.add('err');
    opts.onError?.(m);
  };

  /** Host index -> can the camera stand there (is the site inside the shown region)? */
  const standable = (i: number) => !!live?.hasSite(i);
  const syncUi = () => {
    const eff = mode === 'site' && standable(siteIdx) ? 'site' : 'orbit';
    const any = sites.some((_, i) => standable(i));
    ui.querySelectorAll<HTMLButtonElement>('button[data-mode]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.mode === eff));
      if (b.dataset.mode === 'site') b.disabled = !any;
    });
    siteBtns.replaceChildren(...sites.map((s, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = s.label; b.dataset.site = String(i);
      b.disabled = !standable(i);
      b.title = b.disabled ? `Site ${s.label} is outside this 3D region` : `Stand at site ${s.label}`;
      b.setAttribute('aria-pressed', String(eff === 'site' && i === siteIdx));
      return b;
    }));
    ui.querySelectorAll<HTMLElement>('.v3-site-only').forEach((e) => { e.hidden = eff !== 'site'; });
    followBtn.setAttribute('aria-pressed', String(follow));
    ui.querySelectorAll<HTMLElement>('button[data-render]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.render === renderMode)));
    q('.v3-legend').hidden = !ready;
    root.querySelectorAll<HTMLElement>('.v3-key').forEach((e) => { e.hidden = renderMode !== 'clear'; });
  };
  ui.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b || b.disabled) return;
    // Render mode and camera go through the action layer: the same path the AI agent uses.
    if (b.dataset.follow !== undefined) { follow = !follow; syncUi(); live?.cameraChanged(); }
    else if (b.dataset.render) void run('render.set', { mode: b.dataset.render });
    else if (b.dataset.site) void run('camera.set', { preset: 'stand-at-site', scenario: sites[+b.dataset.site].label });
    else if (b.dataset.mode === 'site') void run('camera.set', { preset: 'stand-at-site' });
    else void run('camera.set', { preset: 'overview' });
  });

  interface Live {
    timeChanged(): void; sitesChanged(): void; cameraChanged(): void; resize(): void; renderModeChanged(): void;
    hasSite(i: number): boolean; applyRegion(hi: Tile): void;
    debug: View3DDebugHandle['debug'];
  }

  // ---- data: static parts once, region tiles on demand ------------------------------------------
  const get = async (p: string) => {
    const r = await fetch(base + p);
    if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
    return r.arrayBuffer();
  };
  const text = async (p: string) => JSON.parse(new TextDecoder().decode(await get(p)));
  let regions: Tile[] = [];
  const tileCache = new Map<string, Promise<Tile>>();
  const loadTile = (id: string) => {
    let p = tileCache.get(id);
    if (!p) {
      const t = regions.find((r) => r.id === id);
      p = t ? get('dem/' + t.file).then((b) => { t.data = new Int16Array(b); return t; }) : Promise.reject(new Error(`No 3D terrain tile "${id}"`));
      p.catch(() => tileCache.delete(id));
      tileCache.set(id, p);
    }
    return p;
  };
  /** Bring region `id` on screen unless a later request has replaced it. */
  async function switchTo(id: string) {
    if (dead || id !== want || id === shown || !live) return;
    msg.classList.remove('err');
    msg.textContent = 'Loading terrain…';
    try {
      const tile = await loadTile(id);
      if (dead) return;
      if (id !== want) { if (want === shown) msg.textContent = ''; return; } // superseded; a later request has its own message
      live.applyRegion(tile);
      shown = id;
      msg.textContent = '';
      syncUi();
      if (!ready) { ready = true; ui.hidden = false; readout.hidden = false; syncUi(); bindView3D(handle); opts.onReady?.(); }
    } catch (e) {
      if (id === want) { want = shown; msg.textContent = ''; } // keep showing the old region
      throw e;
    }
  }
  let chain: Promise<void> = (async () => {
    const [manifest, ephMeta, ephBuf] = await Promise.all([text('dem/manifest.json'), text('ephem.json'), get('ephem.bin')]);
    regions = regionTiles(manifest.tiles as Tile[]);
    const lo: Tile | undefined = manifest.tiles.find((t: Tile) => t.id === LO_ID);
    if (!lo) throw new Error('DEM manifest lacks ' + LO_ID);
    lo.data = new Int16Array(await get('dem/' + lo.file));
    if (dead) return;
    live = start(lo, new Ephem(ephMeta, ephBuf));
    await switchTo(want);
  })();
  chain.catch((e) => fail(e instanceof Error ? e.message : String(e)));

  const handle: View3DDebugHandle = {
    setTime(t) { tMs = t; live?.timeChanged(); },
    setSites(s) { sites = s.slice(); if (siteIdx >= sites.length) siteIdx = 0; live?.sitesChanged(); syncUi(); },
    setCamera(m, i) {
      mode = m;
      if (i !== undefined && i >= 0 && i < Math.max(1, sites.length)) siteIdx = i;
      if (m === 'site') follow = true;
      syncUi(); live?.cameraChanged();
    },
    resize() { live?.resize(); },
    setRegion(id) {
      if (id === want) return chain;
      want = id;
      chain = chain.catch(() => {}).then(() => switchTo(id));
      return chain;
    },
    region: () => want,
    setRenderMode(m) { if (m === renderMode) return; renderMode = m; syncUi(); live?.renderModeChanged(); },
    renderMode: () => renderMode,
    cameraState: () => (mode === 'site' && standable(siteIdx) ? { preset: 'stand-at-site', scenario: sites[siteIdx].label } : { preset: 'overview', scenario: null }),
    siteStates: () => sites.map((s, i) => ({ label: s.label, inRegion: standable(i) })),
    destroy() {
      if (dead) return;
      dead = true;
      if (ready) bindView3D(undefined);
      cleanup.splice(0).reverse().forEach((f) => f());
      live = undefined;
      root.remove();
    },
    debug: {
      gpu: () => live?.debug.gpu() ?? 'not loaded',
      probe: (lat, lon) => live?.debug.probe(lat, lon) ?? { gpu: NaN, cpu: NaN },
      bench: (n) => live?.debug.bench(n) ?? { ms: NaN, fps: NaN, width: 0, height: 0 },
      stats: () => live?.debug.stats() ?? { n: 0, mean: NaN, p95: NaN, max: NaN, scale: 1, width: 0, height: 0 },
      camera: () => live?.debug.camera() ?? { mode: 'none', pos: [], dist: NaN, finite: false },
      events: () => live?.debug.events() ?? [],
      setPixelRatio: (pr) => live?.debug.setPixelRatio(pr),
      pose: (...a) => live?.debug.pose(...a),
      look: (az, pitch, hfov) => { follow = false; syncUi(); live?.debug.look(az, pitch, hfov); },
      pixel: (x, y) => live?.debug.pixel(x, y) ?? [],
      tune: (n, v) => live?.debug.tune(n, v),
    },
  };

  function start(lo: Tile, eph: Ephem): Live {
    let renderer: THREE.WebGLRenderer;
    try {
      const canvas = document.createElement('canvas');
      // No MSAA: silhouettes are anti-aliased by supersampling the idle frame instead (see frame()).
      if (!canvas.getContext('webgl2', { antialias: false, powerPreference: 'high-performance' })) throw new Error('no context');
      renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    } catch {
      throw new Error('3D view needs WebGL2, which this browser or device does not provide.');
    }
    const gl = renderer.getContext() as WebGL2RenderingContext;
    renderer.setClearColor(BG);
    root.prepend(renderer.domElement);
    const cv = renderer.domElement;
    let prOverride: number | undefined;
    const basePR = () => prOverride ?? Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);

    // ---- static GPU resources -------------------------------------------------------------------
    const floatLinear = renderer.extensions.has('OES_texture_float_linear');
    const heightTex = (t: Tile) => {
      const a = new Float32Array(t.w * t.h), d = t.data!;
      for (let i = 0; i < a.length; i++) a[i] = t.offset + t.scale * d[i];
      const tex = new THREE.DataTexture(a, t.w, t.h, THREE.RedFormat, THREE.FloatType);
      // texelFetch (manual bilinear) ignores the filter; LINEAR only serves the far samples when available.
      tex.minFilter = tex.magFilter = floatLinear ? THREE.LinearFilter : THREE.NearestFilter;
      tex.generateMipmaps = false;
      tex.needsUpdate = true;
      return tex;
    };
    /** Max height per BLOCK x BLOCK texels (inclusive of the shared edge samples). */
    const blockRaw = (t: Tile, BLOCK: number) => {
      const n = Math.ceil((t.w - 1) / BLOCK), a = new Float32Array(n * n), d = t.data!;
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        let m = -32768;
        const r1 = Math.min(j * BLOCK + BLOCK, t.h - 1), c1 = Math.min(i * BLOCK + BLOCK, t.w - 1);
        for (let r = j * BLOCK; r <= r1; r++) for (let c = i * BLOCK; c <= c1; c++) if (d[r * t.w + c] > m) m = d[r * t.w + c];
        a[j * n + i] = t.offset + t.scale * m;
      }
      return a;
    };
    /** Block maxima dilated by one block: bounds all terrain within a block length of a point. */
    const maxTex = (t: Tile, BLOCK: number, raw: Float32Array, also: Tile | undefined, edge: (m: number) => number) => {
      const n = Math.ceil((t.w - 1) / BLOCK), a = raw.slice();
      if (also) { // finer tile lying inside this one
        const e = also.data!, k = also.px! / t.px! / BLOCK;
        const i0 = (also.x0! - t.x0!) / t.px! / BLOCK, j0 = (t.y0! - also.y0!) / t.px! / BLOCK;
        for (let r = 0; r < also.h; r++) {
          const j = Math.floor(j0 + r * k);
          for (let c = 0; c < also.w; c++) {
            const q = j * n + Math.floor(i0 + c * k), v = also.offset + also.scale * e[r * also.w + c];
            if (v > a[q]) a[q] = v;
          }
        }
      }
      const b = new Float32Array(n * n);
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        let m = -1e9;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const jj = j + dj, ii = i + di;
          if (jj >= 0 && jj < n && ii >= 0 && ii < n) m = Math.max(m, a[jj * n + ii]);
        }
        b[j * n + i] = i === 0 || j === 0 || i >= n - 2 || j >= n - 2 ? edge(m) : m; // the last block can be partial: two rings
      }
      const tex = new THREE.DataTexture(b, n, n, THREE.RedFormat, THREE.FloatType);
      tex.minFilter = tex.magFilter = THREE.NearestFilter;
      tex.needsUpdate = true;
      return { tex, geo: [t.x0!, t.y0!, t.px! * BLOCK, n - 1] as const };
    };
    const texLo = heightTex(lo), loRaw = blockRaw(lo, BLOCK_LO);
    const sunDir = new THREE.Vector3(0, 1, 0), earthDir = new THREE.Vector3(0, 1, 0);
    const shared = {
      uHi: { value: null as THREE.Texture | null }, uLo: { value: texLo }, uHiGeo: { value: new THREE.Vector4() }, uLoGeo: { value: new THREE.Vector4() },
      uMaxHi: { value: null as THREE.Texture | null }, uMaxMid: { value: null as THREE.Texture | null }, uMaxLo: { value: null as THREE.Texture | null },
      uMaxHiGeo: { value: new THREE.Vector4() }, uMaxMidGeo: { value: new THREE.Vector4() }, uMaxLoGeo: { value: new THREE.Vector4() },
      uLinear: { value: floatLinear ? 1 : 0 }, uSun: { value: sunDir }, uHMax: { value: 0 }, uStepScale: { value: STEP_SCALE },
      uC: { value: new THREE.Vector3() }, uCk: { value: new THREE.Vector4() }, uXY0: { value: new THREE.Vector2() },
    };
    const camS = new THREE.Vector3();
    const shadeUniforms = {
      ...shared, uCam: { value: camS }, uExposure: { value: 1.25 }, uAmbient: { value: 0.004 },
      uEarth: { value: earthDir }, uEarthshine: { value: 0 }, uPix: { value: 1e-3 },
      uClear: { value: renderMode === 'clear' ? 1 : 0 }, uHill: { value: new THREE.Vector3(0, 0, -1) },
      uDetail: { value: DETAIL }, uLit: { value: null as THREE.Texture | null }, uScatter: { value: 0.5 },
    };
    // Deferred when float render targets exist (practically always): meshes write (x, y, depth), one
    // full-screen pass marches once per pixel. Otherwise forward, with a depth pre-pass against overdraw.
    const deferred = renderer.extensions.has('EXT_color_buffer_float');
    const offset = <T extends THREE.Material>(m: T) => { m.polygonOffset = true; m.polygonOffsetFactor = 1; m.polygonOffsetUnits = 1; return m; };
    const terrainMat = (frag: string, extra: THREE.ShaderMaterialParameters = {}) =>
      new THREE.ShaderMaterial({ uniforms: shadeUniforms, vertexShader: TERRAIN_VERT, fragmentShader: frag, side: THREE.DoubleSide, ...extra });
    const gTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
    const mats: THREE.ShaderMaterial[] = [];

    const scene = new THREE.Scene(), gScene = new THREE.Scene();
    const emptyGeo = new THREE.BufferGeometry();
    const hiMeshes: THREE.Mesh[] = [], loMeshes: THREE.Mesh[] = [];
    const addMesh = (to: THREE.Scene, list: THREE.Mesh[], mat: THREE.ShaderMaterial, order: number) => {
      const m = new THREE.Mesh(emptyGeo, mat);
      m.frustumCulled = false; m.renderOrder = order;
      mats.push(mat); list.push(m);
      to.add(m);
    };
    const screenGeo = new THREE.PlaneGeometry(2, 2);
    if (deferred) {
      addMesh(gScene, hiMeshes, terrainMat(GBUF_FRAG), 0); addMesh(gScene, loMeshes, offset(terrainMat(GBUF_FRAG)), 0);
      const resolve = new THREE.ShaderMaterial({ uniforms: { ...shadeUniforms, uG: { value: gTarget.texture } }, vertexShader: SCREEN_VERT, fragmentShader: RESOLVE_FRAG, depthFunc: THREE.AlwaysDepth });
      const quad = new THREE.Mesh(screenGeo, resolve);
      quad.frustumCulled = false; quad.renderOrder = 1;
      mats.push(resolve);
      scene.add(quad);
    } else {
      addMesh(scene, hiMeshes, terrainMat(DEPTH_FRAG, { colorWrite: false }), 0); addMesh(scene, loMeshes, offset(terrainMat(DEPTH_FRAG, { colorWrite: false })), 0);
      addMesh(scene, hiMeshes, terrainMat(TERRAIN_FRAG, { depthWrite: false }), 1); addMesh(scene, loMeshes, offset(terrainMat(TERRAIN_FRAG, { depthWrite: false })), 1);
    }

    // ---- scattered light: low-resolution sunlit irradiance of the region, redrawn when the Sun moves ----
    const LIT_N = 128;
    const litRT = new THREE.WebGLRenderTarget(LIT_N, LIT_N, { depthBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
    const litMat = new THREE.ShaderMaterial({ uniforms: { ...shared, uLitSize: { value: LIT_N } }, vertexShader: SCREEN_VERT, fragmentShader: LITMAP_FRAG, depthTest: false, depthWrite: false });
    const litMesh = new THREE.Mesh(screenGeo, litMat);
    litMesh.frustumCulled = false;
    const litScene = new THREE.Scene().add(litMesh), litCam = new THREE.Camera();
    shadeUniforms.uLit.value = litRT.texture;
    let litDirty = true;
    const litSun = new THREE.Vector3(), LIT_REDRAW_COS = Math.cos(2 * DEG);
    const drawLitMap = () => {
      litDirty = false;
      litSun.copy(sunDir);
      renderer.setRenderTarget(litRT);
      renderer.render(litScene, litCam);
      renderer.setRenderTarget(null);
    };

    // ---- Sun and Earth disks (site view). Drawn first without depth; terrain then covers them. ---
    const diskGeo = new THREE.CircleGeometry(1, 64);
    const sky = <M extends THREE.Material>(geo: THREE.BufferGeometry, mat: M, radiusDeg: number, order: number) => {
      const m = new THREE.Mesh(geo, mat);
      m.scale.setScalar(SKY_M * Math.tan(radiusDeg * DEG));
      m.renderOrder = order; m.frustumCulled = false; m.visible = false;
      scene.add(m);
      return m;
    };
    const sunDisk = sky(diskGeo, new THREE.MeshBasicMaterial({ color: SUN_HEX, depthTest: false, depthWrite: false, toneMapped: false }), SUN_RADIUS_DEG, -1);
    // Restrained glare: a tight radial falloff around the disk, scaled by how much of the Sun the eye sees.
    const glareMat = new THREE.ShaderMaterial({ uniforms: { uGlare: { value: 0 } }, vertexShader: SKY_VERT, fragmentShader: GLARE_FRAG, depthTest: false, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending });
    const sunGlare = sky(diskGeo, glareMat, GLARE_RADIUS_DEG, -2);
    // Earth: a small shaded globe with the phase the Sun direction gives it.
    const earthMat = new THREE.ShaderMaterial({ uniforms: { uL: { value: new THREE.Vector3(0, 0, 1) } }, vertexShader: SKY_VERT, fragmentShader: EARTH_FRAG, depthTest: false, depthWrite: false });
    const earthDisk = sky(diskGeo, earthMat, EARTH_RADIUS_DEG, -1);
    // Sparse faint stars (site view, Realistic, Sun out of sight): fixed random directions, illustrative.
    const starGeo = new THREE.BufferGeometry();
    {
      const N = 600, pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
      let seed = 20270620;
      const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
      for (let i = 0; i < N; i++) {
        const z = 2 * rnd() - 1, a = 2 * Math.PI * rnd(), r = Math.sqrt(1 - z * z), b = 0.07 + 0.40 * rnd() ** 4;
        pos.set([r * Math.cos(a) * SKY_M, r * Math.sin(a) * SKY_M, z * SKY_M], i * 3);
        col.set([b, b, b * (0.9 + 0.2 * rnd())], i * 3);
      }
      starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      starGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
    const starMat = new THREE.PointsMaterial({ size: 1.5, sizeAttenuation: false, vertexColors: true, depthTest: false, depthWrite: false, toneMapped: false });
    const stars = new THREE.Points(starGeo, starMat);
    stars.frustumCulled = false; stars.renderOrder = -3; stars.visible = false;
    scene.add(stars);
    const camera = new THREE.PerspectiveCamera(35, 1, 10, FAR_M);

    // ---- region: everything that depends on which 20 m tile is shown ------------------------------
    interface Region {
      hi: Tile; dem: Dem; xy0: [number, number]; lat0: number; lon0: number; h0: number; centre: V3; up0: THREE.Vector3;
      pos(x: number, y: number, h: number): THREE.Vector3; // scene position of a map point
      hiGrid: Grid; loGrid: Grid; inHi(x: number, y: number, m: number): boolean; dispose(): void;
    }
    let reg: Region | undefined;
    let controls: OrbitControls | undefined;
    const saved = { pos: new THREE.Vector3(), quat: new THREE.Quaternion() }; // orbit pose, kept across visits to a site
    let lastSiteView = '', inSite = false;

    function buildRegion(hi: Tile): Region {
      const hiX1 = hi.x0! + (hi.w - 1) * hi.px!, hiY0 = hi.y0! - (hi.h - 1) * hi.px!;
      const xy0: [number, number] = [(hi.x0! + hiX1) / 2, (hi.y0! + hiY0) / 2];
      const [lat0, lon0] = spInv(xy0[0], xy0[1]);
      // CPU twin of what the GPU sees: exactly these two tiles.
      const dem = new Dem([hi, lo], async () => { throw new Error('tiles are preloaded'); });
      const h0 = dem.sample(lat0, lon0);
      const centre = posQ(xy0[0], xy0[1], h0);            // C: scene origin, orbit target (float64 here; the GPU only sees differences)
      const pos = (x: number, y: number, h: number) => { const p = posQ(x, y, h); return new THREE.Vector3(p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]); };
      const texHi = heightTex(hi);
      const maxHi = maxTex(hi, BLOCK_HI, blockRaw(hi, BLOCK_HI), undefined, () => 1e9); // beyond its edge the 20 m tile knows nothing: never skip there
      const maxMid = maxTex(hi, BLOCK_MID, blockRaw(hi, BLOCK_MID), undefined, () => 1e9);
      const maxLo = maxTex(lo, BLOCK_LO, loRaw, hi, (m) => Math.max(m, 0));             // outside the 240 m tile the terrain is the sphere (0)

      const seq = (n: number, f: (i: number) => number) => Int32Array.from({ length: n }, (_, i) => f(i));
      const hiGrid: Grid = (() => {
        const n = Math.ceil((hi.w - 1) / HI_STEP) + 1, m = Math.ceil((hi.h - 1) / HI_STEP) + 1;
        return { tile: hi, cols: seq(n, (i) => Math.min(i * HI_STEP, hi.w - 1)), rows: seq(m, (i) => Math.min(i * HI_STEP, hi.h - 1)) };
      })();
      // Far field: the whole 240 m tile on a graded grid (240 m near the 20 m tile, 480 m, then 960 m).
      const half = (hiX1 - hi.x0!) / 2;
      const graded = (c0: number, n: number) => {
        const out: number[] = [];
        for (let i = 0; i < n - 1;) { out.push(i); const d = Math.abs(i - c0) * lo.px! - half; i += d < 25e3 ? 1 : d < 80e3 ? 2 : 4; }
        out.push(n - 1);
        return Int32Array.from(out);
      };
      const inHi = (x: number, y: number, m: number) => x > hi.x0! + m && x < hiX1 - m && y > hiY0 + m && y < hi.y0! - m;
      const loGrid: Grid = {
        tile: lo, cols: graded((xy0[0] - lo.x0!) / lo.px!, lo.w), rows: graded((lo.y0! - xy0[1]) / lo.px!, lo.h),
        sink: (x, y) => (inHi(x, y, 0) ? 60 : 0), // tuck the overlap ring under the 20 m mesh
      };
      const hiGeo = buildMesh(hiGrid, centre, xy0);
      // Hole under the 20 m tile, leaving a one-cell overlap ring (sunk, so it never z-fights).
      const loGeo = buildMesh(loGrid, centre, xy0, (xa, xb, ya, yb) => inHi(xa, ya, 0) && inHi(xb, yb, 0));

      // Point every shader at this region. The uniform objects are shared by all materials: mutate in place.
      // Map-coordinate uniforms are relative to (x0, y0), subtracted here in float64.
      const relGeo = (v: THREE.Vector4, g: readonly [number, number, number, number]) => v.set(g[0] - xy0[0], g[1] - xy0[1], g[2], g[3]);
      shared.uHi.value = texHi;
      relGeo(shared.uHiGeo.value, [hi.x0!, hi.y0!, hi.px!, hi.w - 1]); relGeo(shared.uLoGeo.value, [lo.x0!, lo.y0!, lo.px!, lo.w - 1]);
      shared.uMaxHi.value = maxHi.tex; shared.uMaxMid.value = maxMid.tex; shared.uMaxLo.value = maxLo.tex;
      relGeo(shared.uMaxHiGeo.value, maxHi.geo); relGeo(shared.uMaxMidGeo.value, maxMid.geo); relGeo(shared.uMaxLoGeo.value, maxLo.geo);
      shared.uHMax.value = demMax(dem);
      const cLen = Math.hypot(centre[0], centre[1], centre[2]);
      shared.uC.value.set(centre[0], centre[1], centre[2]);
      shared.uCk.value.set((cLen - R) * (cLen + R), cLen, cLen - centre[2], h0);
      shared.uXY0.value.set(xy0[0], xy0[1]);
      // Clear mode's hillshade light: 45 deg up, from the upper left of the default overview. Fixed to the
      // ground (Moon-fixed), so the relief does not swim when the camera orbits.
      const up = v3(unit(lat0, lon0)), from = new THREE.Vector3(0.99, 0.14, 0); // grid (dx, dy) = (0.14, 0.99) -> (dy, dx, 0)
      from.addScaledVector(up, -up.dot(from)).normalize();
      shadeUniforms.uHill.value.copy(from).add(up).normalize();
      for (const [list, geo] of [[hiMeshes, hiGeo], [loMeshes, loGeo]] as const) for (const m of list) m.geometry = geo;
      return {
        hi, dem, xy0, lat0, lon0, h0, centre, pos, up0: v3(unit(lat0, lon0)), hiGrid, loGrid, inHi,
        dispose() { for (const d of [texHi, maxHi.tex, maxMid.tex, maxLo.tex, hiGeo, loGeo]) d.dispose(); },
      };
    }

    /** Oblique overview of the region, scaled to the tile size. */
    function defaultPose(r: Region) {
      const up = r.up0, k = Math.max(0.7, (r.hi.w - 1) * r.hi.px! / 40e3) * (opts.startZoom ?? 1);
      const flat = new THREE.Vector3(-0.60, -0.80, 0); // grid (dx, dy) = (-0.8, -0.6) -> S (dy, dx, 0)
      flat.addScaledVector(up, -up.dot(flat)).normalize();
      camera.up.copy(up);
      camera.position.set(0, 0, 0).addScaledVector(flat, 38e3 * k).addScaledVector(up, 24e3 * k);
    }
    /** The overview camera never goes below (or closer than MIN_ALT_M to) the terrain. Moves only the camera: no controls.update(), so no recursion. */
    function keepAbove() {
      const r = reg;
      if (!r) return;
      const p = camera.position, qx = p.x + r.centre[0], qy = p.y + r.centre[1], qz = p.z + r.centre[2], len = Math.hypot(qx, qy, qz);
      const alt = len - R - r.dem.sampleUnit(qx / len, qy / len, qz / len);
      if (alt < MIN_ALT_M) p.set(p.x + qx / len * (MIN_ALT_M - alt), p.y + qy / len * (MIN_ALT_M - alt), p.z + qz / len * (MIN_ALT_M - alt));
    }
    /** After a zoom-to-cursor or pan the orbit target can float off the ground: put it back on the terrain at the screen centre (same view, new pivot). */
    function snapTarget() {
      if (!reg || !controls || inSite) return;
      const b = cv.getBoundingClientRect(), hit = terrainAt(b.left + b.width / 2, b.top + b.height / 2, 0);
      if (!hit) return;
      const [lat, lon] = spInv(hit[0], hit[1]);
      const t = reg.pos(hit[0], hit[1], reg.dem.sample(lat, lon)), d = t.distanceTo(camera.position);
      if (d < MIN_ORBIT_M || d > controls.maxDistance) return;
      controls.target.copy(t);
    }
    /** Short eased move of the orbit pivot (and the camera with it) to a terrain point. */
    let easeRaf = 0;
    function retarget(x: number, y: number) {
      if (!reg || !controls || inSite) return;
      const [lat, lon] = spInv(x, y), c = controls;
      const to = reg.pos(x, y, reg.dem.sample(lat, lon)), from = c.target.clone(), cam0 = camera.position.clone(), t0 = performance.now();
      cancelAnimationFrame(easeRaf);
      const step = () => {
        if (dead || c !== controls || inSite || !visible) return;
        const u = Math.min(1, (performance.now() - t0) / 380), k = 1 - (1 - u) ** 3;
        tmp2.copy(to).sub(from).multiplyScalar(k);
        c.target.copy(from).add(tmp2);
        camera.position.copy(cam0).add(tmp2);
        c.update();
        if (u < 1) easeRaf = requestAnimationFrame(step);
      };
      easeRaf = requestAnimationFrame(step);
    }

    function makeControls(r: Region) {
      cancelAnimationFrame(easeRaf);
      controls?.dispose();
      defaultPose(r);
      const c = controls = new OrbitControls(camera, cv); // reads camera.up now: one per region
      c.target.set(0, 0, 0); // the region centre is the scene origin
      c.minDistance = MIN_ORBIT_M; c.maxDistance = 350e3;
      c.maxPolarAngle = 89 * DEG;
      c.zoomSpeed = 1.2;
      c.zoomToCursor = true;
      c.update();
      saved.pos.copy(camera.position); saved.quat.copy(camera.quaternion);
      c.addEventListener('change', () => {
        if (!inSite) { keepAbove(); saved.pos.copy(camera.position); saved.quat.copy(camera.quaternion); }
        requestRender();
      });
      c.addEventListener('start', () => cancelAnimationFrame(easeRaf));
      c.addEventListener('end', snapTarget);
      c.enabled = visible;
    }

    function applyRegion(hi: Tile) {
      const old = reg;
      reg = buildRegion(hi);
      inSite = false; lastSiteView = '';
      makeControls(reg);
      old?.dispose();
      eph.at(tMs = eph.clamp(tMs), v6);
      sitesChanged();
      timeChanged();
      idleNext = true; // the first frame of a region is already the refined one
      litDirty = true;
    }

    interface SiteGeo { s: View3DSite; h: number; eyeH: number; base: THREE.Vector3; up: THREE.Vector3; e: THREE.Vector3; n: THREE.Vector3; pin: THREE.Line; label: HTMLElement }
    let siteGeo: (SiteGeo | undefined)[] = []; // host index -> geometry; undefined = outside the shown region
    const pinMat = new THREE.LineBasicMaterial({ color: PIN_HEX });
    const look = { az: 0, pitch: 0, hfov: 60 };
    const standing = () => (mode === 'site' ? siteGeo[siteIdx] : undefined);

    const v6 = new Float64Array(6);
    const sunS = new THREE.Vector3(), earthS = new THREE.Vector3(); // body positions in scene coordinates (metres)

    // ---- render on demand ----------------------------------------------------------------------------
    // Interactive frames (camera moving, time playing) run at the base pixel ratio, scaled down if they
    // are slow. When input stops, one idle frame is supersampled (up to 2x per axis) and the browser
    // scales the canvas down: that is the anti-aliasing for terrain silhouettes, pins and disks.
    let raf = 0, refineTimer = 0, scale = 1, curPR = 0, idleNext = true, afterIdle = false, visible = false;
    const times: number[] = [];
    const requestRender = () => { if (!raf && !dead) raf = requestAnimationFrame(frame); };
    const px1 = new Uint8Array(4);
    const bufSize = new THREE.Vector2();
    const idlePR = () => {
      const b = basePR(), w = root.clientWidth, h = root.clientHeight;
      return Math.max(b, Math.min(2 * b, Math.sqrt(IDLE_MAX_PX / Math.max(1, w * h))));
    };
    const renderOnce = () => {
      if (litDirty) drawLitMap();
      if (deferred) {
        renderer.getDrawingBufferSize(bufSize);
        if (gTarget.width !== bufSize.x || gTarget.height !== bufSize.y) gTarget.setSize(bufSize.x, bufSize.y);
        renderer.setRenderTarget(gTarget);
        renderer.setClearColor(0x000000, 0);   // alpha 0 = sky
        renderer.render(gScene, camera);
        renderer.setRenderTarget(null);
        renderer.setClearColor(BG, 1);
      }
      renderer.render(scene, camera);
    };
    const draw = (pr: number) => {
      if (pr !== curPR) { curPR = pr; renderer.setPixelRatio(pr); }
      prepare();
      renderOnce();
    };
    const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px1); // blocks until the GPU is done
    function frame() {
      raf = 0;
      clearTimeout(refineTimer);
      if (!reg || !visible) return; // hidden (zero-sized) stage: resize() renders when it is shown again
      if (idleNext) { idleNext = false; afterIdle = true; if (sunDir.dot(litSun) < 0.9999999) litDirty = true; draw(idlePR()); return; } // idle frames use an exact map
      const t0 = performance.now();
      draw(basePR() * scale);
      sync();
      const ms = performance.now() - t0;
      // The first frame after an idle one also pays for that (unsynchronised, supersampled) frame and
      // for reallocating the buffers: it says nothing about the interactive frame rate.
      if (afterIdle) afterIdle = false;
      else {
        times.push(ms); if (times.length > 240) times.shift();
        if (ms > 21) scale = Math.max(0.4, scale * 0.88);  // hold interactive frames near 60 fps
        else if (ms < 12) scale = Math.min(1, scale * 1.08);
      }
      refineTimer = window.setTimeout(() => { idleNext = true; requestRender(); }, 160);
    }

    // ---- per-frame camera and overlays ----------------------------------------------------------------
    const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
    const css = getComputedStyle(root);
    const token = (n: string, d: string) => css.getPropertyValue(n).trim() || d;
    const azInk = { tick: token('--faint', '#5d626b'), text: token('--muted', '#8e939c'), strong: token('--fg', '#e8e6e1'), font: `11px ${token('--sans', 'system-ui, sans-serif')}` };
    function prepare() {
      const r = reg!, w = root.clientWidth, h = root.clientHeight;
      const sg = standing();
      if (sg) {
        const ca = Math.cos(look.az * DEG), sa = Math.sin(look.az * DEG), cp = Math.cos(look.pitch * DEG), sp = Math.sin(look.pitch * DEG);
        camera.position.copy(sg.base).addScaledVector(sg.up, sg.eyeH);
        camera.up.copy(sg.up);
        tmp.copy(camera.position).addScaledVector(sg.n, ca * cp).addScaledVector(sg.e, sa * cp).addScaledVector(sg.up, sp);
        camera.lookAt(tmp);
        camera.fov = 2 * Math.atan(Math.tan(look.hfov * DEG / 2) / camera.aspect) / DEG;
        camera.near = 0.5;
      } else {
        camera.fov = 35;
        camera.near = Math.max(2, 0.004 * camera.position.distanceTo(controls!.target));
      }
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
      camS.copy(camera.position);
      shadeUniforms.uPix.value = 2 * Math.tan(camera.fov * DEG / 2) / Math.max(1, h);

      // Earthshine (cosmetic, see shaders.ts): only while Earth is above the local horizontal.
      const at = sg ? sg.s : { lat: r.lat0, lon: r.lon0 };
      const e = azel(at.lat, at.lon, sg ? sg.h + sg.eyeH : r.h0, v6[3], v6[4], v6[5]);
      shadeUniforms.uEarthshine.value = (sg ? 0.022 : 0.008) * Math.min(1, Math.max(0, e.el / 1.5));

      let sunInView = false;
      for (const [d, body, lab, rad] of [[sunDisk, sunS, bodySun, SUN_RADIUS_DEG], [earthDisk, earthS, bodyEarth, EARTH_RADIUS_DEG]] as const) {
        d.visible = !!sg;
        lab.hidden = true;
        if (!sg) continue;
        tmp.copy(body).sub(camera.position).normalize(); // true direction from the eye (Earth parallax 0.26 deg)
        d.position.copy(camera.position).addScaledVector(tmp, SKY_M);
        d.lookAt(camera.position);
        tmp.copy(d.position).project(camera);
        if (tmp.z < 1 && Math.abs(tmp.x) < 1.05 && Math.abs(tmp.y) < 1.05) {
          if (d === sunDisk) sunInView = true;
          lab.hidden = false;
          const rpx = rad / look.hfov * w;
          lab.style.transform = `translate(${((tmp.x + 1) / 2 * w + rpx + 6).toFixed(1)}px, ${((1 - tmp.y) / 2 * h).toFixed(1)}px) translate(0, -50%)`;
        }
      }
      sunGlare.visible = stars.visible = false;
      if (sg) {
        const eyeSun = sunFractionAt(r.dem, v6, sg.s.lat, sg.s.lon, sg.eyeH); // what the eye sees of the disk
        sunGlare.visible = eyeSun > 0;
        sunGlare.position.copy(sunDisk.position); sunGlare.quaternion.copy(sunDisk.quaternion);
        glareMat.uniforms.uGlare.value = eyeSun;
        // Earth's phase: the Sun direction in the disk's own frame (x right, y up, z towards the eye).
        earthDisk.updateMatrixWorld();
        const el = earthDisk.matrixWorld.elements, L = tmp.copy(sunS).sub(earthS).normalize();
        earthMat.uniforms.uL.value.set(
          (L.x * el[0] + L.y * el[1] + L.z * el[2]) / earthDisk.scale.x, (L.x * el[4] + L.y * el[5] + L.z * el[6]) / earthDisk.scale.x, (L.x * el[8] + L.y * el[9] + L.z * el[10]) / earthDisk.scale.x);
        stars.visible = renderMode === 'realistic' && (eyeSun === 0 || !sunInView);
        stars.position.copy(camera.position);
        starMat.size = 1.15 * curPR;
      }

      siteGeo.forEach((g, i) => {
        if (!g) return;
        const own = sg && i === siteIdx;
        g.pin.visible = !own;
        tmp.copy(g.base).addScaledVector(g.up, PIN_M).project(camera);
        const show = !own && tmp.z < 1 && tmp.z > -1;
        g.label.hidden = !show;
        if (show) g.label.style.transform = `translate(${((tmp.x + 1) / 2 * w).toFixed(1)}px, ${((1 - tmp.y) / 2 * h).toFixed(1)}px) translate(-50%, -110%)`;
      });

      // Overview: ticks at the edge showing the horizontal direction to the Sun and to Earth.
      for (const [elm, body] of [[dirSun, sunS], [dirEarth, earthS]] as const) {
        elm.hidden = !!sg;
        if (sg) continue;
        const tg = controls!.target;
        tmp.copy(body).sub(tg).normalize();
        tmp.addScaledVector(r.up0, -tmp.dot(r.up0)).normalize();
        tmp2.copy(tg).project(camera);
        tmp.multiplyScalar(0.05 * camera.position.distanceTo(tg)).add(tg).project(camera);
        const dx = (tmp.x - tmp2.x) * w, dy = -(tmp.y - tmp2.y) * h, len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len;
        const rr = Math.min((w / 2 - 70) / Math.max(Math.abs(ux), 1e-6), (h / 2 - 44) / Math.max(Math.abs(uy), 1e-6));
        elm.style.transform = `translate(${(w / 2 + ux * rr).toFixed(1)}px, ${(h / 2 + uy * rr).toFixed(1)}px) translate(-9px, -50%)`;
        (elm.firstElementChild as HTMLElement).style.transform = `rotate(${(Math.atan2(uy, ux) / DEG).toFixed(1)}deg)`;
      }

      azCanvas.hidden = !sg;
      if (sg) drawAzimuthScale(sg, w);
    }

    /** Site view: azimuth scale along the bottom (true azimuth, clockwise from local north). */
    function drawAzimuthScale(sg: SiteGeo, w: number) {
      const dpr = Math.min(window.devicePixelRatio || 1, 2), H = 26;
      if (azCanvas.width !== Math.round(w * dpr)) { azCanvas.width = Math.round(w * dpr); azCanvas.height = H * dpr; }
      const c = azCanvas.getContext('2d')!;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.clearRect(0, 0, w, H);
      const [tick, label] = look.hfov > 40 ? [5, 15] : look.hfov > 12 ? [1, 5] : [0.2, 1];
      const span = look.hfov / 2 + 2 * label;
      c.font = azInk.font; c.textAlign = 'center'; c.textBaseline = 'alphabetic'; c.lineWidth = 1;
      for (let k = Math.ceil((look.az - span) / tick); k * tick <= look.az + span; k++) {
        const az = k * tick, a = az * DEG;
        tmp.copy(camera.position).addScaledVector(sg.n, Math.cos(a)).addScaledVector(sg.e, Math.sin(a)).project(camera);
        if (tmp.z >= 1) continue;
        const x = Math.round((tmp.x + 1) / 2 * w) + 0.5;
        const major = Math.abs(az / label - Math.round(az / label)) < 1e-6;
        c.strokeStyle = major ? azInk.text : azInk.tick;
        c.beginPath(); c.moveTo(x, H); c.lineTo(x, H - (major ? 9 : 5)); c.stroke();
        if (!major) continue;
        const d = ((Math.round(az * 10) / 10) % 360 + 360) % 360, card = d % 90 === 0 ? 'NESW'[d / 90] : '';
        c.fillStyle = card ? azInk.strong : azInk.text;
        c.fillText(card || `${d}°`, x, H - 13);
      }
    }

    // ---- state changes --------------------------------------------------------------------------
    const pct = (f: number) => `${Math.round(f * 100)}%`;
    const deg = (v: number, d = 1) => `${v.toFixed(d)}°`;
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    function updateReadout() {
      const r = reg!;
      const iso = new Date(eph.clamp(tMs)).toISOString();
      const when = `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
      const sg = standing();
      if (sg) {
        const s = azel(sg.s.lat, sg.s.lon, sg.h + sg.eyeH, v6[0], v6[1], v6[2]), e = azel(sg.s.lat, sg.s.lon, sg.h + sg.eyeH, v6[3], v6[4], v6[5]);
        readout.innerHTML = `<b>Site ${esc(sg.s.label)}</b> · ${when} · <span class="sun">Sun</span> az ${deg(s.az)} el ${deg(s.el, 2)}, <b>${pct(sunFractionAt(r.dem, v6, sg.s.lat, sg.s.lon, sg.eyeH))}</b> of disk visible · <span class="earth">Earth</span> az ${deg(e.az)} el ${deg(e.el, 2)}`;
      } else {
        const s = azel(r.lat0, r.lon0, r.h0, v6[0], v6[1], v6[2]);
        const per = siteGeo.flatMap((g) => (g ? [`${esc(g.s.label)} <b>${pct(sunFractionAt(r.dem, v6, g.s.lat, g.s.lon, g.s.mast))}</b>`] : [])).join(' · ');
        readout.innerHTML = `${when} · <span class="sun">Sun</span> el ${deg(s.el, 2)} at view centre${per ? ` · Sun disk visible from mast: ${per}` : ''}`;
      }
    }

    /** Site view with "Follow Sun" on: face the Sun's azimuth, a few degrees above level. */
    function aim() {
      const sg = standing();
      if (!sg || !follow) return;
      const s = azel(sg.s.lat, sg.s.lon, sg.h + sg.eyeH, v6[0], v6[1], v6[2]);
      look.az = s.az;
      // Zoomed in, a fixed pitch would leave the Sun outside the frame: then centre on the Sun itself.
      const vHalf = Math.atan(Math.tan(look.hfov * DEG / 2) / camera.aspect) / DEG;
      look.pitch = Math.abs(FOLLOW_PITCH - s.el) < 0.6 * vHalf ? FOLLOW_PITCH : Math.max(-60, Math.min(80, s.el));
    }

    function timeChanged() {
      if (!reg) return;
      eph.at(tMs, v6);
      const c = reg.centre;
      sunS.set(v6[0] * 1000 - c[0], v6[1] * 1000 - c[1], v6[2] * 1000 - c[2]);
      earthS.set(v6[3] * 1000 - c[0], v6[4] * 1000 - c[1], v6[5] * 1000 - c[2]);
      sunDir.set(v6[0], v6[1], v6[2]).normalize(); // one Moon-fixed direction for the whole scene
      if (sunDir.dot(litSun) < LIT_REDRAW_COS) litDirty = true; // the scattered-light map only needs the Sun roughly right
      earthDir.set(v6[3], v6[4], v6[5]).normalize();
      aim();
      updateReadout();
      requestRender();
    }

    function sitesChanged() {
      if (!reg) return;
      const r = reg;
      for (const g of siteGeo) if (g) { scene.remove(g.pin); g.pin.geometry.dispose(); g.label.remove(); }
      siteGeo = sites.map((s) => {
        if (!(s.lat < -60)) return undefined;
        const xy = spFwd(s.lat, s.lon);
        if (!r.inHi(xy[0], xy[1], 0)) return undefined; // other regions' scenarios get no pin here
        const h = r.dem.sample(s.lat, s.lon);
        // Eye above whichever is higher: the DEM or the decimated mesh that is actually drawn.
        const surf = Math.max(h, meshHeight(r.hiGrid, xy[0], xy[1]));
        const f = enu(s.lat, s.lon);
        const base = r.pos(xy[0], xy[1], h), up = v3(f.u);
        const pin = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), up.clone().multiplyScalar(PIN_M)]), pinMat);
        pin.position.copy(base); pin.frustumCulled = false; pin.renderOrder = 2;
        scene.add(pin);
        const label = document.createElement('div');
        label.className = 'v3-label'; label.textContent = s.label;
        root.append(label);
        return { s, h, eyeH: surf - h + Math.max(s.mast, MIN_EYE_M), base, up, e: v3(f.e), n: v3(f.n), pin, label };
      });
      cameraChanged();
    }

    function cameraChanged() {
      if (!reg) return;
      const sg = standing();
      controls!.enabled = !sg && visible;
      const wasSite = inSite;
      inSite = !!sg;
      if (sg) {
        const key = String(siteIdx); // nudging a site keeps the user's view direction
        if (key !== lastSiteView) {
          if (!follow) { look.az = azel(sg.s.lat, sg.s.lon, sg.h + sg.eyeH, v6[0], v6[1], v6[2]).az; look.pitch = FOLLOW_PITCH; }
          look.hfov = 60;
          lastSiteView = key;
        }
        aim();
      } else {
        lastSiteView = '';
        if (wasSite) { // back from a site: the orbit pose as it was left
          camera.position.copy(saved.pos); camera.quaternion.copy(saved.quat);
          camera.up.copy(reg.up0);
          controls!.update();
        }
      }
      cv.style.cursor = '';
      updateReadout();
      requestRender();
    }

    // ---- input ---------------------------------------------------------------------------------------
    // Site view: drag to look around, wheel / pinch to zoom the field of view. No translation.
    // Overview: OrbitControls moves the camera; a click that did not drag picks the terrain point.
    const ptrs = new Map<number, { x: number; y: number }>();
    const evLog: string[] = [];
    const logEv = (e: Event) => { evLog.push(`${e.type}:${e.isTrusted ? 'trusted' : 'synthetic'}`); if (evLog.length > 60) evLog.shift(); };
    let pinch = 0, downAt: { x: number; y: number; id: number } | undefined, hoverAt: { x: number; y: number } | undefined, hoverRaf = 0;
    const gPix = new Float32Array(4);
    /** Stereographic (x, y) of the terrain under a client point, from the last frame's G-buffer. */
    function terrainAt(clientX: number, clientY: number, inset = PICK_INSET_M): [number, number] | undefined {
      if (!deferred || !reg || gTarget.width < 2) return undefined;
      const b = cv.getBoundingClientRect();
      const px = Math.floor((clientX - b.left) / b.width * gTarget.width), py = gTarget.height - 1 - Math.floor((clientY - b.top) / b.height * gTarget.height);
      if (!(px >= 0 && py >= 0 && px < gTarget.width && py < gTarget.height)) return undefined;
      renderer.readRenderTargetPixels(gTarget, px, py, 1, 1, gPix);
      if (!(gPix[3] > 0.5)) return undefined; // sky
      const x = gPix[0] + reg.xy0[0], y = gPix[1] + reg.xy0[1]; // the G-buffer holds relative map coords
      return reg.inHi(x, y, inset) ? [x, y] : undefined; // the coarse surround is not pickable
    }
    const onDown = (e: PointerEvent) => {
      logEv(e);
      if (!standing()) { downAt = e.button === 0 && e.isPrimary !== false ? { x: e.clientX, y: e.clientY, id: e.pointerId } : undefined; return; }
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      pinch = 0;
    };
    const onMove = (e: PointerEvent) => {
      if (!standing()) {
        if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) downAt = undefined; // a drag, not a click
        if (!e.buttons && opts.onPick) { // hover: crosshair where a click would place a site
          hoverAt = { x: e.clientX, y: e.clientY };
          hoverRaf ||= requestAnimationFrame(() => { hoverRaf = 0; if (hoverAt && !standing() && !dead) cv.style.cursor = terrainAt(hoverAt.x, hoverAt.y) ? 'crosshair' : ''; });
        }
        return;
      }
      const p = ptrs.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (ptrs.size === 1) {
        const k = look.hfov / root.clientWidth;
        look.az = (look.az - dx * k + 360) % 360;
        look.pitch = Math.max(-60, Math.min(80, look.pitch + dy * k));
        if (follow && (dx || dy)) { follow = false; syncUi(); } // the user took over
      } else if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch) look.hfov = Math.max(4, Math.min(100, look.hfov * pinch / d));
        pinch = d;
        aim();
      }
      requestRender();
    };
    const onUp = (e: PointerEvent) => {
      ptrs.delete(e.pointerId); pinch = 0;
      const d = downAt;
      downAt = undefined;
      if (!d || d.id !== e.pointerId || e.type !== 'pointerup' || standing() || !opts.onPick) return;
      const hit = terrainAt(d.x, d.y);
      if (!hit) return;
      const b = root.getBoundingClientRect(), ring = document.createElement('div');
      ring.className = 'v3-ring';
      ring.style.left = `${d.x - b.left}px`; ring.style.top = `${d.y - b.top}px`;
      root.append(ring);
      setTimeout(() => ring.remove(), 900);
      const [lat, lon] = spInv(hit[0], hit[1]);
      opts.onPick(lat, lon);
      retarget(hit[0], hit[1]); // the picked point becomes the orbit pivot
    };
    const onWheel = (e: WheelEvent) => {
      logEv(e);
      if (!standing()) return;
      e.preventDefault();
      look.hfov = Math.max(4, Math.min(100, look.hfov * Math.exp(e.deltaY * 0.0015)));
      aim();
      requestRender();
    };
    const onLeave = () => { hoverAt = undefined; };
    cv.addEventListener('pointerdown', onDown, true); cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp); cv.addEventListener('pointercancel', onUp); cv.addEventListener('pointerleave', onLeave);
    cv.addEventListener('wheel', onWheel, { passive: false, capture: true });
    const noMenu = (e: Event) => e.preventDefault();
    cv.addEventListener('contextmenu', noMenu);

    /** Size follows the host element. A hidden (zero-sized) stage stops rendering and input; showing it re-checks the camera. */
    function resize() {
      const w = root.clientWidth, h = root.clientHeight;
      const was = visible;
      visible = w > 0 && h > 0;
      if (controls) controls.enabled = visible && !inSite;
      if (!visible) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      if (!was && reg && !inSite) { // shown again: never come back to a broken or runaway orbit pose
        const d = camera.position.distanceTo(controls!.target), p = camera.position;
        if (!(Number.isFinite(p.x + p.y + p.z) && d >= controls!.minDistance * 0.99 && d <= controls!.maxDistance * 1.01)) makeControls(reg);
      }
      idleNext = true;
      requestRender();
    }
    const ro = new ResizeObserver(resize);
    ro.observe(root);

    // ---- self-check: the GLSL march at one point, read back from a 1x1 target ---------------------
    const probeRT = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
    const probeMat = new THREE.ShaderMaterial({ uniforms: { ...shared, uProbe: { value: new THREE.Vector2() } }, vertexShader: SCREEN_VERT, fragmentShader: PROBE_FRAG, depthTest: false, depthWrite: false });
    const probeMesh = new THREE.Mesh(screenGeo, probeMat);
    probeMesh.frustumCulled = false;
    const probeScene = new THREE.Scene().add(probeMesh), probeCam = new THREE.Camera();
    const debug: View3DDebugHandle['debug'] = {
      probe(lat, lon) {
        if (!reg) return { gpu: NaN, cpu: NaN };
        const [x, y] = spFwd(lat, lon);
        probeMat.uniforms.uProbe.value.set(x - reg.xy0[0], y - reg.xy0[1]);
        renderer.setRenderTarget(probeRT);
        renderer.render(probeScene, probeCam);
        const b = new Uint8Array(4);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b);
        renderer.setRenderTarget(null);
        return { gpu: (b[0] * 256 + b[1]) / 65535, cpu: sunFractionAt(reg.dem, v6, lat, lon) };
      },
      bench(n = 20) {
        if (!reg || !visible) return { ms: NaN, fps: NaN, width: 0, height: 0 };
        draw(basePR()); sync();
        const t0 = performance.now();
        for (let i = 0; i < n; i++) { renderOnce(); sync(); }
        const ms = (performance.now() - t0) / n;
        const out = { ms, fps: 1000 / ms, width: cv.width, height: cv.height };
        idleNext = true; requestRender();
        return out;
      },
      stats() {
        const a = times.slice().sort((x, y) => x - y), n = a.length;
        const out = { n, mean: n ? a.reduce((x, y) => x + y, 0) / n : NaN, p95: n ? a[Math.floor(0.95 * (n - 1))] : NaN, max: n ? a[n - 1] : NaN, scale, width: Math.round(root.clientWidth * basePR() * scale), height: Math.round(root.clientHeight * basePR() * scale) };
        times.length = 0;
        return out;
      },
      camera() {
        const p = camera.position, d = controls ? p.distanceTo(controls.target) : NaN;
        return { mode: standing() ? 'site' : 'orbit', pos: [p.x, p.y, p.z].map(Math.round), dist: Math.round(d), finite: Number.isFinite(p.x + p.y + p.z + d) };
      },
      events: () => evLog.slice(),
      setPixelRatio(pr) { prOverride = pr; scale = 1; idleNext = true; requestRender(); },
      pose(lat, lon, dist, az, el) {
        if (!reg || !controls) return;
        const [x, y] = spFwd(lat, lon), f = enu(lat, lon), t = reg.pos(x, y, reg.dem.sample(lat, lon));
        const a = az * DEG, e = el * DEG;
        controls.target.copy(t);
        camera.position.copy(t).addScaledVector(v3(f.n), dist * Math.cos(e) * Math.cos(a)).addScaledVector(v3(f.e), dist * Math.cos(e) * Math.sin(a)).addScaledVector(v3(f.u), dist * Math.sin(e));
        controls.update();
        idleNext = true; requestRender();
      },
      tune(name, value) { const u = (shadeUniforms as unknown as Record<string, { value: unknown }>)[name]; if (u && typeof u.value === 'number') { u.value = value; requestRender(); } },
      look(az, pitch, hfov) { look.az = az; look.pitch = pitch; look.hfov = hfov; idleNext = true; requestRender(); },
      pixel(x, y) {
        if (!reg || !visible) return [];
        draw(curPR || basePR());
        const b = new Uint8Array(4), k = cv.width / root.clientWidth;
        gl.readPixels(Math.round(x * k), cv.height - 1 - Math.round(y * k), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b);
        return [b[0], b[1], b[2]];
      },
      gpu() {
        const ext = gl.getExtension('WEBGL_debug_renderer_info');
        return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
      },
    };

    cleanup.push(() => {
      cancelAnimationFrame(raf); cancelAnimationFrame(hoverRaf); cancelAnimationFrame(easeRaf); clearTimeout(refineTimer);
      ro.disconnect();
      cv.removeEventListener('pointerdown', onDown, true); cv.removeEventListener('pointermove', onMove);
      cv.removeEventListener('pointerup', onUp); cv.removeEventListener('pointercancel', onUp); cv.removeEventListener('pointerleave', onLeave);
      cv.removeEventListener('wheel', onWheel, true); cv.removeEventListener('contextmenu', noMenu);
      controls?.dispose();
      reg?.dispose();
      for (const g of siteGeo) g?.pin.geometry.dispose();
      for (const d of [emptyGeo, diskGeo, screenGeo, texLo, gTarget, litRT, litMat, glareMat, starGeo, starMat, ...mats, pinMat, probeMat, probeRT, sunDisk.material, earthDisk.material]) d.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      lo.data = undefined;
      for (const t of regions) t.data = undefined;
    });

    const renderModeChanged = () => { shadeUniforms.uClear.value = renderMode === 'clear' ? 1 : 0; requestRender(); };
    resize();
    return { timeChanged, sitesChanged, cameraChanged, resize, renderModeChanged, applyRegion, hasSite: (i) => !!siteGeo[i], debug };
  }

  syncUi();
  return handle;
}
