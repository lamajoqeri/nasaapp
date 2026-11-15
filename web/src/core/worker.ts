/// <reference lib="webworker" />
import { Dem } from './dem';
import { Ephem } from './ephem';
import { horizon, type Horizon } from './horizon';
import { battery, commsHours, type Dsn } from './extra';
import { monteCarlo } from './mc';
import { metrics, series, type Site } from './series';
import { terrainAt, terrainSearch, type Pgda, type Raster } from './terrain';
import type { Mission, Request, ScenarioResult, StripResult } from './api';

let dataBase = ''; // set by the first message from api.ts
const get = async (p: string) => {
  const r = await fetch(dataBase + p);
  if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
  return r.arrayBuffer();
};

const text = (b: ArrayBuffer) => JSON.parse(new TextDecoder().decode(b));
const table = async (name: string) => new Ephem(text(await get(name + '.json')), await get(name + '.bin'));

/** ephs[0] is the main 2024-2040 table; an optional 1969-1972 table follows so Apollo sites can use their real dates. */
let ready: Promise<{ dem: Dem; ephs: Ephem[]; dsn: Dsn | null }> | null = null;
const init = () => (ready ??= (async () => {
  const [dem, eph, apollo, dsnBits] = await Promise.all([
    Dem.open((f) => get('dem/' + f)),
    table('ephem'),
    table('ephem_apollo').catch(() => null), // optional
    get('dsn.bin').catch(() => null),        // optional
  ]);
  const dsn = dsnBits ? { t0: eph.t0, stepMs: eph.stepMs, bits: new Uint8Array(dsnBits) } : null;
  return { dem, ephs: apollo ? [eph, apollo] : [eph], dsn };
})().catch((e) => { ready = null; throw e; }));

const OUTSIDE = 'that date is outside the ephemeris (2024–2040, plus 1969–1972 for the Apollo landings)';
/** The table that fully contains [t0, t1], or the one containing t0 when t1 is omitted. */
function pick(ephs: Ephem[], t0: number, t1 = t0): Ephem {
  const e = ephs.find((x) => t0 >= x.t0 && t1 <= x.t1);
  if (!e) throw new Error(OUTSIDE);
  return e;
}

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

/** DSN station bits per series sample (0 when no table covers it). */
function dsnBits(s: { t: Float64Array }, d: Dsn | null): Uint8Array {
  const out = new Uint8Array(s.t.length);
  if (d) for (let i = 0; i < out.length; i++) { const k = Math.round((s.t[i] - d.t0) / d.stepMs); out[i] = k >= 0 && k < d.bits.length ? d.bits[k] : 0; }
  return out;
}

/** The PGDA sp_sun / sp_earth PNGs, decoded once to their gray channel. A map that fails to load reads as null. */
let pgda: Promise<Pgda> | null = null;
const loadPgda = () => (pgda ??= (async () => {
  const index: { id: string; file: string; bounds?: number[] }[] = await get('maps/index.json').then(text, () => []);
  const one = async (id: string): Promise<Raster | null> => {
    const m = index.find((x) => x.id === id);
    if (!m?.bounds) return null;
    try {
      const bmp = await createImageBitmap(new Blob([await get('maps/' + m.file)]), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      const g = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d')!;
      g.drawImage(bmp, 0, 0);
      const px = g.getImageData(0, 0, bmp.width, bmp.height).data, data = new Uint8Array(bmp.width * bmp.height);
      for (let i = 0; i < data.length; i++) data[i] = px[i * 4];
      return { w: bmp.width, h: bmp.height, bounds: m.bounds, data };
    } catch { return null; }
  };
  const [sun, earth] = await Promise.all([one('sp_sun'), one('sp_earth')]);
  return { sun, earth };
})());

async function handle(req: Request): Promise<unknown> {
  const { dem, ephs, dsn } = await init();
  switch (req.type) {
    case 'range':
      return { t0: ephs[0].t0, t1: ephs[0].t1, ranges: ephs.map((e) => ({ t0: e.t0, t1: e.t1 })) };
    case 'scenario': {
      const h = await hor(req.site);
      // No silent clamp: a shifted or truncated window would be compared as if it were the asked-for one.
      const t0 = req.t, t1 = t0 + (req.days ?? 29.5) * 86400e3;
      const eph = pick(ephs, t0, t1);
      const s = series(eph, req.site, h, t0, t1, req.stepMs ?? 3600e3, req.earthMargin ?? 0);
      const m = metrics(s);
      const u = req.mc === false ? null : monteCarlo(s, h, req.earthMargin ?? 0);
      const stepH = s.stepMs / 3600e3;
      const mission: Mission = { commsHours: commsHours(s, dsn), battery: battery(s.sunFrac, stepH, req.power), dsn: dsnBits(s, dsn) };
      const res: ScenarioResult = { horizon: h, series: s, metrics: m, uncertainty: u, mission };
      return res;
    }
    case 'strip': {
      const h = await hor(req.site);
      const eph = pick(ephs, req.t0);
      const t0 = eph.clamp(req.t0), t1 = eph.clamp(req.t1);
      const s = series(eph, req.site, h, t0, t1, req.stepMs ?? 3600e3, req.earthMargin ?? 0);
      const res: StripResult = { t0, stepMs: s.stepMs, sunFrac: s.sunFrac, earthVis: s.earthVis };
      return res;
    }
    case 'terrain':
    case 'terrainSearch': {
      const radius = req.type === 'terrain' ? 0 : req.radius ?? 500;
      const [p] = await Promise.all([loadPgda(), dem.ensure(req.lat, req.lon, radius + 2000)]); // + room for the ±px slope stencil
      return req.type === 'terrain' ? terrainAt(dem, p, req.lat, req.lon) : terrainSearch(dem, p, req.lat, req.lon, radius, req.maxSlope, req.limit);
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
