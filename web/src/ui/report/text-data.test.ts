import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REFS } from './refs';
import { span, tileAt, tileRes } from './text-data';

const data = (f: string) => JSON.parse(readFileSync(new URL(`../../../public/data/${f}`, import.meta.url), 'utf8'));
const { tiles } = data('dem/manifest.json');

describe('report text data', () => {
  it('finds the tile that serves a point, finest first', () => {
    expect(tileAt(tiles, -89.474, -137.414)?.id).toBe('shackleton_20m'); // Connecting Ridge
    expect(tileAt(tiles, -85.9891, 0.238)?.id).toBe('malapert_20m');
    expect(tileAt(tiles, -82, 100)?.id).toBe('sp_240m');
    expect(tileAt(tiles, 0.6741, 23.473)?.id).toBe('global_8ppd'); // Apollo 11
    expect(Math.round(tileRes(tileAt(tiles, 0.6741, 23.473)!))).toBe(3790);
  });

  it('reads the ephemeris span', () => {
    const [t0, t1] = span(data('ephem.json'));
    expect(new Date(t0).toISOString().slice(0, 10)).toBe('2024-01-01');
    expect(new Date(t1).toISOString().slice(0, 10)).toBe('2040-01-01');
  });

  it('has unique reference keys, including every key the other sections cite', () => {
    const keys = REFS.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of ['mazarico2011', 'barker2023', 'barker2021', 'ldem16', 'de440', 'spice', 'horizons', 'lroc', 'derosa2012', 'glaser2014', 'dsn']) expect(keys).toContain(k);
  });
});
