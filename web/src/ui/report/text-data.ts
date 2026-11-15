// The shipped data files the method and context sections quote (so their numbers follow the data), and which DEM
// tile serves a point. No DOM.
import { DEG, R, spFwd } from '../../core/geom';

export interface Tile { id: string; proj: 'spstere' | 'eqc'; w: number; h: number; x0?: number; y0?: number; px?: number; ppd?: number; sigma_h: number }
export interface EphemMeta { t0: string; step_s: number; n: number; kernels: string[] }
interface Stat { mae: number; bias: number; r: number }
interface Pair { sun: Stat; earth: Stat }

export interface Data {
  tiles: Tile[];
  sites: { id: string; note: string }[];
  ephem: EphemMeta;
  apollo: EphemMeta | null;
  psr: { min_area_km2: number };
  val: { horizons: { n: number }; dense_march: { max_missed_deg: number }; pgda: Pair; pgda_other_regions: Record<string, Pair>; pgda_240m_only_region: Pair };
  cal: { window_half_m: number; clone_ids: number[]; pct_lit_year: { shipped_20m: number; with_5m_detail: number; clones_mean: number; clones_std: number; model_mc_std: number } };
  bench: { images: unknown[] };
}

const cache = new Map<string, Promise<Data>>();

/** Every file once per data folder; a failed load is retried next time. */
export function load(base: string): Promise<Data> {
  let p = cache.get(base);
  if (!p) {
    const get = (f: string) => fetch(base + f).then((r) => { if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`); return r.json(); });
    p = Promise.all([
      get('dem/manifest.json'), get('sites.json'), get('ephem.json'), get('ephem_apollo.json').catch(() => null),
      get('psr_dist.json'), get('validation.json'), get('calibration.json'), get('bench/index.json'),
    ]).then(([m, sites, ephem, apollo, psr, val, cal, bench]) => ({ tiles: m.tiles, sites, ephem, apollo, psr, val, cal, bench }));
    p.catch(() => cache.delete(base));
    cache.set(base, p);
  }
  return p;
}

/** The tile that serves heights at (lat, lon): the first in the manifest (finest first) that contains it, as core/dem.ts. */
export function tileAt(tiles: Tile[], lat: number, lon: number): Tile | undefined {
  const [x, y] = spFwd(lat, lon);
  return tiles.find((t) => {
    if (t.proj === 'eqc') return true;
    const c = (x - t.x0!) / t.px!, r = (t.y0! - y) / t.px!;
    return c >= 0 && c <= t.w - 1 && r >= 0 && r <= t.h - 1;
  });
}

/** Pixel spacing of a tile, metres (along a meridian for the global grid). */
export const tileRes = (t: Tile) => (t.proj === 'eqc' ? (R * DEG) / t.ppd! : t.px!);

/** First and last instant of an ephemeris table, ms UTC. */
export function span(e: EphemMeta): [number, number] {
  const t0 = Date.parse(e.t0);
  return [t0, t0 + (e.n - 1) * e.step_s * 1000];
}
