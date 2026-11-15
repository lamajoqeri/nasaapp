import { describe, expect, it } from 'vitest';
import { monteCarlo, quantile } from './mc';
import type { Horizon } from './horizon';
import type { Series } from './series';

/** Flat horizon at 0 deg with a 1-sigma terrain error of `sigDeg`; the Sun climbs linearly from -1.5 to +1.5 deg. */
function setup(sigDeg: number, n = 120): { s: Series; h: Horizon } {
  const naz = 720;
  const h: Horizon = { el: new Float32Array(naz), dist: new Float32Array(naz).fill(1000), sigmaH: new Float32Array(naz).fill(1000 * Math.tan((sigDeg * Math.PI) / 180)), hSite: 0 };
  const s: Series = {
    t: Float64Array.from({ length: n }, (_, i) => i * 3600e3), stepMs: 3600e3,
    sunAz: Float32Array.from({ length: n }, (_, i) => (i * 3) % 360), sunEl: Float32Array.from({ length: n }, (_, i) => -1.5 + (3 * i) / (n - 1)),
    sunFrac: new Float32Array(n), sunRadius: new Float32Array(n).fill(0.27), eclipse: new Float32Array(n),
    earthAz: new Float32Array(n), earthEl: new Float32Array(n).fill(5), earthVis: new Uint8Array(n).fill(1),
  };
  return { s, h };
}

describe('monteCarlo percentiles', () => {
  it('quantile interpolates between ranks', () => {
    expect(quantile([0, 1, 2, 3, 4], 0.5)).toBe(2);
    expect(quantile([0, 10], 0.1)).toBeCloseTo(1);
    expect(quantile([7], 0.9)).toBe(7);
  });

  it('fracLo <= fracHi, both in 0..1, and consistent with pLit', () => {
    const { s, h } = setup(0.3);
    const u = monteCarlo(s, h);
    expect(u.fracLo.length).toBe(s.t.length);
    expect(u.fracHi.length).toBe(s.t.length);
    let wide = 0;
    for (let i = 0; i < s.t.length; i++) {
      expect(u.fracLo[i]).toBeGreaterThanOrEqual(0);
      expect(u.fracHi[i]).toBeLessThanOrEqual(1);
      expect(u.fracLo[i]).toBeLessThanOrEqual(u.fracHi[i]);
      if (u.pLit[i] === 0) expect(u.fracHi[i]).toBe(0);          // never lit in any draw: the band is at zero
      if (u.pLit[i] === 1) expect(u.fracHi[i]).toBeGreaterThan(0);
      if (u.pLit[i] > 0.95) expect(u.fracLo[i]).toBeGreaterThan(0); // lit in more than 90% of draws: the 10th percentile is lit
      if (u.fracHi[i] - u.fracLo[i] > 0.2) wide++;
    }
    expect(wide).toBeGreaterThan(0);                              // the band opens where the Sun grazes the horizon
    expect(u.fracHi[0]).toBe(0);                                  // Sun 1.5 deg under a 0.3 deg-sigma horizon
    expect(u.fracLo[s.t.length - 1]).toBe(1);                     // and 1.5 deg above it
  });

  it('collapses to the deterministic series when the terrain has no error', () => {
    const { s, h } = setup(0);
    const u = monteCarlo(s, h);
    for (let i = 0; i < s.t.length; i++) expect(u.fracHi[i] - u.fracLo[i]).toBe(0);
  });
});
