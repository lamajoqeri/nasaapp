import { beforeEach, describe, expect, it } from 'vitest';
import { actions } from './actions';
import { bindInspector, type InspectorDeps } from './inspector';
import { defaultSkyMode, lerpAz, radialScale, readHash, scenarioIndex, SKY_FLOOR, skyRadius, skyState, skyXY, writeHash, ZOOM_CORE, ZOOM_TOP, type SkyMode } from './sky';

const MODES: SkyMode[] = ['true', 'zoom'];
const run = (name: string, args?: unknown) => actions.get(name)!.run(args);

describe('skyRadius', () => {
  it('is 0 at the zenith, 1 at the floor, and the horizon is inside the plot', () => {
    for (const m of MODES) {
      expect(skyRadius(90, m)).toBe(0);
      expect(skyRadius(SKY_FLOOR[m], m)).toBeCloseTo(1, 12);
      expect(skyRadius(0, m)).toBeGreaterThan(0.5);
      expect(skyRadius(0, m)).toBeLessThan(1);
      expect(skyRadius(-20, m)).toBeGreaterThan(1);        // below the floor keeps going outward
      expect(skyRadius(95, m)).toBe(0);                    // clamped
    }
  });
  it('is strictly decreasing in elevation', () => {
    for (const m of MODES) {
      let prev = skyRadius(-30, m);
      for (let el = -29.9; el <= 90; el += 0.1) { const r = skyRadius(el, m); expect(r).toBeLessThan(prev); prev = r; }
    }
  });
  it('is continuous, including across the zoom knee', () => {
    for (const m of MODES) {
      for (let el = -30; el < 90; el += 0.05) expect(Math.abs(skyRadius(el + 0.001, m) - skyRadius(el, m))).toBeLessThan(1e-3);
      expect(skyRadius(ZOOM_TOP - 1e-9, m)).toBeCloseTo(skyRadius(ZOOM_TOP + 1e-9, m), 6);
    }
    expect(skyRadius(ZOOM_TOP, 'zoom')).toBeCloseTo(ZOOM_CORE, 12);
  });
  it('true sky is linear in angle; horizon zoom gives the −8°..+12° band most of the radius', () => {
    expect(skyRadius(45, 'true')).toBeCloseTo(skyRadius(0, 'true') / 2, 12);
    expect(skyRadius(-8, 'zoom') - skyRadius(12, 'zoom')).toBeCloseTo(0.8, 12);
    expect(skyRadius(-8, 'true') - skyRadius(12, 'true')).toBeCloseTo(0.2, 12);
  });
  it('radialScale is the slope of skyRadius', () => {
    for (const m of MODES) for (const el of [-5, 0, 5, 40, 80]) {
      expect(radialScale(el, m)).toBeCloseTo((skyRadius(el - 0.01, m) - skyRadius(el + 0.01, m)) / 0.02, 6);
    }
    expect(radialScale(0, 'zoom') / radialScale(0, 'true')).toBeCloseTo(4, 6);
  });
});

describe('skyXY', () => {
  it('north is up and east is to the left (looking up at the sky)', () => {
    for (const m of MODES) {
      const n = skyXY(0, 0, m), e = skyXY(90, 0, m), s = skyXY(180, 0, m), w = skyXY(270, 0, m);
      expect(n[1]).toBeLessThan(0); expect(n[0]).toBeCloseTo(0, 12);
      expect(e[0]).toBeLessThan(0); expect(e[1]).toBeCloseTo(0, 12);
      expect(s[1]).toBeGreaterThan(0);
      expect(w[0]).toBeGreaterThan(0);
      expect(skyXY(123, 90, m).map(Math.abs)).toEqual([0, 0]);   // the zenith is the centre
      expect(Math.hypot(...skyXY(77, 3, m))).toBeCloseTo(skyRadius(3, m), 12);
    }
  });
});

describe('helpers', () => {
  it('default scale: horizon zoom when the Sun stays under 15°', () => {
    expect(defaultSkyMode([-1, 0.5, 1.6])).toBe('zoom');
    expect(defaultSkyMode([-60, 14.9])).toBe('zoom');
    expect(defaultSkyMode([-60, 15])).toBe('true');
    expect(defaultSkyMode([10, 80])).toBe('true');
  });
  it('scenarioIndex takes a letter or a position', () => {
    expect(scenarioIndex('A', 2)).toBe(0);
    expect(scenarioIndex(' b ', 2)).toBe(1);
    expect(scenarioIndex('2', 2)).toBe(1);
    expect(() => scenarioIndex('C', 2)).toThrow(/no scenario C/);
    expect(() => scenarioIndex('E', 4)).toThrow();
    expect(() => scenarioIndex('', 4)).toThrow();
  });
  it('lerpAz takes the short way round north', () => {
    expect(lerpAz(350, 10, 0.5)).toBeCloseTo(0, 9);
    expect(lerpAz(10, 350, 0.25)).toBeCloseTo(5, 9);
    expect(lerpAz(100, 110, 0.5)).toBeCloseTo(105, 9);
  });
});

describe('sky actions', () => {
  let selected = 0;
  const picks: number[] = [];
  beforeEach(async () => {
    selected = 0; picks.length = 0;
    bindInspector({
      scenarios: () => [{}, {}, {}] as never, selected: () => selected, select: (i: number) => { selected = i; picks.push(i); },
    } as unknown as InspectorDeps);
    readHash(new URLSearchParams(''));
  });

  it('are registered with strict schemas', () => {
    for (const name of ['sky.open', 'sky.close']) {
      const a = actions.get(name)!;
      expect(a, name).toBeDefined();
      expect(a.description.length).toBeGreaterThan(10);
      expect(a.schema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(a.schema.properties).toBeTypeOf('object');
      expect(Array.isArray(a.schema.required)).toBe(true);
    }
    expect(Object.keys(actions.get('sky.open')!.schema.properties as object)).toEqual(['scenario', 'scale']);
    expect(Object.keys(actions.get('sky.close')!.schema.properties as object)).toEqual([]);
  });

  it('open and close change skyState and return it', async () => {
    expect(skyState()).toMatchObject({ open: false, scenario: 'A', scale: 'zoom', scaleIsDefault: true });
    const r = await run('sky.open', {});
    expect(r).toEqual(skyState());
    expect(skyState().open).toBe(true);
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);       // plain JSON
    await run('sky.close', {});
    expect(skyState().open).toBe(false);
    await run('sky.close');                                 // idempotent, no args
    expect(skyState().open).toBe(false);
  });

  it('open selects the scenario first and can set the scale', async () => {
    await run('sky.open', { scenario: 'C', scale: 'true' });
    expect(picks).toEqual([2]);
    expect(skyState()).toMatchObject({ open: true, scenario: 'C', scale: 'true', scaleIsDefault: false });
    await run('sky.open', { scenario: 'c' });               // already selected: no second select
    expect(picks).toEqual([2]);
    await run('sky.open', { scale: 'zoom' });
    expect(skyState().scale).toBe('zoom');
  });

  it('rejects bad arguments without changing state', async () => {
    await expect(run('sky.open', { scenario: 'D' })).rejects.toThrow(/no scenario D/);
    await expect(run('sky.open', { scenario: 'Z' })).rejects.toThrow();
    await expect(run('sky.open', { scale: 'big' })).rejects.toThrow();
    await expect(run('sky.open', { nope: 1 })).rejects.toThrow(/unknown argument/);
    await expect(run('sky.close', { x: 1 })).rejects.toThrow();
    expect(skyState().open).toBe(false);
    expect(picks).toEqual([]);
  });

  it('round-trips through the URL hash', async () => {
    await run('sky.open', { scale: 'true' });
    const p = new URLSearchParams();
    writeHash(p);
    expect(p.toString()).toBe('sky=1&ss=true');
    readHash(new URLSearchParams(''));
    expect(skyState()).toMatchObject({ open: false, scaleIsDefault: true });
    readHash(p);
    expect(skyState()).toMatchObject({ open: true, scale: 'true' });
    const q = new URLSearchParams();
    readHash(new URLSearchParams('ss=bogus'));
    writeHash(q);
    expect(q.toString()).toBe('');
  });
});
