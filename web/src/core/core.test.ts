import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { Dem } from './dem';
import { Ephem } from './ephem';
import { azel } from './geom';
import { horizon } from './horizon';
import { metrics, series } from './series';
import { monteCarlo } from './mc';
import { landingT } from '../ui/format';

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

describe('matches prep/geom.py on real sites (fixture/series_check.json)', () => {
  it('sun_frac, Earth clearance, metrics, MC spread', async () => {
    const checks = await json('fixture/series_check.json');
    const dem = await Dem.open((f) => buf('dem/' + f));
    const eph = new Ephem(await json('ephem.json'), await buf('ephem.bin'));
    for (const c of checks) {
      const site = { lat: c.lat, lon: c.lon, mast: c.mast };
      await dem.ensure(site.lat, site.lon);
      const h = horizon(dem, site.lat, site.lon, site.mast);
      const t0 = Date.parse(c.t0);
      const s = series(eph, site, h, t0, t0 + c.n * c.step_s * 1000, c.step_s * 1000);
      expect(s.t.length, c.site).toBe(c.n);
      c.horizon_el_every_10deg.forEach((v: number, i: number) => expect(Math.abs(h.el[i * 20] - v), `${c.site} hor ${i * 10}`).toBeLessThan(0.02));
      let bad = 0;
      for (let i = 0; i < c.n; i++) {
        const d = Math.abs(s.sunFrac[i] - c.sun_frac[i]);
        expect(d, `${c.site} sunFrac[${i}]`).toBeLessThan(0.05);
        if (d > 0.01) bad++;
      }
      expect(bad, `${c.site} steps off by >0.01`).toBeLessThanOrEqual(3);
      const m = metrics(s), r = c.metrics;
      const hrs: [number | null, number | null][] = [
        [m.hoursToSunset, r.hours_to_sunset], [m.hoursToSunrise, r.hours_to_sunrise],
        [m.hoursToEarthset, r.hours_to_earthset], [m.hoursToEarthrise, r.hours_to_earthrise],
        [m.longestDarkHours, r.longest_dark_h], [m.dteHours, r.dte_hours], [m.longestNoEarthHours, r.longest_no_earth_h],
      ];
      for (const [a, b] of hrs) b === null ? expect(a, c.site).toBeNull() : expect(Math.abs(a! - b), c.site).toBeLessThanOrEqual(1);
      expect(Math.abs(m.pctLit / 100 - r.pct_lit), c.site).toBeLessThan(0.01);
      const u = monteCarlo(s, h);
      const std = u.std.pctLit / 100;
      if (c.pct_lit_std < 1e-4) expect(std, c.site).toBeLessThan(1e-3);
      else { expect(std / c.pct_lit_std, `${c.site} MC std ratio`).toBeLessThan(1.5); expect(c.pct_lit_std / std, `${c.site} MC std ratio`).toBeLessThan(1.5); }
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

describe('catalogue landing times', () => {
  it('Apollo 11: Sun at the sites.json touchdown time is ~10.7° (historical 10.8°)', async () => {
    const a11 = (await json('sites.json')).find((s: { id: string }) => s.id === 'apollo11');
    const eph = new Ephem(await json('ephem_apollo.json'), await buf('ephem_apollo.bin'));
    const v = eph.at(landingT(a11.date));
    expect(Math.abs(azel(a11.lat, a11.lon, 0, v[0], v[1], v[2]).el - 10.7)).toBeLessThan(0.1);
  });
});
