import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { Dem } from './dem';
import { Ephem } from './ephem';
import { azel } from './geom';
import { horizon } from './horizon';
import { metrics, series } from './series';
import { monteCarlo } from './mc';

const DATA = new URL('../../public/data/', import.meta.url);
const buf = async (p: string) => { const b = await readFile(new URL(p, DATA)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const json = async (p: string) => JSON.parse(await readFile(new URL(p, DATA), 'utf8'));
const angDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

describe('fixture', () => {
  it('horizon matches analytic Gaussian mountain', async () => {
    const fx = await json('fixture/fixture.json');
    const dem = await Dem.open((f) => buf('fixture/dem/' + f));
    await dem.ensure(fx.site.lat, fx.site.lon);
    const h = horizon(dem, fx.site.lat, fx.site.lon, fx.site.mast);
    let worst = 0;
    h.el.forEach((v, i) => { worst = Math.max(worst, Math.abs(v - fx.horizon_el[i])); });
    expect(worst).toBeLessThan(0.05);
    const argmax = h.el.indexOf(Math.max(...h.el));
    expect(angDiff(argmax * 0.5, fx.peak_az)).toBeLessThan(0.5);
  });

  it('Sun and Earth az/el match SPICE', async () => {
    const fx = await json('fixture/fixture.json');
    const eph = new Ephem(await json('ephem.json'), await buf('ephem.bin'));
    for (const r of fx.ephem) {
      const v = eph.at(Date.parse(r.t));
      const s = azel(r.lat, r.lon, r.h, v[0], v[1], v[2]);
      const e = azel(r.lat, r.lon, r.h, v[3], v[4], v[5]);
      expect(angDiff(s.az, r.sun_az)).toBeLessThan(0.005);
      expect(Math.abs(s.el - r.sun_el)).toBeLessThan(0.005);
      expect(angDiff(e.az, r.earth_az)).toBeLessThan(0.005);
      expect(Math.abs(e.el - r.earth_el)).toBeLessThan(0.005);
    }
  });

  it('real DEM georeferencing matches source rasters', async () => {
    const pts = await json('fixture/dem_check.json');
    const dem = await Dem.open((f) => buf('dem/' + f));
    for (const p of pts) {
      await dem.ensure(p.lat, p.lon, 0);
      expect(Math.abs(dem.sample(p.lat, p.lon) - p.h), `${p.lat},${p.lon}`).toBeLessThan(15);
    }
  });
});

describe('real site sanity', () => {
  it('connecting ridge: horizon, series, metrics, MC in range', async () => {
    const dem = await Dem.open((f) => buf('dem/' + f));
    const eph = new Ephem(await json('ephem.json'), await buf('ephem.bin'));
    const site = { lat: -89.474, lon: -137.414, mast: 2 };
    await dem.ensure(site.lat, site.lon);
    const t = performance.now();
    const h = horizon(dem, site.lat, site.lon, site.mast);
    const ms = performance.now() - t;
    const t0 = Date.parse('2026-01-01T00:00:00Z');
    const s = series(eph, site, h, t0, t0 + 365.25 * 86400e3, 3600e3);
    const m = metrics(s);
    const u = monteCarlo(s, h);
    console.log(`horizon ${ms.toFixed(0)} ms; lit ${m.pctLit.toFixed(1)}% earth ${m.pctEarth.toFixed(1)}% longest dark ${m.longestDarkHours} h; MC lit ${u.mean.pctLit.toFixed(1)}±${u.std.pctLit.toFixed(1)}`);
    expect(Math.max(...s.sunEl)).toBeLessThan(2.5);
    expect(m.pctAnyLit).toBeGreaterThan(60);
  });
});
