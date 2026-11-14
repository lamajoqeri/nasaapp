// 3D view of the Shackleton 20 m tile with ray-marched terrain shadows (HANDOFF B2).
// Lazy-loaded by ui/app.ts so three.js stays out of the main bundle.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { core } from '../core/api';
import { Dem, type Tile } from '../core/dem';
import { azel, DEG, enu, R, SUN_R, spFwd, unit } from '../core/geom';
import { frag, vert } from './shaders';

export interface View3DInput { lat: number; lon: number; mast: number; name: string; t: number; sunFrac: number }
export interface View3D { update(v: View3DInput): void }

const EARTH_R = 6371e3;
const SKY_D = 1e6; // m: Sun/Earth discs sit beyond all terrain (rays stop at 300 km)
// Quality ladder for slow devices. March step = clamp(grow * t, 10 m, 12000 * grow) (grow 0.02 = core's
// horizon schedule), long skips over terrain that cannot reach the Sun disk, at most `steps` steps.
const QUALITY = [
  { grow: 0.02, steps: 768, pr: 2 }, { grow: 0.03, steps: 384, pr: 1.5 }, { grow: 0.05, steps: 256, pr: 1 },
  { grow: 0.08, steps: 160, pr: 0.75 }, { grow: 0.12, steps: 96, pr: 0.5 },
];
const BLOCK = { shackleton_20m: 16, sp_240m: 8 } as Record<string, number>;

async function bin(f: string): Promise<ArrayBuffer> {
  const r = await fetch(import.meta.env.BASE_URL + 'data/dem/' + f);
  if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
  return r.arrayBuffer();
}

const tex = (f: Float32Array, w: number, h: number) => {
  const t = new THREE.DataTexture(f, w, h, THREE.RedFormat, THREE.FloatType);
  t.needsUpdate = true;
  return t;
};

/** Heights (m) as an R32F texture, plus a max-height grid over BxB blocks dilated by one block, so a step of
 *  up to one block length from anywhere in a block never passes terrain higher than the grid value. */
function heights(t: Tile, B: number) {
  const a = t.data!, f = new Float32Array(a.length), bw = Math.ceil(t.w / B), bh = Math.ceil(t.h / B);
  const raw = new Float32Array(bw * bh).fill(-1e5), dil = new Float32Array(bw * bh);
  let max = -Infinity;
  for (let r = 0; r < t.h; r++) for (let c = 0; c < t.w; c++) {
    const v = (f[r * t.w + c] = t.offset + t.scale * a[r * t.w + c]);
    if (v > max) max = v;
    // a pixel on a block edge also bounds the neighbour's bilinear cell
    for (const rr of new Set([Math.floor(r / B), Math.floor(Math.max(r - 1, 0) / B)]))
      for (const cc of new Set([Math.floor(c / B), Math.floor(Math.max(c - 1, 0) / B)]))
        if (v > raw[rr * bw + cc]) raw[rr * bw + cc] = v;
  }
  for (let r = 0; r < bh; r++) for (let c = 0; c < bw; c++) {
    let m = -1e5;
    for (let i = Math.max(r - 1, 0); i <= Math.min(r + 1, bh - 1); i++)
      for (let j = Math.max(c - 1, 0); j <= Math.min(c + 1, bw - 1); j++) m = Math.max(m, raw[i * bw + j]);
    dil[r * bw + c] = m;
  }
  return { tex: tex(f, t.w, t.h), mtex: tex(dil, bw, bh), max };
}

/** Grid mesh over a spstere tile, n x n vertices, positions Moon-fixed minus c (float64 math, float32 storage). */
function tileMesh(t: Tile, n: number, c: number[], mat: THREE.Material): THREE.Mesh {
  const a = t.data!, pos = new Float32Array(n * n * 3);
  for (let i = 0; i < n; i++) {
    const r = Math.round((i * (t.h - 1)) / (n - 1));
    for (let j = 0; j < n; j++) {
      const cc = Math.round((j * (t.w - 1)) / (n - 1));
      const x = t.x0! + cc * t.px!, y = t.y0! - r * t.px!;
      const s = R + t.offset + t.scale * a[r * t.w + cc];
      // inverse stereographic as a unit vector (see shaders.ts normalAt)
      const A = x / (2 * R), B = y / (2 * R), q = A * A + B * B, q1 = q + 1;
      const k = (i * n + j) * 3;
      pos[k] = (s * 2 * B) / q1 - c[0]; pos[k + 1] = (s * 2 * A) / q1 - c[1]; pos[k + 2] = (s * (q - 1)) / q1 - c[2];
    }
  }
  const idx = new Uint32Array((n - 1) * (n - 1) * 6);
  let m = 0;
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < n - 1; j++) {
    const v = i * n + j;
    idx[m++] = v; idx[m++] = v + n; idx[m++] = v + 1; idx[m++] = v + 1; idx[m++] = v + n; idx[m++] = v + n + 1;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, mat);
  mesh.frustumCulled = false;
  return mesh;
}

export async function mount(root: HTMLElement): Promise<View3D> {
  root.innerHTML = `
    <div class="v3d-bar">
      <label><input type="radio" name="v3cam" value="orbit" checked> Overview</label>
      <label><input type="radio" name="v3cam" value="stand"> Stand at the site</label>
      <label>Quality <select class="v3q">${QUALITY.map((q, i) => `<option value="${i}">${q.steps} steps, ${q.grow * 100}%</option>`).join('')}<option value="auto" selected>auto</option></select></label>
    </div>
    <p class="v3d-note status busy">Loading terrain (20 m Shackleton tile + 240 m polar mosaic)…</p>
    <div class="v3d-wrap"><canvas class="v3d"></canvas><div class="v3d-hud"></div></div>
    <p class="v3d-dbg"></p>`;
  const $ = <T extends HTMLElement>(s: string) => root.querySelector(s) as T;
  const canvas = $<HTMLCanvasElement>('canvas.v3d'), note = $('.v3d-note'), hud = $('.v3d-hud'), dbg = $('.v3d-dbg');

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  const probeRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType, format: THREE.RGBAFormat });

  // --- terrain data ---
  const man = JSON.parse(new TextDecoder().decode(await bin('manifest.json')));
  const tiles: Tile[] = man.tiles;
  const t20 = tiles.find((t) => t.id === 'shackleton_20m')!, t240 = tiles.find((t) => t.id === 'sp_240m')!;
  [t20.data, t240.data] = (await Promise.all([bin(t20.file), bin(t240.file)])).map((b) => new Int16Array(b));
  const dem = new Dem([t20, t240], bin); // site heights from the same two tiles the shader sees
  const h20 = heights(t20, BLOCK[t20.id]), h240 = heights(t240, BLOCK[t240.id]);

  // Tile centre, rounded to float32 so CPU and GPU agree on the origin exactly.
  const cx = t20.x0! + ((t20.w - 1) / 2) * t20.px!, cy = t20.y0! - ((t20.h - 1) / 2) * t20.px!;
  const Ac = cx / (2 * R), Bc = cy / (2 * R), qc = Ac * Ac + Bc * Bc;
  const lat0 = Math.asin((qc - 1) / (qc + 1)) / DEG, lon0 = Math.atan2(2 * Ac, 2 * Bc) / DEG;
  const sc = R + dem.sample(lat0, lon0), u0 = unit(lat0, lon0);
  const C = u0.map((v) => Math.fround(sc * v));
  const Rc = Math.hypot(C[0], C[1], C[2]);

  const uniforms = {
    uT20: { value: h20.tex }, uT240: { value: h240.tex }, uM20: { value: h20.mtex }, uM240: { value: h240.mtex },
    uB: { value: new THREE.Vector2(BLOCK[t20.id], BLOCK[t240.id]) },
    uG20: { value: new THREE.Vector4(t20.x0, t20.y0, t20.px, t20.w) },
    uG240: { value: new THREE.Vector4(t240.x0, t240.y0, t240.px, t240.w) },
    uC: { value: new THREE.Vector3(...C) }, uRc: { value: Rc }, uRcR: { value: Rc - R },
    uSun: { value: new THREE.Vector3(0, 0, 1) }, uSunR: { value: 0.266 * DEG },
    uMaxH: { value: Math.max(h20.max, h240.max) },
    uSteps: { value: 256 }, uGrow: { value: 0.05 }, uExposure: { value: 1.3 },
    uSite: { value: new THREE.Vector3() }, uMark: { value: 1 },
  };
  const mat = (defines: Record<string, string> = {}) => new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: vert, fragmentShader: frag, uniforms, defines,
  });

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  scene.add(tileMesh(t20, 500, C, mat()));
  scene.add(tileMesh(t240, 634, C, mat({ FAR: '' })));

  // Sun and Earth: spheres at SKY_D along their true directions from the observer (stand view only).
  const sunMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), new THREE.MeshBasicMaterial({ color: 0xfff4d6 }));
  const earthMat = new THREE.ShaderMaterial({
    uniforms: { uSun: uniforms.uSun },
    vertexShader: 'varying vec3 vN; void main(){ vN = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'uniform vec3 uSun; varying vec3 vN; void main(){ float d = max(dot(vN, uSun), 0.0); gl_FragColor = vec4(vec3(0.25,0.45,0.9) * (0.04 + 1.1 * d), 1.0); }',
  });
  const earthMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), earthMat);
  scene.add(sunMesh, earthMesh);

  // Probe: same shader, one point at the site + mast, rendered to a 1x1 float target and read back.
  const probeScene = new THREE.Scene();
  const probeGeo = new THREE.BufferGeometry();
  probeGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
  const probe = new THREE.Points(probeGeo, mat({ PROBE: '' }));
  probe.frustumCulled = false;
  probeScene.add(probe);
  const probeCam = new THREE.Camera();

  const camera = new THREE.PerspectiveCamera(45, 1, 10, 2e6);
  const controls = new OrbitControls(camera, canvas);
  controls.maxDistance = 4e5; controls.minDistance = 100;

  // --- state ---
  let mode: 'orbit' | 'stand' = 'orbit';
  let input: View3DInput | null = null, siteKey = '', inside = false;
  let sitePos = [0, 0, 0], siteUp = new THREE.Vector3(), siteE = new THREE.Vector3(), siteN = new THREE.Vector3();
  let sunAz = 0, sunEl = 0, earthAz = 0, earthEl = 0, shaderFrac = NaN;
  let yaw = 0, pitch = 0, fov = 30; // stand view offsets from the Sun azimuth
  let needCam = true, qual = 1, auto = true, dirty = true, token = 0;
  let sunKm = [0, 0, 0], earthKm = [0, 0, 0];

  const setQuality = (i: number) => {
    qual = i;
    uniforms.uSteps.value = QUALITY[i].steps; uniforms.uGrow.value = QUALITY[i].grow;
    renderer.setPixelRatio(Math.min(QUALITY[i].pr, devicePixelRatio));
    resize();
    probeDue = true;
  };
  const sel = $<HTMLSelectElement>('.v3q');
  sel.onchange = () => { auto = sel.value === 'auto'; if (!auto) setQuality(+sel.value); };

  function resize() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
    dirty = true;
  }
  new ResizeObserver(resize).observe(canvas);

  function placeSite(v: View3DInput) {
    const { e, n, u } = enu(v.lat, v.lon);
    const s = R + dem.sample(v.lat, v.lon) + v.mast;
    sitePos = u.map((x, k) => s * x - C[k]);
    siteUp.set(...u); siteE.set(...e); siteN.set(...n);
    probeGeo.attributes.position.array.set(sitePos);
    probeGeo.attributes.position.needsUpdate = true;
    uniforms.uSite.value.set(sitePos[0], sitePos[1], sitePos[2]);
    needCam = true;
  }

  // Overview start: above the site with the Sun behind the camera, so lit slopes face us and shadows run away.
  function overviewCamera() {
    const az = sunAz * DEG;
    camera.up.copy(siteUp);
    controls.target.set(sitePos[0], sitePos[1], sitePos[2]);
    camera.position.copy(controls.target).addScaledVector(siteUp, 10000)
      .addScaledVector(siteN, 14000 * Math.cos(az)).addScaledVector(siteE, 14000 * Math.sin(az));
    controls.update();
  }

  function setSky() {
    const hSite = Math.hypot(...sitePos.map((x, k) => x + C[k])) - R;
    const s = azel(input!.lat, input!.lon, hSite, sunKm[0], sunKm[1], sunKm[2]);
    const e = azel(input!.lat, input!.lon, hSite, earthKm[0], earthKm[1], earthKm[2]);
    sunAz = s.az; sunEl = s.el; earthAz = e.az; earthEl = e.el;
    uniforms.uSunR.value = Math.asin(SUN_R / s.dist);
    const dir = (b: number[]) => {
      const v = b.map((x, k) => x * 1000 - (sitePos[k] + C[k]));
      const d = Math.hypot(v[0], v[1], v[2]);
      return { v: new THREE.Vector3(v[0] / d, v[1] / d, v[2] / d), d };
    };
    const sd = dir(sunKm), ed = dir(earthKm);
    uniforms.uSun.value.copy(sd.v); // parallax across 300 km is < 1e-6 rad
    const at = (m: THREE.Mesh, d: THREE.Vector3, r: number) => {
      m.position.set(sitePos[0], sitePos[1], sitePos[2]).addScaledVector(d, SKY_D);
      m.scale.setScalar(SKY_D * Math.tan(r));
    };
    at(sunMesh, sd.v, Math.asin(SUN_R / sd.d));
    at(earthMesh, ed.v, Math.asin(EARTH_R / ed.d));
  }

  function runProbe() {
    if (!input || !inside) return;
    renderer.setRenderTarget(probeRT);
    renderer.render(probeScene, probeCam);
    const px = new Float32Array(4);
    renderer.readRenderTargetPixels(probeRT, 0, 0, 1, 1, px);
    renderer.setRenderTarget(null);
    shaderFrac = px[0];
    const core = input.sunFrac, d = Math.abs(shaderFrac - core);
    const pct = (f: number) => (f > 0 && f < 0.005 ? '<1' : String(Math.round(f * 100)));
    dbg.innerHTML = `Shader at site: <b>${pct(shaderFrac)}%</b> of Sun disk visible · core: <b>${pct(core)}%</b> · ` +
      `<span class="${d <= 0.1 ? 'good' : 'bad'}">Δ ${(d * 100).toFixed(1)} pts</span> · ${QUALITY[qual].steps} steps · ${fps ? fps.toFixed(0) + ' fps' : ''}`;
    dbg.dataset.shader = String(shaderFrac); dbg.dataset.core = String(core);
  }

  function setMode(m: typeof mode) {
    mode = m; yaw = 0; pitch = 0; fov = 30;
    controls.enabled = m === 'orbit';
    uniforms.uMark.value = m === 'orbit' ? 1 : 0;
    sunMesh.visible = earthMesh.visible = m === 'stand';
    camera.near = m === 'orbit' ? 10 : 0.5;
    camera.fov = m === 'orbit' ? 45 : fov;
    camera.updateProjectionMatrix();
    dirty = true;
  }
  root.querySelectorAll<HTMLInputElement>('input[name=v3cam]').forEach((r) => (r.onchange = () => setMode(r.value as typeof mode)));
  controls.addEventListener('change', () => (dirty = true));

  // Stand view: drag to look around, wheel to zoom (narrow FOV shows the Sun disk on the ridge line).
  let drag: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => { if (mode === 'stand') { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); } });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const k = fov / canvas.clientHeight;
    yaw -= (e.clientX - drag.x) * k; pitch = Math.max(-80, Math.min(80, pitch + (e.clientY - drag.y) * k));
    drag = { x: e.clientX, y: e.clientY }; dirty = true;
  });
  canvas.addEventListener('pointerup', () => (drag = null));
  canvas.addEventListener('wheel', (e) => {
    if (mode !== 'stand') return;
    e.preventDefault();
    fov = Math.max(1, Math.min(90, fov * Math.exp(e.deltaY * 0.001))); camera.fov = fov; camera.updateProjectionMatrix(); dirty = true;
  }, { passive: false });

  function standCamera() {
    const az = (sunAz + yaw) * DEG, el = (Math.max(sunEl, -5) + pitch) * DEG;
    const look = siteN.clone().multiplyScalar(Math.cos(az)).addScaledVector(siteE, Math.sin(az))
      .multiplyScalar(Math.cos(el)).addScaledVector(siteUp, Math.sin(el));
    camera.position.set(sitePos[0], sitePos[1], sitePos[2]);
    camera.up.copy(siteUp);
    camera.lookAt(camera.position.clone().add(look));
  }

  // --- render loop: on demand, with frame-time based auto-degrade ---
  let last = 0, ema = 16, fps = 0, slow = 0;
  let probeDue = false, lastProbe = 0;
  function frame(now: number) {
    requestAnimationFrame(frame);
    // Probe readback stalls the GPU pipeline: at most 4 per second, the latest time always lands.
    if (probeDue && now - lastProbe > 250) { probeDue = false; lastProbe = now; runProbe(); }
    if (!dirty || !inside || !root.isConnected || root.offsetParent === null) { last = 0; return; }
    dirty = false;
    if (mode === 'stand') standCamera();
    renderer.render(scene, camera);
    if (last) {
      ema = ema * 0.9 + (now - last) * 0.1; fps = 1000 / ema;
      if (auto && ema > 45 && qual < QUALITY.length - 1 && ++slow > 20) { slow = 0; ema = 16; setQuality(qual + 1); }
    }
    last = now;
    const fmt = (a: number, e: number) => `az ${a.toFixed(1)}°, el ${e.toFixed(2)}°`;
    hud.textContent = `${input!.name} · Sun ${fmt(sunAz, sunEl)} · Earth ${fmt(earthAz, earthEl)}`;
  }
  requestAnimationFrame(frame);
  setQuality(1);
  note.textContent = '';

  return {
    update(v) {
      input = v;
      const key = `${v.lat},${v.lon},${v.mast}`;
      if (key !== siteKey) {
        siteKey = key;
        const [x, y] = spFwd(v.lat, v.lon);
        const m = 2000; // keep the site away from the tile edge so its surroundings are in view
        inside = v.lat < -80 && x > t20.x0! + m && x < t20.x0! + (t20.w - 1) * t20.px! - m && y < t20.y0! - m && y > t20.y0! - (t20.h - 1) * t20.px! + m;
        note.textContent = inside ? '' : `3D view covers the Shackleton 20 m tile only (89–90°S near Shackleton crater). “${v.name}” is outside it: pick Connecting Ridge or Shackleton rim in the first column.`;
        note.className = 'v3d-note status';
        root.querySelector<HTMLElement>('.v3d-wrap')!.hidden = !inside;
        dbg.hidden = !inside;
        if (!inside) return;
        placeSite(v);
        resize();
      }
      if (!inside) return;
      const tok = ++token;
      core.sunVector(v.t).then(({ sun, earth }) => {
        if (tok !== token) return;
        sunKm = sun; earthKm = earth;
        setSky();
        if (needCam) { needCam = false; overviewCamera(); }
        probeDue = dirty = true;
      });
    },
  };
}
