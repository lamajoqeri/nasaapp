import { describe, expect, it, test } from 'vitest';
import { horizonAt } from '../core/geom';
import {
  chartValues, commsVerdict, contactMask, dayTicks, DURATIONS, elevationRange, formatValue, hourAtX, niceStep, niceTicks, PAD,
  powerPct, powerVerdict, rowMask, runAt, samplesIn, SCENARIO_COLORS, sunClearance, WIN, windows, windowsHeight, windowsHit, windowText, xAtHour,
} from './charts';
import { realResult } from './test-fixture';

const H = 3600e3;
const ser = (sunFrac: number[], earthVis: number[] = sunFrac.map(() => 1)) => ({
  t: Float64Array.from(sunFrac, (_, i) => i * H), stepMs: H, sunFrac: Float32Array.from(sunFrac), earthVis: Uint8Array.from(earthVis),
});
const rep = (v: number, n: number) => Array<number>(n).fill(v);

describe('windows', () => {
  it('merges adjacent samples into [start, end) hours', () => {
    expect(windows([0, 1, 1, 0, 1, 0])).toEqual([{ start: 1, end: 3 }, { start: 4, end: 5 }]);
  });
  it('keeps windows that are open at either edge', () => {
    expect(windows([1, 1, 0, 0, 1])).toEqual([{ start: 0, end: 2 }, { start: 4, end: 5 }]);
  });
  it('handles empty, all-off and all-on masks', () => {
    expect(windows([])).toEqual([]);
    expect(windows([0, 0, 0])).toEqual([]);
    expect(windows([1, 1, 1])).toEqual([{ start: 0, end: 3 }]);
  });
  it('treats any positive fraction as on, and scales by the step', () => {
    expect(windows(Float32Array.of(0, 0.01, 0.6, 0), 0.5)).toEqual([{ start: 0.5, end: 1.5 }]);
    expect(windows(Uint8Array.of(1, 0, 1), 2)).toEqual([{ start: 0, end: 2 }, { start: 4, end: 6 }]);
  });
});

describe('runAt', () => {
  it('finds the on or off run around a sample', () => {
    const m = [1, 1, 0, 0, 0, 1];
    expect(runAt(m, 0)).toEqual({ start: 0, end: 2, on: true });
    expect(runAt(m, 3)).toEqual({ start: 2, end: 5, on: false });
    expect(runAt(m, 5)).toEqual({ start: 5, end: 6, on: true });
    expect(runAt(m, 6)).toBeNull();
    expect(runAt([], 0)).toBeNull();
  });
  it('window text names the run, its length and its end', () => {
    expect(windowText(0, { start: 0, end: 157, on: true }, 708)).toBe('Sunlit for 6 d 13 h, ends day 6.5');
    expect(windowText(0, { start: 157, end: 181, on: false }, 708)).toBe('Dark for 24 h, ends day 7.5');
    expect(windowText(1, { start: 0, end: 708, on: true }, 708)).toBe('Earth in view for all 29.5 d');
    expect(windowText(2, { start: 600, end: 708, on: false }, 708)).toBe('No DSN contact for 4 d 12 h from day 25.0, continues past day 29.5');
  });
});

describe('ticks', () => {
  it('niceStep rounds up to 1, 2 or 5 times a power of ten', () => {
    expect([0.03, 0.1, 1.2, 2, 3, 7, 22, 50].map(niceStep)).toEqual([0.05, 0.1, 2, 2, 5, 10, 50, 50]);
  });
  it('niceTicks cover the range with round values', () => {
    expect(niceTicks(0, 100, 2)).toEqual([0, 50, 100]);
    expect(niceTicks(-6, 6, 4)).toEqual([-10, -5, 0, 5, 10]);
    const t = niceTicks(-3.2, 81.7, 5);
    expect(t[0]).toBeLessThanOrEqual(-3.2);
    expect(t[t.length - 1]).toBeGreaterThanOrEqual(81.7);
    expect(t).toContain(0);
    for (let i = 2; i < t.length; i++) expect(t[i] - t[i - 1]).toBeCloseTo(t[1] - t[0]);
    expect(niceTicks(5, 5).length).toBeGreaterThan(1); // degenerate range still gives an axis
  });
  it('day ticks: daily for a week, every 2 d for 14 d, every 5 d for a lunar day', () => {
    expect(dayTicks(7)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(dayTicks(14)).toEqual([0, 2, 4, 6, 8, 10, 12, 14]);
    expect(dayTicks(29.5)).toEqual([0, 5, 10, 15, 20, 25]);
  });
});

describe('plot geometry', () => {
  it('hourAtX and xAtHour are inverse and clamp', () => {
    for (const d of DURATIONS) for (const h of [0, 1, 37.5, d * 24 - 1]) expect(hourAtX(xAtHour(h, 352, d), 352, d)).toBeCloseTo(h, 6);
    expect(hourAtX(-50, 352, 14)).toBe(0);
    expect(hourAtX(9999, 352, 14)).toBe(14 * 24);
    expect(hourAtX(9999, 352, 29.5)).toBe(707);              // never past the last series sample
    expect(xAtHour(0, 352, 7)).toBe(PAD.l);
    expect(xAtHour(168, 352, 7)).toBe(352 - PAD.r);
  });
  it('windowsHit maps y to a scenario group and one of three rows', () => {
    expect(windowsHit(WIN.top + 1, 2)).toEqual({ scenario: 0, row: 0 });
    expect(windowsHit(WIN.top + WIN.row + WIN.gap + 1, 2)).toEqual({ scenario: 0, row: 1 });
    expect(windowsHit(WIN.top + WIN.pitch + 2 * (WIN.row + WIN.gap) + 2, 2)).toEqual({ scenario: 1, row: 2 });
    expect(windowsHit(WIN.top + WIN.pitch - 3, 2)).toBeNull();   // the gap between groups
    expect(windowsHit(WIN.top + 2 * WIN.pitch + 1, 2)).toBeNull(); // below the last group
    expect(windowsHeight(4)).toBeGreaterThan(windowsHeight(2));
  });
  it('formats readout values', () => {
    expect(formatValue('power', 99.6)).toBe('100%');
    expect(formatValue('power', 0.2)).toBe('<1%');
    expect(formatValue('power', 0)).toBe('0%');
    expect(formatValue('elevation', 1.24)).toBe('+1.2°');
    expect(formatValue('elevation', -0.26)).toBe('−0.3°');
    expect(formatValue('elevation', 0.01)).toBe('0.0°');
  });
  it('scenario colours are four distinct hex colours', () => {
    expect(new Set(SCENARIO_COLORS).size).toBe(4);
    for (const c of SCENARIO_COLORS) expect(c).toMatch(/^#[0-9a-f]{6}$/);
    for (const c of ['#f2b544', '#5b9cf5']) expect(SCENARIO_COLORS).not.toContain(c); // not the Sun or Earth colour
  });
});

describe('elevationRange', () => {
  it('is ±6° when the data fits (polar sites), even when the Sun goes far below', () => {
    expect(elevationRange([[1.2, -0.5, 3]], 3)).toEqual({ lo: -6, hi: 6, ticks: [-6, -3, 0, 3, 6] });
    expect(elevationRange([[2, -40]], 2).lo).toBe(-6);
    expect(elevationRange([], 10).hi).toBe(6);
  });
  it('expands to a round range for high Sun and keeps the zero line', () => {
    const r = elevationRange([[-75, 10, 81.4]], 3);
    expect(r.hi).toBeGreaterThanOrEqual(81.4);
    expect(r.lo).toBeLessThan(0);
    expect(r.lo).toBeGreaterThanOrEqual(-60);   // the night side is clipped, not given half the chart
    expect(r.ticks).toContain(0);
    expect(r.ticks[0]).toBe(r.lo);
    expect(r.hi).toBeLessThanOrEqual(90);        // nothing above the zenith
    expect(Math.max(...r.ticks)).toBeLessThanOrEqual(r.hi);
    expect(elevationRange([[-20, 30]], 2)).toEqual({ lo: -20, hi: 30, ticks: [-20, -10, 0, 10, 20, 30] });
  });
  it('only looks at the first n samples', () => {
    expect(elevationRange([[1, 2, 50]], 2).hi).toBe(6);
  });
});

describe('powerVerdict', () => {
  // default model: 200 W panel, 100 W load, 1500 Wh, starts full. Dark drains 100 Wh/h.
  it('OK when the charge never goes below 20%', () => {
    const v = powerVerdict(ser(rep(1, 48)), 48);
    expect(v).toMatchObject({ level: 'ok', label: 'OK', minSoc: 1, survivalHours: null });
    expect(v.detail).toBe('lowest charge 100%');
  });
  it('exactly 20% is still OK; one hour more is Marginal', () => {
    expect(powerVerdict(ser([...rep(0, 12), ...rep(1, 12)]), 24)).toMatchObject({ level: 'ok', detail: 'lowest charge 20%' });
    const m = powerVerdict(ser([...rep(0, 13), ...rep(1, 11)]), 24);
    expect(m).toMatchObject({ level: 'marginal', label: 'Marginal', survivalHours: null });
    expect(m.detail).toBe('lowest charge 13%');
  });
  it('No when the battery empties, and says after how long', () => {
    const v = powerVerdict(ser([...rep(1, 5), ...rep(0, 30)]), 35);
    expect(v).toMatchObject({ level: 'no', label: 'No', survivalHours: 20 });
    expect(v.detail).toBe('empty after 20 h');
  });
  it('only the mission duration counts', () => {
    const s = ser([...rep(1, 24), ...rep(0, 48)]);
    expect(powerVerdict(s, 24).level).toBe('ok');
    expect(powerVerdict(s, 24 + 13).level).toBe('marginal');
    expect(powerVerdict(s, 72).level).toBe('no');
    expect(samplesIn(s, 1000)).toBe(72);   // longer than the series: the whole series
    expect(samplesIn(s, 0)).toBe(1);
  });
  it('a half-lit Sun exactly carries the load', () => {
    expect(powerVerdict(ser(rep(0.5, 100)), 100)).toMatchObject({ level: 'ok', minSoc: 1 });
  });
});

describe('commsVerdict', () => {
  const dsnOn = (n: number) => ({ commsHours: 1, dsn: new Uint8Array(n).fill(1) });
  const noData = (n: number) => ({ commsHours: null, dsn: new Uint8Array(n) });
  it('OK with continuous contact', () => {
    expect(commsVerdict(ser(rep(1, 48)), dsnOn(48), 48)).toMatchObject({ level: 'ok', label: 'OK', detail: 'no gaps', basis: 'dsn', longestGapHours: 0 });
  });
  it('a gap of exactly 24 h is OK; 25 h is Gaps', () => {
    const at = (gap: number) => commsVerdict(ser(rep(1, 72), [...rep(1, 10), ...rep(0, gap), ...rep(1, 62 - gap)]), dsnOn(72), 72);
    expect(at(24)).toMatchObject({ level: 'ok', detail: 'longest gap 24 h', longestGapHours: 24 });
    expect(at(25)).toMatchObject({ level: 'gaps', label: 'Gaps', detail: 'longest gap 25 h', longestGapHours: 25 });
  });
  it('No when there is no contact at all', () => {
    expect(commsVerdict(ser(rep(1, 48), rep(0, 48)), dsnOn(48), 48)).toMatchObject({ level: 'no', label: 'No', detail: 'no contact in 2 d' });
  });
  it('DSN contact needs Earth in view AND a station', () => {
    const s = ser(rep(1, 60), rep(1, 60)), m = { commsHours: 1, dsn: Uint8Array.from(rep(0, 60), (_, i) => (i < 20 ? 1 : 0)) };
    expect([...contactMask(s, m)].reduce((a, b) => a + b, 0)).toBe(20);
    expect(commsVerdict(s, m, 60)).toMatchObject({ level: 'gaps', longestGapHours: 40, basis: 'dsn' });
    expect(commsVerdict(s, { commsHours: 1, dsn: new Uint8Array(60) }, 60).level).toBe('no'); // Earth up, no station
  });
  it('without station data (Apollo era) Earth in view is used', () => {
    const v = commsVerdict(ser(rep(1, 48), rep(1, 48)), noData(48), 48);
    expect(v).toMatchObject({ level: 'ok', basis: 'earth' });
    expect(commsVerdict(ser(rep(1, 48), rep(0, 48)), noData(48), 48)).toMatchObject({ level: 'no', basis: 'earth' });
  });
  it('gaps that run into either end of the mission count; time after the mission does not', () => {
    const lead = commsVerdict(ser(rep(1, 60), [...rep(0, 30), ...rep(1, 30)]), dsnOn(60), 60);
    expect(lead).toMatchObject({ level: 'gaps', longestGapHours: 30 });
    const trail = commsVerdict(ser(rep(1, 60), [...rep(1, 30), ...rep(0, 30)]), dsnOn(60), 60);
    expect(trail).toMatchObject({ level: 'gaps', longestGapHours: 30 });
    expect(commsVerdict(ser(rep(1, 60), [...rep(1, 30), ...rep(0, 30)]), dsnOn(60), 40)).toMatchObject({ level: 'ok', longestGapHours: 10 });
  });
});

test('series extraction on a real scenario (Connecting Ridge, 2027-06-20)', async () => {
  const r = await realResult();
  const s = r.series, p = powerPct(r), c = sunClearance(r);
  expect(p.length).toBe(708);
  expect(c.length).toBe(708);
  expect(powerPct(r)).toBe(p);                      // cached per result
  let lit = 0;
  for (let i = 0; i < 708; i++) {
    expect(p[i]).toBeCloseTo(s.sunFrac[i] * 100, 3);
    expect(p[i]).toBeGreaterThanOrEqual(0);
    expect(p[i]).toBeLessThanOrEqual(100);
    expect(c[i]).toBeCloseTo(s.sunEl[i] - horizonAt(r.horizon.el, s.sunAz[i]), 5);
    // the chart's zero line agrees with the lighting: clear of the terrain by a disk radius = fully lit, and the reverse
    if (c[i] >= s.sunRadius[i]) expect(s.sunFrac[i]).toBe(1);
    if (c[i] <= -s.sunRadius[i]) expect(s.sunFrac[i]).toBe(0);
    if (c[i] > 0) expect(s.sunFrac[i]).toBeGreaterThan(0.5);
    if (s.sunFrac[i] > 0) lit++;
  }
  expect(lit).toBeGreaterThan(50);
  expect(Math.max(...c)).toBeLessThan(6);           // a polar site: fits the default ±6° range
  expect(elevationRange([c], 336)).toMatchObject({ lo: -6, hi: 6 });

  // windows bar rows, and the sum of sunlit windows equals the lit hours
  expect(rowMask(r, 0)).toBe(s.sunFrac);
  expect(rowMask(r, 1)).toBe(s.earthVis);
  const dsn = rowMask(r, 2)!;
  expect(dsn.length).toBe(708);
  expect(windows(s.sunFrac).reduce((a, w) => a + w.end - w.start, 0)).toBe(lit);
  const contact = Array.from(dsn).reduce((a, b) => a + b, 0);
  expect(contact).toBe(r.mission.commsHours);       // the same count the Details table shows
  expect(rowMask({ ...r, mission: { ...r.mission, commsHours: null } }, 2)).toBeNull();

  // uncertainty band brackets nothing impossible and the verdicts agree with the app's own battery result
  const u = r.uncertainty!;
  for (let i = 0; i < 708; i++) expect(u.fracLo[i]).toBeLessThanOrEqual(u.fracHi[i]);
  const full = powerVerdict(s, 708);
  expect(full.survivalHours).toBe(r.mission.battery.survivalH);
  if (r.mission.battery.survivalH === null) expect(full.minSoc).toBeCloseTo(r.mission.battery.minSoc, 6);
  const cv = commsVerdict(s, r.mission, 14 * 24);
  expect(['ok', 'gaps', 'no']).toContain(cv.level);
  expect(cv.basis).toBe('dsn');

  const m = { metric: 'power' as const, durationDays: 14, selected: 0, items: [{ letter: 'A', color: '#fff', result: r }, { letter: 'B', color: '#000' }] };
  expect(chartValues(m, 10.4)).toEqual([p[10], null]);
  expect(chartValues({ ...m, metric: 'elevation' }, 9999)[0]).toBe(c[707]);
});
