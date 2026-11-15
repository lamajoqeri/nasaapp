// CPU reference of the shadow march in shaders.ts (MARCH_GLSL). Keep the two in step, line for line.
// No three.js / CSS imports here: this file is loaded by the node test.
import type { Dem } from '../core/dem';
import { DEG, R, unit } from '../core/geom';
import { frac } from '../core/series';

export const SUN_RADIUS_DEG = 0.266;
export const EARTH_RADIUS_DEG = 0.95;
/** March schedule: s from S_START to S_END, step = clamp(STEP_K * s, STEP_MIN, STEP_MAX). Starts at 10 m in 10 m steps like the core horizon: at mast 0 the horizon is often set by ground 10-20 m away. */
export const S_START = 10, S_END = 300e3, STEP_K = 0.03, STEP_MIN = 10, STEP_MAX = 480;

const hMaxCache = new WeakMap<Dem, { n: number; v: number }>();

/** Highest terrain in the loaded spstere tiles (m above R); bounds the march. */
export function demMax(dem: Dem): number {
  const loaded = dem.tiles.filter((t) => t.data && t.proj === 'spstere');
  const c = hMaxCache.get(dem);
  if (c && c.n === loaded.length) return c.v;
  let v = 0;
  for (const t of loaded) {
    let m = -32768;
    const a = t.data!;
    for (let i = 0; i < a.length; i++) if (a[i] > m) m = a[i];
    v = Math.max(v, t.offset + t.scale * m);
  }
  hMaxCache.set(dem, { n: loaded.length, v });
  return v;
}

/**
 * Visible fraction (0..1) of the Sun disk from the terrain surface at (lat, lon) (or `mast` metres above
 * it), by marching from that point toward the Sun through the DEM. `sunVecKm` = Moon centre -> Sun, MOON_ME (only its
 * direction is used: one Sun direction for the whole scene). The caller loads the tiles it wants
 * considered; the 3D view uses shackleton_20m + sp_240m.
 */
export function sunFractionAt(dem: Dem, sunVecKm: ArrayLike<number>, lat: number, lon: number, mast = 0, hMax = demMax(dem)): number {
  const n = Math.hypot(sunVecKm[0], sunVecKm[1], sunVecKm[2]);
  const sx = sunVecKm[0] / n, sy = sunVecKm[1] / n, sz = sunVecKm[2] / n;
  const u = unit(lat, lon);
  const r0 = R + dem.sampleUnit(u[0], u[1], u[2]) + mast;
  const px = r0 * u[0], py = r0 * u[1], pz = r0 * u[2];
  const sunR = Math.tan(SUN_RADIUS_DEG * DEG);
  let minC = Infinity; // tan of the smallest clearance between the ray and the terrain below it
  for (let s = S_START; s <= S_END; s += Math.min(Math.max(STEP_K * s, STEP_MIN), STEP_MAX)) {
    const qx = px + s * sx, qy = py + s * sy, qz = pz + s * sz;
    const r = Math.hypot(qx, qy, qz);
    const rayH = r - R;
    // (rayH - hMax)/s only grows with s, so nothing further out can lower the result.
    if ((rayH - hMax) / s >= Math.min(minC, sunR)) break;
    const c = (rayH - dem.sampleUnit(qx / r, qy / r, qz / r)) / s;
    if (c < minC) minC = c;
    if (minC <= -sunR) break;
  }
  return frac(Math.atan(minC) / DEG, SUN_RADIUS_DEG);
}
