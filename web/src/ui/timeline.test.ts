import { expect, test } from 'vitest';
import { binMean, hourAt, laneBoxes, lanesHeight, PITCH, STEPS, ticks, TOP, xAt } from './timeline';

test('lane layout keeps a constant pitch with and without a slip', () => {
  const a = laneBoxes(3, false), b = laneBoxes(3, true);
  expect(a.map((l) => l.y)).toEqual([TOP, TOP + PITCH, TOP + 2 * PITCH]);
  expect(b.map((l) => l.y)).toEqual(a.map((l) => l.y));
  expect(a[0].ghostSun).toBeUndefined();
  for (const l of b) {
    const end = l.ghostEarth![0] + l.ghostEarth![1];
    expect(end).toBeLessThanOrEqual(l.y + PITCH);            // ghost stays inside its lane
    expect(l.ghostSun![0]).toBeGreaterThanOrEqual(l.earth[0] + l.earth[1]); // and below the main bands
  }
  expect(lanesHeight(4)).toBeGreaterThan(TOP + 4 * PITCH);
});

test('binMean averages samples per pixel column', () => {
  expect([...binMean([1, 1, 0, 0], 2)]).toEqual([1, 0]);
  expect([...binMean([1, 0, 1, 0], 2)]).toEqual([0.5, 0.5]);
  expect([...binMean([0.5], 3)]).toEqual([0.5, 0.5, 0.5]);   // more columns than samples
  expect(binMean([], 4).length).toBe(4);
});

test('hourAt and xAt are inverse and clamp to the window', () => {
  expect(hourAt(-20, 700)).toBe(0);
  expect(hourAt(9999, 700)).toBe(STEPS - 1);
  for (const h of [0, 1, 240, 707]) expect(hourAt(xAt(h, 700), 700)).toBe(h);
  expect(xAt(STEPS - 1, 700)).toBe(700);
});

test('ticks every 5 days', () => {
  expect(ticks().map((t) => t.label)).toEqual(['0', '5 d', '10 d', '15 d', '20 d', '25 d']);
  expect(ticks()[2].h).toBe(240);
});
