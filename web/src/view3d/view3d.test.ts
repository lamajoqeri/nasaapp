import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { Dem } from '../core/dem';
import { Ephem } from '../core/ephem';
import { azel, horizonAt, spInv } from '../core/geom';
import { horizon } from '../core/horizon';
import { frac } from '../core/series';
import { SUN_RADIUS_DEG, sunFractionAt } from './march';
import { regionAt, regionTiles } from './regions';

const DATA = new URL('../../public/data/', import.meta.url);
const buf = async (p: string) => { const b = await readFile(new URL(p, DATA)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

const LAT = -89.474, LON = -137.414; // Connecting Ridge
// Fixed times in 2027: one every 35 days, plus three inside sunrise/sunset transitions (partial disk).
const TIMES = [
  ...Array.from({ length: 7 }, (_, i) => Date.parse('2027-01-10T00:00:00Z') + i * 35 * 86400e3),
  Date.parse('2027-02-13T08:00:00Z'), Date.parse('2027-07-04T18:00:00Z'), Date.parse('2027-08-27T03:00:00Z'),
];

describe('3D shadow march vs core horizon', () => {
  it('sunFractionAt agrees with horizon() + frac() at the Connecting Ridge', async () => {
    const eph = new Ephem(JSON.parse(new TextDecoder().decode(await buf('ephem.json'))), await buf('ephem.bin'));
    const core = await Dem.open((f) => buf('dem/' + f));
    await core.ensure(LAT, LON);
    const hor = horizon(core, LAT, LON, 0);

    // The view only uploads these two tiles to the GPU.
    const m = JSON.parse(new TextDecoder().decode(await buf('dem/manifest.json')));
    const tiles = m.tiles.filter((t: { id: string }) => t.id === 'shackleton_20m' || t.id === 'sp_240m');
    for (const t of tiles) t.data = new Int16Array(await buf('dem/' + t.file));
    const dem = new Dem(tiles, async () => { throw new Error('preloaded'); });

    let close = 0, lit = 0, dark = 0, partial = 0;
    const rows: string[] = [];
    for (const t of TIMES) {
      const v = eph.at(t);
      const s = azel(LAT, LON, hor.hSite, v[0], v[1], v[2]);
      const want = frac(s.el - horizonAt(hor.el, s.az), SUN_RADIUS_DEG);
      const got = sunFractionAt(dem, v, LAT, LON);
      rows.push(`${new Date(t).toISOString()} core ${want.toFixed(3)} march ${got.toFixed(3)}`);
      if (Math.abs(got - want) <= 0.15) close++;
      if (want === 1) { lit++; expect(got, rows.at(-1)).toBe(1); }
      else if (want === 0) { dark++; expect(got, rows.at(-1)).toBe(0); }
      else partial++;
    }
    console.log(rows.join('\n'));
    expect(close, rows.join('\n')).toBeGreaterThanOrEqual(9);
    expect(lit).toBeGreaterThan(0);
    expect(dark).toBeGreaterThan(0);
    expect(partial).toBeGreaterThan(0);
  });
});

describe('3D regions', () => {
  it('sunFractionAt agrees with core at Malapert Massif (malapert_20m + sp_240m only)', async () => {
    const lat = -85.9891, lon = 0.238;
    const eph = new Ephem(JSON.parse(new TextDecoder().decode(await buf('ephem.json'))), await buf('ephem.bin'));
    const core = await Dem.open((f) => buf('dem/' + f));
    await core.ensure(lat, lon);
    const hor = horizon(core, lat, lon, 0);
    const m = JSON.parse(new TextDecoder().decode(await buf('dem/manifest.json')));
    expect(regionAt(m.tiles, lat, lon)).toBe('malapert_20m');
    const tiles = m.tiles.filter((t: { id: string }) => t.id === 'malapert_20m' || t.id === 'sp_240m');
    for (const t of tiles) t.data = new Int16Array(await buf('dem/' + t.file));
    const dem = new Dem(tiles, async () => { throw new Error('preloaded'); });
    // Fixed times: every 36.5 days through 2027, at varying hours.
    const times = Array.from({ length: 10 }, (_, i) => Date.parse('2027-01-05T00:00:00Z') + i * (36.5 * 86400e3 + 5 * 3600e3));
    let close = 0;
    const rows: string[] = [];
    for (const t of times) {
      const v = eph.at(t);
      const s = azel(lat, lon, hor.hSite, v[0], v[1], v[2]);
      const want = frac(s.el - horizonAt(hor.el, s.az), SUN_RADIUS_DEG);
      const got = sunFractionAt(dem, v, lat, lon);
      rows.push(`${new Date(t).toISOString()} core ${want.toFixed(3)} march ${got.toFixed(3)}`);
      if (Math.abs(got - want) <= 0.15) close++;
    }
    console.log(rows.join('\n'));
    expect(close, rows.join('\n')).toBeGreaterThanOrEqual(9);
    // Those ten happen to be all lit or all dark, so also sweep the year every 7 h for partial-disk cases.
    let n = 0, partial = 0, far = 0;
    for (let t = Date.parse('2027-01-01T00:00:00Z'); t < Date.parse('2028-01-01T00:00:00Z'); t += 7 * 3600e3, n++) {
      const v = eph.at(t);
      const s = azel(lat, lon, hor.hSite, v[0], v[1], v[2]);
      const want = frac(s.el - horizonAt(hor.el, s.az), SUN_RADIUS_DEG);
      if (want > 0 && want < 1) partial++;
      if (Math.abs(sunFractionAt(dem, v, lat, lon) - want) > 0.15) far++;
    }
    console.log(`Malapert 2027 sweep: ${n} times, ${partial} partial, ${far} differ by more than 0.15`);
    expect(partial).toBeGreaterThan(10);
    expect(far / n).toBeLessThan(0.01);
  });

  it('regionAt finds the 20 m tile of each polar site and nothing elsewhere', async () => {
    const m = JSON.parse(new TextDecoder().decode(await buf('dem/manifest.json')));
    expect(regionTiles(m.tiles).map((t) => t.id).sort()).toEqual(['degerlache_20m', 'haworth_20m', 'malapert_20m', 'mouton_nobile_20m', 'shackleton_20m']);
    expect(regionAt(m.tiles, -89.474, -137.414)).toBe('shackleton_20m');
    expect(regionAt(m.tiles, -89.6861, -162.815)).toBe('shackleton_20m');
    const sites: { id: string; lat: number; lon: number }[] = JSON.parse(new TextDecoder().decode(await buf('sites.json')));
    const at = (id: string) => { const s = sites.find((x) => x.id === id)!; return regionAt(m.tiles, s.lat, s.lon); };
    expect(at('malapert')).toBe('malapert_20m');
    expect(at('mons_mouton')).toBe('mouton_nobile_20m');
    expect(at('haworth')).toBe('haworth_20m');
    expect(at('degerlache_rim')).toBe('degerlache_20m');
    expect(regionAt(m.tiles, 0.6741, 23.473)).toBeUndefined();   // Apollo 11
    expect(regionAt(m.tiles, -80, 90)).toBeUndefined();          // polar, but in no 20 m tile
    const t = m.tiles.find((x: { id: string }) => x.id === 'malapert_20m');
    const [lat, lon] = spInv(t.x0 + 500, t.y0 - 5000);            // 500 m inside the edge: within the 1 km margin
    expect(regionAt(m.tiles, lat, lon)).toBeUndefined();
    expect(regionAt(m.tiles, lat, lon, 0)).toBe('malapert_20m');
  });
});
