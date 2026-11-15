// Agent panel: key form or chat thread. Streaming text, one line per tool call, suggested prompts, stop.
import type Anthropic from '@anthropic-ai/sdk';
import { createClient, explain, mountAuth, ready, SIGN_OUT_LABEL, signOut } from './client';
import { runTurn } from './loop';
import { systemPrompt, type PromptSite } from './prompt';

const SUGGESTIONS = [
  'Find the best-lit site for a 14-day mission starting March 2027',
  'What happens if we slip 2 weeks?',
  'Compare Connecting Ridge and Malapert Massif for power and comms',
];

const brief = (v: unknown, n = 90) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

export function mountAgent(root: HTMLElement, opts: { sites: PromptSite[] }): void {
  const system = systemPrompt(opts.sites);
  let history: Anthropic.MessageParam[] = [];
  let abort: AbortController | undefined;

  function render() {
    if (!ready()) {
      root.innerHTML = '<div class="agent-auth"></div>';
      return mountAuth(root.firstElementChild as HTMLElement, () => { render(); root.querySelector('textarea')?.focus(); });
    }
    root.innerHTML = `
      <div class="thread" role="log" aria-live="polite" aria-label="Conversation with the assistant"></div>
      <form class="ask">
        <textarea rows="2" aria-label="Message the assistant" placeholder="Ask about sites, dates or delays"></textarea>
        <button type="submit" class="send">Send</button>
      </form>
      <div class="agent-foot">
        <span class="lbl quiet">Claude operates the app.</span>
        <button type="button" class="link" data-do="new">New chat</button>
        <button type="button" class="link" data-do="out">${SIGN_OUT_LABEL}</button>
      </div>`;
    const thread = root.querySelector<HTMLElement>('.thread')!, form = root.querySelector('form')!;
    const input = root.querySelector('textarea')!, btn = root.querySelector<HTMLButtonElement>('.send')!;

    const add = (cls: string, text = '') => {
      const stick = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40;
      const el = document.createElement('div');
      el.className = cls; el.textContent = text;
      thread.append(el);
      if (stick) thread.scrollTop = thread.scrollHeight;
      return el;
    };
    const grow = (el: HTMLElement, text: string) => {
      const stick = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 40;
      el.append(text);
      if (stick) thread.scrollTop = thread.scrollHeight;
    };
    const empty = () => {
      thread.innerHTML = `<div class="suggest"><p class="lbl">Try asking</p>${SUGGESTIONS.map((s) => `<button type="button">${s}</button>`).join('')}</div>`;
    };
    const busy = (on: boolean) => {
      btn.textContent = on ? 'Stop' : 'Send';
      btn.classList.toggle('stop', on);
      root.classList.toggle('busy', on);
      thread.setAttribute('aria-busy', String(on));
    };

    async function send(text: string) {
      if (abort || !text.trim()) return;
      thread.querySelector('.suggest')?.remove();
      add('msg user', text.trim());
      const ac = abort = new AbortController();
      const live = () => abort === ac; // false once "New chat" or "Forget key" dropped this turn
      busy(true);
      let bubble: HTMLElement | undefined;
      const wait = add('msg wait', 'Thinking');
      try {
        await runTurn(await createClient(), system, history, text.trim(), {
          text: (d) => { if (!live()) return; wait.remove(); grow(bubble ??= add('msg bot'), d); },
          tool: (name, args) => {
            if (!live()) return () => {};
            wait.remove(); bubble = undefined; // text after a tool call starts a new bubble
            const line = add('tool run');
            line.innerHTML = '<code></code><span></span>';
            line.firstElementChild!.textContent = name;
            line.lastElementChild!.textContent = brief(args, 60);
            return (result, isError) => {
              if (!live()) return;
              line.className = isError ? 'tool err' : 'tool';
              line.lastElementChild!.textContent = brief((result as { summary?: string } | null)?.summary ?? result);
              line.title = brief(result, 600);
              thread.append(wait); // more model output follows the results
            };
          },
          notice: (t) => { if (live()) add('msg note', t); },
        }, ac.signal);
      } catch (e) {
        const x = await explain(e).catch(() => ({ text: `Something went wrong: ${(e as Error)?.message ?? e}` }));
        if (live()) add('msg note' + ('aborted' in x && x.aborted ? '' : ' err'), x.text);
      }
      if (!live()) return;
      wait.remove();
      abort = undefined;
      busy(false);
    }

    form.onsubmit = (e) => {
      e.preventDefault();
      if (abort) { // a tool may be waiting on the worker: show the stop now, the turn ends when it returns
        abort.abort();
        btn.textContent = 'Stopping…'; // stays enabled so focus isn't dropped
        return;
      }
      const v = input.value;
      input.value = '';
      void send(v);
    };
    input.onkeydown = (e) => {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      e.preventDefault();
      if (!abort) form.requestSubmit(); // only the Stop button stops a running turn
    };
    thread.onclick = (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('.suggest button');
      if (b) void send(b.textContent!);
    };
    root.querySelector<HTMLElement>('.agent-foot')!.onclick = (e) => {
      const d = (e.target as HTMLElement).closest<HTMLElement>('[data-do]')?.dataset.do;
      if (!d) return;
      abort?.abort();
      abort = undefined; // the running turn sees it is no longer live and leaves the new thread alone
      history = [];
      if (d === 'out') { signOut(); render(); } else { busy(false); empty(); }
    };
    empty();
  }
  render();
}
