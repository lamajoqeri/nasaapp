// The agent loop: stream a turn, run the tool calls it asks for against the action registry, send every
// result back in one user message, repeat until the model stops asking. No DOM: the panel passes callbacks.
import type Anthropic from '@anthropic-ai/sdk';
import { run, tools } from '../ui/actions';
import { MODEL, TOO_LONG } from './client';

export interface LoopUI {
  /** Streamed assistant text. */
  text(delta: string): void;
  /** A tool call starts; the returned function receives its result. */
  tool(action: string, input: unknown): (result: unknown, isError: boolean) => void;
  /** The turn ended for a reason the user should see. */
  notice(text: string): void;
}

/**
 * Sends `text` and runs until the model ends its turn. `history` is appended to in place and stays valid to resend.
 * On a refusal the whole turn (from `text` on) is dropped, so it can't merge into the next message. So is a turn
 * that fails before any tool ran. Once a tool has run the app has changed, so a failed turn is kept up to its last
 * tool results: the model then still knows what it did. After a stop it is kept: it ends in the user's text or in tool results, and the next message joins that user turn.
 */
export async function runTurn(client: Anthropic, system: string, history: Anthropic.MessageParam[], text: string, ui: LoopUI, signal: AbortSignal): Promise<void> {
  const mark = history.length;
  history.push({ role: 'user', content: text });
  try {
    if (!await turn(client, system, history, ui, signal)) history.length = mark;
  } catch (e) {
    // Tool results are the only array-content user messages the loop adds, and it adds them after the tools ran.
    const ranTools = history.slice(mark).some((m) => m.role === 'user' && Array.isArray(m.content));
    if (!signal.aborted && !ranTools) history.length = mark;
    throw e;
  }
}

/** False when the turn must be dropped from the history. */
async function turn(client: Anthropic, system: string, history: Anthropic.MessageParam[], ui: LoopUI, signal: AbortSignal): Promise<boolean> {
  for (;;) {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }], // stable prefix: tools + system
      tools: tools(),
      messages: history,
      cache_control: { type: 'ephemeral' }, // automatic breakpoint on the conversation so far
    }, { signal });
    stream.on('text', (d) => ui.text(d));
    const msg = await stream.finalMessage();

    const calls = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (msg.stop_reason === 'refusal') {
      ui.notice('Claude declined to continue with this request. Try rephrasing it, or start a new chat.');
      return false;
    }
    if (msg.stop_reason === 'max_tokens' || msg.stop_reason === 'model_context_window_exceeded') {
      // Never run this turn's tools: the cap can cut a call off mid-input. Keep the reply only if it leaves the
      // history resendable (an unanswered tool_use would not).
      if (msg.content.length && !calls.length) history.push({ role: 'assistant', content: msg.content });
      ui.notice(msg.stop_reason === 'max_tokens'
        ? 'The reply hit the length limit and was cut off. Ask for a shorter answer or a smaller step.'
        : TOO_LONG);
      return true;
    }
    if (msg.content.length) history.push({ role: 'assistant', content: msg.content }); // the whole content, thinking blocks included
    if (msg.stop_reason !== 'tool_use' || !calls.length) return true;

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const c of calls) {
      if (signal.aborted) { results.push({ type: 'tool_result', tool_use_id: c.id, content: 'Not run: the user pressed stop.', is_error: true }); continue; }
      const done = ui.tool(c.name, c.input);
      try {
        const r = await run(c.name, c.input); // run() maps the underscored tool name back to the action
        results.push({ type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(r ?? null) });
        done(r, false);
      } catch (e) {
        const m = (e as Error).message;
        results.push({ type: 'tool_result', tool_use_id: c.id, content: m, is_error: true });
        done(m, true);
      }
    }
    history.push({ role: 'user', content: results }); // all results in one message
    if (signal.aborted) { ui.notice('Stopped.'); return true; }
  }
}
