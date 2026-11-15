// Vercel Function: relays the assistant's Messages API calls with the site owner's key, so visitors paste none.
// The SDK in src/agent/client.ts gets baseURL <site>/api and appends /v1/messages, so this file's path is the route.
// GET answers whether the key is configured (the client's proxy probe); POST forwards one call and streams the reply.
// Max duration and cancel-on-disconnect are set in web/vercel.json. No imports: Vercel bundles this file alone.

export const MODEL = 'claude-opus-5-5';  // the app's MODEL (src/agent/client.ts)
export const MAX_TOKENS = 16000;         // the app's max_tokens (src/agent/loop.ts)
export const MAX_BODY = 1_000_000;       // bytes. System + tools are about 20 KB; each call adds a few KB of history. Vercel's own cap is 4.5 MB
export const CALLS_PER_HOUR = 60;        // per address. An agent turn is one call per round of tool calls
const HOUR = 3_600_000;
// The top-level fields the app sends. Anything else (speed, output_config, inference_geo, mcp_servers, ...) can raise the price.
const FIELDS = new Set(['model', 'max_tokens', 'thinking', 'system', 'tools', 'messages', 'cache_control', 'stream']);

const fail = (status: number, type: string, message: string, headers?: HeadersInit) =>
  Response.json({ type: 'error', error: { type, message } }, { status, headers }); // the API's error shape, so the SDK maps it

/** Why the app would never send this body; '' when it is one of the app's requests. */
export function invalid(b: unknown): string {
  if (typeof b !== 'object' || b === null || Array.isArray(b)) return 'The body must be a JSON object.';
  const o = b as Record<string, unknown>;
  const extra = Object.keys(o).find((k) => !FIELDS.has(k));
  if (extra) return `The field "${extra}" is not allowed through this proxy.`;
  if (o.model !== MODEL) return `Only ${MODEL} is allowed through this proxy.`;
  if (!Number.isInteger(o.max_tokens) || (o.max_tokens as number) > MAX_TOKENS) return `max_tokens must be an integer up to ${MAX_TOKENS}.`;
  if (o.tools !== undefined && (!Array.isArray(o.tools) || o.tools.some((t: { type?: unknown } | null) => t?.type !== undefined && t.type !== 'custom')))
    return 'Only the app\'s own tools are allowed through this proxy, no server tools.';
  return '';
}

// ponytail: in memory, so the limit holds per instance and per exact address. Fluid compute reuses instances, but a
// burst can spread over several, a deploy resets it and an IPv6 client can rotate within its /64. For one global limit
// add a Vercel Firewall rate-limit rule on /api/v1/messages, or keep the counter in Upstash Redis (Vercel Marketplace).
const hits = new Map<string, { reset: number; n: number }>();
/** Seconds until `ip` may call again; 0 means allowed, and the call is counted. Fixed one-hour window. */
export function wait(ip: string, now = Date.now()): number {
  let h = hits.get(ip);
  if (!h || now >= h.reset) {
    if (hits.size > 10_000) for (const [k, v] of hits) if (now >= v.reset) hits.delete(k); // bound the memory
    hits.set(ip, h = { reset: now + HOUR, n: 0 });
  }
  if (h.n >= CALLS_PER_HOUR) return Math.ceil((h.reset - now) / 1000);
  h.n++;
  return 0;
}

export default {
  async fetch(req: Request): Promise<Response> {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!new URL(req.url).pathname.endsWith('/v1/messages')) return fail(404, 'not_found_error', 'Not found.');
    if (req.method === 'GET') return Response.json({ ok: !!key }, { status: key ? 200 : 503 });
    if (req.method !== 'POST') return fail(405, 'invalid_request_error', 'Use POST.', { allow: 'GET, POST' });
    if (!key) return fail(503, 'api_error', 'This site has no API key configured.');

    const raw = await req.arrayBuffer();
    if (raw.byteLength > MAX_BODY)
      return fail(413, 'request_too_large', `This chat is too long for the site's shared key (over ${MAX_BODY / 1e6} MB). Start a new chat to continue.`);
    let body: unknown;
    try { body = JSON.parse(new TextDecoder().decode(raw)); } catch { /* invalid() rejects undefined */ }
    const bad = invalid(body);
    if (bad) return fail(400, 'invalid_request_error', bad);

    // Vercel overwrites both headers with the client's address, so they can't be spoofed.
    const s = wait(req.headers.get('x-real-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown');
    if (s) return fail(429, 'rate_limit_error', `This site's shared key allows ${CALLS_PER_HOUR} Claude calls an hour from each address.`,
      { 'retry-after': String(s), 'x-should-retry': 'false' }); // the SDK would otherwise retry at once

    // A fresh header set: the visitor's key (x-api-key or Authorization), any anthropic-beta and the SDK's browser-access header stay here.
    const up = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': req.headers.get('anthropic-version') ?? '2026-10-21', 'x-api-key': key },
      body: raw,
      signal: req.signal, // with supportsCancellation, Stop in the app ends the upstream call too
    });
    const headers = new Headers();
    for (const h of ['content-type', 'retry-after', 'x-should-retry', 'request-id']) { const v = up.headers.get(h); if (v) headers.set(h, v); }
    return new Response(up.body, { status: up.status, headers }); // streamed through, not buffered
  },
};
