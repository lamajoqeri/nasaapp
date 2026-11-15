import { beforeEach, describe, expect, it } from 'vitest';
import { actions, register, run, schema, setSnapshot, snapshot, tools, utcTime } from './actions';

describe('action registry', () => {
  beforeEach(() => {
    actions.clear();
    register({
      name: 'scenario.nudge', description: 'Move a scenario.',
      schema: schema({ id: { type: 'string' }, dir: { type: 'string', enum: ['N', 'E', 'S', 'W'] }, m: { type: 'number' }, quiet: { type: 'boolean' } }, ['id', 'dir', 'm']),
      run: async (a) => ({ moved: a.m }),
    });
  });

  it('runs by dotted name and by tool name', async () => {
    expect(await run('scenario.nudge', { id: 'A', dir: 'N', m: 100 })).toEqual({ moved: 100 });
    expect(await run('scenario_nudge', { id: 'A', dir: 'N', m: 100 })).toEqual({ moved: 100 });
  });

  it('rejects unknown actions and invalid arguments', async () => {
    await expect(run('nope')).rejects.toThrow(/Unknown action/);
    await expect(run('scenario.nudge', { id: 'A', dir: 'N' })).rejects.toThrow(/missing required argument "m"/);
    await expect(run('scenario.nudge', { id: 'A', dir: 'up', m: 1 })).rejects.toThrow(/one of N, E, S, W/);
    await expect(run('scenario.nudge', { id: 'A', dir: 'N', m: '100' })).rejects.toThrow(/"m" must be a number/);
    await expect(run('scenario.nudge', { id: 'A', dir: 'N', m: 1, extra: 1 })).rejects.toThrow(/unknown argument "extra"/);
    await expect(run('scenario.nudge', [])).rejects.toThrow(/must be an object/);
  });

  it('refuses names that cannot become tool names', () => {
    expect(() => register({ name: 'bad name', description: '', schema: schema(), run: async () => 0 })).toThrow();
  });

  it('reports errors under the tool name', async () => {
    register({ name: 'chart.set', description: '', schema: schema(), run: async () => { throw new Error('chart.set: bad; see scenario.nudge'); } });
    await expect(run('chart.set')).rejects.toThrow('chart_set: bad; see scenario_nudge');
  });

  it('reads UTC times strictly', () => {
    const t = Date.UTC(2027, 2, 2, 12);
    for (const s of ['2027-03-02T12:00Z', '2027-03-02T12:00', '2027-03-02 12:00', '2027-03-02T14:00+02:00', ' 2027-03-02T12:00:00.000Z ']) expect(utcTime(s)).toBe(t);
    expect(utcTime('2027-03-02')).toBe(Date.UTC(2027, 2, 2));
    for (const s of ['March 2027', '03/02/2027', '2027', 'tomorrow', '']) expect(() => utcTime(s)).toThrow(/ISO 8601/);
  });

  it('generates tool definitions without strict mode', () => {
    const [t] = tools();
    expect(t.name).toBe('scenario_nudge');
    expect(t.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(t).not.toHaveProperty('strict'); // the API caps strict tools (20) and optional parameters (24) per request
    expect(t.input_schema.additionalProperties).toBe(false);
    expect(t.input_schema.required).toEqual(['id', 'dir', 'm']);
    expect(t.description).toBe('Move a scenario.');
  });

  it('snapshot comes from the provider', () => {
    setSnapshot(() => ({ tab: 'mission' }));
    expect(snapshot()).toEqual({ tab: 'mission' });
  });
});
