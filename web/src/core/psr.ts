// Distance to the nearest permanently shadowed region (PSR), from the field built by prep/psr.py.
import { spFwd } from './geom';

export interface PsrMeta { w: number; h: number; px: number; x0: number; y0: number; unit_m: number; min_area_km2: number }

export class PsrField {
  private a: Uint16Array;
  constructor(readonly meta: PsrMeta, buf: ArrayBuffer) { this.a = new Uint16Array(buf); }

  /** Metres to the nearest PSR of at least meta.min_area_km2 (0 inside one); null outside the data (north of about 85°S). */
  distance(lat: number, lon: number): number | null {
    if (lat > -84) return null;
    const { w, h, px, x0, y0, unit_m } = this.meta;
    const [x, y] = spFwd(lat, lon);
    const c = (x - x0) / px, r = (y0 - y) / px;
    if (!(c >= 0 && c <= w - 1 && r >= 0 && r <= h - 1)) return null;
    const c0 = Math.min(Math.floor(c), w - 2), r0 = Math.min(Math.floor(r), h - 2), fc = c - c0, fr = r - r0, a = this.a;
    const v = (a[r0 * w + c0] * (1 - fc) + a[r0 * w + c0 + 1] * fc) * (1 - fr) + (a[(r0 + 1) * w + c0] * (1 - fc) + a[(r0 + 1) * w + c0 + 1] * fc) * fr;
    return v * unit_m;
  }
}
