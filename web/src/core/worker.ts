/// <reference lib="webworker" />
import { Dem } from './dem';
import { Ephem, pickEphem } from './ephem';
import { horizon, type Horizon } from './horizon';
import { monteCarlo } from './mc';
import { metrics, series, type Site } from './series';
import type { Request, ScenarioResult, StripResult } from './api';

let dataBase = ''; // set by the first message from api.ts
const get = async (p: string) => {
  const r = await fetch(dataBase + p);
  if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
  return r.arrayBuffer();
};

const table = async (name: string, dsn?: string) => {
  const [meta, bin, d] = await Promise.all([
    get(name + '.json').then((b) => JSON.parse(new TextDecoder().decode(b))), get(name + '.bin'), dsn ? get(dsn) : undefined,
  ]);
  return new Ephem(meta, bin, d);
};

/** Ephemeris tables in time order: Apollo 1969–1973 (optional per CONTRACT) then 2024–2040. */
let ready: Promise<{ dem: Dem; ephs: Ephem[] }> | null = null;
const init = () => (ready ??= (async () => {
  const [dem, apollo, main] = await Promise.all([
    Dem.open((f) => get('dem/' + f)),
    table('ephem_apollo').catch(() => null),
    table('ephem', 'dsn.bin'), // dsn.bin is aligned with the 2024–2040 table only
  ]);
  return { dem, ephs: apollo ? [apollo, main] : [main] };
})().catch((e) => { ready = null; throw e; }));

// ponytail: unbounded cache, fine for a session's handful of sites; LRU if people script hundreds
const horizons = new Map<string, Promise<Horizon>>();
async function hor(site: Site): Promise<Horizon> {
  const key = `${site.lat.toFixed(6)},${site.lon.toFixed(6)},${site.mast}`;
  let p = horizons.get(key);
  if (!p) {
    p = init().then(async ({ dem }) => {
      await dem.ensure(site.lat, site.lon);
      return horizon(dem, site.lat, site.lon, site.mast);
    });
    horizons.set(key, p);
    p.catch(() => horizons.delete(key));
  }
  return p;
}

async function handle(req: Request): Promise<unknown> {
  const { ephs } = await init();
  switch (req.type) {
    case 'range': {
      const main = ephs[ephs.length - 1];
      return { t0: main.t0, t1: main.t1, ranges: ephs.map((e) => ({ t0: e.t0, t1: e.t1 })) };
    }
    case 'sunVector': {
      const v = pickEphem(ephs, req.t).at(req.t);
      return { sun: [v[0], v[1], v[2]], earth: [v[3], v[4], v[5]] };
    }
    case 'scenario': {
      const h = await hor(req.site);
      // No silent clamp: a shifted or truncated window would be compared as if it were the asked-for one.
      const t0 = req.t, t1 = t0 + (req.days ?? 29.5) * 86400e3, eph = pickEphem(ephs, t0);
      if (t0 < eph.t0 || t1 > eph.t1) throw new Error('window is outside the ephemeris (1969-07-01..1973-01-01, 2024–2040)');
      const s = series(eph, req.site, h, t0, t1, req.stepMs ?? 3600e3, req.earthMargin ?? 0);
      const m = metrics(s);
      const u = req.mc === false ? null : monteCarlo(s, h, req.earthMargin ?? 0);
      if (!eph.hasDsn) { // no DSN table outside 2024–2040
        m.commsHours = NaN;
        if (u) u.mean.commsHours = u.std.commsHours = NaN;
      }
      const res: ScenarioResult = { horizon: h, series: s, metrics: m, uncertainty: u };
      return res;
    }
    case 'strip': {
      const h = await hor(req.site);
      const eph = pickEphem(ephs, req.t0), t0 = eph.clamp(req.t0), t1 = eph.clamp(req.t1);
      const s = series(eph, req.site, h, t0, t1, req.stepMs ?? 3600e3, req.earthMargin ?? 0);
      const res: StripResult = { t0, stepMs: s.stepMs, sunFrac: s.sunFrac, earthVis: s.earthVis };
      return res;
    }
  }
}

self.onmessage = async (ev: MessageEvent<{ id: number; req: Request & { dataBase?: string } }>) => {
  const { id, req } = ev.data;
  if (req.dataBase) dataBase = req.dataBase;
  try {
    self.postMessage({ id, ok: true, value: await handle(req) });
  } catch (e) {
    self.postMessage({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
};
