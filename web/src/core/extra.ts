// Mission-level metrics on top of a series: battery survival and DSN-backed comms. Mirrors prep/geom.py.
import type { Series } from './series';

export interface Power { panelW: number; loadW: number; capacityWh: number }
export const DEFAULT_POWER: Power = { panelW: 200, loadW: 100, capacityWh: 1500 };

/** CONTRACT "Battery survival": starts full; dead at the first step where stored energy reaches 0. */
export function battery(sunFrac: ArrayLike<number>, stepH: number, p: Power = DEFAULT_POWER): { survivalH: number | null; minSoc: number } {
  let e = p.capacityWh, dead: number | null = null, min = 1;
  for (let i = 0; i < sunFrac.length; i++) {
    e = Math.min(p.capacityWh, e + (p.panelW * sunFrac[i] - p.loadW) * stepH);
    if (e <= 0 && dead === null) dead = (i + 1) * stepH;
    e = Math.max(e, 0);
    min = Math.min(min, e / p.capacityWh);
  }
  return { survivalH: dead, minSoc: min };
}

/** DSN table: one byte per ephemeris step, bit 0 Goldstone, bit 1 Madrid, bit 2 Canberra. */
export interface Dsn { t0: number; stepMs: number; bits: Uint8Array }
export const DSN_NAMES = ['Goldstone', 'Madrid', 'Canberra'];

export function dsnAt(d: Dsn, t: number): number {
  const i = Math.round((t - d.t0) / d.stepMs);
  return i >= 0 && i < d.bits.length ? d.bits[i] : 0;
}

/** Hours with Earth in view from the site AND at least one DSN complex seeing the Moon. null if no table covers the series. */
export function commsHours(s: Series, d: Dsn | null): number | null {
  if (!d || !s.t.length || s.t[0] < d.t0 || s.t[s.t.length - 1] > d.t0 + (d.bits.length - 1) * d.stepMs) return null;
  let n = 0;
  for (let i = 0; i < s.t.length; i++) if (s.earthVis[i] && dsnAt(d, s.t[i])) n++;
  return (n * s.stepMs) / 3600e3;
}
