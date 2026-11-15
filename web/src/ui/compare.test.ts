import { expect, test } from 'vitest';
import { bestOf, compareTable } from './compare';
import type { Row } from './format';

const row = (num: number | null, o: Partial<Row> = {}): Row => ({ key: 'lit', label: 'Sunlit', text: String(num), sd: '', num, f: String, eps: 0.5, good: 1, ...o });
const best = (...r: (Row | undefined)[]) => [...bestOf(r)];

test('higher is better, lower is better, neutral is unmarked', () => {
  expect(best(row(83), row(78), row(40))).toEqual([0]);
  expect(best(row(73, { good: -1 }), row(50, { good: -1 }))).toEqual([1]);
  expect(best(row(1, { good: 0 }), row(5, { good: 0 }))).toEqual([]);
});

test('ties: all equal marks nothing, a shared lead marks both', () => {
  expect(best(row(708), row(708))).toEqual([]);
  expect(best(row(708), row(707.8), row(300))).toEqual([0, 1]);
});

test('missing results and null values are skipped; a lone value is unmarked', () => {
  expect(best(row(10), undefined, row(null))).toEqual([]);
  expect(best(row(10), undefined, row(null), row(20))).toEqual([3]);
});

test('state rows: the good state wins, then the direction within that state', () => {
  const lit = (h: number) => row(h, { key: 'sunEvent', label: 'Sunset in', ok: true, good: 1 });
  const dark = (h: number) => row(h, { key: 'sunEvent', label: 'Sunrise in', ok: false, good: -1 });
  expect(best(dark(2), lit(5))).toEqual([1]);            // lit now beats a short wait for sunrise
  expect(best(lit(5), lit(200), dark(1))).toEqual([1]);  // later sunset is better
  expect(best(dark(300), dark(12))).toEqual([1]);        // sooner sunrise is better
  const batt = (h: number, ok: boolean) => row(h, { key: 'battery', ok });
  expect(best(batt(708, true), batt(708, true))).toEqual([]);
  expect(best(batt(708, true), batt(200, false))).toEqual([0]);
});

test('compareTable marks the best cell and shows slip deltas', () => {
  const col = (letter: string, lit: number, slipLit?: number) => ({
    letter, name: `Site <${letter}>`, when: '2027-06-20 00:00 UTC', selected: letter === 'A',
    rows: [row(lit, { text: `${lit}%` })], cmp: [row(lit)], srows: slipLit === undefined ? undefined : [row(slipLit)],
  });
  const plain = compareTable([col('A', 83), col('B', 78)], 0);
  expect(plain.match(/class="best"/g)?.length).toBe(1);
  expect(plain).toContain('Site &#60;A&#62;');
  expect(plain).not.toContain('class="d ');
  const slipped = compareTable([col('A', 83, 90), col('B', 78, 70)], 21);
  expect(slipped).toContain('class="d good"');
  expect(slipped).toContain('class="d bad"');
});

test('event rows read as sentences, including when the event never happens', () => {
  const ev = (label: string, text: string, num: number, ok: boolean): Row => row(num, { key: 'earthEvent', label, text, ok, good: ok ? 1 : -1 });
  const col = (letter: string, r: Row) => ({ letter, name: letter, when: '', selected: false, rows: [r] });
  const html = compareTable([
    col('A', ev('Earthset in', 'none in 29.5 d', 708, true)),
    col('B', ev('Earthrise in', '2 d 7 h', 55, false)),
    col('C', ev('Earthrise in', 'not within 29.5 d', 708, false)),
    col('D', { ...ev('Sunset in', '<1 h', 0, true), key: 'earthEvent' }),
  ], 0);
  expect(html).toContain('no Earthset in 29.5 d');
  expect(html).toContain('<small>Earthrise in</small> 2 d 7 h');
  expect(html).toContain('no Earthrise in 29.5 d');
  expect(html).toContain('<small>sunset in</small> &#60;1 h');
  expect(html).not.toMatch(/in none|in not/);
});
