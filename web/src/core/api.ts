// Main-thread client for the core Web Worker. This is the only core entry point the UI should use.
import type { Horizon } from './horizon';
import type { Uncertainty } from './mc';
import type { Metrics, Series, Site } from './series';

export type { Horizon, Metrics, Series, Site, Uncertainty };

export type Request =
  | { type: 'range' }
  /** Series + metrics over [t, t + days] (default 29.5 d, hourly), with Monte Carlo unless mc === false. */
  | { type: 'scenario'; site: Site; t: number; days?: number; stepMs?: number; mc?: boolean; earthMargin?: number }
  /** Compact lit / Earth-visible arrays for heat-strips (e.g. a year at 1 h). */
  | { type: 'strip'; site: Site; t0: number; t1: number; stepMs?: number; earthMargin?: number };

export interface ScenarioResult { horizon: Horizon; series: Series; metrics: Metrics; uncertainty: Uncertainty | null }
export interface StripResult { t0: number; stepMs: number; sunFrac: Float32Array; earthVis: Uint8Array }

const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const dataBase = new URL(import.meta.env.BASE_URL + 'data/', location.href).href;
let next = 0;
const waiting = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
worker.onmessage = (ev) => {
  const { id, ok, value, error } = ev.data;
  const w = waiting.get(id);
  waiting.delete(id);
  ok ? w?.res(value) : w?.rej(new Error(error));
};

worker.onerror = (ev) => {
  for (const w of waiting.values()) w.rej(new Error(ev.message || 'core worker failed to load'));
  waiting.clear();
};

function call<T>(req: Request): Promise<T> {
  const id = next++;
  return new Promise<T>((res, rej) => {
    waiting.set(id, { res, rej });
    worker.postMessage({ id, req: { ...req, dataBase } });
  });
}

export const core = {
  /** Valid ephemeris ranges in ms (time order; a window must fit inside one). t0/t1 = the 2024–2040 table. */
  range: () => call<{ t0: number; t1: number; ranges: { t0: number; t1: number }[] }>({ type: 'range' }),
  scenario: (site: Site, t: number, opts: { days?: number; stepMs?: number; mc?: boolean; earthMargin?: number } = {}) =>
    call<ScenarioResult>({ type: 'scenario', site, t, ...opts }),
  strip: (site: Site, t0: number, t1: number, opts: { stepMs?: number; earthMargin?: number } = {}) =>
    call<StripResult>({ type: 'strip', site, t0, t1, ...opts }),
};
