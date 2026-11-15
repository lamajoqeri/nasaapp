// Terrain readings at a point (elevation, slope, NASA PGDA average Sun/Earth visibility) and a flat-and-lit search.
import type { Dem } from './dem';
import { DEG, offset, R, spFwd } from './geom';

/** An 8-bit gray raster in south-polar stereographic metres; bounds are pixel edges [xmin, ymin, xmax, ymax], row 0 = ymax. */
export interface Raster { w: number; h: number; bounds: number[]; data: Uint8Array }
export interface Pgda { sun: Raster | null; earth: Raster | null }
export const PGDA_R = 150000; // the data disc the map shows (≈85°S), metres from the pole

export interface TerrainPoint {
  lat: number; lon: number;
  elevation_m: number; slope_deg: number;
  resolution_m: number;        // pixel spacing of the DEM tile used (20 or 240 m near the pole)
  sunPct: number | null; earthPct: number | null; // PGDA long-term averages, null outside coverage
}

const r1 = (x: number) => Math.round(x * 10) / 10;

/** PGDA value (0..100 % of time) at a point, nearest pixel; null outside the raster or the 150 km disc. */
export function pgdaAt(r: Raster | null, lat: number, lon: number): number | null {
  if (!r || lat > -60) return null;
  const [x, y] = spFwd(lat, lon), b = r.bounds;
  if (Math.hypot(x, y) > PGDA_R || x < b[0] || x > b[2] || y < b[1] || y > b[3]) return null;
  const c = Math.min(r.w - 1, Math.floor(((x - b[0]) / (b[2] - b[0])) * r.w));
  const k = Math.min(r.h - 1, Math.floor(((b[3] - y) / (b[3] - b[1])) * r.h));
  return (r.data[k * r.w + c] / 255) * 100;
}

/** Slope (deg) from central differences at ±d metres east/west and north/south. */
export function slopeAt(z: (lat: number, lon: number) => number, lat: number, lon: number, d: number): number {
  const at = (b: number) => z(...offset(lat, lon, b, d));
  const dx = (at(90) - at(270)) / (2 * d), dy = (at(0) - at(180)) / (2 * d);
  return Math.atan(Math.hypot(dx, dy)) / DEG;
}

/** Readings at a point from the finest loaded DEM tile containing it; null when no tile does. Call dem.ensure first. */
export function terrainAt(dem: Dem, pgda: Pgda, lat: number, lon: number): TerrainPoint | null {
  const h = dem.sample(lat, lon), t = dem.tile;
  if (!t) return null;
  const px = t.proj === 'spstere' ? t.px! : (R * DEG) / t.ppd!;
  const slope = slopeAt((a, b) => dem.sample(a, b), lat, lon, px);
  const s = pgdaAt(pgda.sun, lat, lon), e = pgdaAt(pgda.earth, lat, lon);
  return {
    lat: +lat.toFixed(5), lon: +lon.toFixed(5), elevation_m: r1(h), slope_deg: r1(slope), resolution_m: Math.round(px),
    sunPct: s === null ? null : r1(s), earthPct: e === null ? null : r1(e),
  };
}

/** [east, north] offsets (m) of a square grid at `step` clipped to the disc of `radius`, centre included. */
export function discGrid(radius: number, step: number): [number, number][] {
  const n = Math.floor(radius / step), out: [number, number][] = [];
  for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) if (Math.hypot(i, j) * step <= radius) out.push([i * step, j * step]);
  return out;
}

type Ranked = Pick<TerrainPoint, 'sunPct' | 'earthPct'> & { distance_m: number };
const desc = (a: number | null, b: number | null) => (a === b ? 0 : a === null ? 1 : b === null ? -1 : b - a);
/** Sun % desc, then Earth % desc (null last), then nearest first. */
export const byLight = (a: Ranked, b: Ranked) => desc(a.sunPct, b.sunPct) || desc(a.earthPct, b.earthPct) || a.distance_m - b.distance_m;

export interface SearchResult {
  centre: TerrainPoint | null;
  radius_m: number; step_m: number; max_slope_deg: number;
  sampled: number; passed: number;
  candidates: (TerrainPoint & { distance_m: number; bearing_deg: number })[];
}

/** Grid around (lat, lon) within `radius` m, kept where slope ≤ maxSlope, ranked byLight, top `limit`. Call dem.ensure first. */
export function terrainSearch(dem: Dem, pgda: Pgda, lat: number, lon: number, radius = 500, maxSlope = 8, limit = 5): SearchResult {
  const centre = terrainAt(dem, pgda, lat, lon);
  // ponytail: radius/25 keeps the disc under ~2050 samples; candidates may sit next to each other (no min separation)
  const step = Math.max(centre?.resolution_m ?? 20, radius / 25);
  const pts: SearchResult['candidates'] = [];
  const grid = discGrid(radius, step);
  for (const [de, dn] of grid) {
    const p = terrainAt(dem, pgda, ...offset(lat, lon, Math.atan2(de, dn) / DEG, Math.hypot(de, dn)));
    if (p && p.slope_deg <= maxSlope) pts.push({ ...p, distance_m: Math.round(Math.hypot(de, dn)), bearing_deg: Math.round((Math.atan2(de, dn) / DEG + 360) % 360) });
  }
  pts.sort(byLight);
  return { centre, radius_m: radius, step_m: Math.round(step), max_slope_deg: maxSlope, sampled: grid.length, passed: pts.length, candidates: pts.slice(0, limit) };
}
