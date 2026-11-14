import { DEG, R, spFwd } from './geom';

export interface Tile {
  id: string; file: string; proj: 'spstere' | 'eqc';
  w: number; h: number; dtype: 'int16'; scale: number; offset: number; sigma_h: number;
  x0?: number; y0?: number; px?: number; lon0?: number; lat0?: number; ppd?: number;
  data?: Int16Array;
}

export type Loader = (file: string) => Promise<ArrayBuffer>;

/** Manifest-driven DEM. Tiles finest first; first loaded tile containing the point wins. */
export class Dem {
  sigma = 0; // sigma_h of the tile that served the last sample
  private pending = new Map<string, Promise<void>>();

  constructor(public tiles: Tile[], private load: Loader) {}

  static async open(load: Loader): Promise<Dem> {
    const m = JSON.parse(new TextDecoder().decode(await load('manifest.json')));
    return new Dem(m.tiles, load);
  }

  private fetchTile(t: Tile): Promise<void> {
    if (t.data) return Promise.resolve();
    let p = this.pending.get(t.id);
    if (!p) {
      p = this.load(t.file).then((b) => { t.data = new Int16Array(b); });
      this.pending.set(t.id, p);
    }
    return p;
  }

  /** Load every tile a ray of length `radius` from (lat, lon) can touch. */
  async ensure(lat: number, lon: number, radius = 300e3): Promise<void> {
    // Stereographic is conformal: the ray disk maps to a circle, so its boundary bbox is exact.
    const a = radius / R;
    const la = lat * DEG, lo = lon * DEG;
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity, maxLat = -90;
    for (let k = 0; k < 72; k++) {
      const b = (k * 5) * DEG;
      const plat = Math.asin(Math.sin(la) * Math.cos(a) + Math.cos(la) * Math.sin(a) * Math.cos(b));
      const plon = lo + Math.atan2(Math.sin(b) * Math.sin(a) * Math.cos(la), Math.cos(a) - Math.sin(la) * Math.sin(plat));
      maxLat = Math.max(maxLat, plat / DEG);
      const [x, y] = spFwd(plat / DEG, plon / DEG);
      xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); ymin = Math.min(ymin, y); ymax = Math.max(ymax, y);
    }
    if (lat + a / DEG > 0) maxLat = 90; // disk crosses far from the south pole
    const pad = 1000;
    let covered = false;
    const jobs: Promise<void>[] = [];
    for (const t of this.tiles) {
      if (t.proj === 'spstere') {
        if (maxLat > 0) continue;
        const tx0 = t.x0!, tx1 = t.x0! + (t.w - 1) * t.px!, ty1 = t.y0!, ty0 = t.y0! - (t.h - 1) * t.px!;
        if (xmax + pad < tx0 || xmin - pad > tx1 || ymax + pad < ty0 || ymin - pad > ty1) continue;
        jobs.push(this.fetchTile(t));
        if (xmin >= tx0 && xmax <= tx1 && ymin >= ty0 && ymax <= ty1) covered = true;
      } else if (!covered) {
        jobs.push(this.fetchTile(t));
      }
    }
    await Promise.all(jobs);
  }

  /** Height (m above R) at a unit vector p. Sets this.sigma. 0 if no loaded tile contains it. */
  sampleUnit(px: number, py: number, pz: number): number {
    for (const t of this.tiles) {
      const a = t.data;
      if (!a) continue;
      let c: number, r: number, c0: number, c1: number, r0: number;
      if (t.proj === 'spstere') {
        const k = (2 * R) / (1 - pz); // x = 2R py/(1-pz), y = 2R px/(1-pz): sp_fwd without trig
        c = (k * py - t.x0!) / t.px!;
        r = (t.y0! - k * px) / t.px!;
        if (!(c >= 0 && c <= t.w - 1 && r >= 0 && r <= t.h - 1)) continue;
        c0 = Math.min(Math.floor(c), t.w - 2);
        c1 = c0 + 1;
      } else {
        const lat = Math.asin(Math.max(-1, Math.min(1, pz))) / DEG;
        const lon = Math.atan2(py, px) / DEG;
        c = ((((lon - t.lon0!) % 360) + 360) % 360) * t.ppd!;
        r = Math.max(0, Math.min(t.h - 1, (t.lat0! - lat) * t.ppd!));
        c0 = Math.floor(c) % t.w;
        c1 = (c0 + 1) % t.w;
      }
      r0 = Math.min(Math.floor(r), t.h - 2);
      const fc = c - Math.floor(c), fr = r - r0, w = t.w;
      const v = (a[r0 * w + c0] * (1 - fc) + a[r0 * w + c1] * fc) * (1 - fr)
              + (a[(r0 + 1) * w + c0] * (1 - fc) + a[(r0 + 1) * w + c1] * fc) * fr;
      this.sigma = t.sigma_h;
      return t.offset + t.scale * v;
    }
    this.sigma = 0;
    return 0;
  }

  sample(lat: number, lon: number): number {
    const la = lat * DEG, lo = lon * DEG;
    return this.sampleUnit(Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la));
  }
}
