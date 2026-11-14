import { DEG, horizonAt } from './geom';
import type { Horizon } from './horizon';
import { frac, metrics, type Metrics, type Series } from './series';

export interface Uncertainty {
  pLit: Float32Array;                            // P(sunFrac > 0) per series sample
  mean: Record<keyof Metrics, number>;
  std: Record<keyof Metrics, number>;
}

function rng(seed: number) { // mulberry32
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Horizon-space Monte Carlo (CONTRACT.md "Uncertainty"). Deterministic for a given seed. */
export function monteCarlo(s: Series, hor: Horizon, earthMargin = 0, draws = 64, seed = 1): Uncertainty {
  const naz = hor.el.length, n = s.t.length;
  const half = Math.round(2.5 / (360 / naz)); // 5 deg box = 2*half+1 bins
  const k = 2 * half + 1, norm = Math.sqrt(k) / k;
  const sigEl = new Float32Array(naz);
  for (let i = 0; i < naz; i++) sigEl[i] = Math.atan(hor.sigmaH[i] / hor.dist[i]) / DEG;

  const rand = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const pLit = new Float32Array(n);
  const keys = Object.keys(metrics(s)) as (keyof Metrics)[];
  const acc = keys.map(() => [] as number[]);
  const g = new Float32Array(naz), el = new Float32Array(naz);
  const sf = new Float32Array(n), ev = new Uint8Array(n);

  for (let d = 0; d < draws; d++) {
    for (let i = 0; i < naz; i++) g[i] = gauss();
    for (let i = 0; i < naz; i++) {
      let sum = 0;
      for (let j = -half; j <= half; j++) sum += g[(i + j + naz) % naz];
      el[i] = hor.el[i] + sum * norm * sigEl[i];
    }
    for (let i = 0; i < n; i++) {
      sf[i] = frac(s.sunEl[i] - horizonAt(el, s.sunAz[i]), s.sunRadius[i]);
      ev[i] = s.earthEl[i] - horizonAt(el, s.earthAz[i]) > earthMargin ? 1 : 0;
      if (sf[i] > 0) pLit[i] += 1 / draws;
    }
    const m = metrics(s, sf, ev);
    keys.forEach((key, j) => acc[j].push(m[key] === null ? NaN : Number(m[key])));
  }
  const mean = {} as Record<keyof Metrics, number>, std = {} as Record<keyof Metrics, number>;
  keys.forEach((key, j) => {
    const v = acc[j].filter((x) => Number.isFinite(x));
    const mu = v.reduce((a, b) => a + b, 0) / (v.length || 1);
    mean[key] = v.length ? mu : NaN;
    std[key] = v.length ? Math.sqrt(v.reduce((a, b) => a + (b - mu) ** 2, 0) / v.length) : NaN;
  });
  return { pLit, mean, std };
}
