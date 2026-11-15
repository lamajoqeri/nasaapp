// Real-time 3D view of the lunar south pole with ray-marched shadows. Geometry: CONTRACT.md.
// Scene coordinates "S" = Moon-fixed MOON_ME metres with z shifted by +R (see shaders.ts).
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Dem, type Tile } from '../core/dem';
import { Ephem } from '../core/ephem';
import { azel, DEG, enu, R, spFwd, spInv, unit, type V3 } from '../core/geom';
import { demMax, EARTH_RADIUS_DEG, SUN_RADIUS_DEG, sunFractionAt } from './march';
import { BLOCK_HI, BLOCK_LO, BLOCK_MID, DEPTH_FRAG, GBUF_FRAG, PROBE_FRAG, RESOLVE_FRAG, SCREEN_VERT, TERRAIN_FRAG, TERRAIN_VERT } from './shaders';
import './view3d.css';

export { sunFractionAt } from './march';

export interface View3DSite { lat: number; lon: number; mast: number; label: string }
export interface View3DHandle {
  setTime(tMs: number): void;                 // UTC ms; clamps to the ephemeris range
  setSites(sites: View3DSite[]): void;        // scenario markers (label "A", "B", …)
  setCamera(mode: 'orbit' | 'site', siteIndex?: number): void;
  resize(): void; destroy(): void;
}
/** Not part of the host API: self-check hooks used by dev-3d.html (`(handle as View3DDebugHandle).debug`). */
export interface View3DDebugHandle extends View3DHandle {
  debug: {
    gpu(): string;
    /** Sun fraction at the surface from the GLSL march (1x1 render target) and from the CPU reference. */
    probe(lat: number, lon: number): { gpu: number; cpu: number };
    /** Average ms per full-resolution frame (GPU-synchronised) over n frames. */
    bench(n?: number): { ms: number; fps: number; width: number; height: number };
  };
}

/** March step multiplier: 1 = the reference schedule of march.ts. Raise (e.g. 1.5, 2) on slow GPUs. */
export const STEP_SCALE = 1;
const MAX_PIXEL_RATIO = 1.5;
const HI_ID = 'shackleton_20m', LO_ID = 'sp_240m';
const HI_STEP = 2;            // mesh decimation of the 20 m tile (shadows always use full resolution)
const PIN_M = 700;
const MIN_EYE_M = 2;
const SKY_M = 400e3;          // distance of the Sun / Earth disks (inside the far plane)
const FAR_M = 1200e3;
const BG = 0x0a0b0d, EARTH_HEX = 0x5b9cf5, SUN_HEX = 0xfff4dc, PIN_HEX = 0xe8e6e1;

/** S position of stereographic (x, y) at height h: (R + h) * unit(lat, lon), z shifted by R. */
function posS(x: number, y: number, h: number): V3 {
  const [lat, lon] = spInv(x, y);
  const u = unit(lat, lon), r = R + h;
  return [r * u[0], r * u[1], r * u[2] + R];
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
      const p = posS(x, y, tileH(t, cols[i], rows[j]) - (g.sink ? g.sink(x, y) : 0));
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

export function mount3D(el: HTMLElement, opts: { dataBase: string; onReady?(): void; onError?(msg: string): void; /** Scales the starting overview distance (1 = default, smaller = closer). */ startZoom?: number }): View3DHandle {
  const base = opts.dataBase.endsWith('/') ? opts.dataBase : opts.dataBase + '/';
  const root = document.createElement('div');
  root.className = 'v3';
  root.innerHTML = `<div class="v3-msg">Loading terrain…</div>
    <div class="v3-ui" hidden role="group" aria-label="Camera">
      <button type="button" data-mode="orbit" aria-pressed="true">Overview</button>
      <button type="button" data-mode="site" aria-pressed="false">Stand at site</button>
      <span class="sep"></span><span class="v3-sites" style="display:contents"></span>
    </div>
    <div class="v3-readout" hidden></div>
    <div class="v3-dir sun" hidden><i></i><span>Sun</span></div>
    <div class="v3-dir earth" hidden><i></i><span>to Earth</span></div>`;
  el.append(root);
  const q = <T extends HTMLElement>(s: string) => root.querySelector(s) as T;
  const msg = q('.v3-msg'), ui = q('.v3-ui'), readout = q('.v3-readout'), siteBtns = q('.v3-sites');
  const dirSun = q('.v3-dir.sun'), dirEarth = q('.v3-dir.earth');

  let dead = false;
  let tMs = Date.now();
  let sites: View3DSite[] = [];
  let mode: 'orbit' | 'site' = 'orbit';
  let siteIdx = 0;
  let live: Live | undefined; // everything that exists only after the data is loaded
  const cleanup: (() => void)[] = [];

  const fail = (m: string) => {
    if (dead) return;
    msg.textContent = m; msg.classList.add('err');
    opts.onError?.(m);
  };

  const syncUi = () => {
    const eff = mode === 'site' && sites.length ? 'site' : 'orbit';
    ui.querySelectorAll<HTMLButtonElement>('button[data-mode]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.mode === eff));
      if (b.dataset.mode === 'site') b.disabled = !sites.length;
    });
    siteBtns.replaceChildren(...sites.map((s, i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = s.label; b.dataset.site = String(i);
      b.title = `Stand at site ${s.label}`;
      b.setAttribute('aria-pressed', String(eff === 'site' && i === siteIdx));
      return b;
    }));
  };
  ui.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b || b.disabled) return;
    if (b.dataset.site) handle.setCamera('site', +b.dataset.site);
    else handle.setCamera(b.dataset.mode as 'orbit' | 'site');
  });

  const handle: View3DDebugHandle = {
    setTime(t) { tMs = t; live?.timeChanged(); },
    setSites(s) { sites = s.slice(); if (siteIdx >= sites.length) siteIdx = 0; syncUi(); live?.sitesChanged(); },
    setCamera(m, i) {
      mode = m;
      if (i !== undefined && i >= 0 && i < Math.max(1, sites.length)) siteIdx = i;
      syncUi(); live?.cameraChanged();
    },
    resize() { live?.resize(); },
    destroy() {
      if (dead) return;
      dead = true;
      cleanup.splice(0).reverse().forEach((f) => f());
      live = undefined;
      root.remove();
    },
    debug: {
      gpu: () => live?.gpu() ?? 'not loaded',
      probe: (lat, lon) => live?.probe(lat, lon) ?? { gpu: NaN, cpu: NaN },
      bench: (n) => live?.bench(n) ?? { ms: NaN, fps: NaN, width: 0, height: 0 },
    },
  };

  interface Live {
    timeChanged(): void; sitesChanged(): void; cameraChanged(): void; resize(): void;
    gpu(): string; probe(lat: number, lon: number): { gpu: number; cpu: number };
    bench(n?: number): { ms: number; fps: number; width: number; height: number };
  }

  (async () => {
    const get = async (p: string) => {
      const r = await fetch(base + p);
      if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
      return r.arrayBuffer();
    };
    const text = async (p: string) => JSON.parse(new TextDecoder().decode(await get(p)));
    const [manifest, ephMeta, ephBuf] = await Promise.all([text('dem/manifest.json'), text('ephem.json'), get('ephem.bin')]);
    const hi: Tile | undefined = manifest.tiles.find((t: Tile) => t.id === HI_ID);
    const lo: Tile | undefined = manifest.tiles.find((t: Tile) => t.id === LO_ID);
    if (!hi || !lo) throw new Error('DEM manifest lacks ' + HI_ID + ' / ' + LO_ID);
    const [hiBuf, loBuf] = await Promise.all([get('dem/' + hi.file), get('dem/' + lo.file)]);
    if (dead) return;
    hi.data = new Int16Array(hiBuf); lo.data = new Int16Array(loBuf);
    const eph = new Ephem(ephMeta, ephBuf);
    // CPU twin of what the GPU sees: exactly these two tiles.
    const dem = new Dem([hi, lo], async () => { throw new Error('tiles are preloaded'); });
    live = start(hi, lo, dem, eph);
    msg.textContent = '';
    ui.hidden = false; readout.hidden = false;
    opts.onReady?.();
  })().catch((e) => fail(e instanceof Error ? e.message : String(e)));

  function start(hi: Tile, lo: Tile, dem: Dem, eph: Ephem): Live {
    let renderer: THREE.WebGLRenderer;
    try {
      const canvas = document.createElement('canvas');
      if (!canvas.getContext('webgl2', { antialias: true, powerPreference: 'high-performance' })) throw new Error('no context');
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    } catch {
      throw new Error('3D view needs WebGL2, which this browser or device does not provide.');
    }
    const gl = renderer.getContext() as WebGL2RenderingContext;
    renderer.setClearColor(BG);
    root.prepend(renderer.domElement);
    const basePR = () => Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);

    // ---- terrain ------------------------------------------------------------------------------
    const hiX1 = hi.x0! + (hi.w - 1) * hi.px!, hiY0 = hi.y0! - (hi.h - 1) * hi.px!;
    const xy0: [number, number] = [(hi.x0! + hiX1) / 2, (hi.y0! + hiY0) / 2];
    const [lat0, lon0] = spInv(xy0[0], xy0[1]);
    const h0 = dem.sample(lat0, lon0);
    const centre = posS(xy0[0], xy0[1], h0);            // orbit target and mesh origin
    const up0 = v3(unit(lat0, lon0));

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
    const floatLinear = renderer.extensions.has('OES_texture_float_linear');
    const texHi = heightTex(hi), texLo = heightTex(lo);
    // Max height per BLOCK x BLOCK texels, dilated by one block: bounds all terrain within a block length.
    const maxTex = (t: Tile, BLOCK: number, also: Tile | undefined, edge: (m: number) => number) => {
      const n = Math.ceil((t.w - 1) / BLOCK), a = new Float32Array(n * n).fill(-1e9), d = t.data!;
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        let m = -32768;
        const r1 = Math.min(j * BLOCK + BLOCK, t.h - 1), c1 = Math.min(i * BLOCK + BLOCK, t.w - 1);
        for (let r = j * BLOCK; r <= r1; r++) for (let c = i * BLOCK; c <= c1; c++) if (d[r * t.w + c] > m) m = d[r * t.w + c];
        a[j * n + i] = t.offset + t.scale * m;
      }
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
      return { tex, geo: new THREE.Vector4(t.x0!, t.y0!, t.px! * BLOCK, n - 1) };
    };
    const maxHi = maxTex(hi, BLOCK_HI, undefined, () => 1e9);        // beyond its edge the 20 m tile knows nothing: never skip there
    const maxMid = maxTex(hi, BLOCK_MID, undefined, () => 1e9);
    const maxLo = maxTex(lo, BLOCK_LO, hi, (m) => Math.max(m, 0));   // outside the 240 m tile the terrain is the sphere (0)
    const geoU = (t: Tile) => new THREE.Vector4(t.x0!, t.y0!, t.px!, t.w - 1);
    const sunDir = new THREE.Vector3(0, 1, 0);
    const shared = {
      uHi: { value: texHi }, uLo: { value: texLo }, uHiGeo: { value: geoU(hi) }, uLoGeo: { value: geoU(lo) },
      uMaxHi: { value: maxHi.tex }, uMaxMid: { value: maxMid.tex }, uMaxLo: { value: maxLo.tex },
      uMaxHiGeo: { value: maxHi.geo }, uMaxMidGeo: { value: maxMid.geo }, uMaxLoGeo: { value: maxLo.geo },
      uLinear: { value: floatLinear ? 1 : 0 }, uSun: { value: sunDir }, uHMax: { value: demMax(dem) }, uStepScale: { value: STEP_SCALE },
    };
    const camS = new THREE.Vector3();
    const shadeUniforms = { ...shared, uXY0: { value: new THREE.Vector2(xy0[0], xy0[1]) }, uCam: { value: camS }, uExposure: { value: 1.7 }, uAmbient: { value: 0.015 } };
    // Deferred when float render targets exist (practically always): meshes write (x, y, depth), one
    // full-screen pass marches once per pixel. Otherwise forward, with a depth pre-pass against overdraw.
    const deferred = renderer.extensions.has('EXT_color_buffer_float');
    const offset = <T extends THREE.Material>(m: T) => { m.polygonOffset = true; m.polygonOffsetFactor = 1; m.polygonOffsetUnits = 1; return m; };
    const terrainMat = (frag: string, extra: THREE.ShaderMaterialParameters = {}) =>
      new THREE.ShaderMaterial({ uniforms: shadeUniforms, vertexShader: TERRAIN_VERT, fragmentShader: frag, side: THREE.DoubleSide, ...extra });
    const gTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
    const mats: THREE.ShaderMaterial[] = [];

    const seq = (n: number, f: (i: number) => number) => Int32Array.from({ length: n }, (_, i) => f(i));
    const hiGrid: Grid = (() => {
      const n = Math.ceil((hi.w - 1) / HI_STEP) + 1, m = Math.ceil((hi.h - 1) / HI_STEP) + 1;
      return { tile: hi, cols: seq(n, (i) => Math.min(i * HI_STEP, hi.w - 1)), rows: seq(m, (i) => Math.min(i * HI_STEP, hi.h - 1)) };
    })();
    // Far field: the whole 240 m tile on a graded grid (240 m near the 20 m tile, 480 m, then 960 m).
    const graded = (c0: number, n: number) => {
      const out: number[] = [];
      for (let i = 0; i < n - 1;) { out.push(i); const d = Math.abs(i - c0) * lo.px!; i += d < 45e3 ? 1 : d < 100e3 ? 2 : 4; }
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

    const scene = new THREE.Scene(), gScene = new THREE.Scene();
    const addMesh = (to: THREE.Scene, geo: THREE.BufferGeometry, mat: THREE.ShaderMaterial, order: number) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(centre[0], centre[1], centre[2]);
      m.frustumCulled = false; m.renderOrder = order;
      mats.push(mat);
      to.add(m);
    };
    const screenGeo = new THREE.PlaneGeometry(2, 2);
    if (deferred) {
      addMesh(gScene, hiGeo, terrainMat(GBUF_FRAG), 0); addMesh(gScene, loGeo, offset(terrainMat(GBUF_FRAG)), 0);
      const resolve = new THREE.ShaderMaterial({ uniforms: { ...shadeUniforms, uG: { value: gTarget.texture } }, vertexShader: SCREEN_VERT, fragmentShader: RESOLVE_FRAG, depthFunc: THREE.AlwaysDepth });
      const quad = new THREE.Mesh(screenGeo, resolve);
      quad.frustumCulled = false; quad.renderOrder = 1;
      mats.push(resolve);
      scene.add(quad);
    } else {
      addMesh(scene, hiGeo, terrainMat(DEPTH_FRAG, { colorWrite: false }), 0); addMesh(scene, loGeo, offset(terrainMat(DEPTH_FRAG, { colorWrite: false })), 0);
      addMesh(scene, hiGeo, terrainMat(TERRAIN_FRAG, { depthWrite: false }), 1); addMesh(scene, loGeo, offset(terrainMat(TERRAIN_FRAG, { depthWrite: false })), 1);
    }

    // ---- Sun and Earth disks (site view). Drawn first without depth; terrain then covers them. ---
    const diskGeo = new THREE.CircleGeometry(1, 48);
    const disk = (hex: number, radiusDeg: number) => {
      const m = new THREE.Mesh(diskGeo, new THREE.MeshBasicMaterial({ color: hex, depthTest: false, depthWrite: false, toneMapped: false }));
      m.scale.setScalar(SKY_M * Math.tan(radiusDeg * DEG));
      m.renderOrder = -1; m.frustumCulled = false; m.visible = false;
      scene.add(m);
      return m;
    };
    const sunDisk = disk(SUN_HEX, SUN_RADIUS_DEG), earthDisk = disk(EARTH_HEX, EARTH_RADIUS_DEG);

    // ---- cameras --------------------------------------------------------------------------------
    const camera = new THREE.PerspectiveCamera(35, 1, 10, FAR_M);
    camera.up.copy(up0);
    const target = v3(centre);
    // Start: oblique, from beyond the Connecting Ridge looking across it into Shackleton.
    const horiz = (dx: number, dy: number) => new THREE.Vector3(dy, dx, 0).addScaledVector(up0, -up0.dot(new THREE.Vector3(dy, dx, 0))).normalize(); // grid (dx, dy) -> S
    camera.position.copy(target).addScaledVector(horiz(-0.80, -0.60), 38e3 * (opts.startZoom ?? 1)).addScaledVector(up0, 24e3 * (opts.startZoom ?? 1));
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.target.copy(target);
    controls.minDistance = 400; controls.maxDistance = 350e3;
    controls.maxPolarAngle = 89 * DEG;
    controls.zoomSpeed = 1.2;
    controls.update();

    interface SiteGeo { s: View3DSite; xy: [number, number]; h: number; eyeH: number; base: THREE.Vector3; up: THREE.Vector3; e: THREE.Vector3; n: THREE.Vector3; pin: THREE.Line; label: HTMLElement }
    let siteGeo: SiteGeo[] = [];
    const pinMat = new THREE.LineBasicMaterial({ color: PIN_HEX });
    const look = { az: 0, pitch: 0, hfov: 60 };

    const v6 = new Float64Array(6);
    const sunS = new THREE.Vector3(), earthS = new THREE.Vector3(); // body positions in S (metres)

    // ---- render on demand, with resolution scaled down while frames are slow ---------------------
    let raf = 0, refineTimer = 0, scale = 1, curPR = 0, forceFull = false;
    const requestRender = () => { if (!raf && !dead) raf = requestAnimationFrame(frame); };
    const px1 = new Uint8Array(4);
    const bufSize = new THREE.Vector2();
    const renderOnce = () => {
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
      if (forceFull) { forceFull = false; draw(basePR()); return; }
      const t0 = performance.now();
      draw(basePR() * scale);
      sync();
      const ms = performance.now() - t0;
      if (ms > 30) scale = Math.max(0.4, scale * 0.85);
      else if (ms < 15) scale = Math.min(1, scale * 1.1);
      if (curPR !== basePR()) refineTimer = window.setTimeout(() => { forceFull = true; requestRender(); }, 160);
    }

    const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();
    function prepare() {
      const w = root.clientWidth, h = root.clientHeight;
      const sg = mode === 'site' ? siteGeo[siteIdx] : undefined;
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
        camera.near = Math.max(2, 0.004 * camera.position.distanceTo(controls.target));
      }
      camera.updateProjectionMatrix();
      camera.updateMatrixWorld();
      camS.copy(camera.position);

      for (const [d, body] of [[sunDisk, sunS], [earthDisk, earthS]] as const) {
        d.visible = !!sg;
        if (!sg) continue;
        tmp.copy(body).sub(camera.position).normalize(); // true direction from the eye (Earth parallax 0.26 deg)
        d.position.copy(camera.position).addScaledVector(tmp, SKY_M);
        d.lookAt(camera.position);
      }

      siteGeo.forEach((g, i) => {
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
        tmp.copy(body).sub(controls.target).normalize();
        tmp.addScaledVector(up0, -tmp.dot(up0)).normalize();
        tmp2.copy(controls.target).project(camera);
        tmp.multiplyScalar(0.05 * camera.position.distanceTo(controls.target)).add(controls.target).project(camera);
        const dx = (tmp.x - tmp2.x) * w, dy = -(tmp.y - tmp2.y) * h, len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len;
        const r = Math.min((w / 2 - 70) / Math.max(Math.abs(ux), 1e-6), (h / 2 - 44) / Math.max(Math.abs(uy), 1e-6));
        elm.style.transform = `translate(${(w / 2 + ux * r).toFixed(1)}px, ${(h / 2 + uy * r).toFixed(1)}px) translate(-9px, -50%)`;
        (elm.firstElementChild as HTMLElement).style.transform = `rotate(${(Math.atan2(uy, ux) / DEG).toFixed(1)}deg)`;
      }
    }

    // ---- state changes --------------------------------------------------------------------------
    const pct = (f: number) => `${Math.round(f * 100)}%`;
    const deg = (v: number, d = 1) => `${v.toFixed(d)}°`;
    function updateReadout() {
      const iso = new Date(eph.clamp(tMs)).toISOString();
      const when = `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
      const sg = mode === 'site' ? siteGeo[siteIdx] : undefined;
      if (sg) {
        const s = azel(sg.s.lat, sg.s.lon, sg.h + sg.eyeH, v6[0], v6[1], v6[2]), e = azel(sg.s.lat, sg.s.lon, sg.h + sg.eyeH, v6[3], v6[4], v6[5]);
        readout.innerHTML = `<b>Site ${esc(sg.s.label)}</b> · ${when} · <span class="sun">Sun</span> az ${deg(s.az)} el ${deg(s.el, 2)}, <b>${pct(sunFractionAt(dem, v6, sg.s.lat, sg.s.lon, sg.eyeH))}</b> of disk visible · <span class="earth">Earth</span> az ${deg(e.az)} el ${deg(e.el, 2)}`;
      } else {
        const s = azel(lat0, lon0, h0, v6[0], v6[1], v6[2]);
        const per = siteGeo.map((g) => `${esc(g.s.label)} <b>${pct(sunFractionAt(dem, v6, g.s.lat, g.s.lon, g.s.mast))}</b>`).join(' · ');
        readout.innerHTML = `${when} · <span class="sun">Sun</span> el ${deg(s.el, 2)} at view centre${per ? ` · Sun disk visible from mast: ${per}` : ''}`;
      }
    }
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

    function timeChanged() {
      eph.at(tMs, v6);
      sunS.set(v6[0] * 1000, v6[1] * 1000, v6[2] * 1000 + R);
      earthS.set(v6[3] * 1000, v6[4] * 1000, v6[5] * 1000 + R);
      sunDir.set(v6[0], v6[1], v6[2]).normalize(); // one Moon-fixed direction for the whole scene
      updateReadout();
      requestRender();
    }

    function sitesChanged() {
      for (const g of siteGeo) { scene.remove(g.pin); g.pin.geometry.dispose(); g.label.remove(); }
      siteGeo = sites.map((s) => {
        const xy = spFwd(s.lat, s.lon), h = dem.sample(s.lat, s.lon);
        // Eye above whichever is higher: the DEM or the decimated mesh that is actually drawn.
        const surf = Math.max(h, meshHeight(inHi(xy[0], xy[1], 0) ? hiGrid : loGrid, xy[0], xy[1]));
        const f = enu(s.lat, s.lon);
        const base = v3(posS(xy[0], xy[1], h)), up = v3(f.u);
        const pin = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), up.clone().multiplyScalar(PIN_M)]), pinMat);
        pin.position.copy(base); pin.frustumCulled = false; pin.renderOrder = 2;
        scene.add(pin);
        const label = document.createElement('div');
        label.className = 'v3-label'; label.textContent = s.label;
        root.append(label);
        return { s, xy, h, eyeH: surf - h + Math.max(s.mast, MIN_EYE_M), base, up, e: v3(f.e), n: v3(f.n), pin, label };
      });
      cameraChanged();
    }

    let lastSiteView = '', inSite = false;
    const saved = { pos: camera.position.clone(), quat: camera.quaternion.clone() };
    controls.addEventListener('change', () => { if (!inSite) { saved.pos.copy(camera.position); saved.quat.copy(camera.quaternion); } requestRender(); });
    function cameraChanged() {
      const sg = mode === 'site' ? siteGeo[siteIdx] : undefined;
      controls.enabled = !sg;
      const wasSite = inSite;
      inSite = !!sg;
      if (sg) {
        const key = String(siteIdx); // nudging a site keeps the user's view direction
        if (key !== lastSiteView) { // entering a site: face the Sun's azimuth, level
          look.az = azel(sg.s.lat, sg.s.lon, sg.h + sg.eyeH, v6[0], v6[1], v6[2]).az; look.pitch = 0; look.hfov = 60;
          lastSiteView = key;
        }
      } else {
        lastSiteView = '';
        if (wasSite) { camera.position.copy(saved.pos); camera.quaternion.copy(saved.quat); } // orbit pose survives a visit to a site
        camera.up.copy(up0);
        controls.update(); // restores the orbit pose from its own state
      }
      updateReadout();
      requestRender();
    }


    // Site view: drag to look around, wheel / pinch to zoom the field of view. No translation.
    const cv = renderer.domElement;
    const ptrs = new Map<number, { x: number; y: number }>();
    let pinch = 0;
    const onDown = (e: PointerEvent) => {
      if (mode !== 'site' || !siteGeo[siteIdx]) return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { cv.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      pinch = 0;
    };
    const onMove = (e: PointerEvent) => {
      const p = ptrs.get(e.pointerId);
      if (!p || mode !== 'site') return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (ptrs.size === 1) {
        const k = look.hfov / root.clientWidth;
        look.az = (look.az - dx * k + 360) % 360;
        look.pitch = Math.max(-60, Math.min(80, look.pitch + dy * k));
      } else if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch) look.hfov = Math.max(4, Math.min(100, look.hfov * pinch / d));
        pinch = d;
      }
      requestRender();
    };
    const onUp = (e: PointerEvent) => { ptrs.delete(e.pointerId); pinch = 0; };
    const onWheel = (e: WheelEvent) => {
      if (mode !== 'site' || !siteGeo[siteIdx]) return;
      e.preventDefault();
      look.hfov = Math.max(4, Math.min(100, look.hfov * Math.exp(e.deltaY * 0.0015)));
      requestRender();
    };
    cv.addEventListener('pointerdown', onDown); cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerup', onUp); cv.addEventListener('pointercancel', onUp);
    cv.addEventListener('wheel', onWheel, { passive: false });
    const noMenu = (e: Event) => e.preventDefault();
    cv.addEventListener('contextmenu', noMenu);

    function resize() {
      const w = root.clientWidth, h = root.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
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
    function probe(lat: number, lon: number) {
      const [x, y] = spFwd(lat, lon);
      probeMat.uniforms.uProbe.value.set(x, y);
      renderer.setRenderTarget(probeRT);
      renderer.render(probeScene, probeCam);
      const b = new Uint8Array(4);
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b);
      renderer.setRenderTarget(null);
      return { gpu: (b[0] * 256 + b[1]) / 65535, cpu: sunFractionAt(dem, v6, lat, lon) };
    }
    function bench(n = 20) {
      draw(basePR()); sync();
      const t0 = performance.now();
      for (let i = 0; i < n; i++) { renderOnce(); sync(); }
      const ms = (performance.now() - t0) / n;
      return { ms, fps: 1000 / ms, width: cv.width, height: cv.height };
    }
    function gpu() {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    }

    cleanup.push(() => {
      cancelAnimationFrame(raf); clearTimeout(refineTimer);
      ro.disconnect();
      cv.removeEventListener('pointerdown', onDown); cv.removeEventListener('pointermove', onMove);
      cv.removeEventListener('pointerup', onUp); cv.removeEventListener('pointercancel', onUp);
      cv.removeEventListener('wheel', onWheel); cv.removeEventListener('contextmenu', noMenu);
      controls.dispose();
      for (const g of siteGeo) g.pin.geometry.dispose();
      for (const d of [hiGeo, loGeo, diskGeo, screenGeo, texHi, texLo, maxHi.tex, maxMid.tex, maxLo.tex, gTarget, ...mats, pinMat, probeMat, probeRT, sunDisk.material, earthDisk.material]) d.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      hi.data = lo.data = undefined;
    });

    const live: Live = { timeChanged, sitesChanged, cameraChanged, resize, gpu, probe, bench };
    tMs = eph.clamp(tMs);
    eph.at(tMs, v6);
    resize();
    timeChanged();
    sitesChanged();
    return live;
  }

  syncUi();
  return handle;
}
