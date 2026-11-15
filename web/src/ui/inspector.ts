// Right inspector (docs/V2-DESIGN.md section 4): horizon panorama, power / Sun-elevation chart,
// viability badges, the status sentence, and the raw figures behind a Details button.
//
// State lives at module level and changes only through the registered actions (`chart.set`,
// `inspector.details`), so the buttons and the AI agent share one path and the module can be imported and
// tested without a DOM. `mountInspector` builds the markup and subscribes to the state.
import type { ScenarioResult } from '../core/api';
import { DSN_NAMES } from '../core/extra';
import { actions, register, type Action } from './actions';
import {
  chartValues, commsVerdict, drawChart, drawChartOverlay, DURATIONS, formatValue, hourAtX,
  LETTERS, METRICS, Plot, powerPct, powerVerdict, samplesIn, SCENARIO_COLORS,
  type ChartModel, type ChartScale, type CommsVerdict, type DurationDays, type Metric, type PowerVerdict,
} from './charts';
import { caption, coord, DAY, delta, dur, isoMin, type Row } from './format';
import { drawPanorama } from './panorama';
import type { Scenario } from './scenario';
import { drawStrip, stripSummary } from './strips';

/* ------------------------------------------------------------------ what the app provides */

export interface InspectorDeps {
  scenarios(): readonly Scenario[];
  selected(): number;
  slip(): number;
  /** Hours after landing shown by the scrubber; fractional while playing. */
  hours(): number;
  playing(): boolean;
  /** Site name for the header ("Custom point" when it has none). */
  name(sc: Scenario): string;
  setHours(h: number): void;
  setPlaying(p: boolean): void;
  select(i: number): void;
  /** Write the URL hash. */
  save(): void;
}

let deps: InspectorDeps | null = null;
/** Connect the state getters and actions to the app (mountInspector does this; tests pass a stub). */
export function bindInspector(d: InspectorDeps | null) { deps = d; }
export const inspectorDeps = () => deps;

/* ------------------------------------------------------------------ state + actions */

const state = { metric: 'power' as Metric, durationDays: 14 as DurationDays, details: false };
const subs = new Set<() => void>();
/** Called after any inspector state change. Returns the unsubscribe function. */
export function onInspectorChange(f: () => void): () => void { subs.add(f); return () => subs.delete(f); }
const changed = () => { for (const f of [...subs]) f(); };

const painted = new Set<(what: 'now' | 'all') => void>();
/** Called after the inspector repaints: 'now' when the scrubber moved, 'all' when scenarios, results or options changed. The sky pop-up follows it. */
export function onInspectorPaint(f: (what: 'now' | 'all') => void): () => void { painted.add(f); return () => painted.delete(f); }

export const missionDays = (): DurationDays => state.durationDays;

export interface ScenarioVerdicts { power: PowerVerdict; comms: CommsVerdict }
export function verdictsOf(r: ScenarioResult, durationDays: number = state.durationDays): ScenarioVerdicts {
  return { power: powerVerdict(r.series, durationDays * 24), comms: commsVerdict(r.series, r.mission, durationDays * 24) };
}

/** Plain JSON for the agent's snapshot(): chart options, Details, and each scenario's verdicts over the mission length. */
export function inspectorState() {
  return {
    chart: { metric: state.metric, durationDays: state.durationDays },
    detailsOpen: state.details,
    verdicts: (deps?.scenarios() ?? []).map((sc, i) => {
      const v = sc.base ? verdictsOf(sc.base) : null;
      return {
        scenario: LETTERS[i],
        power: v ? { level: v.power.level, detail: v.power.detail } : null,
        comms: v ? { level: v.comms.level, detail: v.comms.detail, basis: v.comms.basis } : null,
      };
    }),
  };
}

function define<A>(a: Action<A>) { actions.delete(a.name); register(a); } // delete first: survives a dev-server hot reload
const isObj = (a: unknown): a is Record<string, unknown> => typeof a === 'object' && a !== null && !Array.isArray(a);
function only(a: unknown, name: string, keys: string[]): Record<string, unknown> {
  const o = a === undefined ? {} : a;
  if (!isObj(o)) throw new Error(`${name}: arguments must be an object`);
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new Error(`${name}: unknown argument "${k}"`);
  return o;
}

/** Run a registered action by name. Every inspector control goes through this. */
export function act(name: string, args: unknown = {}): Promise<unknown> {
  const a = actions.get(name);
  return a ? a.run(args) : Promise.reject(new Error(`unknown action ${name}`));
}

define<{ open: boolean }>({
  name: 'inspector.details',
  description: 'Open or close the Details section of the right inspector: the raw metrics table for the selected scenario (with the change if the landing is delayed) and the 12-month sunlight / Earth-visibility strip.',
  schema: { type: 'object', properties: { open: { type: 'boolean', description: 'true to show the section, false to hide it' } }, required: ['open'], additionalProperties: false },
  async run(args) {
    const a = only(args, 'inspector.details', ['open']);
    if (typeof a.open !== 'boolean') throw new Error('inspector.details: "open" must be true or false');
    if (a.open !== state.details) { state.details = a.open; changed(); }
    return { summary: state.details ? 'Opened the Details section' : 'Closed the Details section', detailsOpen: state.details };
  },
});

define<{ metric?: Metric; durationDays?: DurationDays }>({
  name: 'chart.set',
  description: 'Set what the inspector chart plots and over how long a mission. metric: "power" (available solar power as % of rated panel output, every scenario overlaid) or "elevation" (Sun elevation above the terrain horizon, degrees). durationDays: the mission length after landing, 7, 14 or 29.5 days; it is also the span of the windows bar, the viability verdicts and the sky pop-up tracks. Give either or both. Returns the new settings and each scenario\'s power and comms verdict for that mission length.',
  schema: {
    type: 'object',
    properties: {
      metric: { type: 'string', enum: [...METRICS], description: 'which series to plot' },
      durationDays: { type: 'number', enum: [...DURATIONS], description: 'mission length in days after landing' },
    },
    required: [],
    additionalProperties: false,
  },
  async run(args) {
    const a = only(args, 'chart.set', ['metric', 'durationDays']);
    if (a.metric === undefined && a.durationDays === undefined) throw new Error('chart.set: give "metric", "durationDays" or both');
    if (a.metric !== undefined && !METRICS.includes(a.metric as Metric)) throw new Error('chart.set: "metric" must be "power" or "elevation"');
    if (a.durationDays !== undefined && !DURATIONS.includes(a.durationDays as DurationDays)) throw new Error('chart.set: "durationDays" must be 7, 14 or 29.5');
    const metric = (a.metric as Metric | undefined) ?? state.metric, durationDays = (a.durationDays as DurationDays | undefined) ?? state.durationDays;
    if (metric !== state.metric || durationDays !== state.durationDays) { state.metric = metric; state.durationDays = durationDays; changed(); }
    const s = inspectorState();
    return { summary: `Chart: ${s.chart.metric === 'power' ? 'solar power' : 'Sun elevation'} over ${s.chart.durationDays} days`, ...s.chart, verdicts: s.verdicts };
  },
});

/* ---- URL hash: cm=elevation, cd=<days>, det=1 (defaults are left out) ---- */

export function writeHash(p: URLSearchParams) {
  if (state.metric !== 'power') p.set('cm', state.metric);
  if (state.durationDays !== 14) p.set('cd', String(state.durationDays));
  if (state.details) p.set('det', '1');
}
export function readHash(p: URLSearchParams) {
  const m = p.get('cm'), d = Number(p.get('cd'));
  state.metric = METRICS.includes(m as Metric) ? (m as Metric) : 'power';
  state.durationDays = DURATIONS.includes(d as DurationDays) ? (d as DurationDays) : 14;
  state.details = p.get('det') === '1';
  changed();
}

/* ---- time: the same path as the timeline. Effort 1's actions when they exist, the app's own functions otherwise ---- */

export function setTime(hours: number) {
  const a = actions.get('time.set');
  if (a) a.run({ hoursAfterLanding: hours }).catch(() => deps?.setHours(hours));
  else deps?.setHours(hours);
}
export function setPlaying(p: boolean) {
  if (deps && deps.playing() === p) return;
  const a = actions.get(p ? 'time.play' : 'time.pause');
  if (a) a.run({}).catch(() => deps?.setPlaying(p));
  else deps?.setPlaying(p);
}

/* ------------------------------------------------------------------ shared formatting */

/** The "now" readout at series sample i, as text. The inspector and the sky pop-up both show exactly this. */
export function nowReadout(r: ScenarioResult, i: number) {
  const s = r.series, f = s.sunFrac[i], bits = r.mission.dsn[i], vis = !!s.earthVis[i];
  return {
    sunEl: `${s.sunEl[i].toFixed(1)}°`,
    sunAz: `${s.sunAz[i].toFixed(0)}°`,
    disk: `${f > 0 && f < 0.005 ? '<1' : Math.round(f * 100)}%`,
    chanceLit: r.uncertainty ? `${Math.round(r.uncertainty.pLit[i] * 100)}%` : '–',
    earthVisible: vis,
    earth: vis ? 'In view' : 'Hidden',
    earthEl: `${s.earthEl[i].toFixed(1)}°`,
    earthAz: `${s.earthAz[i].toFixed(0)}°`,
    dsn: r.mission.commsHours === null ? 'no station data for this era' : !vis ? 'no link while Earth is hidden'
      : bits ? `link via ${DSN_NAMES.filter((_, k) => bits & (1 << k)).join(' and ')}` : 'no station can see the Moon',
  };
}

export const durLabel = (d: number) => `${d} d`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

const TABLE_TITLES: Partial<Record<Row['key'], string>> = {
  dsn: 'Hours when Earth is in view from the site and the Moon is above 10° at Goldstone, Madrid or Canberra',
  battery: '200 W Sun-tracking panel, constant 100 W load, 1.5 kWh of storage, starting full',
};
const EMPTY_ROWS = ['Sun elevation (vs level)', 'Sun disk visible', 'Sunset in', 'Earthset in', 'Sunlit, 29.5 d', 'Longest dark', 'Earth in view', 'Deep Space Network, 29.5 d', 'Battery, 29.5 d', 'Permanent shadow'];

/** The raw metrics table (today's rendering, unchanged): values at landing, plus the change if the landing is delayed. */
export function metricsTable(sc: Pick<Scenario, 'rows' | 'cmp' | 'srows' | 'slipError'> | undefined, slip: number): string {
  if (!sc?.rows) {
    return '<thead><tr><th></th><th>At landing</th></tr></thead><tbody>'
      + EMPTY_ROWS.map((l) => `<tr><th scope="row">${l}</th><td>–</td></tr>`).join('') + '</tbody>';
  }
  const head = `<thead><tr><th></th><th>At landing</th>${slip ? `<th>Delayed ${slip} d</th>` : ''}</tr></thead>`;
  return head + '<tbody>' + sc.rows.map((r, i) => {
    const d = sc.cmp && sc.srows ? delta(sc.cmp[i], sc.srows[i]) : null;
    const cell = slip ? `<td class="d ${d?.cls ?? 'pending'}">${d ? esc(d.text) : sc.slipError ? 'n/a' : '…'}</td>` : '';
    const t = TABLE_TITLES[r.key];
    return `<tr><th scope="row"${t ? ` title="${esc(t)}"` : ''}>${t ? `<span class="hint">${r.label}</span>` : r.label}</th><td>${esc(r.text)}${r.sd ? `<small>${esc(r.sd)}</small>` : ''}</td>${cell}</tr>`;
  }).join('') + '</tbody>';
}

const RANK: Record<string, number> = { no: 0, marginal: 1, gaps: 1, ok: 2 };
const VERDICT_CLASS: Record<string, string> = { ok: 'ok', marginal: 'warn', gaps: 'warn', no: 'no' };
const commsBasis = (v: CommsVerdict) => (v.basis === 'dsn' ? 'Deep Space Network contact' : 'Earth in view, no station data for these dates');

/** One sentence per scenario for the all-scenarios summary (title and screen-reader text of the two dots). */
export function verdictSummary(letter: string, v: ScenarioVerdicts | null): string {
  if (!v) return `Scenario ${letter}: not computed yet`;
  return `Scenario ${letter}: power ${v.power.label} (${v.power.detail}); comms ${v.comms.label} (${v.comms.detail}; ${commsBasis(v.comms)})`;
}

/* ------------------------------------------------------------------ DOM */

const ICON = {
  sky: '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M7 1.5h3.5V5M5 10.5H1.5V7M10.5 1.5 6.8 5.2M1.5 10.5l3.7-3.7" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
  chev: '<svg class="chev" viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M3 1.5 6.5 5 3 8.5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
};

const MARKUP = `
  <div class="pane-head"><span id="i-badge" class="badge on"></span><h2 id="i-name"></h2><span id="i-coord" class="coord"></span></div>
  <div class="insp-body">
    <p id="i-status" class="i-status" role="status"></p>
    <section>
      <div class="sec-head mid"><h3 class="lbl">Horizon seen from the site</h3>
        <button type="button" id="i-sky" class="mini" aria-haspopup="dialog" title="Open the all-sky view from this site">${ICON.sky}<span>Sky</span></button></div>
      <canvas id="i-pano" class="pano" role="img" aria-label="Horizon panorama: terrain silhouette with the paths of the Sun and Earth"></canvas>
      <dl class="now">
        <div title="Elevation of the Sun's centre above a level horizon. From a mast on high ground the real horizon can sit below level, so a Sun slightly below 0° can still be visible; terrain can also hide a Sun above 0°."><dt>Sun angle</dt><dd id="n-el">–</dd></div>
        <div><dt>Disk visible</dt><dd id="n-disk">–</dd></div>
        <div title="Share of terrain-model draws in which some of the Sun is visible"><dt>Chance lit</dt><dd id="n-plit">–</dd></div>
        <div><dt>Earth</dt><dd id="n-earth">–</dd></div>
        <div class="wide" title="NASA ground stations at Goldstone, Madrid and Canberra. A station counts when the Moon is more than 10° above its horizon."><dt>Deep Space Network</dt><dd id="n-dsn">–</dd></div>
      </dl>
    </section>

    <section class="chart-sec">
      <div class="chart-ctl">
        <div class="seg" role="group" aria-label="Chart shows">
          <button type="button" data-metric="power" aria-pressed="true">Power</button>
          <button type="button" data-metric="elevation" aria-pressed="false">Sun elevation</button>
        </div>
        <div class="seg nums" role="group" aria-label="Mission length">
          ${DURATIONS.map((d) => `<button type="button" data-dur="${d}" aria-pressed="${d === 14}" aria-label="${d} days">${d} d</button>`).join('')}
        </div>
      </div>
      <div class="sec-head"><h3 class="lbl" id="c-title"></h3><div id="c-legend" class="c-legend" aria-label="Scenario colours"></div></div>
      <p id="c-read" class="c-read"></p>
      <canvas id="c-chart" class="chart" role="img" aria-label="Chart"></canvas>
    </section>

    <section class="via">
      <h3 class="lbl">Viability over <span id="v-dur"></span></h3>
      <dl class="verdicts" title="Power: 200 W tracking panel, 100 W load, 1.5 kWh battery. OK = never below 20%, Marginal = dips but never empty, No = empties. Comms: OK = longest gap without DSN contact ≤ 24 h, Gaps = longer, No = none.">
        <div><dt>Power</dt><dd id="v-power"></dd></div>
        <div><dt>Comms</dt><dd id="v-comms"></dd></div>
      </dl>
      <div class="v-all"><span class="lbl">All scenarios</span><span class="v-key">power · comms</span><div id="v-all"></div></div>
    </section>

    <p id="i-cap" class="cap"></p>

    <section class="details">
      <button type="button" id="i-details" class="disclose" aria-expanded="false" aria-controls="i-more">${ICON.chev}<span>Details</span><span class="quiet">figures at landing and the 12-month strip</span></button>
      <div id="i-more" class="more" hidden>
        <table id="i-table" class="m"></table>
        <section>
          <div class="sec-head"><h3 class="lbl" id="i-year">12 months</h3><span class="lbl quiet">Click to set the landing date</span></div>
          <canvas id="i-strip" class="strip" role="img" aria-label="Sunlight and Earth visibility over one year"></canvas>
          <p id="i-ysum" class="ysum"></p>
        </section>
      </div>
    </section>

  </div>`;

export interface InspectorHandle {
  /** Selected scenario, its results or the slip changed: repaint everything. */
  paint(): void;
  /** Header only (letter, name, coordinates). */
  paintHead(): void;
  /** Scrubber moved: panorama, readouts, playheads. Cheap; called every frame while playing. */
  paintNow(): void;
  /** The 12-month strip (its landing and delay markers). */
  paintStrip(): void;
  /** Any scenario changed, was added or removed: the chart and the all-scenarios verdicts. */
  paintAll(): void;
  /** Layout changed: redraw the canvases at their new size. */
  resize(): void;
}

const TITLES: Record<Metric, string> = { power: 'Solar power, % of rated', elevation: 'Sun above terrain, deg' };

export function mountInspector(el: HTMLElement, d: InspectorDeps): InspectorHandle {
  bindInspector(d);
  el.innerHTML = MARKUP;
  const $ = <T extends Element = HTMLElement>(s: string) => el.querySelector(s) as T;
  const cur = () => d.scenarios()[d.selected()] as Scenario | undefined;

  let lastIdx = -1, lastRead = '', hover: number | null = null;
  let scale: ChartScale | undefined, model: ChartModel = { metric: state.metric, durationDays: state.durationDays, items: [], selected: 0 };
  let readCells: HTMLElement[] = [], readCount = -1;

  const chart = new Plot($<HTMLCanvasElement>('#c-chart'),
    (g, W, H) => { scale = drawChart(g, W, H, model); },
    (g) => { if (scale) drawChartOverlay(g, scale, model, d.hours(), hover); });

  const buildModel = () => {
    const slip = d.slip();
    model = {
      metric: state.metric, durationDays: state.durationDays, selected: d.selected(),
      items: d.scenarios().map((sc, i) => ({ letter: LETTERS[i], color: SCENARIO_COLORS[i], result: sc.base, slipped: slip ? sc.slipped : undefined })),
    };
  };

  /* ---- pieces ---- */

  function paintHead() {
    const sc = cur();
    if (!sc) return;
    const b = $('#i-badge');
    b.textContent = LETTERS[d.selected()];
    b.style.setProperty('--sc', SCENARIO_COLORS[d.selected()]);
    $('#i-name').textContent = d.name(sc);
    $('#i-coord').textContent = coord(sc.spec.lat, sc.spec.lon, 4);
  }

  function paintStrip() {
    const sc = cur(), slip = d.slip();
    if (sc?.strip && state.details) drawStrip($<HTMLCanvasElement>('#i-strip'), sc.strip, { markT: sc.spec.t, markT2: slip ? sc.spec.t + slip * DAY : undefined });
  }

  const dot = (level: string) => `<i class="vd ${VERDICT_CLASS[level]}"></i>`;
  function paintVerdicts() {
    const list = d.scenarios(), sel = d.selected();
    const all = list.map((sc) => (sc.base ? verdictsOf(sc.base) : null));
    const v = all[sel];
    $('#v-dur').textContent = durLabel(state.durationDays);
    $('#v-power').innerHTML = v ? `${dot(v.power.level)}<b>${v.power.label}</b><small>${esc(v.power.detail)}</small>` : '<b class="na">–</b><small>&nbsp;</small>';
    $('#v-comms').innerHTML = v
      ? `${dot(v.comms.level)}<b>${v.comms.label}</b><small>${esc(v.comms.detail)}${v.comms.basis === 'earth' ? ' · Earth in view' : ''}</small>`
      : '<b class="na">–</b><small>&nbsp;</small>';
    // Landing delayed: the same verdicts for the delayed landing, under each (pending while it computes).
    const slip = d.slip(), sc = list[sel], sv = slip && sc?.slipped ? verdictsOf(sc.slipped) : null;
    if (v && slip) for (const k of ['power', 'comms'] as const) {
      $(`#v-${k}`).insertAdjacentHTML('beforeend', `<small class="v-slip">+${slip} d: ${sv ? `${dot(sv[k].level)} <span class="${RANK[sv[k].level] > RANK[v[k].level] ? 'good' : RANK[sv[k].level] < RANK[v[k].level] ? 'bad' : ''}">${sv[k].label}</span>` : sc?.slipError ? 'n/a' : '…'}</small>`);
    }
    $('#v-all').innerHTML = all.map((x, i) => {
      const text = esc(verdictSummary(LETTERS[i], x));
      return `<span class="va${i === sel ? ' on' : ''}" role="img" title="${text}" aria-label="${text}"><b style="color:${SCENARIO_COLORS[i]}">${LETTERS[i]}</b>${x ? dot(x.power.level) + dot(x.comms.level) : '<i class="vd na"></i><i class="vd na"></i>'}</span>`;
    }).join('');
  }

  function paintLegend() {
    const n = d.scenarios().length;
    const slip = d.slip();
    $('#c-legend').innerHTML = (slip ? `<span class="dash" title="The selected scenario if the landing is delayed ${slip} d"><i style="border-color:${SCENARIO_COLORS[d.selected()]}"></i>+${slip} d</span>` : '') + d.scenarios().map((_, i) => `<span${i === d.selected() ? ' class="on"' : ''}><i style="background:${SCENARIO_COLORS[i]}"></i>${LETTERS[i]}</span>`).join('');
    if (n !== readCount) {
      readCount = n;
      $('#c-read').innerHTML = '<span class="rt"></span>' + d.scenarios().map((_, i) => `<span class="rv"><i style="background:${SCENARIO_COLORS[i]}"></i><b></b></span>`).join('');
      readCells = [$('#c-read .rt'), ...el.querySelectorAll<HTMLElement>('#c-read .rv b')];
      lastRead = '';
    }
    const letters = d.scenarios().map((_, i) => LETTERS[i]).join(', '), days = `${state.durationDays} days after landing`;
    const sel = cur()?.base;
    let extra = '';
    if (sel) {
      const k = samplesIn(sel.series, state.durationDays * 24), p = powerPct(sel);
      let sum = 0;
      for (let i = 0; i < k; i++) sum += p[i];
      extra = ` Scenario ${LETTERS[d.selected()]} averages ${Math.round(sum / k)}% of rated power.`;
    }
    $('#c-chart').setAttribute('aria-label', state.metric === 'power'
      ? `Line chart: available solar power as a percentage of rated panel output over the ${days}, one line per scenario (${letters}).${extra}`
      : `Line chart: Sun elevation above the terrain horizon in degrees over the ${days}, one line per scenario (${letters}).${extra}`);
  }

  /** Readout row: values under the cursor, or at the playhead when the pointer is elsewhere. */
  function paintRead() {
    if (!readCells.length) return;
    const h = hover ?? d.hours(), idx = Math.round(h);
    const key = `${idx}|${hover === null}|${model.metric}`;
    if (key === lastRead) return;
    lastRead = key;
    readCells[0].textContent = `${hover === null ? 'now' : 'at'} day ${(idx / 24).toFixed(1)}`;
    chartValues(model, idx).forEach((v, i) => { if (readCells[i + 1]) readCells[i + 1].textContent = v === null ? '–' : formatValue(model.metric, v); });
  }

  function paintAll() {
    buildModel();
    paintLegend();
    paintVerdicts();
    chart.invalidate();
    lastRead = '';
    chart.render();
    paintRead();
    for (const f of painted) f('all');
  }

  function paint() {
    const sc = cur();
    if (!sc) return;
    paintHead();
    el.classList.toggle('busy', sc.busy);
    el.classList.toggle('empty', !sc.base);
    $('#i-status').textContent = sc.error || sc.slipError;
    const b = sc.base;
    $('#i-cap').textContent = b && sc.rows ? `At landing: ${caption(b.metrics)}`
      : 'Computing the terrain horizon. The first polar site downloads about 50 MB of terrain and ephemeris data.'; // same layout as the result, so nothing jumps when it arrives
    $('#i-table').innerHTML = metricsTable(b ? sc : undefined, d.slip());
    if (b && sc.strip) {
      const y = stripSummary(sc.strip);
      $('#i-year').textContent = `12 months from ${isoMin(sc.strip.t0).slice(0, 10)}`;
      $('#i-ysum').textContent = `${Math.round(y.pctLit)}% sunlit · Earth in view ${Math.round(y.pctEarth)}% · longest dark ${dur(y.longestDarkHours)}`;
    }
    paintStrip();
    paintAll();
    lastIdx = -1;
    paintNow();
  }

  function paintNow() {
    const sc = cur();
    if (!sc) return;
    const b = sc.base;
    if (b) {
      const i = Math.min(Math.round(d.hours()), b.series.t.length - 1);
      if (i !== lastIdx) {
        lastIdx = i;
        drawPanorama($<HTMLCanvasElement>('#i-pano'), b, { idx: i });
        const r = nowReadout(b, i);
        $('#n-el').textContent = r.sunEl;
        $('#n-disk').textContent = r.disk;
        $('#n-plit').textContent = r.chanceLit;
        const e = $('#n-earth');
        e.textContent = r.earth; e.classList.toggle('on', r.earthVisible);
        $('#n-dsn').textContent = r.dsn;
      }
    }
    chart.render();
    paintRead();
    for (const f of painted) f('now');
  }

  /* ---- state -> controls ---- */

  function sync() {
    for (const b of el.querySelectorAll<HTMLElement>('[data-metric]')) b.setAttribute('aria-pressed', String(b.dataset.metric === state.metric));
    for (const b of el.querySelectorAll<HTMLElement>('[data-dur]')) b.setAttribute('aria-pressed', String(+b.dataset.dur! === state.durationDays));
    $('#c-title').textContent = TITLES[state.metric];
    const more = $('#i-more'), was = more.hidden;
    more.hidden = !state.details;
    $('#i-details').setAttribute('aria-expanded', String(state.details));
    if (was && state.details) paintStrip(); // its canvas had no size while hidden
    paintAll();
  }
  onInspectorChange(() => { sync(); d.save(); });

  /* ---- controls: every one runs its action ---- */

  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const m = t.closest<HTMLElement>('[data-metric]'), du = t.closest<HTMLElement>('[data-dur]');
    if (m) void act('chart.set', { metric: m.dataset.metric });
    else if (du) void act('chart.set', { durationDays: +du.dataset.dur! });
    else if (t.closest('#i-details')) void act('inspector.details', { open: !state.details });
    else if (t.closest('#i-sky')) void act('sky.open', {}).catch(() => {});
  });

  /* ---- pointer: hover readout, click or drag to scrub ---- */

  const attach = (cv: HTMLCanvasElement) => {
    let drag = false;
    const hourOf = (e: PointerEvent) => {
      const r = cv.getBoundingClientRect();
      const h = hourAtX(e.clientX - r.left - cv.clientLeft, cv.clientWidth, state.durationDays);
      return h;
    };
    const show = () => { chart.render(); paintRead(); };
    cv.addEventListener('pointerdown', (e) => {
      if (e.button) return;
      drag = true; cv.setPointerCapture(e.pointerId);
      hover = hourOf(e);
      setPlaying(false); setTime(Math.round(hover));
      show();
    });
    cv.addEventListener('pointermove', (e) => {
      hover = hourOf(e);
      if (drag) setTime(Math.round(hover));
      show();
    });
    const end = (e: PointerEvent) => {
      if (!drag) return;
      drag = false; d.save();
      if (e.pointerType !== 'mouse') { hover = null; show(); } // touch has no hover to keep
    };
    cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', () => { if (!drag) { hover = null; show(); } });
  };
  attach(chart.canvas);

  const ro = new ResizeObserver(() => { chart.render(); });
  ro.observe(chart.canvas);

  sync();

  return {
    paint, paintHead, paintNow, paintStrip, paintAll,
    resize() { lastIdx = -1; paintNow(); paintStrip(); },
  };
}
