import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { Dem } from '../core/dem';
import { Ephem } from '../core/ephem';
import { azel, horizonAt } from '../core/geom';
import { horizon } from '../core/horizon';
import { frac } from '../core/series';
import { SUN_RADIUS_DEG, sunFractionAt } from './march';

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
