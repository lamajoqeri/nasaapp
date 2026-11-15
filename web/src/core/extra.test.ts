import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { Dem } from './dem';
import { Ephem } from './ephem';
import { battery, commsHours, dsnAt } from './extra';
import { horizon } from './horizon';
import { series } from './series';

const DATA = new URL('../../public/data/', import.meta.url);
const buf = async (p: string) => { const b = await readFile(new URL(p, DATA)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };
const json = async (p: string) => JSON.parse(await readFile(new URL(p, DATA), 'utf8'));

describe('battery', () => {
  it('charges, drains and dies as specified', () => {
    const f = [...Array(5).fill(1), ...Array(20).fill(0)];
    const r = battery(f, 1, { panelW: 200, loadW: 100, capacityWh: 1000 });
    expect(r.survivalH).toBe(15); // 5 h of Sun, then 1000 Wh / 100 W = 10 h
    expect(r.minSoc).toBe(0);
    expect(battery(Array(10).fill(1), 1).survivalH).toBeNull();
  });
});

describe('matches prep on real sites', () => {
  it('battery and DSN comms hours (fixture/series_check.json)', async () => {
    const checks = await json('fixture/series_check.json');
    const dem = await Dem.open((f) => buf('dem/' + f));
    const meta = await json('ephem.json');
    const eph = new Ephem(meta, await buf('ephem.bin'));
    const dsn = { t0: Date.parse(meta.t0), stepMs: meta.step_s * 1000, bits: new Uint8Array(await buf('dsn.bin')) };
    expect(dsn.bits.length).toBe(meta.n);
    for (const c of checks) {
      const site = { lat: c.lat, lon: c.lon, mast: c.mast };
      await dem.ensure(site.lat, site.lon);
      const t0 = Date.parse(c.t0);
      const s = series(eph, site, horizon(dem, site.lat, site.lon, site.mast), t0, t0 + c.n * c.step_s * 1000, c.step_s * 1000);
      const b = battery(s.sunFrac, 1);
      const ref = c.battery_default.survival_h;
      ref === null ? expect(b.survivalH, c.site).toBeNull() : expect(Math.abs(b.survivalH! - ref), c.site).toBeLessThanOrEqual(1);
      expect(Math.abs(b.minSoc - c.battery_default.min_soc), c.site).toBeLessThan(0.02);
      expect(Math.abs(commsHours(s, dsn)! - c.metrics.comms_hours), c.site).toBeLessThanOrEqual(1);
    }
    expect(dsnAt(dsn, dsn.t0 - 1e9)).toBe(0);
    expect(commsHours({ t: Float64Array.of(0), stepMs: 3600e3, earthVis: Uint8Array.of(1) } as any, dsn)).toBeNull();
  });
});
