/// <reference lib="webworker" />
import { Dem } from './dem';
import { Ephem } from './ephem';
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

let ready: Promise<{ dem: Dem; eph: Ephem }> | null = null;
const init = () => (ready ??= (async () => {
  const [dem, meta, bin] = await Promise.all([
    Dem.open((f) => get('dem/' + f)),
    get('ephem.json').then((b) => JSON.parse(new TextDecoder().decode(b))),
    get('ephem.bin'),
  ]);
  return { dem, eph: new Ephem(meta, bin) };
})());

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
  const { eph } = await init();
  switch (req.type) {
    case 'range':
      return { t0: eph.t0, t1: eph.t1 };
    case 'scenario': {
      const h = await hor(req.site);
      const t0 = eph.clamp(req.t);
      const t1 = eph.clamp(t0 + (req.days ?? 29.5) * 86400e3);
      const s = series(eph, req.site, h, t0, t1, req.stepMs ?? 3600e3, req.earthMargin ?? 0);
      const m = metrics(s);
      const u = req.mc === false ? null : monteCarlo(s, h, req.earthMargin ?? 0);
      const res: ScenarioResult = { horizon: h, series: s, metrics: m, uncertainty: u };
      return res;
    }
    case 'strip': {
      const h = await hor(req.site);
      const t0 = eph.clamp(req.t0), t1 = eph.clamp(req.t1);
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
    self.postMessage({ id, ok: false, error: String(e) });
  }
};
