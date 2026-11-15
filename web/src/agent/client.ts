// Auth and client construction. Phase 1: the user pastes their own API key, kept in localStorage only
// (never the URL, the hash or any server but api.anthropic.com). Phase 2 (OAuth or a proxy) swaps this file only:
// the rest of the agent uses ready(), mountAuth(), signOut(), createClient() and explain().
import type Anthropic from '@anthropic-ai/sdk';

export const MODEL = 'claude-opus-5-5';
export const SIGN_OUT_LABEL = 'Forget key';
export const TOO_LONG = 'This chat is now too long for the model. Start a new chat to continue.';

const KEY = 'shackleton-live.anthropic-key';
let mem = '';  // fallback when storage is blocked (private windows): the key then lasts until the tab closes

// Dev only: a key in web/.env.local (gitignored) is preloaded. Vite folds DEV to false in builds, so it never ships.
const DEV_KEY: string = import.meta.env.DEV ? (import.meta.env.VITE_ANTHROPIC_API_KEY ?? '') : '';

let forgotten = false; // "Forget key" also drops the dev key, until the page reloads

function key(): string {
  const fallback = mem || (forgotten ? '' : DEV_KEY);
  try { return localStorage.getItem(KEY) ?? fallback; } catch { return fallback; }
}
export const ready = () => !!key();
export function signOut(): void {
  mem = ''; forgotten = true;
  try { localStorage.removeItem(KEY); } catch { /* nothing stored */ }
}

/** Render the sign-in UI into `el`; calls `done` once credentials exist. */
export function mountAuth(el: HTMLElement, done: () => void): void {
  el.innerHTML = `
    <form class="keyform">
      <p><b>Ask Claude to plan with you.</b> The assistant can add and move scenarios, change dates and read the results.
        It needs an Anthropic API key.</p>
      <label class="f"><span>Anthropic API key</span>
        <input type="password" name="key" autocomplete="off" spellcheck="false" placeholder="sk-ant-…" required></label>
      <button type="submit">Save key</button>
      <p class="hint">The key is stored only in this browser and sent only to api.anthropic.com. It never goes into the link you copy.
        Everything else in the app works without it.</p>
      <p class="keyerr" role="alert"></p>
    </form>`;
  const form = el.querySelector('form')!;
  form.onsubmit = (e) => {
    e.preventDefault();
    const v = (form.elements.namedItem('key') as HTMLInputElement).value.trim();
    if (!v || /\s/.test(v)) { form.querySelector('.keyerr')!.textContent = 'That does not look like an API key.'; return; }
    mem = v;
    try { localStorage.setItem(KEY, v); } catch { /* kept in memory for this tab */ }
    done();
  };
}

let sdk: Promise<typeof import('@anthropic-ai/sdk')> | undefined;
const load = () => (sdk ??= import('@anthropic-ai/sdk')); // lazy: the SDK stays out of the main bundle

export async function createClient(): Promise<Anthropic> {
  const { default: Client } = await load();
  return new Client({ apiKey: key(), baseURL: 'https://api.anthropic.com', dangerouslyAllowBrowser: true });
}

/** A failure as a sentence for the thread. `auth`: the credentials were rejected. `aborted`: the user pressed stop. */
export async function explain(e: unknown): Promise<{ text: string; auth?: boolean; aborted?: boolean }> {
  const A = (await load()).default;
  if (e instanceof A.APIUserAbortError) return { text: 'Stopped.', aborted: true };
  if (e instanceof A.AuthenticationError) return { text: 'The API rejected this key. Forget it and paste a valid one.', auth: true };
  if (e instanceof A.PermissionDeniedError) return { text: `This key cannot use ${MODEL}: ${e.message}`, auth: true };
  if (e instanceof A.RateLimitError) return { text: 'Rate limited by the API. Wait a moment and send again.' };
  if (e instanceof A.APIConnectionError) return { text: 'Could not reach api.anthropic.com. Check the connection and send again.' };
  if (e instanceof A.BadRequestError && /prompt is too long/i.test(e.message)) return { text: TOO_LONG };
  if (e instanceof A.APIError) {
    // e.message is "<status> <raw JSON body>"; the body's own message is the readable part. Errors that arrive
    // mid-stream have no status, only a type.
    if (e.type === 'overloaded_error' || e.status === 529) return { text: 'Claude is overloaded right now. Send again in a moment.' };
    if (e.type === 'rate_limit_error') return { text: 'Rate limited by the API. Wait a moment and send again.' };
    if ((e.status ?? 0) >= 500 || e.type === 'api_error') return { text: 'The API had a temporary problem. Send again in a moment.' };
    return { text: `The API returned an error${e.status ? ` (${e.status})` : ''}: ${e.apiMessage ?? e.message}` };
  }
  if (e instanceof TypeError && /fetch|network|load failed/i.test(e.message)) return { text: 'Could not reach api.anthropic.com. Check the connection and send again.' };
  return { text: `Something went wrong: ${(e as Error)?.message ?? e}` };
}
