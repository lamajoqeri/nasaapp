// Port of prep/geom.py. Conventions: CONTRACT.md. Degrees at every interface.
export const R = 1737400;
export const NAZ = 720;
export const SUN_R = 695700e3;
export const DEG = Math.PI / 180;

export type V3 = [number, number, number];

export function unit(lat: number, lon: number): V3 {
  const la = lat * DEG, lo = lon * DEG;
  return [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
}

export function enu(lat: number, lon: number): { e: V3; n: V3; u: V3 } {
  const la = lat * DEG, lo = lon * DEG;
  return {
    e: [-Math.sin(lo), Math.cos(lo), 0],
    n: [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)],
    u: unit(lat, lon),
  };
}

export function spFwd(lat: number, lon: number): [number, number] {
  const rho = 2 * R * Math.tan(Math.PI / 4 + (lat * DEG) / 2);
  return [rho * Math.sin(lon * DEG), rho * Math.cos(lon * DEG)];
}

export function spInv(x: number, y: number): [number, number] {
  return [(2 * Math.atan(Math.hypot(x, y) / (2 * R)) - Math.PI / 2) / DEG, Math.atan2(x, y) / DEG];
}

export function schedule(): Float64Array {
  const out: number[] = [];
  let d = 10;
  while (d <= 300000) {
    out.push(d);
    d += Math.min(Math.max(0.02 * d, 10), 240);
  }
  return Float64Array.from(out);
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Az/el (deg) and distance (m) of a body from its Moon-centred MOON_ME vector in km. hSite includes mast. */
export function azel(lat: number, lon: number, hSite: number, bx: number, by: number, bz: number) {
  const { e, n, u } = enu(lat, lon);
  const s = R + hSite;
  const v: V3 = [bx * 1000 - s * u[0], by * 1000 - s * u[1], bz * 1000 - s * u[2]];
  const dist = Math.hypot(v[0], v[1], v[2]);
  let az = Math.atan2(dot(v, e), dot(v, n)) / DEG;
  if (az < 0) az += 360;
  return { az, el: Math.asin(dot(v, u) / dist) / DEG, dist };
}

/** Horizon elevation at an azimuth, linear between bins, wrapping at 360. */
export function horizonAt(hor: ArrayLike<number>, az: number): number {
  const i = az / (360 / hor.length);
  const i0 = Math.floor(i), f = i - i0, n = hor.length;
  return hor[((i0 % n) + n) % n] * (1 - f) + hor[(((i0 + 1) % n) + n) % n] * f;
}

/** Point `m` meters from (lat, lon) along bearing `bearingDeg` (0 = local north, 90 = east), great circle on the R sphere. */
export function offset(lat: number, lon: number, bearingDeg: number, m: number): [number, number] {
  const la = lat * DEG, d = m / R, b = bearingDeg * DEG;
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
  const dlo = Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return [la2 / DEG, ((((lon * DEG + dlo) / DEG) + 540) % 360) - 180];
}
