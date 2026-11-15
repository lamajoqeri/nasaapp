import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { runTurn } from './loop';

/** A client whose stream yields `msg`, or throws `err`. */
const fake = (msg: Partial<Anthropic.Message>, err?: Error) => ({
  messages: { stream: () => ({ on() {}, finalMessage: async () => { if (err) throw err; return msg; } }) },
}) as unknown as Anthropic;
const ui = { text() {}, tool: () => () => {}, notice() {} };
const prior = (): Anthropic.MessageParam[] => [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }];

describe('runTurn history', () => {
  it('keeps a finished turn', async () => {
    const h = prior();
    await runTurn(fake({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok', citations: null }] }), '', h, 'q', ui, new AbortController().signal);
    expect(h.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });
  it('drops the turn on a refusal', async () => {
    const h = prior();
    await runTurn(fake({ stop_reason: 'refusal', content: [] }), '', h, 'q', ui, new AbortController().signal);
    expect(h).toEqual(prior());
  });
  it('drops the turn on an error, keeps it after a stop', async () => {
    const h = prior();
    await expect(runTurn(fake({}, new Error('boom')), '', h, 'q', ui, new AbortController().signal)).rejects.toThrow('boom');
    expect(h).toEqual(prior());
    const ac = new AbortController(); ac.abort();
    await expect(runTurn(fake({}, new Error('aborted')), '', h, 'q', ui, ac.signal)).rejects.toThrow();
    expect(h.at(-1)).toEqual({ role: 'user', content: 'q' });
  });
});
