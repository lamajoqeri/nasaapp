import { describe, expect, it } from 'vitest';
import { actions, register, run, schema } from '../ui/actions';
import { bindView3D, onView3dChange, view3dState, wantedRenderMode, type CameraState, type RenderMode, type View3DBinding } from './actions';

/** Stand-in for the mounted view: scenarios A, B in the region, C outside. */
function fakeView(): View3DBinding & { calls: string[] } {
  let mode: RenderMode = 'realistic', cam: CameraState = { preset: 'overview', scenario: null };
  const sites = [{ label: 'A', inRegion: true }, { label: 'B', inRegion: true }, { label: 'C', inRegion: false }];
  const calls: string[] = [];
  return {
    calls,
    region: () => 'shackleton_20m',
    renderMode: () => mode,
    setRenderMode: (m) => { mode = m; calls.push('render:' + m); },
    cameraState: () => cam,
    siteStates: () => sites,
    setCamera: (m, i) => { cam = m === 'site' ? { preset: 'stand-at-site', scenario: sites[i ?? 0].label } : { preset: 'overview', scenario: null }; calls.push(`camera:${m}:${i ?? ''}`); },
  };
}

describe('3D view actions', () => {
  it('registers render.set and camera.set with strict schemas', () => {
    for (const name of ['render.set', 'camera.set']) {
      const a = actions.get(name)!;
      expect(a, name).toBeDefined();
      expect(a.description.length).toBeGreaterThan(80);
      const s = a.schema as { type: string; properties: Record<string, { type: string; enum?: string[] }>; required: string[]; additionalProperties: boolean };
      expect(s.type).toBe('object');
      expect(s.additionalProperties).toBe(false);
      for (const r of s.required) expect(s.properties[r], `${name}.${r}`).toBeDefined();
      for (const p of Object.values(s.properties)) { expect(p.type).toBe('string'); expect(p.enum!.length).toBeGreaterThan(1); }
      expect(() => JSON.stringify(s)).not.toThrow();
    }
    expect((actions.get('render.set')!.schema as any).properties.mode.enum).toEqual(['realistic', 'clear']);
    expect((actions.get('camera.set')!.schema as any).properties.preset.enum).toEqual(['overview', 'stand-at-site']);
    expect((actions.get('camera.set')!.schema as any).properties.scenario.enum).toEqual(['A', 'B', 'C', 'D']);
    expect((actions.get('camera.set')!.schema as any).required).toEqual(['preset']);
  });

  it('remembers requests while unmounted, applies them on mount, and round-trips the state', async () => {
    let changes = 0;
    const off = onView3dChange(() => { changes++; });
    expect(view3dState()).toEqual({ mounted: false, region: null, renderMode: 'realistic', camera: { preset: 'overview', scenario: null } });
    expect(await run('render.set', { mode: 'clear' })).toMatchObject({ mode: 'clear' });
    expect(wantedRenderMode()).toBe('clear');
    expect(await run('camera.set', { preset: 'stand-at-site', scenario: 'B' })).toMatchObject({ preset: 'stand-at-site', scenario: 'B', pending: true });
    expect(view3dState()).toEqual({ mounted: false, region: null, renderMode: 'clear', camera: { preset: 'stand-at-site', scenario: 'B' } });
    expect(changes).toBe(2);

    const v = fakeView();
    bindView3D(v);
    expect(v.calls).toEqual(['render:clear', 'camera:site:1']);
    expect(view3dState()).toEqual({ mounted: true, region: 'shackleton_20m', renderMode: 'clear', camera: { preset: 'stand-at-site', scenario: 'B' } });
    expect(JSON.parse(JSON.stringify(view3dState()))).toEqual(view3dState()); // plain JSON

    expect(await run('render.set', { mode: 'realistic' })).toMatchObject({ mode: 'realistic' });
    expect(view3dState().renderMode).toBe('realistic');
    expect(await run('camera.set', { preset: 'overview' })).toMatchObject({ preset: 'overview', scenario: null });
    expect(await run('camera.set', { preset: 'stand-at-site' })).toMatchObject({ preset: 'stand-at-site', scenario: 'A' }); // first in region
    expect(await run('camera.set', { preset: 'stand-at-site', scenario: 'B' })).toMatchObject({ preset: 'stand-at-site', scenario: 'B' });

    // Outside the region: the action fails (the model sees is_error) and the camera stays put.
    await expect(run('camera.set', { preset: 'stand-at-site', scenario: 'C' })).rejects.toThrow(/outside the 3D region/);
    expect(view3dState().camera).toEqual({ preset: 'stand-at-site', scenario: 'B' });
    await expect(run('camera.set', { preset: 'stand-at-site', scenario: 'D' })).rejects.toThrow(/no scenario D/);

    // With the app shell's view.set registered, camera.set brings the 3D stage on screen first.
    const shown: unknown[] = [];
    register({ name: 'view.set', description: '', schema: schema({ mode: { type: 'string' } }), run: async (a) => { shown.push(a); } });
    await run('camera.set', { preset: 'stand-at-site', scenario: 'B' });
    expect(shown).toEqual([{ mode: '3d' }]);
    actions.delete('view.set');

    bindView3D(undefined);
    expect(view3dState()).toEqual({ mounted: false, region: null, renderMode: 'realistic', camera: { preset: 'stand-at-site', scenario: 'B' } });
    off();
  });

  it('rejects malformed arguments', async () => {
    await expect(run('render.set', {})).rejects.toThrow(/mode/);
    await expect(run('render.set', { mode: 'pretty' })).rejects.toThrow(/mode/);
    await expect(run('render.set', { mode: 'clear', extra: 1 })).rejects.toThrow(/unknown argument/);
    await expect(run('render.set', 'clear')).rejects.toThrow(/object/);
    await expect(run('camera.set', {})).rejects.toThrow(/preset/);
    await expect(run('camera.set', { preset: 'orbit' })).rejects.toThrow(/preset/);
    await expect(run('camera.set', { preset: 'stand-at-site', scenario: 'E' })).rejects.toThrow(/scenario/);
    await expect(run('camera.set', { preset: 'stand-at-site', scenario: 1 })).rejects.toThrow(/scenario/);
    await expect(run('camera.set', { preset: 'overview', site: 'A' })).rejects.toThrow(/unknown argument/);
  });
});
