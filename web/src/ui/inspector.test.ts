import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ScenarioResult } from '../core/api';
import { actions } from './actions';
import { rows } from './format';
import {
  bindInspector, inspectorState, metricsTable, missionDays, nowReadout, onInspectorChange, readHash, verdictsOf, verdictSummary, writeHash, type InspectorDeps,
} from './inspector';
import './sky';
import { realResult } from './test-fixture';

const run = (name: string, args?: unknown) => actions.get(name)!.run(args);
let real: ScenarioResult;
beforeAll(async () => { real = await realResult(); });
beforeEach(() => {
  bindInspector({ scenarios: () => [{ base: real }, {}] as never, selected: () => 0 } as unknown as InspectorDeps);
  readHash(new URLSearchParams(''));
});

describe('action registry', () => {
  it('the four Effort 2 inspector actions are registered with strict, valid schemas', () => {
    for (const name of ['inspector.details', 'sky.open', 'sky.close', 'chart.set']) {
      const a = actions.get(name)!;
      expect(a, name).toBeDefined();
      expect(a.name).toBe(name);
      expect(a.description.length, name).toBeGreaterThan(10);
      const s = a.schema as { type: string; properties: Record<string, { type: string; enum?: unknown[] }>; required: string[]; additionalProperties: boolean };
      expect(s.type).toBe('object');
      expect(s.additionalProperties).toBe(false);
      expect(Array.isArray(s.required)).toBe(true);
      for (const k of s.required) expect(s.properties[k], `${name}.${k}`).toBeDefined();
      for (const p of Object.values(s.properties)) expect(['string', 'number', 'boolean']).toContain(p.type);
      expect(() => JSON.stringify(s)).not.toThrow();
    }
    expect(actions.get('inspector.details')!.schema.required).toEqual(['open']);
    const c = actions.get('chart.set')!.schema.properties as unknown as Record<string, { enum: unknown[] }>;
    expect(c.metric.enum).toEqual(['power', 'elevation']);
    expect(c.durationDays.enum).toEqual([7, 14, 29.5]);
  });
});

describe('chart.set', () => {
  it('defaults: power over 14 days', () => {
    expect(inspectorState().chart).toEqual({ metric: 'power', durationDays: 14 });
    expect(missionDays()).toBe(14);
  });
  it('changes the metric, the duration, or both, and returns the new state', async () => {
    const r = await run('chart.set', { metric: 'elevation' }) as { metric: string; durationDays: number; verdicts: unknown[] };
    expect(r).toMatchObject({ metric: 'elevation', durationDays: 14 });
    expect(r.verdicts).toEqual(inspectorState().verdicts);
    expect(inspectorState().chart.metric).toBe('elevation');
    await run('chart.set', { durationDays: 29.5 });
    expect(inspectorState().chart).toEqual({ metric: 'elevation', durationDays: 29.5 });
    await run('chart.set', { metric: 'power', durationDays: 7 });
    expect(inspectorState().chart).toEqual({ metric: 'power', durationDays: 7 });
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });
  it('rejects values outside the schema and leaves the state alone', async () => {
    await expect(run('chart.set', {})).rejects.toThrow();
    await expect(run('chart.set', { metric: 'heat' })).rejects.toThrow(/metric/);
    await expect(run('chart.set', { durationDays: 10 })).rejects.toThrow(/durationDays/);
    await expect(run('chart.set', { durationDays: '14' })).rejects.toThrow();
    await expect(run('chart.set', { metric: 'power', extra: 1 })).rejects.toThrow(/unknown argument/);
    await expect(run('chart.set', 'power')).rejects.toThrow();
    expect(inspectorState().chart).toEqual({ metric: 'power', durationDays: 14 });
  });
  it('notifies subscribers only on a real change', async () => {
    let n = 0;
    const off = onInspectorChange(() => n++);
    await run('chart.set', { metric: 'power' });      // already power
    expect(n).toBe(0);
    await run('chart.set', { metric: 'elevation' });
    expect(n).toBe(1);
    off();
    await run('chart.set', { metric: 'power' });
    expect(n).toBe(1);
  });
});

describe('inspector.details', () => {
  it('opens and closes', async () => {
    expect(inspectorState().detailsOpen).toBe(false);
    expect(await run('inspector.details', { open: true })).toEqual({ detailsOpen: true });
    expect(inspectorState().detailsOpen).toBe(true);
    await run('inspector.details', { open: false });
    expect(inspectorState().detailsOpen).toBe(false);
  });
  it('needs a boolean', async () => {
    await expect(run('inspector.details', {})).rejects.toThrow();
    await expect(run('inspector.details', { open: 'yes' })).rejects.toThrow();
    await expect(run('inspector.details')).rejects.toThrow();
    expect(inspectorState().detailsOpen).toBe(false);
  });
});

describe('state for snapshot()', () => {
  it('lists each scenario\'s verdicts, null until it has results, and follows the mission length', async () => {
    const s = inspectorState();
    expect(s.verdicts.map((v) => v.scenario)).toEqual(['A', 'B']);
    expect(s.verdicts[1]).toEqual({ scenario: 'B', power: null, comms: null });
    const v = verdictsOf(real, 14);
    expect(s.verdicts[0]).toEqual({ scenario: 'A', power: { level: v.power.level, detail: v.power.detail }, comms: { level: v.comms.level, detail: v.comms.detail, basis: 'dsn' } });
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    await run('chart.set', { durationDays: 29.5 });
    const full = verdictsOf(real, 29.5);
    expect(inspectorState().verdicts[0].power).toEqual({ level: full.power.level, detail: full.power.detail });
    expect(full.power.survivalHours).toBe(real.mission.battery.survivalH); // the whole lunar day = the Details battery row
  });
  it('is empty but valid before the app is bound', () => {
    bindInspector(null);
    expect(inspectorState()).toEqual({ chart: { metric: 'power', durationDays: 14 }, detailsOpen: false, verdicts: [] });
  });
  it('round-trips through the URL hash, leaving defaults out', async () => {
    const p = new URLSearchParams();
    writeHash(p);
    expect(p.toString()).toBe('');
    await run('chart.set', { metric: 'elevation', durationDays: 29.5 });
    await run('inspector.details', { open: true });
    writeHash(p);
    expect(p.toString()).toBe('cm=elevation&cd=29.5&det=1');
    readHash(new URLSearchParams('cm=zzz&cd=3'));
    expect(inspectorState()).toMatchObject({ chart: { metric: 'power', durationDays: 14 }, detailsOpen: false });
    readHash(p);
    expect(inspectorState()).toMatchObject({ chart: { metric: 'elevation', durationDays: 29.5 }, detailsOpen: true });
  });
});

describe('shared formatting', () => {
  it('nowReadout gives the values the inspector and the sky pop-up both show', () => {
    const s = real.series;
    for (const i of [0, 100, 707]) {
      const r = nowReadout(real, i);
      expect(r.sunEl).toBe(`${s.sunEl[i].toFixed(1)}°`);
      expect(r.earthVisible).toBe(!!s.earthVis[i]);
      expect(r.earth).toBe(s.earthVis[i] ? 'In view' : 'Hidden');
      expect(r.disk).toMatch(/^(<1|\d+)%$/);
      expect(r.chanceLit).toMatch(/^\d+%$/);
      expect(r.sunAz).toMatch(/^\d+°$/);
      if (!s.earthVis[i]) expect(r.dsn).toBe('no link while Earth is hidden');
      else expect(r.dsn).toMatch(/^(link via|no station can see the Moon)/);
    }
    expect(nowReadout({ ...real, uncertainty: null }, 0).chanceLit).toBe('–');
    expect(nowReadout({ ...real, mission: { ...real.mission, commsHours: null } }, 0).dsn).toBe('no station data for this era');
  });
  it('metricsTable: placeholder rows before results, a delta column with a slip', () => {
    const empty = metricsTable(undefined, 0);
    expect(empty.match(/<tr>/g)!.length).toBe(10);
    expect(empty).toContain('<td>–</td>');
    const r = rows(real.metrics, real.uncertainty, real.mission), c = rows(real.metrics, null, real.mission);
    const plain = metricsTable({ rows: r, cmp: c, srows: undefined, slipError: '' }, 0);
    expect(plain).not.toContain('Delayed');
    expect(plain.match(/<tr>/g)!.length).toBe(10);
    const slipped = metricsTable({ rows: r, cmp: c, srows: c, slipError: '' }, 21);
    expect(slipped).toContain('<th>Delayed 21 d</th>');
    expect(slipped).toContain('class="d same"');           // identical rows: no change
    expect(metricsTable({ rows: r, cmp: c, srows: undefined, slipError: '' }, 21)).toContain('class="d pending">…');
    expect(metricsTable({ rows: r, cmp: c, srows: undefined, slipError: 'x' }, 21)).toContain('n/a');
  });
  it('verdictSummary is a full sentence for the summary marks', () => {
    expect(verdictSummary('B', null)).toBe('Scenario B: not computed yet');
    const t = verdictSummary('A', verdictsOf(real, 14));
    expect(t).toMatch(/^Scenario A: power (OK|Marginal|No) \(.+\); comms (OK|Gaps|No) \(.+; Deep Space Network contact\)$/);
  });
});
