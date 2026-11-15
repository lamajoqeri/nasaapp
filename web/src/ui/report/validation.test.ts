import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import {
  DEFAULT_IMAGE, fmtDeg, fmtIoU, fmtPct, fmtUtc, groupLabel, MODELS, prettyRegion,
  scatterSeries, shapeBench, shapeCalibration, shapeValidation,
} from './validation';

const real = (f: string): any => JSON.parse(readFileSync(new URL(`../../../public/data/${f}`, import.meta.url), 'utf8'));

test('number formatting', () => {
  expect(fmtDeg(0.00002, 5)).toBe('0.00002°');
  expect(fmtDeg(0.00012, 5)).toBe('0.00012°');
  expect(fmtDeg(0.0416)).toBe('0.04°');
  expect(fmtDeg(0.0517, 3)).toBe('0.052°');
  expect(fmtPct(0.0152)).toBe('1.5%');
  expect(fmtPct(0.0024, 2)).toBe('0.24%');
  expect(fmtPct(0.8609)).toBe('86.1%');
  expect(fmtIoU(0.96)).toBe('0.96');
  expect(fmtIoU(0)).toBe('0.00');
});

test('UTC time is rounded to the minute', () => {
  expect(fmtUtc('2010-10-05T11:25:59Z')).toBe('2010-10-05 11:26 UTC');
  expect(fmtUtc('2010-09-22T12:24:13Z')).toBe('2010-09-22 12:24 UTC');
  expect(fmtUtc('2010-12-31T23:59:45Z')).toBe('2011-01-01 00:00 UTC');
});

test('labels', () => {
  expect(prettyRegion('mouton_nobile')).toBe('Mons Mouton / Nobile');
  expect(prettyRegion('degerlache')).toBe('de Gerlache');
  expect(prettyRegion('some_new_region')).toBe('Some New Region');
  expect(groupLabel('known_time')).toBe('known time');
  expect(groupLabel('matched_time')).toBe('matched time');
  expect(MODELS.map((m) => m.key)).toEqual(['flat', 'dem240', 'slope_only', 'ours']);
});

test('scatter series: x = NASA, y = ours', () => {
  const s = scatterSeries([[0.1, 0.2, 0.3, 0.4]]);
  expect(s.sun).toEqual([[0.3, 0.1]]);
  expect(s.earth).toEqual([[0.4, 0.2]]);
});

test('real bench/index.json has every field the page reads', () => {
  const b = shapeBench(real('bench/index.json'));
  expect(b.images).toHaveLength(15);
  expect(b.images.some((im) => im.id === DEFAULT_IMAGE)).toBe(true);
  expect(b.summary.known.n + b.summary.matched.n).toBe(b.images.length);
  for (const im of b.images) {
    expect(im.photo).toMatch(/\.png$/);
    expect(im.model).toMatch(/\.png$/);
    expect(fmtUtc(im.utc)).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d UTC$/);
    for (const { key } of MODELS) {
      expect(im.scores[key].iou).toBeGreaterThanOrEqual(0);
      expect(im.scores[key].iou).toBeLessThanOrEqual(1);
    }
  }
  expect(fmtIoU(b.summary.known.scores.ours.iou)).toBe('0.70');
  expect(fmtIoU(b.summary.matched.scores.ours.iou)).toBe('0.96');
});

test('real validation.json has every field the page reads', () => {
  const v = shapeValidation(real('validation.json'));
  expect(fmtDeg(v.horizons.sun, 5)).toBe('0.00002°');
  expect(v.pgda.points.length).toBe(v.pgda.n);
  for (const p of v.pgda.points) for (const x of p) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(1); }
  expect(v.otherRegions.map((r) => r.id)).toContain('mouton_nobile');
  expect(Number.isFinite(v.coarseRegion.sun.mae)).toBe(true);
  expect(Number.isFinite(v.denseMarchMaxMissedDeg)).toBe(true);
});

test('real calibration.json has every field the page reads', () => {
  const c = shapeCalibration(real('calibration.json'));
  for (const g of [c.horizonSigma, c.litStd, c.litMean]) {
    expect(Number.isFinite(g.clones)).toBe(true);
    expect(Number.isFinite(g.model)).toBe(true);
  }
});

test('schema drift throws with the field name', () => {
  const v = real('validation.json');
  delete v.horizons.max_sep_deg.earth;
  expect(() => shapeValidation(v)).toThrow(/horizons\.max_sep_deg\.earth/);
  const b = real('bench/index.json');
  b.images[3].scores.ours.iou = null;
  expect(() => shapeBench(b)).toThrow(/images\[3\]\.scores\.ours\.iou/);
  const c = real('calibration.json');
  c.pct_lit_year.clones_std = 'x';
  expect(() => shapeCalibration(c)).toThrow(/pct_lit_year\.clones_std/);
  expect(() => shapeBench({})).toThrow();
});
