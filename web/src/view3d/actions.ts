// Actions of the 3D view (docs/V2-DESIGN.md): `render.set` and `camera.set`. The overlay buttons and the
// AI agent both go through these. No three.js / CSS imports: the app shell imports this statically so the
// actions exist before (and whether or not) the lazily loaded view is on screen; requests made while the
// view is not mounted are remembered and applied when it is.
import { actions, register, run, type JSONSchema } from '../ui/actions';

export type RenderMode = 'realistic' | 'clear';
export type CameraPreset = 'overview' | 'stand-at-site';
export interface CameraState { preset: CameraPreset; scenario: string | null }
export interface View3DState { mounted: boolean; region: string | null; renderMode: RenderMode; camera: CameraState }

/** The slice of the view handle the actions drive (mount3D binds itself once its first region is up). */
export interface View3DBinding {
  region(): string;
  renderMode(): RenderMode;
  setRenderMode(mode: RenderMode): void;
  cameraState(): CameraState;
  /** The host's scenarios, in order: letter and whether its site lies in the region shown. */
  siteStates(): { label: string; inRegion: boolean }[];
  setCamera(mode: 'orbit' | 'site', siteIndex?: number): void;
}

const RENDER_MODES: RenderMode[] = ['realistic', 'clear'];
const PRESETS: CameraPreset[] = ['overview', 'stand-at-site'];
const LETTERS = ['A', 'B', 'C', 'D'];

const want: { renderMode: RenderMode; camera: CameraState } = { renderMode: 'realistic', camera: { preset: 'overview', scenario: null } };
let view: View3DBinding | undefined;
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((f) => f());

/** Plain JSON for snapshot(): what the 3D view shows, or will show once mounted. */
export function view3dState(): View3DState {
  return {
    mounted: !!view,
    region: view ? view.region() : null,
    renderMode: view ? view.renderMode() : want.renderMode,
    camera: view ? view.cameraState() : { ...want.camera },
  };
}
/** Called after every render-mode or camera change made through an action (e.g. to store it in the URL). */
export function onView3dChange(f: () => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** Throws when the camera cannot stand where asked; it then stays put. */
function applyCamera(v: View3DBinding, preset: CameraPreset, scenario: string | undefined): CameraState {
  if (preset === 'overview') {
    v.setCamera('orbit');
    return v.cameraState();
  }
  const sites = v.siteStates(), cur = v.cameraState();
  let i: number;
  if (scenario !== undefined) {
    i = sites.findIndex((s) => s.label === scenario);
    if (i < 0) throw new Error(`There is no scenario ${scenario}.`);
    if (!sites[i].inRegion) throw new Error(`Scenario ${scenario} is outside the 3D region shown (${v.region()}), so the camera cannot stand there. Select that scenario first to switch region.`);
  } else {
    i = sites.findIndex((s) => s.inRegion && s.label === cur.scenario);
    if (i < 0) i = sites.findIndex((s) => s.inRegion);
    if (i < 0) throw new Error(`No scenario lies inside the 3D region shown (${v.region()}).`);
  }
  v.setCamera('site', i);
  return v.cameraState();
}

/** mount3D calls this when the view can take commands (and with undefined when it is destroyed). */
export function bindView3D(v: View3DBinding | undefined): void {
  view = v;
  if (!v) return;
  v.setRenderMode(want.renderMode);
  if (want.camera.preset === 'stand-at-site') try { applyCamera(v, 'stand-at-site', want.camera.scenario ?? undefined); } catch { /* best effort: stays on the overview */ }
  changed();
}
/** Render mode the view should start in. */
export const wantedRenderMode = (): RenderMode => want.renderMode;

const obj = (a: unknown, allowed: string[]): Record<string, unknown> => {
  if (typeof a !== 'object' || a === null || Array.isArray(a)) throw new Error('arguments must be an object');
  for (const k of Object.keys(a)) if (!allowed.includes(k)) throw new Error(`unknown argument "${k}"`);
  return a as Record<string, unknown>;
};

export const renderSetSchema: JSONSchema = {
  type: 'object',
  properties: { mode: { type: 'string', enum: RENDER_MODES, description: 'realistic = Sun-only lighting with black shadows; clear = relief-map style with shadows lifted and tinted cool.' } },
  required: ['mode'],
  additionalProperties: false,
};
export const cameraSetSchema: JSONSchema = {
  type: 'object',
  properties: {
    preset: { type: 'string', enum: PRESETS, description: 'overview = orbiting view of the region; stand-at-site = ground-level view from a scenario site.' },
    scenario: { type: 'string', enum: LETTERS, description: 'Scenario letter to stand at (stand-at-site only). Omit to use the current or first scenario in the region.' },
  },
  required: ['preset'],
  additionalProperties: false,
};

register<{ mode: RenderMode }>({
  name: 'render.set',
  description: 'Set how the 3D terrain is drawn. "realistic": lit only by the Sun, ray-marched shadows are black, as a camera would see it. '
    + '"clear": a relief-map rendering for reading terrain and lighting at a glance; sunlit ground is warm, ground in shadow is lifted to a cool blue-grey '
    + 'with hillshading, and the shadow boundary is the same physically computed one. Does not change any number. Returns { mode }. '
    + 'If the 3D view is not on screen (map shown or still loading) the mode is applied when it appears.',
  schema: renderSetSchema,
  async run(args) {
    const { mode } = obj(args, ['mode']);
    if (!RENDER_MODES.includes(mode as RenderMode)) throw new Error('mode must be "realistic" or "clear"');
    want.renderMode = mode as RenderMode;
    view?.setRenderMode(want.renderMode);
    changed();
    return { summary: `3D render mode: ${want.renderMode}`, mode: want.renderMode };
  },
});

register<{ preset: CameraPreset; scenario?: string }>({
  name: 'camera.set',
  description: 'Move the 3D camera. preset "overview": the orbiting oblique view of the region shown. preset "stand-at-site": stand at a scenario\'s site at mast '
    + 'height, facing the Sun\'s azimuth, with the Sun and Earth drawn at their true positions; pass "scenario" (letter A to D) to choose the site. '
    + 'Switches the stage to the 3D view if the map is showing. Returns { preset, scenario } as now shown. Fails, without moving the camera, if the scenario '
    + 'is outside the 3D region shown. If the 3D view is still loading the request is applied when it appears (result has pending: true).',
  schema: cameraSetSchema,
  async run(args) {
    const a = obj(args, ['preset', 'scenario']);
    if (!PRESETS.includes(a.preset as CameraPreset)) throw new Error('preset must be "overview" or "stand-at-site"');
    if (a.scenario !== undefined && !LETTERS.includes(a.scenario as string)) throw new Error('scenario must be one of A, B, C, D');
    const preset = a.preset as CameraPreset, scenario = preset === 'stand-at-site' ? (a.scenario as string | undefined) : undefined;
    if (actions.has('view.set')) await run('view.set', { mode: '3d' }); // the app shell's action: brings the 3D stage on screen
    if (!view) {
      want.camera = { preset, scenario: scenario ?? null };
      changed();
      return { summary: 'Camera request saved; it applies when the 3D view is shown', ...want.camera, pending: true };
    }
    const res = applyCamera(view, preset, scenario);
    want.camera = { preset: res.preset, scenario: res.scenario };
    changed();
    const summary = res.preset === 'overview' ? 'Camera: overview' : `Camera: standing at scenario ${res.scenario}`;
    return { summary, ...res };
  },
});
