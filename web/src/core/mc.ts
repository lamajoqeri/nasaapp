import { DEG, horizonAt } from './geom';
import type { Horizon } from './horizon';
import { frac, metrics, type Metrics, type Series } from './series';

export const SMOOTH_DEG = 45;

export interface Uncertainty {
  pLit: Float32Array;                            // P(sunFrac > 0) per series sample
  fracLo: Float32Array;                          // 10th percentile of the visible Sun fraction per sample, over the draws
  fracHi: Float32Array;                          // 90th percentile
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
  // CONTRACT: boxcar over 45 deg (calibrated on NASA DEM clones), unit variance. Same window as prep/geom.py.
  const k = Math.max(1, Math.round(SMOOTH_DEG / (360 / naz))), lo = k - 1 - Math.floor(k / 2), hi = Math.floor(k / 2);
  const norm = 1 / Math.sqrt(k);
  const sigEl = new Float32Array(naz);
  for (let i = 0; i < naz; i++) sigEl[i] = Math.atan(hor.sigmaH[i] / hor.dist[i]) / DEG;

  const rand = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const pLit = new Float32Array(n);
  const keys = Object.keys(metrics(s)) as (keyof Metrics)[];
  const acc = keys.map(() => [] as number[]);
  const g = new Float32Array(naz), el = new Float32Array(naz);
  const sf = new Float32Array(n), ev = new Uint8Array(n);
  const all = new Float32Array(draws * n); // every draw's sunFrac, for the per-sample percentiles

  for (let d = 0; d < draws; d++) {
    for (let i = 0; i < naz; i++) g[i] = gauss();
    for (let i = 0; i < naz; i++) {
      let sum = 0;
      for (let j = -lo; j <= hi; j++) sum += g[(i + j + naz) % naz];
      el[i] = hor.el[i] + sum * norm * sigEl[i];
    }
    for (let i = 0; i < n; i++) {
      sf[i] = frac(s.sunEl[i] - horizonAt(el, s.sunAz[i]), s.sunRadius[i]) * (1 - s.eclipse[i]);
      ev[i] = s.earthEl[i] - horizonAt(el, s.earthAz[i]) > earthMargin ? 1 : 0;
      if (sf[i] > 0) pLit[i] += 1 / draws;
    }
    all.set(sf, d * n);
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
  const fracLo = new Float32Array(n), fracHi = new Float32Array(n), col = new Float32Array(draws);
  for (let i = 0; i < n; i++) {
    for (let d = 0; d < draws; d++) col[d] = all[d * n + i];
    col.sort();
    fracLo[i] = quantile(col, 0.1); fracHi[i] = quantile(col, 0.9);
  }
  return { pLit, fracLo, fracHi, mean, std };
}

/** Quantile of an ascending array, linear between ranks. */
export function quantile(sorted: ArrayLike<number>, q: number): number {
  const x = q * (sorted.length - 1), i = Math.floor(x), f = x - i;
  return i + 1 < sorted.length ? sorted[i] * (1 - f) + sorted[i + 1] * f : sorted[sorted.length - 1];
}
