// One scenario: its spec, its worker results and the rows derived from them. No DOM.
import { core, type Range, type ScenarioResult, type Site, type StripResult } from '../core/api';
import { DAY, rows, type Row } from './format';

/** `site` is a sites.json id or 'custom'. */
export interface Spec { site: string; lat: number; lon: number; t: number; mast: number }

export interface Env {
  slip(): number;
  rangeOf(t: number): Range;
  /** Results, busy state or errors changed. */
  onUpdate(s: Scenario): void;
}

export class Scenario {
  base?: ScenarioResult; strip?: StripResult; slipped?: ScenarioResult;
  rows?: Row[];   // shown values (Monte Carlo mean where available)
  cmp?: Row[];    // deterministic rows: the slip has no Monte Carlo, so deltas compare like with like
  srows?: Row[];  // deterministic rows at the delayed date
  busy = false; error = ''; slipError = '';
  private token = 0; private slipToken = 0;

  constructor(public spec: Spec, private env: Env) {}

  site(): Site { return { lat: this.spec.lat, lon: this.spec.lon, mast: this.spec.mast }; }

  async compute() {
    const tok = ++this.token;
    this.slipToken++;
    this.busy = true; this.error = ''; this.slipError = '';
    this.env.onUpdate(this);
    const s = this.site(), t = this.spec.t, r = this.env.rangeOf(t);
    const y0 = Math.max(r.t0, Math.min(t, r.t1 - 365 * DAY));
    try {
      const [b, st] = await Promise.all([core.scenario(s, t), core.strip(s, y0, y0 + 365 * DAY)]);
      if (tok !== this.token) return;
      this.base = b; this.strip = st; this.slipped = this.srows = undefined;
      this.rows = rows(b.metrics, b.uncertainty, b.mission);
      this.cmp = rows(b.metrics, null, b.mission);
      this.busy = false;
      this.env.onUpdate(this);
      if (this.env.slip()) await this.computeSlip(); // awaited so callers of compute() get the delayed numbers too
    } catch (e) {
      if (tok !== this.token) return;
      this.busy = false; this.error = `Could not compute: ${(e as Error).message}.`;
      this.env.onUpdate(this);
    }
  }

  async computeSlip() {
    const tok = ++this.slipToken, slip = this.env.slip();
    this.slipError = '';
    if (!slip || !this.base) { this.slipped = this.srows = undefined; return this.env.onUpdate(this); }
    try {
      const r = await core.scenario(this.site(), this.spec.t + slip * DAY, { mc: false });
      if (tok !== this.slipToken) return;
      this.slipped = r; this.srows = rows(r.metrics, null, r.mission);
    } catch (e) {
      if (tok !== this.slipToken) return;
      this.slipped = this.srows = undefined;
      this.slipError = `Delay of ${slip} d: ${(e as Error).message}.`;
    }
    this.env.onUpdate(this);
  }
}
