// The action layer from docs/V2-DESIGN.md: every user-visible change goes through one typed registry, so UI
// controls and the AI agent call the same functions.
//
// NOTE FOR EFFORT 1 (owner of this file): this is the minimal Day-0 shape from the design doc, added so Effort 2
// could register its actions before yours landed. Replace it with your full version (snapshot(), state.get, ...);
// keep `Action`, `actions` and `register` source-compatible. Effort 2 state for snapshot() is exported as plain
// getters: inspectorState() in ui/inspector.ts, skyState() in ui/sky.ts, and view3d handle renderMode()/cameraState().
export type JSONSchema = Record<string, unknown>;

export interface Action<A> {
  name: string;                    // 'render.set', 'sky.open', ...
  description: string;             // shown to the model as the tool description
  schema: JSONSchema;              // input_schema, additionalProperties: false
  run(args: A): Promise<unknown>;  // returns a short result the model can read
}

export const actions = new Map<string, Action<any>>();

export function register<A>(a: Action<A>): void {
  if (actions.has(a.name)) throw new Error(`action ${a.name} registered twice`);
  actions.set(a.name, a);
}

/** Run a registered action by name. UI handlers use this so the agent and the buttons share one path. */
export function run(name: string, args: unknown = {}): Promise<unknown> {
  const a = actions.get(name);
  if (!a) return Promise.reject(new Error(`unknown action ${name}`));
  return a.run(args);
}
