import { core, type ScenarioResult, type Site, type StripResult } from '../core/api';
import { drawPanorama } from './panorama';
import { drawStrip, stripSummary, stripTimeAt } from './strips';
import { caption, compass, DAY, delta, dur, isoMin, rows, stations, utc } from './format';
import { offset } from '../core/geom';
import { mountProof } from './proof';
import { createMap } from './map';
import type { View3D } from '../view3d/view3d';

interface SiteRec { id: string; name: string; lat: number; lon: number; program: string; date: string | null; note: string }
/** One scenario column. `site` is a sites.json id or 'custom'. */
interface Spec { site: string; lat: number; lon: number; t: number; mast: number }

const MASTS = [0, 2, 5, 10];
const STEPS = 708;          // scrubber samples: 29.5 d hourly
const PLAY_MS = 15000;      // one lunar day of playback
const MAX_COLS = 4;
const NUDGE_M = [50, 100, 200, 500];
const DEFAULT_T = Date.parse('2026-12-01T00:00:00Z');

let sites: SiteRec[] = [];
let ranges = [{ t0: -Infinity, t1: Infinity }]; // ephemeris tables, time order
let slip = 0, idx = 0, playing = false;
const cols: Col[] = [];
let active: Col | undefined;        // the column the map edits
let map: { draw(): void } | undefined;
let view3d: View3D | null = null; // lazy: three.js loads only when the 3D section is opened
const $ = <T extends Element = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
/** Nearest landing time whose 29.5-day window fits inside one ephemeris table. */
const clampT = (t: number) => ranges
  .map((r) => Math.min(r.t1 - 29.5 * DAY, Math.max(r.t0, t)))
  .reduce((a, b) => (Math.abs(b - t) < Math.abs(a - t) ? b : a));
const rangeOf = (t: number) => ranges.find((r) => t >= r.t0 && t <= r.t1) ?? ranges[ranges.length - 1];

class Col {
  el: HTMLElement;
  base?: ScenarioResult; strip?: StripResult; slipped?: ScenarioResult;
  token = 0; slipToken = 0;
  /** Nudge: the site before the first nudge, its result, and the summed move in local east/north meters. */
  origin?: { site: string; lat: number; lon: number; name: string }; orig?: ScenarioResult; moved = [0, 0];

  constructor(public spec: Spec) {
    this.el = document.createElement('section');
    this.el.className = 'col';
    this.el.innerHTML = `
      <div class="ctl"><select class="site" aria-label="Site"></select><button class="rm" title="Remove scenario" aria-label="Remove scenario">×</button></div>
      <div class="ctl custom" hidden>
        <label>Lat <input class="lat" type="number" step="any" min="-90" max="90"></label>
        <label>Lon <input class="lon" type="number" step="any" min="-180" max="360"></label>
      </div>
      <div class="ctl nudge">
        <span>Nudge</span>
        <select class="nd" aria-label="Nudge distance">${NUDGE_M.map((m) => `<option value="${m}"${m === 100 ? ' selected' : ''}>${m} m</option>`).join('')}</select>
        ${[['N', 0], ['E', 90], ['S', 180], ['W', 270]].map(([d, b]) => `<button data-b="${b}" title="Move the site ${d === 'N' ? 'north' : d === 'E' ? 'east' : d === 'S' ? 'south' : 'west'}">${d}</button>`).join('')}
      </div>
      <p class="moved" hidden></p>
      <div class="ctl">
        <label class="grow">Landing (UTC) <input class="date" type="datetime-local" step="3600"></label>
        <label>Mast <select class="mast">${MASTS.map((m) => `<option value="${m}">${m} m</option>`).join('')}</select></label>
      </div>
      <p class="note"></p>
      <p class="status" role="status"></p>
      <canvas class="pano"></canvas>
      <p class="cap"></p>
      <p class="now"></p>
      <table class="m"></table>
      <div class="striphead"><span>Year view <small>(tap to set landing)</small></span><span class="ysum"></span></div>
      <canvas class="strip"></canvas>`;
    const sel = $<HTMLSelectElement>('.site', this.el);
    const groups = new Map<string, HTMLOptGroupElement>();
    for (const s of sites) {
      let g = groups.get(s.program);
      if (!g) { g = document.createElement('optgroup'); g.label = s.program; groups.set(s.program, g); sel.append(g); }
      g.append(new Option(s.name + (s.date ? ` (${s.date.slice(0, 4)})` : ''), s.id));
    }
    const og = document.createElement('optgroup'); og.label = 'Any point';
    og.append(new Option('Custom lat/lon…', 'custom'));
    sel.append(og);

    sel.onchange = () => {
      const s = sites.find((x) => x.id === sel.value);
      this.setSite(sel.value, s?.lat ?? this.spec.lat, s?.lon ?? this.spec.lon);
    };
    this.el.addEventListener('pointerdown', () => setActive(this));
    this.el.addEventListener('focusin', () => setActive(this));
    const lat = $<HTMLInputElement>('.lat', this.el), lon = $<HTMLInputElement>('.lon', this.el);
    lat.onchange = lon.onchange = () => {
      const a = lat.valueAsNumber, o = lon.valueAsNumber;
      if (!(Math.abs(a) <= 90) || !(o >= -180 && o <= 360)) return this.status('Latitude must be -90..90 and longitude -180..360.', 'err');
      this.spec.lat = a; this.spec.lon = o; this.origin = undefined; this.sync(); this.compute(); saveHash();
    };
    const date = $<HTMLInputElement>('.date', this.el);
    date.onchange = () => {
      const t = Date.parse(date.value + 'Z');
      if (Number.isNaN(t)) return;
      this.spec.t = clampT(t); this.sync(); this.compute(); saveHash();
    };
    const mast = $<HTMLSelectElement>('.mast', this.el);
    mast.onchange = () => { this.spec.mast = +mast.value; this.compute(); saveHash(); };
    $('.rm', this.el).onclick = () => removeCol(this);
    const strip = $<HTMLCanvasElement>('.strip', this.el);
    strip.onclick = (e) => {
      if (!this.strip) return;
      this.spec.t = clampT(Math.round(stripTimeAt(strip, this.strip, e.clientX) / 3600e3) * 3600e3);
      this.sync(); this.compute(); saveHash();
    };
    this.el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-t]');
      if (b) { this.spec.t = clampT(+b.dataset.t!); this.sync(); this.compute(); saveHash(); }
      const n = (e.target as HTMLElement).closest<HTMLElement>('[data-b]');
      if (n) this.nudge(+n.dataset.b!, +$<HTMLSelectElement>('.nd', this.el).value);
      if ((e.target as HTMLElement).closest('.reset')) this.nudge(0, 0, true);
    });
    this.sync();
    this.compute();
  }

  /** Move the site m meters along bearing b (deg from local north) of the original site; reset goes back to it. */
  nudge(b: number, m: number, reset = false) {
    const { spec } = this;
    const o = (this.origin ??= { site: spec.site, lat: spec.lat, lon: spec.lon, name: this.name() });
    if (reset) this.moved = [0, 0];
    else { this.moved[0] += m * Math.sin(b * Math.PI / 180); this.moved[1] += m * Math.cos(b * Math.PI / 180); }
    const dist = Math.hypot(this.moved[0], this.moved[1]);
    if (dist < 1) {
      Object.assign(spec, { site: o.site, lat: o.lat, lon: o.lon });
      this.origin = undefined; this.moved = [0, 0];
    } else {
      const [lat, lon] = offset(o.lat, o.lon, Math.atan2(this.moved[0], this.moved[1]) * 180 / Math.PI, dist);
      Object.assign(spec, { site: 'custom', lat: +lat.toFixed(6), lon: +lon.toFixed(6) });
    }
    this.sync(); this.compute(); saveHash();
  }

  /** Pick a site (select or map). Clears any nudge. */
  setSite(id: string, lat: number, lon: number) {
    Object.assign(this.spec, { site: id, lat, lon });
    this.origin = undefined; this.moved = [0, 0];
    this.sync(); this.compute(); saveHash();
  }

  rec() { return sites.find((s) => s.id === this.spec.site); }
  name() { return this.rec()?.name ?? `${this.spec.lat.toFixed(3)}°, ${this.spec.lon.toFixed(3)}°`; }
  site(): Site { return { lat: this.spec.lat, lon: this.spec.lon, mast: this.spec.mast }; }

  /** Push spec into the form controls and the note. */
  sync() {
    const { spec } = this, rec = this.rec();
    $<HTMLSelectElement>('.site', this.el).value = rec ? spec.site : 'custom';
    $('.custom', this.el).hidden = !!rec;
    $<HTMLInputElement>('.lat', this.el).value = String(spec.lat);
    $<HTMLInputElement>('.lon', this.el).value = String(spec.lon);
    const date = $<HTMLInputElement>('.date', this.el);
    date.min = isoMin(ranges[0].t0); date.max = isoMin(clampT(Infinity)); date.value = isoMin(spec.t);
    $<HTMLSelectElement>('.mast', this.el).value = String(spec.mast);
    let note = rec?.note ? esc(rec.note) : 'Custom point. Polar sites (south of 80°S) use high-resolution terrain.';
    if (rec?.date) {
      const t = Date.parse(rec.date + 'T00:00:00Z'), c = clampT(t);
      note += Math.abs(c - t) > 30 * DAY
        ? ` Landed ${esc(rec.date)}, outside our ephemeris (1969–1972, 2024–2040): shown at the date you pick.`
        : ` Landed ${esc(rec.date)}. <button class="link" data-t="${t}">Use landing date</button>`
          + (c !== t ? ` (window starts ${isoMin(c).slice(0, 10)} so it fits the ephemeris)` : '');
    }
    $('.note', this.el).innerHTML = note;
    const mv = $('.moved', this.el), o = this.origin;
    if (!o) { this.moved = [0, 0]; this.orig = undefined; }
    mv.hidden = !o;
    if (o) {
      const [e, n] = this.moved;
      mv.innerHTML = `Moved ${Math.round(Math.hypot(e, n))} m ${compass(Math.atan2(e, n) * 180 / Math.PI)} of ${esc(o.name)}. <button class="link reset">Back to original</button>`;
    }
  }

  status(text: string, cls = '') { const s = $('.status', this.el); s.textContent = text; s.className = 'status ' + cls; }

  async compute() {
    const tok = ++this.token;
    this.slipToken++;
    this.el.classList.add('busy');
    this.status('Computing horizon… the first polar site downloads ~20 MB of terrain.', 'busy');
    const s = this.site(), t = this.spec.t, o = this.origin;
    try {
      const y0 = Math.max(rangeOf(t).t0, Math.min(t, rangeOf(t).t1 - 365 * DAY));
      const [b, st, orig] = await Promise.all([
        core.scenario(s, t), core.strip(s, y0, y0 + 365 * DAY),
        o ? core.scenario({ lat: o.lat, lon: o.lon, mast: this.spec.mast }, t, { mc: false }) : undefined,
      ]);
      if (tok !== this.token) return;
      this.base = b; this.strip = st; this.slipped = undefined; this.orig = orig;
      this.status('');
      this.el.classList.remove('busy');
      this.render();
      if (slip) this.computeSlip();
    } catch (e) {
      if (tok === this.token) { this.el.classList.remove('busy'); this.status(`Could not compute: ${(e as Error).message}`, 'err'); }
    }
  }

  async computeSlip() {
    const tok = ++this.slipToken;
    if ($('.status', this.el).classList.contains('slip')) this.status('');
    if (!slip || !this.base) { this.slipped = undefined; return this.render(); }
    try {
      const r = await core.scenario(this.site(), this.spec.t + slip * DAY, { mc: false });
      if (tok === this.slipToken) { this.slipped = r; this.render(); }
    } catch (e) {
      if (tok === this.slipToken) this.status(`Slip: ${(e as Error).message}`, 'err slip');
    }
  }

  render() {
    const b = this.base;
    if (!b) return;
    $('.cap', this.el).textContent = caption(b.metrics);
    const br = rows(b.metrics, b.uncertainty);
    const sr = slip && this.slipped ? rows(this.slipped.metrics, null) : null;
    const cmp = rows(b.metrics, null); // deltas have no MC: compare deterministic to deterministic
    const or = this.origin && this.orig ? rows(this.orig.metrics, null) : null;
    const head = `<tr><th></th><th>At landing</th>${this.origin ? '<th>vs original</th>' : ''}${slip ? `<th>Delayed ${slip} d</th>` : ''}</tr>`;
    const td = (d: { text: string; cls: string } | null, was?: string) =>
      `<td class="d ${d?.cls ?? 'pending'}"${was ? ` title="original: ${esc(was)}"` : ''}>${d ? esc(d.text) : '…'}</td>`;
    $('.m', this.el).innerHTML = head + br.map((r, i) => {
      const cell = (this.origin ? td(or && delta(or[i], cmp[i]), or?.[i].text) : '') + (slip ? td(sr && delta(cmp[i], sr[i])) : '');
      return `<tr><th>${r.label}</th><td>${esc(r.text)}<small>${esc(r.sd)}</small></td>${cell}</tr>`;
    }).join('');
    if (this.strip) {
      const y = stripSummary(this.strip);
      $('.ysum', this.el).textContent = `year: ${Math.round(y.pctLit)}% sunlit, Earth ${Math.round(y.pctEarth)}%, longest dark ${dur(y.longestDarkHours)}`;
    }
    this.drawStrip();
    this.drawNow();
  }

  drawStrip() {
    if (this.strip) drawStrip($<HTMLCanvasElement>('.strip', this.el), this.strip, { markT: this.spec.t, markT2: slip ? this.spec.t + slip * DAY : undefined });
  }

  /** Scrubber position: panorama + one-line readout. No worker call. */
  drawNow() {
    const b = this.base;
    if (!b) return;
    const s = b.series, i = Math.min(Math.round(idx), s.t.length - 1);
    drawPanorama($<HTMLCanvasElement>('.pano', this.el), b, { idx: i, label: this.name() });
    const p = b.uncertainty ? `, P(lit) ${Math.round(b.uncertainty.pLit[i] * 100)}%` : '';
    $('.now', this.el).textContent =
      `${utc(s.t[i])}: Sun ${s.sunEl[i].toFixed(1)}°, ${s.sunFrac[i] > 0 && s.sunFrac[i] < 0.005 ? '<1' : Math.round(s.sunFrac[i] * 100)}% visible${p}; Earth ${s.earthVis[i] ? `in view · ${stations(s.dsn[i]) || 'no DSN station'}` : 'hidden'}`;
    if (this === cols[0]) view3d?.update({ ...this.site(), name: this.name(), t: s.t[i], sunFrac: s.sunFrac[i] });
  }
}

function addCol(spec: Spec) {
  const c = new Col(spec);
  cols.push(c);
  $('#cols').append(c.el);
  updateButtons();
}
function removeCol(c: Col) {
  if (cols.length <= 1) return;
  cols.splice(cols.indexOf(c), 1);
  c.el.remove();
  if (active === c) setActive(cols[0]);
  updateButtons(); saveHash();
}
function updateButtons() {
  $<HTMLButtonElement>('#add').disabled = cols.length >= MAX_COLS;
  for (const c of cols) {
    $<HTMLButtonElement>('.rm', c.el).disabled = cols.length <= 1;
    c.el.classList.toggle('active', c === active && cols.length > 1);
  }
}

function setActive(c: Col) {
  if (active === c) return;
  active = c;
  updateButtons();
  map?.draw();
}

// URL hash: #c=<siteId|lat,lon>~<YYYY-MM-DDTHH:MM>~<mast>&c=...&slip=N
function saveHash() {
  const p = new URLSearchParams();
  for (const { spec } of cols) p.append('c', `${spec.site === 'custom' ? `${spec.lat},${spec.lon}` : spec.site}~${isoMin(spec.t)}~${spec.mast}`);
  if (slip) p.set('slip', String(slip));
  history.replaceState(null, '', '#' + p.toString());
  map?.draw(); // every spec change ends here
}
function loadHash(): Spec[] {
  const p = new URLSearchParams(location.hash.slice(1));
  slip = Math.min(60, Math.max(0, Math.round(+(p.get('slip') ?? 0)) || 0));
  const specs: Spec[] = [];
  for (const c of p.getAll('c').slice(0, MAX_COLS)) {
    const [key, d, m] = c.split('~');
    const rec = sites.find((s) => s.id === key);
    const [lat, lon] = rec ? [rec.lat, rec.lon] : (key ?? '').split(',').map(Number);
    const t = Date.parse((d ?? '') + 'Z');
    if (!(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 360)) continue;
    specs.push({
      site: rec ? rec.id : 'custom', lat, lon,
      t: clampT(Number.isNaN(t) ? DEFAULT_T : t),
      mast: MASTS.includes(+m) ? +m : 2,
    });
  }
  return specs;
}
function defaults(): Spec[] {
  return ['connecting_ridge', 'malapert'].map((id) => {
    const s = sites.find((x) => x.id === id) ?? sites[0];
    return { site: s.id, lat: s.lat, lon: s.lon, t: clampT(DEFAULT_T), mast: 2 };
  });
}

function setIdx(v: number) {
  idx = v;
  $<HTMLInputElement>('#scrub').value = String(Math.round(v));
  $('#scrubv').textContent = `landing + ${dur(v)}`.replace('<1 h', '0 h');
  for (const c of cols) c.drawNow();
}

let lastFrame = 0;
function tick(now: number) {
  if (!playing) return;
  if (lastFrame) setIdx((idx + ((now - lastFrame) / PLAY_MS) * STEPS) % STEPS);
  lastFrame = now;
  requestAnimationFrame(tick);
}
function setPlaying(p: boolean) {
  playing = p; lastFrame = 0;
  const b = $('#play');
  b.textContent = p ? '❚❚' : '▶';
  b.setAttribute('aria-label', p ? 'Pause' : 'Play');
  if (p) requestAnimationFrame(tick);
}

export async function start(root: HTMLElement) {
  root.innerHTML = `
    <header>
      <h1>Lunar Landing Site Navigator</h1>
      <p>Compare landing sites and dates: Sun and Earth against the real terrain horizon, and what a launch slip does to power and comms.</p>
    </header>
    <div class="bar">
      <div class="row">
        <button id="play" aria-label="Play">▶</button>
        <input id="scrub" type="range" min="0" max="${STEPS - 1}" value="0" aria-label="Time after landing">
        <span id="scrubv" class="val">landing + 0 h</span>
      </div>
      <div class="row">
        <label for="slip">Landing delayed</label>
        <input id="slip" type="range" min="0" max="60" value="0">
        <span id="slipv" class="val">0 d</span>
      </div>
    </div>
    <p id="err" class="status err"></p>
    <section id="map" class="mapbox"></section>
    <main id="cols"></main>
    <div class="actions"><button id="add">+ Add scenario</button></div>
    <details id="v3d"><summary>3D view: shadows over Shackleton (first scenario)</summary><div id="v3dmount"></div></details>
    <div id="proof"></div>
    <footer>
      Metrics cover the 29.5-day window from the landing date. “±” is how much a number moves when the terrain is varied within its measurement error (a lower bound; see “What am I looking at?”).
      Ephemeris covers 1969-07 to 1972 (Apollo, on their real dates) and 2024–2040; other historical landings (Chang'e 3–5, Chandrayaan-3) show their site at the date you pick.
      Deltas compare the delayed landing to the planned one, and a nudged site to the original: <span class="good">better</span> / <span class="bad">worse</span>.
      Comms (DSN) = Earth above the terrain and a Deep Space Network dish (Goldstone, Madrid, Canberra) seeing the Moon above 10° (2024–2040 only).
    </footer>`;
  mountProof($('#proof'));
  try {
    const [list, r] = await Promise.all([
      fetch(import.meta.env.BASE_URL + 'data/sites.json').then((x) => { if (!x.ok) throw new Error(`sites.json: HTTP ${x.status}`); return x.json(); }),
      core.range(),
    ]);
    sites = list; ranges = r.ranges;
  } catch (e) {
    $('#err').textContent = `Could not load data: ${(e as Error).message}`;
    return;
  }
  const specs = loadHash();
  (specs.length ? specs : defaults()).forEach(addCol);
  setActive(cols[0]);
  map = createMap($('#map'), sites, () => cols.map((c) => ({ lat: c.spec.lat, lon: c.spec.lon, label: c.name(), active: c === active })),
    (id, lat, lon) => active?.setSite(id ?? 'custom', lat, lon));
  saveHash();

  const slipIn = $<HTMLInputElement>('#slip');
  slipIn.value = String(slip);
  $('#slipv').textContent = `${slip} d`;
  let deb = 0;
  slipIn.oninput = () => {
    slip = +slipIn.value;
    $('#slipv').textContent = `${slip} d`;
    for (const c of cols) c.drawStrip(); // marker moves now, numbers after the debounce
    clearTimeout(deb);
    deb = window.setTimeout(() => { for (const c of cols) c.computeSlip(); saveHash(); }, 120);
  };
  const scrub = $<HTMLInputElement>('#scrub');
  scrub.oninput = () => { setPlaying(false); setIdx(+scrub.value); };
  $('#play').onclick = () => setPlaying(!playing);
  $('#add').onclick = () => { addCol({ ...cols[cols.length - 1].spec }); saveHash(); };

  $<HTMLDetailsElement>('#v3d').ontoggle = async () => {
    if (view3d || !$<HTMLDetailsElement>('#v3d').open) return;
    $('#v3dmount').textContent = 'Loading 3D view…';
    try {
      view3d = await (await import('../view3d/view3d')).mount($('#v3dmount'));
      cols[0]?.drawNow();
    } catch (e) {
      $('#v3dmount').textContent = `3D view unavailable: ${(e as Error).message}`;
    }
  };

  let raf = 0;
  addEventListener('resize', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { cols.forEach((c) => c.render()); map?.draw(); }); });
  addEventListener('hashchange', () => location.reload()); // pasted share link; replaceState doesn't fire this
}
