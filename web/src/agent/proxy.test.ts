// The Vercel function in web/api, driven by the real SDK and the real agent loop. Upstream fetch is stubbed.
import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import proxy, { CALLS_PER_HOUR, invalid, MAX_BODY, MAX_TOKENS, MODEL, wait } from '../../api/v1/messages';
import { explain, MODEL as APP_MODEL } from './client';
import { runTurn } from './loop';

const BASE = 'https://site.test/api';
const sse = (...events: object[]) => events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const head = sse(
  { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
);
const tail = sse(
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
  { type: 'message_stop' },
);

/** An SDK client whose requests go to the function, as from a browser at `ip` with a key of its own. */
const client = (ip: string, seen: Request[] = []) => new Anthropic({
  apiKey: 'sk-visitor', baseURL: BASE, dangerouslyAllowBrowser: true,
  defaultHeaders: { 'anthropic-beta': 'some-beta', 'x-real-ip': ip },
  fetch: async (url, init) => { const r = new Request(url, init); seen.push(r.clone()); return proxy.fetch(r); },
});
const post = (body: unknown, path = '/v1/messages') => proxy.fetch(new Request(BASE + path, { method: 'POST', body: JSON.stringify(body) }));
const ok = { model: MODEL, max_tokens: MAX_TOKENS, messages: [{ role: 'user', content: 'hi' }], stream: true };
const ui = { text() {}, tool: () => () => {}, notice() {} };

let upstream: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-owner');
  upstream = vi.fn();
  vi.stubGlobal('fetch', upstream);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('proxy', () => {
  it('accepts exactly what the app sends', () => {
    expect(MODEL).toBe(APP_MODEL);
    expect(invalid(ok)).toBe('');
    expect(invalid({ ...ok, model: 'claude-fable-5-2' })).toMatch(/Only claude-opus-5-5/);
    expect(invalid({ ...ok, max_tokens: MAX_TOKENS + 1 })).toMatch(/max_tokens/);
    expect(invalid({ ...ok, speed: 'fast' })).toMatch(/"speed"/);
    expect(invalid({ ...ok, tools: [{ name: 'a', input_schema: {} }, { type: 'web_search_20260209', name: 'web_search' }] })).toMatch(/server tools/);
    expect(invalid(null)).toMatch(/JSON object/);
  });

  it('streams a turn through with the owner key and none of the visitor headers', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const enc = new TextEncoder();
    upstream.mockResolvedValue(new Response(new ReadableStream({
      async start(c) { c.enqueue(enc.encode(head)); await gate; c.enqueue(enc.encode(tail)); c.close(); },
    }), { headers: { 'content-type': 'text/event-stream' } }));

    const seen: Request[] = [], got: string[] = [], history: Anthropic.MessageParam[] = [];
    // The text arrives before upstream finishes: if the function buffered the body, the gate would never open.
    await runTurn(client('198.51.100.1', seen), 'system', history, 'q', { ...ui, text: (d) => { got.push(d); release(); } }, new AbortController().signal);

    expect(got).toEqual(['Hello']);
    expect(history.at(-1)).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: 'Hello' }] });
    expect(seen[0].url).toBe(`${BASE}/v1/messages`);
    expect(seen[0].headers.get('authorization')).toBe('Bearer sk-visitor'); // what the browser sends (SDK 1.x: a bearer key)...
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    const h = new Headers(init.headers);
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(h.get('x-api-key')).toBe('sk-owner'); // ...and what goes upstream
    expect(h.get('authorization')).toBeNull();
    expect(h.get('anthropic-dangerous-direct-browser-access')).toBeNull();
    expect(h.get('anthropic-beta')).toBeNull();
    expect(h.get('anthropic-version')).toBe(seen[0].headers.get('anthropic-version'));
    expect(JSON.parse(new TextDecoder().decode(init.body as ArrayBuffer))).toMatchObject({ model: MODEL, max_tokens: MAX_TOKENS, stream: true });
  }, 5000);

  it('limits calls per address and the app explains it', async () => {
    const ip = '198.51.100.2';
    for (let i = 0; i < CALLS_PER_HOUR; i++) expect(wait(ip)).toBe(0);
    const seen: Request[] = [];
    const e = await client(ip, seen).messages.create({ model: MODEL, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }).catch((x) => x);
    expect(e).toBeInstanceOf(Anthropic.RateLimitError);
    expect(seen).toHaveLength(1); // x-should-retry: false, so the SDK does not retry
    expect(upstream).not.toHaveBeenCalled();
    expect(Number(e.headers.get('retry-after'))).toBeGreaterThan(3500);
    expect((await explain(e)).text).toBe('Rate limited. Try again in about 60 minutes.');
    expect(wait('198.51.100.3')).toBe(0); // other addresses are unaffected
  });

  it('opens a fresh window after an hour', () => {
    const ip = '198.51.100.4', t = 1e12;
    for (let i = 0; i < CALLS_PER_HOUR; i++) wait(ip, t);
    expect(wait(ip, t + 1000)).toBe(3599);
    expect(wait(ip, t + 3_600_000)).toBe(0);
  });

  it('answers the probe and rejects other methods, paths and sizes', async () => {
    expect(await (await proxy.fetch(new Request(`${BASE}/v1/messages`))).json()).toEqual({ ok: true });
    expect((await proxy.fetch(new Request(`${BASE}/v1/messages`, { method: 'PUT', body: '{}' }))).status).toBe(405);
    expect((await post(ok, '/v1/models')).status).toBe(404);
    expect((await post({ ...ok, messages: [{ role: 'user', content: 'x'.repeat(MAX_BODY) }] })).status).toBe(413);
    expect((await post({ ...ok, model: 'claude-haiku-5-5' })).status).toBe(400);
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    expect((await proxy.fetch(new Request(`${BASE}/v1/messages`))).status).toBe(503);
    expect((await post(ok)).status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });
});
