// Main-thread client for the core Web Worker. This is the only core entry point the UI should use.
import type { Power } from './extra';
import type { Horizon } from './horizon';
import type { Uncertainty } from './mc';
import type { Metrics, Series, Site } from './series';
import type { SearchResult, TerrainPoint } from './terrain';

export type { Horizon, Metrics, Power, SearchResult, Series, Site, TerrainPoint, Uncertainty };

/** Mission-level results. commsHours is null when the DSN table does not cover the window (Apollo era). */
export interface Mission {
  commsHours: number | null; battery: { survivalH: number | null; minSoc: number }; dsn: Uint8Array;
  /** Metres to the nearest permanently shadowed region of at least 0.1 km² (0 inside one); null where there is no data (north of about 85°S). */
  psrM: number | null;
}
export interface Range { t0: number; t1: number }

export type Request =
  | { type: 'range' }
  /** Series + metrics over [t, t + days] (default 29.5 d, hourly), with Monte Carlo unless mc === false. */
  | { type: 'scenario'; site: Site; t: number; days?: number; stepMs?: number; mc?: boolean; earthMargin?: number; power?: Power }
  /** Compact lit / Earth-visible arrays for heat-strips (e.g. a year at 1 h). */
  | { type: 'strip'; site: Site; t0: number; t1: number; stepMs?: number; earthMargin?: number }
  /** Elevation, slope (finest DEM tile) and PGDA average Sun/Earth % at a point; null when no DEM tile covers it. */
  | { type: 'terrain'; lat: number; lon: number }
  /** Flattest-and-best-lit grid points within `radius` m (slope ≤ maxSlope, ranked by PGDA Sun % then Earth %). */
  | { type: 'terrainSearch'; lat: number; lon: number; radius?: number; maxSlope?: number; limit?: number };

export interface ScenarioResult { horizon: Horizon; series: Series; metrics: Metrics; uncertainty: Uncertainty | null; mission: Mission }
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
  /** Main ephemeris range in ms, plus every available range (main first; an Apollo-era table may follow). */
  range: () => call<{ t0: number; t1: number; ranges: Range[] }>({ type: 'range' }),
  scenario: (site: Site, t: number, opts: { days?: number; stepMs?: number; mc?: boolean; earthMargin?: number; power?: Power } = {}) =>
    call<ScenarioResult>({ type: 'scenario', site, t, ...opts }),
  strip: (site: Site, t0: number, t1: number, opts: { stepMs?: number; earthMargin?: number } = {}) =>
    call<StripResult>({ type: 'strip', site, t0, t1, ...opts }),
  terrain: (lat: number, lon: number) => call<TerrainPoint | null>({ type: 'terrain', lat, lon }),
  terrainSearch: (lat: number, lon: number, opts: { radius?: number; maxSlope?: number; limit?: number } = {}) =>
    call<SearchResult>({ type: 'terrainSearch', lat, lon, ...opts }),
};
