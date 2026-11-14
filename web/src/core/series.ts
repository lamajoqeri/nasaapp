import { Ephem } from './ephem';
import { DEG, enu, horizonAt, R, SUN_R } from './geom';
import type { Horizon } from './horizon';

export interface Site { lat: number; lon: number; mast: number }

export interface Series {
  t: Float64Array;        // ms
  stepMs: number;
  sunAz: Float32Array; sunEl: Float32Array; sunFrac: Float32Array;
  sunRadius: Float32Array; // deg
  earthAz: Float32Array; earthEl: Float32Array;
  earthVis: Uint8Array;
}

/** Sun/Earth geometry vs the terrain horizon from t0 to t1 (ms, inclusive) every stepMs. */
export function series(eph: Ephem, site: Site, hor: Horizon, t0: number, t1: number, stepMs: number, earthMargin = 0): Series {
  const n = Math.max(1, Math.floor((t1 - t0) / stepMs) + 1);
  const s: Series = {
    t: new Float64Array(n), stepMs,
    sunAz: new Float32Array(n), sunEl: new Float32Array(n), sunFrac: new Float32Array(n), sunRadius: new Float32Array(n),
    earthAz: new Float32Array(n), earthEl: new Float32Array(n), earthVis: new Uint8Array(n),
  };
  const { e, n: no, u } = enu(site.lat, site.lon);
  const r = R + hor.hSite;
  const sx = r * u[0], sy = r * u[1], sz = r * u[2];
  const v = new Float64Array(6);
  const look = (bx: number, by: number, bz: number) => {
    const x = bx * 1000 - sx, y = by * 1000 - sy, z = bz * 1000 - sz;
    const d = Math.hypot(x, y, z);
    let az = Math.atan2(x * e[0] + y * e[1] + z * e[2], x * no[0] + y * no[1] + z * no[2]) / DEG;
    if (az < 0) az += 360;
    return [az, Math.asin((x * u[0] + y * u[1] + z * u[2]) / d) / DEG, d];
  };
  for (let i = 0; i < n; i++) {
    const t = t0 + i * stepMs;
    s.t[i] = t;
    eph.at(t, v);
    const [saz, sel, sd] = look(v[0], v[1], v[2]);
    const [eaz, eel] = look(v[3], v[4], v[5]);
    const rad = Math.asin(SUN_R / sd) / DEG;
    s.sunAz[i] = saz; s.sunEl[i] = sel; s.sunRadius[i] = rad;
    s.sunFrac[i] = frac(sel - horizonAt(hor.el, saz), rad);
    s.earthAz[i] = eaz; s.earthEl[i] = eel;
    s.earthVis[i] = eel - horizonAt(hor.el, eaz) > earthMargin ? 1 : 0;
  }
  return s;
}

/** Visible fraction of a disk whose centre is `clear` deg above the horizon. */
export function frac(clear: number, radius: number): number {
  const x = Math.max(-1, Math.min(1, clear / radius));
  return 1 - (Math.acos(x) - x * Math.sqrt(1 - x * x)) / Math.PI;
}

export interface Metrics {
  sunEl: number; sunFrac: number; earthEl: number; earthVisible: boolean;
  hoursToSunset: number | null;   // null = no sunset in the window; 0 = dark now
  hoursToSunrise: number | null;  // when dark now
  hoursToEarthset: number | null; // null = no Earthset in the window; 0 = hidden now
  hoursToEarthrise: number | null;
  pctLit: number;                 // mean sunFrac over the window, 0..100
  pctAnyLit: number;              // % of time any part of the disk is visible
  longestDarkHours: number;
  dteHours: number;               // hours with Earth above the horizon
  pctEarth: number;
}

/** Metrics over a series (window = the whole series, starting at its first sample). */
export function metrics(s: Series, sunFracOverride?: ArrayLike<number>, earthVisOverride?: ArrayLike<number>): Metrics {
  const sf = sunFracOverride ?? s.sunFrac, ev = earthVisOverride ?? s.earthVis;
  const n = s.t.length, h = s.stepMs / 3600e3;
  let sum = 0, any = 0, run = 0, longest = 0, earth = 0;
  let sunset: number | null = null, sunrise: number | null = null, earthset: number | null = null, earthrise: number | null = null;
  const darkNow = sf[0] === 0, hiddenNow = !ev[0];
  for (let i = 0; i < n; i++) {
    sum += sf[i];
    if (sf[i] > 0) { any++; run = 0; } else { run++; longest = Math.max(longest, run); }
    if (ev[i]) earth++;
    if (sunset === null && !darkNow && sf[i] === 0) sunset = i * h;
    if (sunrise === null && darkNow && sf[i] > 0) sunrise = i * h;
    if (earthset === null && !hiddenNow && !ev[i]) earthset = i * h;
    if (earthrise === null && hiddenNow && ev[i]) earthrise = i * h;
  }
  return {
    sunEl: s.sunEl[0], sunFrac: sf[0], earthEl: s.earthEl[0], earthVisible: !hiddenNow,
    hoursToSunset: darkNow ? 0 : sunset, hoursToSunrise: darkNow ? sunrise : 0,
    hoursToEarthset: hiddenNow ? 0 : earthset, hoursToEarthrise: hiddenNow ? earthrise : 0,
    pctLit: (100 * sum) / n, pctAnyLit: (100 * any) / n,
    longestDarkHours: longest * h, dteHours: earth * h, pctEarth: (100 * earth) / n,
  };
}
