export interface EphemMeta { t0: string; step_s: number; n: number }

/** Hourly Sun/Earth vectors (km, Moon centre -> body, MOON_ME). Linear interpolation. */
export class Ephem {
  readonly t0: number;     // ms
  readonly t1: number;     // ms, last valid instant
  readonly stepMs: number;
  private a: Float32Array;
  private dsn?: Uint8Array;

  /** dsn: optional dsn.bin (Uint8 per step, bit0 Goldstone, bit1 Madrid, bit2 Canberra). */
  constructor(meta: EphemMeta, buf: ArrayBuffer, dsn?: ArrayBuffer) {
    if (dsn) this.dsn = new Uint8Array(dsn);
    this.t0 = Date.parse(meta.t0);
    this.stepMs = meta.step_s * 1000;
    this.a = new Float32Array(buf);
    const n = this.a.length / 6;
    this.t1 = this.t0 + (n - 1) * this.stepMs;
  }

  clamp(t: number): number {
    return Math.max(this.t0, Math.min(this.t1, t));
  }

  get hasDsn(): boolean { return !!this.dsn; }

  /** DSN station bits at the nearest step (0 when dsn.bin was not given). */
  dsnAt(t: number): number {
    if (!this.dsn) return 0;
    return this.dsn[Math.min(this.dsn.length - 1, Math.max(0, Math.round((t - this.t0) / this.stepMs)))];
  }

  /** Writes [sun xyz, earth xyz] km into out. t in ms, clamped to the table. */
  at(t: number, out = new Float64Array(6)): Float64Array {
    const n = this.a.length / 6;
    const i = (this.clamp(t) - this.t0) / this.stepMs;
    const i0 = Math.min(Math.floor(i), n - 2), f = i - i0;
    for (let j = 0; j < 6; j++) out[j] = this.a[i0 * 6 + j] * (1 - f) + this.a[(i0 + 1) * 6 + j] * f;
    return out;
  }
}

/** The table covering t, else the one nearest to it. */
export function pickEphem(tables: Ephem[], t: number): Ephem {
  const d = (e: Ephem) => Math.max(e.t0 - t, t - e.t1, 0);
  return tables.reduce((a, b) => (d(b) < d(a) ? b : a));
}
