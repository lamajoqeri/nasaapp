// The action layer: every user-visible change goes through one registry, so the UI's buttons and the
// agent's tools call the same functions. No DOM and no app imports: owners call register() from their own modules.
// Effort 2: build schemas with schema(props, required) below; strict tool mode rejects minimum/maximum, so check
// ranges inside run(). snapshot() picks up inspectorState(), skyState() and the view3d getters once they land.

/** The JSON Schema subset the API's strict tool mode accepts (no minimum/maximum: check ranges in run()). */
export interface PropSchema { type: 'string' | 'number' | 'integer' | 'boolean'; description?: string; enum?: readonly (string | number)[] }
export type JSONSchema = { // a type alias, not an interface, so it fits the SDK's index-signature InputSchema
  type: 'object';
  properties: Record<string, PropSchema>;
  required: string[];
  additionalProperties: false;
};

export interface Action<A = any> {
  name: string;             // 'scenario.add', 'view.set', ...
  description: string;      // shown to the model as the tool description
  schema: JSONSchema;       // input_schema, additionalProperties:false
  run(args: A): Promise<unknown>;   // returns a short result the model can read
}

export const actions = new Map<string, Action>();

export function register<A = any>(a: Action<A>): void {
  if (!/^[a-z][a-zA-Z0-9]*(\.[a-zA-Z][a-zA-Z0-9]*)*$/.test(a.name)) throw new Error(`Bad action name: ${a.name}`);
  actions.set(a.name, a);
}

/** Shorthand for the schema boilerplate. */
export const schema = (properties: Record<string, PropSchema> = {}, required: string[] = []): JSONSchema =>
  ({ type: 'object', properties, required, additionalProperties: false });

let provider: () => unknown = () => ({});
/** The app shell supplies the function that reads the screen. */
export function setSnapshot(fn: () => unknown): void { provider = fn; }
/** Everything on screen, as JSON. */
export function snapshot(): unknown { return provider(); }

/** Problems with `args` against an action schema; empty when valid. */
export function validate(s: JSONSchema, args: unknown): string[] {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return ['arguments must be an object'];
  const a = args as Record<string, unknown>, out: string[] = [];
  for (const k of s.required) if (a[k] === undefined || a[k] === null) out.push(`missing required argument "${k}"`);
  for (const [k, v] of Object.entries(a)) {
    const p = s.properties[k];
    if (!p) { out.push(`unknown argument "${k}"`); continue; }
    if (v === undefined || v === null) continue;
    const ok = p.type === 'integer' ? Number.isInteger(v) : p.type === 'number' ? typeof v === 'number' && Number.isFinite(v) : typeof v === p.type;
    if (!ok) out.push(`"${k}" must be ${p.type === 'integer' ? 'an integer' : `a ${p.type}`}`);
    else if (p.enum && !p.enum.includes(v as string | number)) out.push(`"${k}" must be one of ${p.enum.join(', ')}`);
  }
  return out;
}

/** Run an action by name (dotted, or the underscored tool name). Rejects on unknown names and invalid arguments. */
export async function run(name: string, args: unknown = {}): Promise<unknown> {
  const a = actions.get(name) ?? [...actions.values()].find((x) => toolName(x.name) === name);
  if (!a) throw new Error(`Unknown action "${name}". Available: ${[...actions.keys()].map(toolName).join(', ')}`);
  const bad = validate(a.schema, args);
  if (bad.length) throw new Error(`${toolName(a.name)}: ${bad.join('; ')}`);
  return a.run(args);
}

/** Tool names must match ^[a-zA-Z0-9_-]{1,64}$, so dots become underscores. */
export const toolName = (action: string) => action.replaceAll('.', '_');

export interface ToolDef { name: string; description: string; input_schema: JSONSchema; strict: true }
/** The registry as Messages API tool definitions, in registration order (stable, so the prompt cache holds). */
export function tools(): ToolDef[] {
  return [...actions.values()].map((a) => ({ name: toolName(a.name), description: a.description, input_schema: a.schema, strict: true }));
}
