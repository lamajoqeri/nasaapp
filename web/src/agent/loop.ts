// The agent loop: stream a turn, run the tool calls it asks for against the action registry, send every
// result back in one user message, repeat until the model stops asking. No DOM: the panel passes callbacks.
import type Anthropic from '@anthropic-ai/sdk';
import { actions, run, toolName, tools } from '../ui/actions';
import { MODEL } from './client';

export interface LoopUI {
  /** Streamed assistant text. */
  text(delta: string): void;
  /** A tool call starts; the returned function receives its result. */
  tool(action: string, input: unknown): (result: unknown, isError: boolean) => void;
  /** The turn ended for a reason the user should see. */
  notice(text: string): void;
}

/** Runs until the model ends its turn. `history` is appended to in place and stays valid to resend, also after a stop. */
export async function runTurn(client: Anthropic, system: string, history: Anthropic.MessageParam[], ui: LoopUI, signal: AbortSignal): Promise<void> {
  for (;;) {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }], // stable prefix: tools + system
      tools: tools() as unknown as Anthropic.Tool[],
      messages: history,
    }, { signal });
    stream.on('text', (d) => ui.text(d));
    const msg = await stream.finalMessage();

    const calls = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (msg.stop_reason === 'refusal' || msg.stop_reason === 'max_tokens') {
      // Never run this turn's tools: a refusal or the token cap can cut a call off mid-input. Keep the turn only
      // if it leaves the history resendable (an unanswered tool_use would not).
      if (msg.content.length && !calls.length && msg.stop_reason === 'max_tokens') history.push({ role: 'assistant', content: msg.content });
      return ui.notice(msg.stop_reason === 'refusal'
        ? 'Claude declined to continue with this request. Try rephrasing it, or start a new chat.'
        : 'The reply hit the length limit and was cut off. Ask for a shorter answer or a smaller step.');
    }
    if (msg.content.length) history.push({ role: 'assistant', content: msg.content }); // the whole content, thinking blocks included
    if (msg.stop_reason !== 'tool_use' || !calls.length) return;

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const c of calls) {
      const name = [...actions.keys()].find((n) => toolName(n) === c.name) ?? c.name;
      if (signal.aborted) { results.push({ type: 'tool_result', tool_use_id: c.id, content: 'Not run: the user pressed stop.', is_error: true }); continue; }
      const done = ui.tool(name, c.input);
      try {
        const r = await run(name, c.input);
        results.push({ type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(r ?? null) });
        done(r, false);
      } catch (e) {
        const m = (e as Error).message;
        results.push({ type: 'tool_result', tool_use_id: c.id, content: m, is_error: true });
        done(m, true);
      }
    }
    history.push({ role: 'user', content: results }); // all results in one message
    if (signal.aborted) return ui.notice('Stopped.');
  }
}
