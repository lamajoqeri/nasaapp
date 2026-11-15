// Sky pop-up (docs/V2-DESIGN.md section 5): an all-sky fisheye from the site. Zenith at the centre, the
// astronomical horizon as a ring, north up and east to the LEFT (the sky-chart convention: you are looking up).
//
// State changes only through the `sky.open` / `sky.close` actions; the module imports and tests without a DOM.
import type { ScenarioResult } from '../core/api';
import { actions, register, type Action } from './actions';
import { dayTicks, EARTH, LETTERS, Plot, SUN } from './charts';
import { coord, dur, utc } from './format';
import { act, inspectorDeps, missionDays, nowReadout, onInspectorChange, onInspectorPaint, setPlaying, setTime, type InspectorDeps } from './inspector';
import { STEPS } from './timeline';

/* ------------------------------------------------------------------ projection (pure) */

export type SkyMode = 'true' | 'zoom';
export const SKY_MODES: readonly SkyMode[] = ['zoom', 'true'];
/** Elevation at the outer edge of the plot. Below the horizon is drawn outside the horizon ring in both modes. */
export const SKY_FLOOR: Record<SkyMode, number> = { true: -10, zoom: -8 };
/** Horizon zoom: elevations from the floor up to ZOOM_TOP fill the plot outside ZOOM_CORE; the rest of the sky is compressed inside it. */
export const ZOOM_TOP = 12, ZOOM_CORE = 0.2;
const EARTH_R = 0.95; // deg, as the panorama

/**
 * Radius of an elevation as a fraction of the plot radius: 0 at the zenith, 1 at the floor elevation, larger
 * below it. "true" is linear in angle (azimuthal equidistant). "zoom" is piecewise linear with a knee at
 * ZOOM_TOP. Both are continuous and strictly decreasing in elevation.
 */
export function skyRadius(elDeg: number, mode: SkyMode): number {
  const el = Math.min(90, elDeg);
  if (mode === 'true') return (90 - el) / (90 - SKY_FLOOR.true);
  if (el >= ZOOM_TOP) return (ZOOM_CORE * (90 - el)) / (90 - ZOOM_TOP);
  return ZOOM_CORE + ((1 - ZOOM_CORE) * (ZOOM_TOP - el)) / (ZOOM_TOP - SKY_FLOOR.zoom);
}

/** Plot radii per degree of elevation at this elevation: the scale a disk's angular radius is drawn at. */
export function radialScale(elDeg: number, mode: SkyMode): number {
  if (mode === 'true') return 1 / (90 - SKY_FLOOR.true);
  return elDeg >= ZOOM_TOP ? ZOOM_CORE / (90 - ZOOM_TOP) : (1 - ZOOM_CORE) / (ZOOM_TOP - SKY_FLOOR.zoom);
}

/** Position in plot radii from the centre, +x right and +y down. North (az 0) is up, east (az 90) is left. */
export function skyXY(azDeg: number, elDeg: number, mode: SkyMode): [number, number] {
  const r = skyRadius(elDeg, mode), a = (azDeg * Math.PI) / 180;
  return [-r * Math.sin(a), -r * Math.cos(a)];
}

/** Horizon zoom when the Sun never climbs above 15° in the window (the lunar poles), the honest linear view otherwise. */
export function defaultSkyMode(sunEl: ArrayLike<number>): SkyMode {
  let mx = -Infinity;
  for (let i = 0; i < sunEl.length; i++) if (sunEl[i] > mx) mx = sunEl[i];
  return mx < 15 ? 'zoom' : 'true';
}

/** "B", "b" or a 1-based position ("2") -> index. Throws when there is no such scenario. */
export function scenarioIndex(arg: unknown, count: number): number {
  const s = String(arg).trim().toUpperCase();
  const i = /^[A-D]$/.test(s) ? LETTERS.indexOf(s) : /^[1-4]$/.test(s) ? +s - 1 : -1;
  if (i < 0) throw new Error('sky.open: "scenario" must be a letter A to D');
  if (i >= count) throw new Error(`sky.open: there is no scenario ${LETTERS[i]}`);
  return i;
}

/** Azimuth between two samples, taking the short way round 360. */
export function lerpAz(a: number, b: number, f: number): number {
  const d = ((b - a + 540) % 360) - 180;
  return (a + d * f + 360) % 360;
}

/* ------------------------------------------------------------------ state + actions */

const state = { open: false, scale: null as SkyMode | null };
const subs = new Set<() => void>();
const changed = () => { for (const f of [...subs]) f(); };

const selectedResult = (): ScenarioResult | undefined => {
  const d = inspectorDeps();
  return d?.scenarios()[d.selected()]?.base;
};
/** The scale shown: the user's or agent's choice, else the default for the selected scenario. */
const shownScale = (): SkyMode => state.scale ?? (selectedResult() ? defaultSkyMode(selectedResult()!.series.sunEl) : 'zoom');

/** Plain JSON for the agent's snapshot(). */
export function skyState() {
  const d = inspectorDeps();
  return {
    open: state.open,
    scenario: d && d.scenarios().length ? LETTERS[d.selected()] : null,
    scale: shownScale(),
    scaleIsDefault: state.scale === null,
    missionDays: missionDays(),
  };
}

function define<A>(a: Action<A>) { actions.delete(a.name); register(a); }
function args(a: unknown, name: string, keys: string[]): Record<string, unknown> {
  const o = a === undefined ? {} : a;
  if (typeof o !== 'object' || o === null || Array.isArray(o)) throw new Error(`${name}: arguments must be an object`);
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new Error(`${name}: unknown argument "${k}"`);
  return o as Record<string, unknown>;
}

define<{ scenario?: string; scale?: SkyMode }>({
  name: 'sky.open',
  description: 'Open the sky pop-up: an all-sky fisheye view from a site (zenith at the centre, horizon as a ring, north up, east left) with the terrain horizon, the Sun and Earth tracks over the mission length, and the Sun and Earth at the time shown by the scrubber. scenario: optional letter A to D to select that scenario first; without it the selected scenario is shown. scale: optional, "zoom" stretches the band from 8° below to 12° above the horizon (best at the lunar poles), "true" is the linear all-sky view; without it the scale is chosen from how high the Sun gets. Calling it while the pop-up is open changes the scenario or scale.',
  schema: {
    type: 'object',
    properties: {
      scenario: { type: 'string', description: 'scenario letter, A to D' },
      scale: { type: 'string', enum: ['zoom', 'true'], description: 'radial scale of the view' },
    },
    required: [],
    additionalProperties: false,
  },
  async run(a) {
    const o = args(a, 'sky.open', ['scenario', 'scale']);
    if (o.scale !== undefined && !SKY_MODES.includes(o.scale as SkyMode)) throw new Error('sky.open: "scale" must be "zoom" or "true"');
    const d = inspectorDeps();
    if (o.scenario !== undefined) {
      const i = scenarioIndex(o.scenario, d ? d.scenarios().length : LETTERS.length);
      if (d && i !== d.selected()) d.select(i);
    }
    if (o.scale !== undefined) state.scale = o.scale as SkyMode;
    state.open = true;
    changed();
    return skyState();
  },
});

define<Record<string, never>>({
  name: 'sky.close',
  description: 'Close the sky pop-up.',
  schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  async run(a) {
    args(a, 'sky.close', []);
    if (state.open) { state.open = false; changed(); }
    return skyState();
  },
});

/* ---- URL hash: sky=1, ss=<zoom|true> when the scale was chosen ---- */

export function writeHash(p: URLSearchParams) {
  if (state.open) p.set('sky', '1');
  if (state.scale) p.set('ss', state.scale);
}
export function readHash(p: URLSearchParams) {
  state.open = p.get('sky') === '1';
  state.scale = SKY_MODES.includes(p.get('ss') as SkyMode) ? (p.get('ss') as SkyMode) : null;
  changed();
}

/* ------------------------------------------------------------------ drawing */

const BG = '#0a0b0d', FG = '#e8e6e1', MUTED = '#8e939c', FAINT = '#686d77', GRID = 'rgba(232,230,225,0.08)', AXIS = '#343a44';
const TERRAIN = '#1c2026', EDGE = '#6b717b';
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace', SANS = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const MARGIN = 20;

interface SkyModel { result?: ScenarioResult; mode: SkyMode; durationDays: number }
interface Geom { cx: number; cy: number; R: number; open?: Path2D }

type G = CanvasRenderingContext2D;

function geom(W: number, H: number): Geom {
  return { cx: W / 2, cy: H / 2, R: Math.max(10, Math.min(W, H) / 2 - MARGIN) };
}
const at = (q: Geom, az: number, el: number, mode: SkyMode): [number, number] => {
  const [x, y] = skyXY(az, el, mode);
  return [q.cx + q.R * x, q.cy + q.R * y];
};

/**
 * Unit normal of a body's path at sample i, in canvas px: the side that faces the zenith (or, for a path that
 * runs straight through the zenith, a fixed side). Day marks cross the path along it; labels sit beside the path.
 */
function pathNormal(q: Geom, az: ArrayLike<number>, el: ArrayLike<number>, i: number, mode: SkyMode): [number, number] {
  const n = az.length, a = at(q, az[Math.max(0, i - 1)], el[Math.max(0, i - 1)], mode), b = at(q, az[Math.min(n - 1, i + 1)], el[Math.min(n - 1, i + 1)], mode);
  const tx = b[0] - a[0], ty = b[1] - a[1], len = Math.hypot(tx, ty);
  const p = at(q, az[i], el[i], mode);
  if (len < 1e-6) { const d = Math.hypot(p[0] - q.cx, p[1] - q.cy) || 1; return [(q.cx - p[0]) / d, (q.cy - p[1]) / d]; }
  let nx = -ty / len, ny = tx / len;
  const inward = nx * (q.cx - p[0]) + ny * (q.cy - p[1]);
  if (inward < -1e-6 || (Math.abs(inward) <= 1e-6 && ny > 0)) { nx = -nx; ny = -ny; }
  return [nx, ny];
}

/** Rings to draw: [elevation, label]. The horizon (0) is drawn separately, stronger. */
const RINGS: Record<SkyMode, [number, string][]> = {
  true: [[60, '60°'], [30, '30°']],
  zoom: [[60, ''], [30, '30°'], [8, '8°'], [4, '4°'], [-4, '−4°']],
};

function label(g: G, text: string, x: number, y: number, color = MUTED) {
  const w = g.measureText(text).width;
  g.fillStyle = BG; g.globalAlpha = 0.78; g.fillRect(x - w / 2 - 2, y - 6, w + 4, 12); g.globalAlpha = 1;
  g.fillStyle = color; g.fillText(text, x, y);
}

/** Static layer: grid, terrain, tracks. Returns the geometry and the open-sky path the bodies are clipped to. */
function drawSky(g: G, W: number, H: number, m: SkyModel): Geom {
  const q = geom(W, H), { cx, cy, R } = q, mode = m.mode;
  g.fillStyle = BG; g.fillRect(0, 0, W, H);
  const ring = (el: number) => { g.beginPath(); g.arc(cx, cy, R * skyRadius(el, mode), 0, Math.PI * 2); };

  g.save();
  g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.clip();

  // grid: spokes every 45°, elevation rings
  g.lineWidth = 1; g.strokeStyle = GRID;
  g.beginPath();
  for (let a = 0; a < 360; a += 45) { const [x, y] = skyXY(a, SKY_FLOOR[mode], mode); g.moveTo(cx, cy); g.lineTo(cx + R * x, cy + R * y); }
  g.stroke();
  for (const [el] of RINGS[mode]) { ring(el); g.stroke(); }
  if (mode === 'zoom') { ring(ZOOM_TOP); g.strokeStyle = 'rgba(232,230,225,0.22)'; g.setLineDash([1, 3]); g.stroke(); g.setLineDash([]); }

  // terrain: everything between the plot edge and the terrain horizon
  const r = m.result;
  if (r) {
    const h = r.horizon.el, n = h.length, open = new Path2D();
    for (let i = 0; i < n; i++) { const [x, y] = at(q, (i * 360) / n, h[i], mode); i ? open.lineTo(x, y) : open.moveTo(x, y); }
    open.closePath();
    const land = new Path2D();
    land.arc(cx, cy, R + 2, 0, Math.PI * 2);
    land.addPath(open);
    g.fillStyle = TERRAIN; g.fill(land, 'evenodd');
    g.strokeStyle = EDGE; g.lineWidth = 1.2; g.stroke(open);
    q.open = open;
  }

  // astronomical horizon, over the terrain so it reads where the ground is above and below it
  ring(0); g.strokeStyle = 'rgba(232,230,225,0.36)'; g.lineWidth = 1; g.setLineDash([4, 3]); g.stroke(); g.setLineDash([]);

  if (r) {
    const s = r.series, n = s.t.length, k = Math.min(n, Math.floor(m.durationDays * 24) + 1);
    const track = (az: Float32Array, el: Float32Array, vis: (i: number) => boolean, color: string) => {
      const seg = (from: number, to: number, want: boolean) => {
        g.beginPath();
        for (let i = Math.max(1, from); i < to; i++) {
          if (vis(i) !== want) continue;
          if (el[i] < SKY_FLOOR[mode] - 6 && el[i - 1] < SKY_FLOOR[mode] - 6) continue; // far outside the plot
          const a = at(q, az[i - 1], el[i - 1], mode), b = at(q, az[i], el[i], mode);
          g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]);
        }
        g.stroke();
      };
      g.strokeStyle = color;
      // rest of the lunar day after the mission: faint, so the body never floats free of a path
      g.lineWidth = 1; g.globalAlpha = 0.2; seg(k - 1, n, true); seg(k - 1, n, false);
      // the mission: solid where visible, dashed where terrain hides it
      g.globalAlpha = 0.5; g.setLineDash([2, 3]); seg(0, k, false); g.setLineDash([]);
      g.globalAlpha = 1; g.lineWidth = 1.6; seg(0, k, true);
      g.globalAlpha = 1;
    };
    track(s.earthAz, s.earthEl, (i) => s.earthVis[i] > 0, EARTH);
    track(s.sunAz, s.sunEl, (i) => s.sunFrac[i] > 0, SUN);

    // day marks along the Sun's track
    const every = dayTicks(m.durationDays)[1] ?? 1;
    g.font = `9px ${MONO}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let dday = 0; dday * 24 < k; dday++) {
      const i = dday * 24;
      if (s.sunEl[i] < SKY_FLOOR[mode]) continue;
      const [x, y] = at(q, s.sunAz[i], s.sunEl[i], mode);
      const [nx, ny] = pathNormal(q, s.sunAz, s.sunEl, i, mode);
      g.strokeStyle = SUN; g.lineWidth = 1; g.globalAlpha = 0.9;
      g.beginPath(); g.moveTo(x - nx * 4, y - ny * 4); g.lineTo(x + nx * 4, y + ny * 4); g.stroke();
      g.globalAlpha = 1;
      if (dday % every === 0) label(g, dday ? String(dday) : 'day 0', x + nx * 13, y + ny * 13, MUTED);
    }
  }

  // ring labels along one spoke (south-south-west), clear of the cardinal spokes
  g.font = `9px ${MONO}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  const LA = 202.5;
  for (const [el, text] of RINGS[mode]) if (text) { const [x, y] = at(q, LA, el, mode); label(g, text, x, y, FAINT); }
  { const [x, y] = at(q, LA, 0, mode); label(g, '0° horizon', x, y, MUTED); }
  if (mode === 'zoom') { const [x, y] = at(q, 337.5, ZOOM_TOP, mode); label(g, `${ZOOM_TOP}° scale changes`, x + 34, y - 9, MUTED); } // on its own spoke, clear of the ring labels
  g.restore();

  g.strokeStyle = AXIS; g.lineWidth = 1; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
  g.font = `600 11px ${SANS}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = MUTED;
  for (const [name, az] of [['N', 0], ['E', 90], ['S', 180], ['W', 270]] as const) {
    const a = (az * Math.PI) / 180;
    g.fillText(name, cx - (R + 11) * Math.sin(a), cy - (R + 11) * Math.cos(a));
  }
  return q;
}

/** Sun and Earth at `hours` after landing (fractional), clipped where the terrain covers them. */
function drawBodies(g: G, q: Geom, m: SkyModel, hours: number) {
  const r = m.result;
  if (!r) return;
  const s = r.series, n = s.t.length, mode = m.mode;
  const h = Math.min(n - 1, Math.max(0, hours)), i0 = Math.floor(h), i1 = Math.min(n - 1, i0 + 1), f = h - i0;
  const mix = (v: ArrayLike<number>) => v[i0] * (1 - f) + v[i1] * f;
  const near = Math.round(h);
  const bodies = [
    { name: 'Earth', color: EARTH, az: lerpAz(s.earthAz[i0], s.earthAz[i1], f), el: mix(s.earthEl), rad: EARTH_R, on: s.earthVis[near] > 0, norm: pathNormal(q, s.earthAz, s.earthEl, near, mode) },
    { name: 'Sun', color: SUN, az: lerpAz(s.sunAz[i0], s.sunAz[i1], f), el: mix(s.sunEl), rad: mix(s.sunRadius), on: s.sunFrac[near] > 0, norm: pathNormal(q, s.sunAz, s.sunEl, near, mode) },
  ].map((b) => {
    const [x, y] = at(q, b.az, b.el, mode);
    return { ...b, x, y, pr: Math.max(3, b.rad * radialScale(b.el, mode) * q.R) };
  });
  const close = Math.hypot(bodies[0].x - bodies[1].x, bodies[0].y - bodies[1].y) < 34;

  g.font = `11px ${SANS}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const b of bodies) {
    const dx = b.x - q.cx, dy = b.y - q.cy, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
    if (len > q.R + b.pr) { // below the plot's floor: say so at the rim
      label(g, `${b.name} ${b.el.toFixed(0).replace('-', '−')}°`, q.cx + ux * (q.R - 26), q.cy + uy * (q.R - 12), FAINT);
      continue;
    }
    g.save();
    g.beginPath(); g.arc(q.cx, q.cy, q.R, 0, Math.PI * 2); g.clip();
    // whole disk, dim: where the body is even when terrain covers it
    g.beginPath(); g.arc(b.x, b.y, b.pr, 0, Math.PI * 2);
    g.fillStyle = b.color; g.globalAlpha = 0.16; g.fill();
    g.globalAlpha = 0.6; g.strokeStyle = b.color; g.lineWidth = 1; g.stroke();
    g.globalAlpha = 1;
    // the part in the open sky, solid
    if (q.open) { g.clip(q.open); g.beginPath(); g.arc(b.x, b.y, b.pr, 0, Math.PI * 2); g.fillStyle = b.color; g.fill(); }
    g.restore();
    // Names sit beside the path, on the side away from the day numbers; Earth's flips when the two bodies are close.
    const side = close && b.name === 'Earth' ? 1 : -1, d = b.pr + 11;
    const w = g.measureText(b.name).width / 2 + 2;
    const lx = Math.min(q.cx + q.R - w, Math.max(q.cx - q.R + w, b.x + b.norm[0] * d * side * (1 + (w - 8) / d * Math.abs(b.norm[0]))));
    label(g, b.name, lx, b.y + b.norm[1] * d * side, b.on ? FG : MUTED);
  }
}

/* ------------------------------------------------------------------ dialog */

const ICON = {
  play: '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2.5 1.2v9.6L10.5 6z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2.5 1.5h2.6v9H2.5zM6.9 1.5h2.6v9H6.9z" fill="currentColor"/></svg>',
  close: '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>',
};

const MARKUP = `
  <header class="sky-head">
    <div class="sky-title"><h2 id="sky-title">Sky from the site</h2><p id="sky-sub"></p></div>
    <div class="seg" role="group" aria-label="Sky scale">
      <button type="button" data-scale="zoom" aria-pressed="false" title="Stretch the band from 8° below to 12° above the horizon">Horizon zoom</button>
      <button type="button" data-scale="true" aria-pressed="false" title="Linear all-sky view">True sky</button>
    </div>
    <button type="button" id="sky-close" class="icon" aria-label="Close the sky view" title="Close (Esc)">${ICON.close}</button>
  </header>
  <div class="sky-main">
    <div class="sky-plot"><canvas id="sky-cv" role="img" aria-label="All-sky view"></canvas></div>
    <div class="sky-info">
      <dl>
        <div class="grp"><dt><i class="sw sun"></i>Sun</dt><dd id="sky-sun">–</dd></div>
        <div><dt>Elevation</dt><dd id="sky-sel">–</dd></div>
        <div><dt>Azimuth</dt><dd id="sky-saz">–</dd></div>
        <div><dt>Disk visible</dt><dd id="sky-disk">–</dd></div>
        <div title="Share of terrain-model draws in which some of the Sun is visible"><dt>Chance lit</dt><dd id="sky-plit">–</dd></div>
        <div class="grp"><dt><i class="sw earth"></i>Earth</dt><dd id="sky-earth">–</dd></div>
        <div><dt>Elevation</dt><dd id="sky-eel">–</dd></div>
        <div><dt>Azimuth</dt><dd id="sky-eaz">–</dd></div>
        <div class="grp wide"><dt>Deep Space Network</dt><dd id="sky-dsn">–</dd></div>
      </dl>
      <ul class="sky-key">
        <li><i class="ln"></i>in the open sky</li>
        <li><i class="ln dash"></i>behind terrain</li>
        <li><i class="ln tick"></i>each day after landing, on the Sun's path</li>
        <li><i class="ln land"></i>terrain, up to its horizon line</li>
      </ul>
    </div>
  </div>
  <footer class="sky-time">
    <button type="button" id="sky-play" class="icon play" aria-label="Play one lunar day" autofocus>${ICON.play}</button>
    <input id="sky-scrub" type="range" min="0" max="${STEPS - 1}" step="1" value="0" aria-label="Time after landing, hours">
    <output id="sky-t"></output>
  </footer>`;

/** Build the dialog (once) and keep it in step with the sky state, the inspector state and the scrubber. */
export function mountSky(d: InspectorDeps): void {
  const dlg = document.createElement('dialog');
  dlg.className = 'sky';
  dlg.setAttribute('role', 'dialog'); dlg.setAttribute('aria-modal', 'true'); dlg.setAttribute('aria-labelledby', 'sky-title');
  dlg.innerHTML = MARKUP;
  document.body.append(dlg);
  const $ = <T extends Element = HTMLElement>(s: string) => dlg.querySelector(s) as T;
  const cur = () => d.scenarios()[d.selected()];

  let model: SkyModel = { mode: 'zoom', durationDays: missionDays() }, q: Geom | undefined;
  let lastIdx = -1, lastPlaying: boolean | null = null;
  const plot = new Plot($<HTMLCanvasElement>('#sky-cv'),
    (g, W, H) => { q = drawSky(g, W, H, model); },
    (g) => { if (q) drawBodies(g, q, model, d.hours()); });

  /** Scenario, result, scale or mission length may have changed. */
  function refresh() {
    const sc = cur(), r = sc?.base, mode = shownScale(), days = missionDays();
    if (r !== model.result || mode !== model.mode || days !== model.durationDays) { model = { result: r, mode, durationDays: days }; plot.invalidate(); lastIdx = -1; }
    for (const b of dlg.querySelectorAll<HTMLElement>('[data-scale]')) b.setAttribute('aria-pressed', String(b.dataset.scale === mode));
    if (sc) {
      const L = LETTERS[d.selected()];
      $('#sky-sub').textContent = `${L} · ${d.name(sc)} · ${coord(sc.spec.lat, sc.spec.lon, 4)}${r ? '' : ' · computing the terrain horizon'}`;
      $('#sky-cv').setAttribute('aria-label', `All-sky view from scenario ${L}, ${d.name(sc)}: zenith at the centre, horizon as a ring, north up and east left. Terrain horizon, and the paths of the Sun and Earth over ${days} days after landing. The values are in the list beside it.`);
    }
    frame();
  }

  /** Scrubber moved: bodies every call, text when the hour changes. */
  function frame() {
    if (!dlg.open) return;
    plot.render();
    const sc = cur(), h = d.hours(), playing = d.playing();
    if (playing !== lastPlaying) {
      lastPlaying = playing;
      const b = $('#sky-play');
      b.innerHTML = playing ? ICON.pause : ICON.play;
      b.setAttribute('aria-label', playing ? 'Pause' : 'Play one lunar day');
    }
    const i = Math.round(h);
    if (!sc || i === lastIdx) return;
    lastIdx = i;
    const scrub = $<HTMLInputElement>('#sky-scrub');
    if (document.activeElement !== scrub || playing) scrub.value = String(i);
    scrub.setAttribute('aria-valuetext', `landing + ${dur(i)}`.replace('<1 h', '0 h'));
    $('#sky-t').textContent = `${`landing + ${dur(i)}`.replace('<1 h', '0 h')} · ${utc(sc.spec.t + i * 3600e3)}`;
    const r = sc.base;
    if (!r) return;
    const v = nowReadout(r, Math.min(i, r.series.t.length - 1));
    $('#sky-sun').textContent = r.series.sunFrac[Math.min(i, r.series.t.length - 1)] > 0 ? 'In view' : 'Hidden';
    $('#sky-sel').textContent = v.sunEl; $('#sky-saz').textContent = v.sunAz;
    $('#sky-disk').textContent = v.disk; $('#sky-plit').textContent = v.chanceLit;
    $('#sky-earth').textContent = v.earth;
    $('#sky-eel').textContent = v.earthEl; $('#sky-eaz').textContent = v.earthAz;
    $('#sky-dsn').textContent = v.dsn;
  }

  function sync() {
    if (state.open && !dlg.open) { dlg.showModal(); lastIdx = -1; lastPlaying = null; }
    else if (!state.open && dlg.open) { dlg.close(); document.getElementById('i-sky')?.focus({ preventScroll: true }); }
    refresh();
  }
  subs.add(() => { sync(); d.save(); });
  onInspectorChange(refresh);
  onInspectorPaint((what) => { if (dlg.open) what === 'all' ? refresh() : frame(); });

  // controls: each runs its action
  let downOnScrim = false; // a drag that starts inside (the slider) and ends on the scrim must not close the dialog
  dlg.addEventListener('pointerdown', (e) => { downOnScrim = e.target === dlg; });
  dlg.addEventListener('click', (e) => {
    const t = e.target as HTMLElement, s = t.closest<HTMLElement>('[data-scale]');
    if (s) void act('sky.open', { scale: s.dataset.scale });
    else if (t.closest('#sky-close') || (t === dlg && downOnScrim)) void act('sky.close'); // the dialog element itself = the scrim
    else if (t.closest('#sky-play')) setPlaying(!d.playing());
  });
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); void act('sky.close'); }); // Esc
  dlg.addEventListener('keydown', (e) => e.stopPropagation()); // the page's shortcuts (c, Esc for Compare) stay off while the dialog is open
  const scrub = $<HTMLInputElement>('#sky-scrub');
  scrub.addEventListener('input', () => { setPlaying(false); setTime(+scrub.value); });
  scrub.addEventListener('change', () => d.save());
  new ResizeObserver(() => { if (dlg.open) plot.render(); }).observe($('#sky-cv'));

  sync();
}
