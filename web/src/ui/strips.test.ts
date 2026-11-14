import { expect, test } from 'vitest';
import { stripSummary } from './strips';

test('stripSummary', () => {
  const r = stripSummary({
    t0: 0, stepMs: 3600e3,
    sunFrac: new Float32Array([1, 0, 0, 0.5, 0, 0, 0, 0.5]),
    earthVis: new Uint8Array([1, 1, 0, 0, 1, 1, 1, 1]),
  });
  expect(r.pctLit).toBeCloseTo(25);
  expect(r.pctEarth).toBeCloseTo(75);
  expect(r.longestDarkHours).toBe(3);
});
