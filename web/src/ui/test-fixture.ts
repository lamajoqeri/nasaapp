// Test helper (node only, never imported by the app): a real ScenarioResult built the way core/worker.ts builds one.
import { readFile } from 'node:fs/promises';
import type { Mission, ScenarioResult } from '../core/api';
import { Dem } from '../core/dem';
import { Ephem } from '../core/ephem';
import { battery, commsHours, dsnAt } from '../core/extra';
import { horizon } from '../core/horizon';
import { monteCarlo } from '../core/mc';
import { metrics, series } from '../core/series';

const DATA = new URL('../../public/data/', import.meta.url);
const buf = async (p: string) => { const b = await readFile(new URL(p, DATA)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; };
const json = async (p: string) => JSON.parse(await readFile(new URL(p, DATA), 'utf8'));

let ready: Promise<{ dem: Dem; eph: Ephem; dsn: { t0: number; stepMs: number; bits: Uint8Array } }> | undefined;
const init = () => (ready ??= (async () => {
  const meta = await json('ephem.json');
  const eph = new Ephem(meta, await buf('ephem.bin'));
  return { dem: await Dem.open((f) => buf('dem/' + f)), eph, dsn: { t0: Date.parse(meta.t0), stepMs: meta.step_s * 1000, bits: new Uint8Array(await buf('dsn.bin')) } };
})());

export const CONNECTING_RIDGE = { lat: -89.474, lon: -137.414, mast: 2 };

/** 29.5 d hourly from `iso`, with Monte Carlo and the mission block. */
export async function realResult(site = CONNECTING_RIDGE, iso = '2027-06-20T00:00:00Z'): Promise<ScenarioResult> {
  const { dem, eph, dsn } = await init();
  await dem.ensure(site.lat, site.lon);
  const h = horizon(dem, site.lat, site.lon, site.mast);
  const t0 = Date.parse(iso);
  const s = series(eph, site, h, t0, t0 + 29.5 * 86400e3, 3600e3);
  const mission: Mission = { commsHours: commsHours(s, dsn), battery: battery(s.sunFrac, 1), dsn: Uint8Array.from(s.t, (t) => dsnAt(dsn, t)) };
  return { horizon: h, series: s, metrics: metrics(s), uncertainty: monteCarlo(s, h), mission };
}
