import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { Dem } from './dem';
import { spFwd, spInv } from './geom';
import { byLight, discGrid, pgdaAt, slopeAt, terrainAt, terrainSearch } from './terrain';

const DATA = new URL('../../public/data/', import.meta.url);
const buf = async (p: string) => { const b = await readFile(new URL(p, DATA)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

describe('terrain helpers', () => {
  it('slopeAt recovers a planar tilt', () => {
    // a plane rising 10° along map +y (north at lon 0); the stereographic scale at 89°S is 1.0001
    const k = Math.tan((10 * Math.PI) / 180), z = (lat: number, lon: number) => k * spFwd(lat, lon)[1];
    expect(slopeAt(z, -89, 0, 20)).toBeCloseTo(10, 1);
  });
  it('discGrid stays in the disc and includes the centre', () => {
    const g = discGrid(500, 20);
    expect(g.some(([e, n]) => e === 0 && n === 0)).toBe(true);
    expect(Math.max(...g.map(([e, n]) => Math.hypot(e, n)))).toBeLessThanOrEqual(500 + 1e-6);
    expect(g.length).toBeGreaterThan(1900);
    expect(discGrid(3000, 3000 / 25).length).toBeLessThan(2500);
  });
  it('byLight: sun desc, earth desc, nulls last, then nearest', () => {
    const p = (sunPct: number | null, earthPct: number | null, distance_m = 0) => ({ sunPct, earthPct, distance_m });
    const s = [p(null, 90), p(50, 10), p(80, null), p(80, 20, 9), p(80, 20, 3)].sort(byLight);
    expect(s).toEqual([p(80, 20, 3), p(80, 20, 9), p(80, null), p(50, 10), p(null, 90)]);
  });
  it('pgdaAt: nearest pixel, null outside the 150 km disc', () => {
    const r = { w: 2, h: 2, bounds: [-200000, -200000, 200000, 200000], data: new Uint8Array([0, 255, 51, 102]) };
    expect(pgdaAt(r, ...spInv(50000, 50000))).toBeCloseTo(100);   // top right
    expect(pgdaAt(r, ...spInv(-50000, -50000))).toBeCloseTo(20);  // bottom left
    expect(pgdaAt(r, ...spInv(140000, 140000))).toBeNull();        // in the raster, beyond 150 km
    expect(pgdaAt(null, -89, 0)).toBeNull();
  });
});

describe('real DEM: Connecting Ridge', () => {
  it('terrain and search use the 20 m tile', async () => {
    const dem = await Dem.open((f) => buf('dem/' + f));
    const [lat, lon] = [-89.474, -137.414];
    await dem.ensure(lat, lon, 2500);
    const pgda = { sun: null, earth: null }; // PNG decoding needs a browser; covered in the app
    const p = terrainAt(dem, pgda, lat, lon)!;
    expect(p.resolution_m).toBe(20);
    expect(Number.isFinite(p.slope_deg)).toBe(true);
    expect(p.slope_deg).toBeLessThan(15);
    const r = terrainSearch(dem, pgda, lat, lon, 500, 8, 10);
    expect(r.passed).toBeGreaterThan(0);
    expect(r.candidates.length).toBe(Math.min(10, r.passed));
    for (const c of r.candidates) { expect(c.distance_m).toBeLessThanOrEqual(501); expect(c.slope_deg).toBeLessThanOrEqual(8); }
    const d = r.candidates.map((c) => c.distance_m);
    expect(d).toEqual([...d].sort((a, b) => a - b)); // all PGDA null: ranked nearest first
  });
});
