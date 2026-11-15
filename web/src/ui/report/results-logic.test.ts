import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { CommsVerdict, PowerVerdict } from '../charts';
import { abstractHtml, agreementFor, bestWindow, longTerm, ranked, recommendation, tileAt, versus, type Summary, type ValidationJson } from './results-logic';

const DATA = new URL('../../../public/data/', import.meta.url);
const json = async (p: string) => JSON.parse(await readFile(new URL(p, DATA), 'utf8'));

const NOW = Date.UTC(2026, 10, 15);
const P = { ok: 'OK', marginal: 'Marginal', no: 'No' } as const, C = { ok: 'OK', gaps: 'Gaps', no: 'No' } as const;
function sum(letter: string, power: number, earth: number, pv: keyof typeof P, cv: keyof typeof C): Summary {
  return {
    letter, name: `Site ${letter}`, t: Date.UTC(2027, 5, 20), lat: -89.474, lon: -137.414,
    power, powerSd: 1.2, anyLit: power, anyLitSd: null, dark: 12, darkSd: 0.2, earth, earthSd: 0, noEarth: 30, noEarthSd: null,
    pv: { level: pv, label: P[pv], detail: pv === 'ok' ? 'lowest charge 80%' : 'lowest charge 12%', minSoc: 0.12, survivalHours: null } as PowerVerdict,
    cv: { level: cv, label: C[cv], detail: cv === 'ok' ? 'no gaps' : 'longest gap 3 d', basis: 'dsn', longestGapHours: 72 } as CommsVerdict,
  };
}

describe('ranking and recommendation', () => {
  it('ranks by summed verdicts first, then power, then Earth', () => {
    const a = sum('A', 95, 50, 'ok', 'gaps'), b = sum('B', 60, 50, 'ok', 'ok'), c = sum('C', 60, 70, 'ok', 'ok'), d = sum('D', 99, 99, 'no', 'ok');
    expect(ranked([a, b, c, d]).map((s) => s.letter)).toEqual(['C', 'B', 'A', 'D']);
  });

  it('words one scenario as pass or fail against the criterion', () => {
    expect(recommendation([sum('A', 90, 60, 'ok', 'ok')], 14, NOW)).toMatch(/^We recommend scenario A \(Site A\): it meets our criterion that power and comms are both OK over the 14-day mission\.$/);
    const f = recommendation([sum('A', 90, 60, 'marginal', 'gaps')], 7, NOW);
    expect(f).toContain('We do not recommend scenario A');
    expect(f).toContain('power Marginal (lowest charge 12%) and comms Gaps (longest gap 3 d)');
  });

  it('names the winner, the criterion, ties and a winner that still fails', () => {
    const r = recommendation([sum('A', 70, 60, 'ok', 'ok'), sum('B', 90, 60, 'ok', 'ok'), sum('C', 50, 40, 'no', 'no')], 29.5, NOW);
    expect(r).toMatch(/^We recommend scenario B \(Site B\): it comes first when the three scenarios are ranked by their summed power and comms verdicts over the 29\.5-day mission \(OK 2, Marginal or Gaps 1, No 0\), then by mean solar power, then by time with Earth in view\.$/);
    expect(r).not.toContain('No scenario passes');
    const t = recommendation([sum('A', 90.2, 60, 'ok', 'ok'), sum('B', 89.8, 60.4, 'ok', 'ok')], 14, NOW);
    expect(t).toContain('We recommend scenarios A (Site A) and B (Site B) equally');
    const g = recommendation([sum('A', 90, 60, 'ok', 'gaps'), sum('B', 80, 60, 'marginal', 'gaps')], 14, NOW);
    expect(g).toMatch(/^No scenario passes both checks, so we do not recommend any of them as planned\. Scenario A \(Site A\) comes first when .*; A has comms Gaps/);
  });

  it('recommends among future landings and keeps past ones as references', () => {
    const apollo = { ...sum('D', 99, 100, 'ok', 'ok'), t: Date.UTC(1969, 6, 20) };
    const r = recommendation([sum('A', 70, 60, 'no', 'gaps'), sum('B', 60, 60, 'no', 'ok'), apollo], 14, NOW);
    expect(r).toMatch(/^No future landing passes both checks, so we do not recommend any of them as planned\. Scenario B \(Site B\) comes first when the two future landings are ranked/);
    expect(r).toContain('D (Site D) landed in the past and serves only as a reference.');
    expect(recommendation([apollo], 14, NOW)).toMatch(/^We recommend scenario D/); // only past landings: compare them anyway
  });
});

describe('abstract', () => {
  it('reads for one and for several scenarios, with numbers from validation.json', async () => {
    const v: ValidationJson = await json('validation.json');
    const one = abstractHtml([sum('A', 92, 55, 'ok', 'gaps')], 14, v, NOW);
    expect(one).toContain('We compare one landing scenario');
    expect(one).toContain('Over the 14-day mission, A has mean solar power 92% ± 1% of rated, Earth in view 55% of the time, longest dark period 12 h; power OK, comms Gaps.');
    expect(one).toContain('0.072″ and 0.43″ at worst');
    expect(one).toContain('to a mean 1.0–1.5 (Sun) and 0.6–2.4 (Earth) percentage points in five 20 m test regions');
    const three = abstractHtml([sum('A', 92, 55, 'ok', 'ok'), sum('B', 80, 50, 'ok', 'ok'), sum('C', 30, 99, 'no', 'ok')], 7, v, NOW);
    expect(three).toContain('We compare three landing scenarios');
    expect(three).toContain('Over the 7-day mission, mean solar power runs from 30% ± 1% (C) to 92% ± 1% (A) of rated, Earth is in view from 50% (B) to 99% (C) of the time, and the longest dark period is 12 h everywhere. Power is OK at A and B, No at C; comms is OK at A, B and C.');
    expect(three).not.toMatch(/undefined|NaN/);
    const words = three.replace(/<[^>]+>/g, '').split(/\s+/).length;
    expect(words).toBeGreaterThan(120);
    expect(words).toBeLessThan(230);
  });
});

describe('validation lookups', () => {
  it('picks the tile and validation row a site uses', async () => {
    const v: ValidationJson = await json('validation.json'), { tiles } = await json('dem/manifest.json');
    expect(agreementFor(v, tileAt(tiles, -89.474, -137.414))?.a).toBe(v.pgda); // Connecting Ridge, Shackleton 20 m tile
    expect(agreementFor(v, tileAt(tiles, -85.9891, 0.238))?.a).toBe(v.pgda_other_regions.malapert);
    expect(tileAt(tiles, -87.5, 100)?.id).toBe('sp_240m');
    expect(agreementFor(v, tileAt(tiles, -87.5, 100))?.a).toBe(v.pgda_240m_only_region);
    expect(tileAt(tiles, 0.6741, 23.473)?.id).toBe('global_8ppd'); // Apollo 11
    expect(agreementFor(v, tileAt(tiles, 0.6741, 23.473))).toBeNull();
  });

  it('long-term shares, the comparison with NASA and the best window', () => {
    expect(longTerm([0, 0.2, 1, 0], [1, 1, 0, 0])).toEqual({ sun: 50, earth: 50 });
    expect(versus(88.8, 88, 1.5)).toEqual({ within: true, text: "+0.8 pts, within the region's mean error of 1.5 pts" });
    expect(versus(80, 84.05, 1.5).text).toBe("−4.0 pts, 2.7× the region's mean error of 1.5 pts");
    expect(bestWindow([0, 1, 1, 0, 1], 2)).toEqual({ i: 1, mean: 1 });
    expect(bestWindow([3], 5)).toEqual({ i: 0, mean: 3 });
  });
});
