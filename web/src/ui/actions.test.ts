import { beforeEach, describe, expect, it } from 'vitest';
import { actions, register, run, schema, setSnapshot, snapshot, tools } from './actions';

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

  it('generates strict tool definitions', () => {
    const [t] = tools();
    expect(t.name).toBe('scenario_nudge');
    expect(t.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(t.strict).toBe(true);
    expect(t.input_schema.additionalProperties).toBe(false);
    expect(t.input_schema.required).toEqual(['id', 'dir', 'm']);
    expect(t.description).toBe('Move a scenario.');
  });

  it('snapshot comes from the provider', () => {
    setSnapshot(() => ({ tab: 'mission' }));
    expect(snapshot()).toEqual({ tab: 'mission' });
  });
});
