import { Dem } from './dem';
import { DEG, NAZ, R, enu, schedule } from './geom';

export interface Horizon {
  el: Float32Array;     // deg, max terrain elevation per azimuth (az_i = i * 360/NAZ)
  dist: Float32Array;   // m, distance of the sample that set the max
  sigmaH: Float32Array; // m, DEM sigma at that sample
  hSite: number;        // m above R, terrain + mast
}

const D = schedule();
const CD = D.map((d) => Math.cos(d / R));
const SD = D.map((d) => Math.sin(d / R));

/** Terrain horizon around a site. Caller must `await dem.ensure(lat, lon)` first. */
export function horizon(dem: Dem, lat: number, lon: number, mast = 0, naz = NAZ): Horizon {
  const { e, n, u } = enu(lat, lon);
  const hSite = dem.sample(lat, lon) + mast;
  const s = R + hSite;
  const sx = s * u[0], sy = s * u[1], sz = s * u[2];
  const el = new Float32Array(naz), dist = new Float32Array(naz), sigmaH = new Float32Array(naz);
  for (let i = 0; i < naz; i++) {
    const az = (i * 360 / naz) * DEG, ca = Math.cos(az), sa = Math.sin(az);
    const dx = ca * n[0] + sa * e[0], dy = ca * n[1] + sa * e[1], dz = ca * n[2] + sa * e[2];
    let best = -Infinity, bk = 0, bsig = 0;
    for (let k = 0; k < D.length; k++) {
      const px = CD[k] * u[0] + SD[k] * dx, py = CD[k] * u[1] + SD[k] * dy, pz = CD[k] * u[2] + SD[k] * dz;
      const r = R + dem.sampleUnit(px, py, pz);
      const vx = r * px - sx, vy = r * py - sy, vz = r * pz - sz;
      const up = vx * u[0] + vy * u[1] + vz * u[2];
      const a = Math.atan2(up, Math.sqrt(Math.max(vx * vx + vy * vy + vz * vz - up * up, 0)));
      if (a > best) { best = a; bk = k; bsig = dem.sigma; }
    }
    el[i] = best / DEG;
    dist[i] = D[bk];
    sigmaH[i] = bsig;
  }
  return { el, dist, sigmaH, hSite };
}
