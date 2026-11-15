// Shell: top bar, agent rail (scenario chips, editor pop-over, chat), stage (3D / map), inspector, timeline dock,
// compare sheet, evidence page. Every control calls an action (see "actions" below); the agent uses the same ones.
import { core, type Range } from '../core/api';
import { DSN_NAMES } from '../core/extra';
import { DEG, enu, R } from '../core/geom';
import { drawPanorama } from './panorama';
import { drawStrip, stripSummary, stripTimeAt } from './strips';
import { caption, coord, DAY, delta, dur, isoMin, pctDelta, pick, shortCaption, utc, type Row } from './format';
import { mountMap, type MapHandle } from './map';
import { Scenario, type Spec } from './scenario';
import { drawLanes, hourAt, lanesHeight, PITCH, STEPS, TOP, xAt } from './timeline';
import { compareTable } from './compare';
import { register, run, schema, setSnapshot, snapshot, actions, toolName, tools } from './actions';
import { mountAgent } from '../agent/panel';
import type { View3DHandle } from '../view3d';
import { regionAt, type RegionTile } from '../view3d/regions';

interface SiteRec { id: string; name: string; lat: number; lon: number; program: string; date: string | null; note: string }
type View = 'mission' | 'evidence';
type Mode = '3d' | 'map';

const MASTS = [0, 2, 5, 10];
const NUDGES = [50, 100, 250, 500];
const WIN = 29.5 * DAY;
const PLAY_MS = 15000;      // one lunar day of playback
const MAX = 4;
const LETTERS = 'ABCD';
const DEFAULT_T = Date.parse('2027-06-20T00:00:00Z');
const DEFAULT_SITES = ['connecting_ridge', 'shackleton_rim'];
const dataBase = new URL(import.meta.env.BASE_URL + 'data/', location.href).href;

const ICON = {
  play: '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2.5 1.2v9.6L10.5 6z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M2.5 1.5h2.6v9H2.5zM6.9 1.5h2.6v9H6.9z" fill="currentColor"/></svg>',
  close: '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>',
  plus: '<svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true"><path d="M5 1v8M1 5h8" stroke="currentColor" stroke-width="1.3" fill="none"/></svg>',
};

let sites: SiteRec[] = [];
let ranges: Range[] = [];
const scs: Scenario[] = [];
const cards = new Map<Scenario, HTMLElement>();
const chips = new Map<Scenario, HTMLButtonElement>();
const pending = new Map<Scenario, Promise<unknown>>(); // worker results in flight, so actions can wait for them
let sel = 0, slip = 0, hours = 0, playing = false, step = 100;
let view: View = 'mission', mode: Mode = '3d', autoMap = false, forced3d = false, cmpOpen = false, editorOpen = false;
let map: MapHandle | undefined, view3d: View3DHandle | undefined, loading3d = false, err3d = '', evidenceMounted = false;
let plotW = 0, lastPano = -1, lanesQueued = false;
let regionLoads = 0;
let demTiles: RegionTile[] | undefined; // DEM manifest: the 3D view can show its 20 m south-polar tiles

const $ = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) => root.querySelector(s) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const cur = () => scs[sel];

/** Nearest landing time for which a full 29.5 d window fits inside one ephemeris table. */
function clampT(t: number): number {
  let best = t, dist = Infinity;
  for (const r of ranges) {
    const c = Math.min(r.t1 - WIN, Math.max(r.t0, t)), d = Math.abs(c - t);
    if (d < dist) { dist = d; best = c; }
  }
  return best;
}
const rangeOf = (t: number) => ranges.find((r) => t >= r.t0 && t <= r.t1) ?? ranges[0];
/** 3D region (20 m DEM tile id) containing a point, 1 km inside the tile edge. */
const regionOf = (lat: number, lon: number) => (demTiles ? regionAt(demTiles, lat, lon) : undefined);
/** Can the 3D view show this point? Unknown (so: yes) until the DEM manifest has loaded. */
const inTile = (lat: number, lon: number) => !demTiles || !!regionOf(lat, lon);
const recOf = (s: Scenario) => sites.find((x) => x.id === s.spec.site);
const nameOf = (s: Scenario) => recOf(s)?.name ?? coord(s.spec.lat, s.spec.lon);
const whenOf = (s: Scenario) => isoMin(s.spec.t).replace('T', ' ');

const env = { slip: () => slip, rangeOf, onUpdate };

/** True while a control's action runs its synchronous part: only then may it move focus (never on agent calls). */
let byUser = false;
/** A control fires an action. Failures are the action's own message (bad input); nothing else to show. */
const ui = (name: string, args?: object) => {
  byUser = true;
  try { run(name, args).catch((e) => console.warn(e)); } finally { byUser = false; }
};
const idOf = (sc: Scenario) => LETTERS[scs.indexOf(sc)];
const iso = (t: number) => isoMin(t) + 'Z';

/* ------------------------------------------------------------------ scenario cards */

function makeCard(sc: Scenario): HTMLElement {
  const el = document.createElement('article');
  el.className = 'card';
  const kpi = (k: string, label: string) => `<div data-k="${k}"><dt>${label}</dt><dd><span class="v">–</span><small class="sd"></small></dd><dd class="d"></dd></div>`;
  el.innerHTML = `
    <div class="card-top">
      <div class="card-head">
        <span class="badge" aria-hidden="true"></span>
        <span class="card-title"><span class="name"></span><span class="when"></span></span>
      </div>
      <button class="rm icon" type="button">${ICON.close}</button>
    </div>
    <dl class="kpis">${kpi('lit', 'Sunlit')}${kpi('earth', 'Earth in view')}${kpi('dark', 'Longest dark')}</dl>
    <p class="card-status" role="status"></p>
    <div class="card-more"><div class="card-ctl">
      <label class="f"><span>Site</span><select class="site"></select></label>
      <div class="f pos"><span>Position</span><output class="coord"></output></div>
      <div class="f2 custom" hidden>
        <label class="f"><span>Latitude</span><input class="lat" type="number" step="any" min="-90" max="90"></label>
        <label class="f"><span>Longitude, east</span><input class="lon" type="number" step="any" min="-180" max="360"></label>
      </div>
      <div class="f2 when-row">
        <label class="f"><span>Landing, UTC</span><input class="date" type="datetime-local" step="3600"></label>
        <label class="f"><span>Mast</span><select class="mast">${MASTS.map((m) => `<option value="${m}">${m} m</option>`).join('')}</select></label>
      </div>
      <div class="nudge" role="group" aria-label="Move the site">
        <span class="lbl">Move the site</span>
        <div class="pad">${[['n', 'N', 'north'], ['w', 'W', 'west'], ['e', 'E', 'east'], ['s', 'S', 'south']].map(([k, l, w]) => `<button type="button" data-nudge="${k}" aria-label="Move ${w}" title="Move ${w}">${l}</button>`).join('')}<i aria-hidden="true"></i></div>
        <div class="seg steps" role="group" aria-label="Distance per move">${NUDGES.map((m) => `<button type="button" data-step="${m}">${m} m</button>`).join('')}</div>
      </div>
      <p class="note"></p>
    </div></div>`;

  const site = $<HTMLSelectElement>('.site', el);
  const groups = new Map<string, HTMLOptGroupElement>();
  for (const s of sites) {
    let g = groups.get(s.program);
    if (!g) { g = document.createElement('optgroup'); g.label = s.program; groups.set(s.program, g); site.append(g); }
    g.append(new Option(s.name + (s.date ? ` (${s.date.slice(0, 4)})` : ''), s.id));
  }
  const og = document.createElement('optgroup'); og.label = 'Any point';
  og.append(new Option('Custom coordinates', 'custom'));
  site.append(og);

  const id = () => idOf(sc);
  site.onchange = () => ui('scenario.update', site.value === 'custom' ? { id: id(), lat: sc.spec.lat, lon: sc.spec.lon } : { id: id(), site: site.value });
  const lat = $<HTMLInputElement>('.lat', el), lon = $<HTMLInputElement>('.lon', el);
  lat.onchange = lon.onchange = () => {
    run('scenario.update', { id: id(), lat: lat.valueAsNumber, lon: lon.valueAsNumber })
      .catch((e) => { sc.error = BAD_COORD; paintCard(sc); console.warn(e); });
  };
  const date = $<HTMLInputElement>('.date', el);
  date.onchange = () => {
    if (date.value) ui('scenario.update', { id: id(), t: date.value + 'Z' });
  };
  const mast = $<HTMLSelectElement>('.mast', el);
  mast.onchange = () => ui('scenario.update', { id: id(), mast: +mast.value });
  $('.rm', el).onclick = () => ui('scenario.remove', { id: id() });
  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const b = t.closest<HTMLElement>('[data-t]');
    if (b) ui('scenario.update', { id: id(), t: iso(+b.dataset.t!) });
    const n = t.closest<HTMLElement>('[data-nudge]');
    if (n) ui('scenario.nudge', { id: id(), dir: n.dataset.nudge!.toUpperCase(), m: step });
    const st = t.closest<HTMLElement>('[data-step]');
    if (st) { step = +st.dataset.step!; for (const s of scs) syncCard(s); } // how far the next nudge goes: an argument, not app state
  });
  return el;
}

/** Move the site `m` metres along local north/east/south/west (great circle, so it is exact near the pole). */
function nudge(sc: Scenario, dir: string, m: number) {
  dir = dir.toLowerCase();
  const { e, n, u } = enu(sc.spec.lat, sc.spec.lon);
  const d = dir === 'n' ? n : dir === 's' ? n.map((v) => -v) : dir === 'e' ? e : e.map((v) => -v);
  const a = m / R, p = u.map((v, i) => Math.cos(a) * v + Math.sin(a) * d[i]);
  sc.spec.lat = +(Math.asin(p[2]) / DEG).toFixed(5);
  sc.spec.lon = +(Math.atan2(p[1], p[0]) / DEG).toFixed(5);
  sc.spec.site = 'custom';
  changed(sc);
}

/** Push the spec into the card's controls and note. */
function syncCard(sc: Scenario) {
  const el = cards.get(sc);
  if (!el) return;
  const { spec } = sc, rec = recOf(sc), i = scs.indexOf(sc), L = LETTERS[i];
  const on = i === sel;
  el.classList.toggle('sel', on);
  $('.badge', el).textContent = L;
  const head = $('.card-head', el);
  head.setAttribute('aria-label', `Scenario ${L}: ${nameOf(sc)}, landing ${whenOf(sc)} UTC${on ? ', selected' : ''}`);
  const rm = $<HTMLButtonElement>('.rm', el);
  rm.disabled = scs.length <= 1;
  rm.setAttribute('aria-label', `Remove scenario ${L}`); rm.title = 'Remove scenario';
  const name = $('.name', el);
  name.textContent = nameOf(sc); name.classList.toggle('mono', !rec);
  $('.when', el).innerHTML = `${whenOf(sc)} <i>UTC</i>`;
  $<HTMLSelectElement>('.site', el).value = rec ? spec.site : 'custom';
  $('.custom', el).hidden = !!rec;
  $('.coord', el).textContent = coord(spec.lat, spec.lon, 4);
  $<HTMLInputElement>('.lat', el).value = String(spec.lat);
  $<HTMLInputElement>('.lon', el).value = String(spec.lon);
  const date = $<HTMLInputElement>('.date', el);
  date.min = isoMin(Math.min(...ranges.map((x) => x.t0))); date.max = isoMin(ranges[0].t1 - WIN); date.value = isoMin(spec.t);
  $<HTMLSelectElement>('.mast', el).value = String(spec.mast);
  for (const b of el.querySelectorAll<HTMLElement>('[data-step]')) b.setAttribute('aria-pressed', String(+b.dataset.step! === step));
  let note = rec?.note ? esc(rec.note) : spec.lat < -80
    ? 'Custom point. Terrain here is 20 m where a detailed tile exists, 240 m otherwise.'
    : 'Custom point. Outside the south polar region terrain is coarse (about 4 km), so the horizon is smoother than reality.';
  if (rec?.date) {
    const t = Date.parse(rec.date + 'T00:00:00Z');
    const ok = ranges.some((x) => t >= x.t0 && t <= x.t1 - WIN);
    note += ok
      ? ` Landed ${esc(rec.date)}. <button type="button" class="link" data-t="${t}">Use the landing date</button>`
      : ` Landed ${esc(rec.date)}, outside the dates we can compute; shown at the date you pick.`;
  }
  if (rangeOf(spec.t) !== ranges[0]) note += ' Apollo-era date: no Deep Space Network data.';
  $('.note', el).innerHTML = note;
  paintChip(sc);
}

/** The compact chip in the strip above the chat: letter, name, date and the three headline numbers. */
function paintChip(sc: Scenario) {
  const el = chips.get(sc);
  if (!el) return;
  const i = scs.indexOf(sc), on = i === sel, L = LETTERS[i];
  const v = (k: 'lit' | 'earth' | 'dark') => { const r = sc.rows && pick(sc.rows, k); return r ? r.short ?? r.text : '–'; };
  el.classList.toggle('busy', sc.busy);
  el.classList.toggle('err', !!sc.error);
  el.setAttribute('aria-pressed', String(on));
  el.setAttribute('aria-label', `Scenario ${L}: ${nameOf(sc)}, landing ${whenOf(sc)} UTC. Sunlit ${v('lit')}, Earth in view ${v('earth')}, longest dark ${v('dark')}. ${on ? 'Selected. ' : ''}Opens the editor.`);
  el.innerHTML = `<span class="badge${on ? ' on' : ''}" aria-hidden="true">${L}</span><span class="chip-name${recOf(sc) ? '' : ' mono'}">${esc(nameOf(sc))}</span>
    <span class="chip-when">${whenOf(sc).slice(0, 10)}</span>
    <span class="chip-kpi"><b class="sun" title="Sunlit, share of the 29.5 days">${v('lit')}</b><b class="earth" title="Earth in view">${v('earth')}</b><span title="Longest dark">${sc.error ? 'no result' : `☾ ${v('dark')}`}</span></span>`;
}

/** Push results into the card's headline numbers and status line. */
function paintCard(sc: Scenario) {
  const el = cards.get(sc);
  if (!el) return;
  el.classList.toggle('busy', sc.busy);
  const st = $('.card-status', el);
  st.className = 'card-status' + (sc.error || sc.slipError ? ' err' : '');
  st.textContent = sc.error || sc.slipError || (sc.base ? shortCaption(sc.base.metrics)
    : 'Computing the terrain horizon');
  paintChip(sc);
  if (!sc.rows) return;
  for (const k of ['lit', 'earth', 'dark'] as const) {
    const box = $(`[data-k="${k}"]`, el), r = pick(sc.rows, k);
    $('.v', box).textContent = r.short ?? r.text;
    $('.sd', box).textContent = k === 'lit' ? r.sd.replace(' ± ', '±') : '';
    const d = $('.d', box);
    if (!slip) { d.textContent = ''; d.className = 'd'; continue; }
    const x = sc.cmp && sc.srows ? (k === 'earth' ? pctDelta : delta)(pick(sc.cmp, k), pick(sc.srows, k)) : { text: sc.slipError ? 'n/a' : '…', cls: 'pending' };
    d.textContent = x.text; d.className = `d ${x.cls}`;
  }
}

/** Spec changed: refresh controls, recompute, update the URL and the stage. */
function changed(sc: Scenario) {
  syncCard(sc);
  track(sc, sc.compute());
  saveHash();
  if (sc === cur()) { paintHead(); stagePolicy(); }
  syncStage();
}

/** Remember a worker job so settled() can wait for it and for whatever replaces it. */
function track(sc: Scenario, p: Promise<unknown>) { pending.set(sc, Promise.all([pending.get(sc), p])); }
async function settled(sc: Scenario) {
  let p;
  do { p = pending.get(sc); await p; } while (pending.get(sc) !== p);
}

function onUpdate(sc: Scenario) {
  paintCard(sc);
  queueLanes();
  if (sc === cur()) paintInspector();
  if (cmpOpen) paintCompare();
}

function select(i: number) {
  if (i < 0 || i >= scs.length) i = 0;
  if (i === sel && cards.get(scs[i])?.classList.contains('sel')) return;
  sel = i;
  for (const s of scs) syncCard(s);
  paintInspector(); queueLanes(); stagePolicy(); syncStage(); saveHash();
  if (mode === 'map') map?.focus(cur().spec.lat, cur().spec.lon);
  if (cmpOpen) paintCompare();
}

function add(spec: Spec, quiet = false): Scenario {
  const sc = new Scenario(spec, env), el = makeCard(sc);
  const chip = document.createElement('button');
  chip.type = 'button'; chip.className = 'chip';
  chip.onclick = () => ui('scenario.select', { id: idOf(sc), editor: true });
  scs.push(sc); cards.set(sc, el); chips.set(sc, chip);
  $('#cards').append(el);
  $('#add').before(chip);
  track(sc, sc.compute());
  if (!quiet) { select(scs.length - 1); afterCount(); }
  return sc;
}
function remove(sc: Scenario) {
  if (scs.length <= 1) return;
  const i = scs.indexOf(sc), lost = !!cards.get(sc)?.contains(document.activeElement); // e.g. its own ✕
  scs.splice(i, 1);
  cards.get(sc)?.remove(); cards.delete(sc);
  chips.get(sc)?.remove(); chips.delete(sc); pending.delete(sc);
  sel = Math.min(sel > i ? sel - 1 : sel, scs.length - 1);
  cards.get(cur())?.classList.remove('sel'); // force select() to repaint
  select(sel); afterCount();
  if (lost) (editorOpen ? $('#editor-close') : chips.get(cur()))?.focus({ preventScroll: true });
}
/** Scenario count changed: letters, lane badges, dock height. */
function afterCount() {
  for (const s of scs) { syncCard(s); paintCard(s); }
  const addBtn = $<HTMLButtonElement>('#add'), full = scs.length >= MAX;
  if (full && document.activeElement === addBtn) chips.get(scs[scs.length - 1])?.focus({ preventScroll: true });
  addBtn.hidden = full;
  $<HTMLCanvasElement>('#lanes').style.height = `${lanesHeight(scs.length)}px`;
  $('.playhead').style.height = `${TOP + scs.length * PITCH - 2}px`;
  $('#lane-badges').innerHTML = scs.map((_, i) => `<button type="button" class="badge" data-lane="${i}" aria-label="Select scenario ${LETTERS[i]}">${LETTERS[i]}</button>`).join('');
  queueLanes(); syncStage(); saveHash();
  if (cmpOpen) paintCompare();
}

/** The full card of the selected scenario, as a pop-over under the chips. */
function setEditor(open: boolean, focus = false) {
  editorOpen = open;
  $('#editor').hidden = !open;
  if (open && focus) $('#editor-close').focus({ preventScroll: true });
  else if ($('#editor').contains(document.activeElement)) chips.get(cur())?.focus();
}

/* ------------------------------------------------------------------ inspector */

function paintHead() {
  const sc = cur();
  $('#i-badge').textContent = LETTERS[sel];
  const n = $('#i-name');
  n.textContent = recOf(sc)?.name ?? 'Custom point';
  $('#i-coord').textContent = coord(sc.spec.lat, sc.spec.lon, 4);
}

function paintInspector() {
  const sc = cur();
  if (!sc) return;
  paintHead();
  const insp = $('.insp');
  insp.classList.toggle('busy', sc.busy);
  insp.classList.toggle('empty', !sc.base);
  const st = $('#i-status');
  st.textContent = sc.error || sc.slipError;
  const b = sc.base;
  if (!b || !sc.rows) { // first load: same layout as the result, so nothing jumps when it arrives
    $('#i-cap').textContent = 'Computing the terrain horizon. The first polar site downloads about 20 MB of terrain.';
    $('#i-table').innerHTML = '<thead><tr><th></th><th>At landing</th></tr></thead><tbody>'
      + ['Sun elevation', 'Sun disk visible', 'Sunset in', 'Earthset in', 'Sunlit, 29.5 d', 'Longest dark', 'Earth in view', 'Deep Space Network', 'Battery']
        .map((l) => `<tr><th scope="row">${l}</th><td>–</td></tr>`).join('') + '</tbody>';
    return;
  }
  $('#i-cap').textContent = `At landing: ${caption(b.metrics)}`;
  const TITLES: Partial<Record<Row['key'], string>> = {
    dsn: 'Hours when Earth is in view from the site and the Moon is above 10° at Goldstone, Madrid or Canberra',
    battery: '200 W Sun-tracking panel, constant 100 W load, 1.5 kWh of storage, starting full',
  };
  const head = `<thead><tr><th></th><th>At landing</th>${slip ? `<th>Delayed ${slip} d</th>` : ''}</tr></thead>`;
  $('#i-table').innerHTML = head + '<tbody>' + sc.rows.map((r, i) => {
    const d = sc.cmp && sc.srows ? delta(sc.cmp[i], sc.srows[i]) : null;
    const cell = slip ? `<td class="d ${d?.cls ?? 'pending'}">${d ? esc(d.text) : sc.slipError ? 'n/a' : '…'}</td>` : '';
    const t = TITLES[r.key];
    return `<tr><th scope="row"${t ? ` title="${esc(t)}"` : ''}>${t ? `<span class="hint">${r.label}</span>` : r.label}</th><td>${esc(r.text)}${r.sd ? `<small>${esc(r.sd)}</small>` : ''}</td>${cell}</tr>`;
  }).join('') + '</tbody>';
  if (sc.strip) {
    const y = stripSummary(sc.strip);
    $('#i-year').textContent = `12 months from ${isoMin(sc.strip.t0).slice(0, 10)}`;
    $('#i-ysum').textContent = `${Math.round(y.pctLit)}% sunlit · Earth in view ${Math.round(y.pctEarth)}% · longest dark ${dur(y.longestDarkHours)}`;
  }
  paintStrip();
  lastPano = -1;
  paintNow();
}

function paintStrip() {
  const sc = cur();
  if (sc?.strip) drawStrip($<HTMLCanvasElement>('#i-strip'), sc.strip, { markT: sc.spec.t, markT2: slip ? sc.spec.t + slip * DAY : undefined });
}

/** Scrubber position: panorama, readouts, clock. Canvas draw first, text writes after. No worker call. */
function paintNow() {
  const sc = cur();
  if (!sc) return;
  const b = sc.base, h = Math.round(hours);
  if (b) {
    const s = b.series, i = Math.min(h, s.t.length - 1);
    if (i !== lastPano) {
      lastPano = i;
      drawPanorama($<HTMLCanvasElement>('#i-pano'), b, { idx: i });
      const f = s.sunFrac[i], bits = b.mission.dsn[i], vis = !!s.earthVis[i];
      $('#n-el').textContent = `${s.sunEl[i].toFixed(1)}°`;
      $('#n-disk').textContent = `${f > 0 && f < 0.005 ? '<1' : Math.round(f * 100)}%`;
      $('#n-plit').textContent = b.uncertainty ? `${Math.round(b.uncertainty.pLit[i] * 100)}%` : '–';
      const e = $('#n-earth');
      e.textContent = vis ? 'In view' : 'Hidden'; e.classList.toggle('on', vis);
      $('#n-dsn').textContent = b.mission.commsHours === null ? 'no station data for this era' : !vis ? 'no link while Earth is hidden'
        : bits ? `link via ${DSN_NAMES.filter((_, k) => bits & (1 << k)).join(' and ')}` : 'no station can see the Moon';
    }
  }
  $('#clock').textContent = utc(sc.spec.t + hours * 3600e3);
  $('#off').textContent = `landing + ${dur(hours)}`.replace('<1 h', '0 h');
}

/* ------------------------------------------------------------------ timeline dock */

function queueLanes() {
  if (lanesQueued) return;
  lanesQueued = true;
  requestAnimationFrame(() => {
    lanesQueued = false;
    const cv = $<HTMLCanvasElement>('#lanes');
    drawLanes(cv, scs.map((s) => ({ series: s.base?.series, ghost: slip ? s.slipped?.series : undefined })), slip > 0);
    plotW = cv.clientWidth;
    placeHead();
    document.querySelectorAll<HTMLElement>('#lane-badges .badge').forEach((b, i) => b.classList.toggle('on', i === sel));
  });
}
function placeHead() {
  $('.playhead').style.transform = `translateX(${xAt(hours, plotW).toFixed(1)}px)`;
}

function setHours(v: number) {
  hours = Math.min(STEPS - 1, Math.max(0, v));
  placeHead();
  paintNow();
  push3dTime();
}
const stageTime = () => cur().spec.t + hours * 3600e3;
function push3dTime() {
  if (view3d && mode === '3d' && view === 'mission') view3d.setTime(stageTime());
}
function scrubAria() {
  const p = $('#scrub');
  p.setAttribute('aria-valuenow', String(Math.round(hours)));
  p.setAttribute('aria-valuetext', `landing + ${dur(hours)}`.replace('<1 h', '0 h'));
}

let lastFrame = 0;
function tick(now: number) {
  if (!playing) return;
  if (lastFrame) setHours((hours + ((now - lastFrame) / PLAY_MS) * STEPS) % (STEPS - 1));
  lastFrame = now;
  requestAnimationFrame(tick);
}
function setPlaying(p: boolean) {
  if (p === playing) return;
  playing = p; lastFrame = 0;
  const b = $('#play');
  b.innerHTML = p ? ICON.pause : ICON.play;
  b.setAttribute('aria-label', p ? 'Pause' : 'Play one lunar day');
  b.title = p ? 'Pause' : 'Play one lunar day (space)';
  if (p) requestAnimationFrame(tick);
  else { setHours(Math.round(hours)); scrubAria(); saveHash(); }
}

/* ------------------------------------------------------------------ stage */

/** The 3D view covers the five 20 m south-polar regions: fall back to the map for sites outside them, and come back. */
function stagePolicy() {
  const sc = cur(), inside = inTile(sc.spec.lat, sc.spec.lon);
  if (inside) forced3d = false;
  if (!inside && mode === '3d' && !forced3d) { setMode('map', false); autoMap = true; map?.focus(sc.spec.lat, sc.spec.lon); }
  else if (inside && autoMap && mode === 'map') setMode('3d', false);
  paintNote();
}

function paintNote() {
  const sc = cur(), n = $('#stage-note');
  if (!sc) return;
  const inside = inTile(sc.spec.lat, sc.spec.lon);
  let text = '';
  if (mode === 'map') text = autoMap && !inside
    ? '3D terrain covers Shackleton, de Gerlache Rim, Haworth, Malapert Massif and Mons Mouton / Nobile Rim. Showing the map for this site.'
    : `Click the map to place scenario ${LETTERS[sel]}.`;
  else if (err3d) text = err3d;
  else if (!inside) text = `Scenario ${LETTERS[sel]} is outside the 3D regions, so it has no pin here. The lighting is for its date.`;
  else if (rangeOf(sc.spec.t) !== ranges[0]) text = '3D lighting covers 2024 to 2040, so it cannot show this date.';
  n.textContent = text;
  n.classList.toggle('err', mode === '3d' && !!err3d);
}

function setMode(m: Mode, user = true) {
  mode = m; autoMap = false;
  if (user) forced3d = m === '3d' && !inTile(cur().spec.lat, cur().spec.lon);
  $('#s3d').hidden = m !== '3d'; $('#smap').hidden = m !== 'map';
  $('.stage').dataset.mode = m;
  for (const b of document.querySelectorAll<HTMLElement>('.stage-switch [data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === m));
  if (view === 'mission') showStage();
  paintNote();
  if (user) saveHash();
}

/** Mount whichever stage pane is showing (once), and bring it up to date. */
function showStage() {
  if (mode === 'map') {
    if (!map) {
      map = mountMap($('#smap'), {
        dataBase, sites,
        onPick: (lat, lon, id) => { if (cur()) ui('scenario.update', id ? { id: LETTERS[sel], site: id } : { id: LETTERS[sel], lat, lon }); },
        onBar: (c) => ui('view.set', { region: keyOf(MAP_REGION, c.mode), overlay: keyOf(MAP_OVERLAY, c.overlay) }),
      });
      map.focus(cur().spec.lat, cur().spec.lon);
    }
  } else if (!view3d && !loading3d) {
    loading3d = true;
    const stage = $('.stage');
    stage.classList.add('loading');
    import('../view3d').then(({ mount3D }) => {
      view3d = mount3D($('#s3d'), {
        dataBase, startZoom: 0.62, region: regionOf(cur().spec.lat, cur().spec.lon),
        onPick: (lat, lon) => { if (cur()) ui('scenario.update', { id: LETTERS[sel], lat, lon }); },
        onReady: () => { stage.classList.remove('loading'); syncStage(); },
        onError: () => stage.classList.remove('loading'), // the module shows its own message
      });
      if (import.meta.env.DEV) (window as unknown as { __view3d?: View3DHandle }).__view3d = view3d; // self-check hooks, dev server only
      syncStage();
    }).catch((e) => {
      stage.classList.remove('loading'); loading3d = false;
      err3d = `The 3D view could not start: ${(e as Error).message}.`;
      paintNote();
    });
  }
  syncStage();
  view3d?.resize();
}

/** Keep the map markers and the 3D pins and clock in step with the scenarios. */
function syncStage() {
  map?.setMarkers(scs.map((c, i) => ({ lat: c.spec.lat, lon: c.spec.lon, label: LETTERS[i] })));
  if (!view3d || !scs.length) return;
  // The view shows the region of the selected scenario and pins only the scenarios inside it.
  const region = regionOf(cur().spec.lat, cur().spec.lon);
  if (region && view3d.region() !== region) {
    const stage = $('.stage');
    stage.classList.add('loading');
    regionLoads++;
    view3d.setRegion(region).catch(() => {}).finally(() => { if (!--regionLoads) stage.classList.remove('loading'); }); // on failure the view keeps the old region
  }
  view3d.setSites(scs.map((c, i) => ({ lat: c.spec.lat, lon: c.spec.lon, mast: c.spec.mast, label: LETTERS[i] })));
  push3dTime();
}

/* ------------------------------------------------------------------ compare sheet */

function paintCompare() {
  $('#cmp-table').innerHTML = compareTable(scs.map((s, i) => ({
    letter: LETTERS[i], name: nameOf(s), when: `${whenOf(s)} UTC`, selected: i === sel,
    rows: s.rows, cmp: s.cmp, srows: slip ? s.srows : undefined, error: s.error,
  })), slip);
  $('#cmp-legend').innerHTML = `<i class="dot"></i> best in the row${slip
    ? ` · second line: change if the landing is delayed by ${slip} d, <span class="good">better</span> or <span class="bad">worse</span>` : ''}`;
}
function setCompare(open: boolean, focus = false) {
  cmpOpen = open;
  const sheet = $('#sheet'), btn = $('#cmp');
  sheet.classList.toggle('open', open);
  sheet.toggleAttribute('inert', !open);
  btn.setAttribute('aria-pressed', String(open));
  if (open) { paintCompare(); if (focus) $('#cmp-close').focus({ preventScroll: true }); }
  else if (sheet.contains(document.activeElement)) btn.focus();
  saveHash();
}

/* ------------------------------------------------------------------ URL hash
   #c=<siteId|lat,lon>~<YYYY-MM-DDTHH:MM>~<mast>&c=...&slip=N&s=<selected>&h=<hours>&m=<3d|map>&cmp=1&v=evidence */

let hashTimer = 0;
/** Coalesced: actions call this freely (a scrub drag fires one per pointer move, and browsers rate-limit replaceState). */
function saveHash() {
  clearTimeout(hashTimer);
  hashTimer = window.setTimeout(writeHash, 150);
}
function writeHash() {
  clearTimeout(hashTimer);
  if (!scs.length) return;
  const p = new URLSearchParams();
  for (const { spec } of scs) p.append('c', `${spec.site === 'custom' ? `${spec.lat},${spec.lon}` : spec.site}~${isoMin(spec.t)}~${spec.mast}`);
  if (slip) p.set('slip', String(slip));
  if (sel) p.set('s', String(sel));
  if (Math.round(hours)) p.set('h', String(Math.round(hours)));
  if (mode === 'map' && !autoMap) p.set('m', 'map');
  if (forced3d) p.set('m', '3d');
  if (cmpOpen) p.set('cmp', '1');
  if (view !== 'mission') p.set('v', view);
  history.replaceState(null, '', '#' + p.toString());
}
function loadHash(): Spec[] {
  const p = new URLSearchParams(location.hash.slice(1));
  const int = (k: string, max: number) => Math.min(max, Math.max(0, Math.round(+(p.get(k) ?? 0)) || 0));
  slip = int('slip', 60); sel = int('s', MAX - 1); hours = int('h', STEPS - 1);
  view = p.get('v') === 'evidence' ? 'evidence' : 'mission';
  mode = p.get('m') === 'map' ? 'map' : '3d';
  forced3d = p.get('m') === '3d';
  cmpOpen = p.get('cmp') === '1';
  const specs: Spec[] = [];
  for (const c of p.getAll('c').slice(0, MAX)) {
    const [key, d, m] = c.split('~');
    const rec = sites.find((s) => s.id === key);
    const [lat, lon] = rec ? [rec.lat, rec.lon] : (key ?? '').split(',').map(Number);
    const t = Date.parse((d ?? '') + 'Z');
    if (!(Math.abs(lat) <= 90) || !(Math.abs(lon) <= 360)) continue;
    specs.push({ site: rec ? rec.id : 'custom', lat, lon, t: clampT(Number.isNaN(t) ? DEFAULT_T : t), mast: MASTS.includes(+m) ? +m : 2 });
  }
  return specs;
}
function defaults(): Spec[] {
  return DEFAULT_SITES.map((id) => {
    const s = sites.find((x) => x.id === id) ?? sites[0];
    return { site: s.id, lat: s.lat, lon: s.lon, t: clampT(DEFAULT_T), mast: 2 };
  });
}

/* ------------------------------------------------------------------ views */

async function setView(v: View) {
  view = v;
  if (v === 'evidence') setPlaying(false);
  $('.shell').dataset.view = v;
  for (const b of document.querySelectorAll<HTMLElement>('.views [data-view]')) b.setAttribute('aria-selected', String(b.dataset.view === v));
  saveHash();
  if (v === 'mission') {
    showStage();
    requestAnimationFrame(() => { queueLanes(); paintInspector(); }); // canvases were hidden: redraw at real size
  } else if (!evidenceMounted) {
    evidenceMounted = true;
    try {
      const { mountEvidence } = await import('./evidence');
      mountEvidence($('#evidence'), { dataBase });
    } catch (e) {
      evidenceMounted = false;
      $('#evidence').textContent = `Could not load this page: ${(e as Error).message}.`;
    }
  }
}

/* ------------------------------------------------------------------ actions
   The only way a user-visible change happens: controls call ui(name, args), the agent calls the same registry.
   Actions that start worker compute resolve when the results are in, and return the headline metrics. */

const BAD_COORD = 'Latitude must be -90 to 90 and longitude -180 to 360.';
const MAP_REGION = { south_pole: 'polar', whole_moon: 'global' } as const;
const MAP_OVERLAY = { terrain: 'none', sunlight: 'sp_sun', earth: 'sp_earth' } as const;
const keyOf = (o: Record<string, string>, v?: string) => Object.keys(o).find((k) => o[k] === v);

function scOf(id: string): Scenario {
  const sc = id.trim().length === 1 ? scs[LETTERS.indexOf(id.trim().toUpperCase())] : undefined;
  if (!sc) throw new Error(`No scenario "${id}". Scenarios now: ${scs.map(idOf).join(', ')}.`);
  return sc;
}
function siteOf(q: string): SiteRec {
  const k = q.trim().toLowerCase();
  const s = sites.find((x) => x.id === k) ?? sites.find((x) => x.name.toLowerCase() === k);
  if (!s) throw new Error(`Unknown site "${q}". Use ${toolName('sites.search')} to find a catalogue id, or give lat and lon.`);
  return s;
}
function timeOf(s: string): number {
  const t = Date.parse(/T/.test(s) && !/(Z|[+-]\d\d:?\d\d)$/i.test(s) ? s + 'Z' : s);
  if (Number.isNaN(t)) throw new Error(`Cannot read "${s}" as a UTC time. Use ISO 8601, for example 2027-03-02T00:00Z.`);
  return clampT(t);
}

interface SpecArgs { site?: string; lat?: number; lon?: number; t?: string; mast?: number }
/** `spec` with the given fields replaced. A site sets the position; lat/lon make it a custom point. Throws on bad input. */
function patch(spec: Spec, a: SpecArgs): Spec {
  const out = { ...spec };
  if (a.site != null && a.site !== 'custom') { const s = siteOf(a.site); out.site = s.id; out.lat = s.lat; out.lon = s.lon; }
  else if (a.lat != null || a.lon != null) {
    const lat = a.lat ?? spec.lat, lon = a.lon ?? spec.lon;
    if (!(Math.abs(lat) <= 90) || !(lon >= -180 && lon <= 360)) throw new Error(BAD_COORD);
    out.site = 'custom'; out.lat = +lat.toFixed(5); out.lon = +lon.toFixed(5);
  }
  if (a.t != null) out.t = timeOf(a.t);
  if (a.mast != null) {
    if (!MASTS.includes(a.mast)) throw new Error(`Mast must be one of ${MASTS.join(', ')} m.`);
    out.mast = a.mast;
  }
  return out;
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const winPct = (rs: Row[]) => r1((100 * pick(rs, 'earth').num!) / (WIN / 3600e3));
/** Headline metrics of a scenario as the model reads them; null while computing. */
function headline(sc: Scenario) {
  if (sc.error) return { error: sc.error };
  const b = sc.base;
  if (!b || !sc.rows || sc.busy) return null;
  const m = b.metrics, at = (h: number | null) => (h === null ? null : iso(sc.spec.t + h * 3600e3));
  return {
    sunlitPct: r1(pick(sc.rows, 'lit').num!),
    sunlitPctSd: b.uncertainty ? r1(b.uncertainty.std.pctLit) : null,
    earthPct: winPct(sc.rows),
    longestDarkHours: Math.round(pick(sc.rows, 'dark').num!),
    dsnHours: b.mission.commsHours === null ? null : Math.round(b.mission.commsHours),
    battery: pick(sc.rows, 'battery').text,
    atLanding: { sunElevationDeg: r1(m.sunEl), sunDiskVisiblePct: Math.round(m.sunFrac * 100), earthInView: m.earthVisible },
    // `at` null: it does not happen within the 29.5 days
    nextSunEvent: m.sunFrac > 0 ? { type: 'sunset', at: at(m.hoursToSunset) } : { type: 'sunrise', at: at(m.hoursToSunrise) },
    nextEarthEvent: m.earthVisible ? { type: 'earthset', at: at(m.hoursToEarthset) } : { type: 'earthrise', at: at(m.hoursToEarthrise) },
    inWords: caption(m),
    ...(slip && sc.srows ? {
      delayed: { days: slip, sunlitPct: r1(pick(sc.srows, 'lit').num!), earthPct: winPct(sc.srows), longestDarkHours: Math.round(pick(sc.srows, 'dark').num!), battery: pick(sc.srows, 'battery').text },
    } : slip && sc.slipError ? { delayed: { days: slip, error: sc.slipError } } : {}),
  };
}
function describe(sc: Scenario) {
  const { spec } = sc;
  return { id: idOf(sc), site: spec.site, name: nameOf(sc), lat: spec.lat, lon: spec.lon, landing: iso(spec.t), mastM: spec.mast, in3dRegion: inTile(spec.lat, spec.lon), metrics: headline(sc) };
}
const oneLine = (sc: Scenario) => {
  const h = headline(sc);
  return `${idOf(sc)}: ${nameOf(sc)}, ${iso(sc.spec.t)}` + (h && 'sunlitPct' in h ? ` (sunlit ${h.sunlitPct}%, Earth ${h.earthPct}%, longest dark ${h.longestDarkHours} h)` : '');
};

function viewState() {
  const mapRegion = keyOf(MAP_REGION, map?.state().mode) ?? 'south_pole';
  return {
    mode,
    mapRegion,
    mapOverlay: mapRegion === 'whole_moon' ? 'terrain' : keyOf(MAP_OVERLAY, map?.state().overlay) ?? 'terrain', // no overlays there
    region3d: view3d?.region() ?? null,
    note: $('#stage-note').textContent || null,
  };
}
const tabNow = () => (view === 'mission' && cmpOpen ? 'compare' : view);

/** Everything on screen, as JSON: what state.get returns. */
function appState() {
  return {
    tab: tabNow(), view: viewState(), selected: LETTERS[sel], editorOpen,
    hoursAfterLanding: Math.round(hours), timeShown: scs.length ? iso(stageTime()) : null, playing, slipDays: slip,
    maxScenarios: MAX,
    landingDatesAvailable: ranges.map((r) => ({ from: iso(r.t0), to: iso(r.t1 - WIN) })),
    scenarios: scs.map(describe),
  };
}

/** Sky state of every scenario at the scrubber position. */
function nowState() {
  const i = Math.round(hours);
  return {
    hoursAfterLanding: i, timeShown: iso(stageTime()),
    scenarios: scs.map((sc) => {
      const s = sc.base?.series, k = s ? Math.min(i, s.t.length - 1) : 0;
      return s ? { id: idOf(sc), at: iso(sc.spec.t + i * 3600e3), sunElevationDeg: r1(s.sunEl[k]), sunDiskVisiblePct: Math.round(s.sunFrac[k] * 100), earthInView: !!s.earthVis[k], dsnLink: !!s.earthVis[k] && !!sc.base!.mission.dsn[k], computing: sc.busy }
        : { id: idOf(sc), computing: true };
    }),
  };
}

let slipTimer = 0;
const slipWaiters: (() => void)[] = [];
function paintSlip() {
  $<HTMLInputElement>('#slip').value = String(slip);
  $('#slipv').textContent = `${slip} d`;
  $('.shell').classList.toggle('has-slip', slip > 0);
}
/** Marker and lane layout move now; the numbers follow a short debounce (the slider fires on every step). Resolves when they are in. */
function setSlip(days: number): Promise<void> {
  slip = days;
  paintSlip(); paintStrip(); queueLanes();
  clearTimeout(slipTimer);
  slipTimer = window.setTimeout(async () => {
    const w = slipWaiters.splice(0);
    for (const c of scs) track(c, c.computeSlip());
    paintInspector(); saveHash();
    await Promise.all(scs.map(settled));
    for (const f of w) f();
  }, 120);
  return new Promise((res) => slipWaiters.push(res));
}

function registerActions() {
  const str = (description: string) => ({ type: 'string' as const, description });
  const num = (description: string) => ({ type: 'number' as const, description });
  const ID = str('Scenario id: its letter, A to D.');
  const SPEC = {
    site: str(`Catalogue site id (see ${toolName('sites.search')}), e.g. "malapert". Sets the position.`),
    lat: num('Latitude in degrees, -90 to 90. Use with lon for a point that is not in the catalogue.'),
    lon: num('Longitude in degrees east, -180 to 360.'),
    t: str('Landing time, UTC, ISO 8601, e.g. "2027-03-02T00:00Z". Clamped to the dates the app can compute.'),
    mast: { type: 'integer' as const, enum: MASTS, description: 'Height of the panel/antenna above the ground in metres.' },
  };

  register({
    name: 'state.get',
    description: 'Read everything on screen as JSON: the scenarios (id, site, position, landing time, mast, headline metrics), the selected scenario, the active tab, the stage view (3D or map, map region and overlay), the time scrubber, the landing delay and whether playback is running. Call this before acting when unsure of the current state.',
    schema: schema(),
    run: async () => snapshot(),
  });
  register({
    name: 'sites.search',
    description: 'Search the site catalogue by words in the id, name, programme or note. An empty query lists every site. Returns id, name, lat, lon, programme, historical landing date if any, and a note with the published average sunlight and Earth visibility where known.',
    schema: schema({ query: str('Words to look for, e.g. "artemis", "apollo", "ridge". Empty for all sites.') }, ['query']),
    run: async ({ query }: { query: string }) => {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      const hit = sites.filter((s) => { const hay = `${s.id} ${s.name} ${s.program} ${s.note}`.toLowerCase(); return words.every((w) => hay.includes(w)); });
      return { count: hit.length, sites: hit.map((s) => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lon, programme: s.program, landed: s.date, note: s.note, in3dRegion: inTile(s.lat, s.lon) })) };
    },
  });
  register({
    name: 'scenario.add',
    description: `Add a scenario (at most ${MAX}) and select it. Give a catalogue site, or lat and lon together; fields left out are copied from the selected scenario. Waits for the computation and returns the new scenario with its metrics: sunlit %, Earth-in-view %, longest dark, DSN hours, battery, next sunset/sunrise and Earthset/Earthrise times.`,
    schema: schema(SPEC),
    run: async (a: SpecArgs) => {
      if (scs.length >= MAX) throw new Error(`There are already ${MAX} scenarios. Remove one first.`);
      if ((a.lat == null) !== (a.lon == null)) throw new Error('Give lat and lon together.');
      const sc = add(patch(cur().spec, a));
      await settled(sc);
      return { summary: `Added scenario ${oneLine(sc)}`, scenario: describe(sc) };
    },
  });
  register({
    name: 'scenario.update',
    description: 'Change a scenario: its site (or lat/lon for a custom point), landing time or mast height. Only the fields given change. Waits for the recomputation and returns the scenario with its new metrics.',
    schema: schema({ id: ID, ...SPEC }, ['id']),
    run: async ({ id, ...a }: SpecArgs & { id: string }) => {
      const sc = scOf(id), next = patch(sc.spec, a);
      Object.assign(sc.spec, next);
      changed(sc);
      if (a.site != null && sc === cur()) map?.focus(next.lat, next.lon);
      await settled(sc);
      return { summary: `Updated scenario ${oneLine(sc)}`, scenario: describe(sc) };
    },
  });
  register({
    name: 'scenario.nudge',
    description: 'Move a scenario a number of metres north, east, south or west, to test how sensitive the site is to position. The scenario becomes a custom point. Waits for the recomputation and returns the new metrics.',
    schema: schema({ id: ID, dir: { type: 'string', enum: ['N', 'E', 'S', 'W'], description: 'Direction.' }, m: num('Distance in metres, above 0 and at most 5000. The buttons use 50, 100, 250 and 500.') }, ['id', 'dir', 'm']),
    run: async ({ id, dir, m }: { id: string; dir: string; m: number }) => {
      const sc = scOf(id);
      if (!(m > 0 && m <= 5000)) throw new Error('m must be above 0 and at most 5000 metres.');
      nudge(sc, dir, m);
      await settled(sc);
      return { summary: `Moved ${m} m ${dir}: scenario ${oneLine(sc)}`, scenario: describe(sc) };
    },
  });
  register({
    name: 'scenario.remove',
    description: 'Remove a scenario. The last one cannot be removed. Scenarios after it move up one letter; the result lists the new ids.',
    schema: schema({ id: ID }, ['id']),
    run: async ({ id }: { id: string }) => {
      const sc = scOf(id), was = `${idOf(sc)} (${nameOf(sc)})`;
      if (scs.length <= 1) throw new Error('The last scenario cannot be removed. Update it instead.');
      remove(sc);
      return { summary: `Removed scenario ${was}`, selected: LETTERS[sel], scenarios: scs.map((s) => ({ id: idOf(s), name: nameOf(s), landing: iso(s.spec.t) })) };
    },
  });
  register({
    name: 'scenario.select',
    description: 'Select a scenario: the inspector, the 3D pins and the map follow it. Optionally open or close its editor pop-over. Returns the scenario with its metrics.',
    schema: schema({ id: ID, editor: { type: 'boolean', description: 'true opens the editor pop-over for this scenario, false closes it. Leave out to keep it as it is.' } }, ['id']),
    run: async ({ id, editor }: { id: string; editor?: boolean }) => {
      const sc = scOf(id);
      select(scs.indexOf(sc));
      if (editor != null) setEditor(editor, byUser);
      await settled(sc);
      return { summary: `Selected scenario ${oneLine(sc)}`, scenario: describe(sc) };
    },
  });
  register({
    name: 'time.set',
    description: 'Move the time scrubber to a number of hours after landing (0 to 707; it applies to every scenario) and pause playback. The 3D lighting and the horizon panorama follow. Returns the Sun and Earth state of each scenario at that moment.',
    schema: schema({ hoursAfterLanding: num('Hours after landing, 0 to 707. Values outside are clamped.') }, ['hoursAfterLanding']),
    run: async ({ hoursAfterLanding }: { hoursAfterLanding: number }) => {
      setPlaying(false);
      setHours(Math.round(hoursAfterLanding)); scrubAria(); saveHash();
      return nowState();
    },
  });
  register({
    name: 'time.play',
    description: 'Start playback: the scrubber sweeps one lunar day in about 15 seconds and loops until paused.',
    schema: schema(),
    run: async () => { setPlaying(true); return { playing }; },
  });
  register({
    name: 'time.pause',
    description: 'Pause playback. Returns the Sun and Earth state of each scenario at the time shown.',
    schema: schema(),
    run: async () => { setPlaying(false); return { playing, ...nowState() }; },
  });
  register({
    name: 'slip.set',
    description: 'Set the landing delay ("slip") in whole days, 0 to 60; 0 turns it off. Every scenario is recomputed at its landing time plus the delay. Waits for the results and returns each scenario with metrics.delayed next to the on-time metrics.',
    schema: schema({ days: { type: 'integer', description: 'Days of delay, 0 to 60.' } }, ['days']),
    run: async ({ days }: { days: number }) => {
      if (!(days >= 0 && days <= 60)) throw new Error('days must be 0 to 60.');
      await setSlip(days);
      return { summary: days ? `Landing delayed by ${days} d` : 'Landing delay off', slipDays: slip, scenarios: scs.map(describe) };
    },
  });
  register({
    name: 'view.set',
    description: 'Change what the stage shows: the 3D terrain or the 2D map, and on the map its region and colour overlay. Giving region or overlay switches to the map. Overlays (NASA average sunlight / Earth visibility) exist only for the south_pole region. The 3D view always shows the region of the selected scenario. Opens the mission tab if another tab is showing.',
    schema: schema({
      mode: { type: 'string', enum: ['3d', 'map'], description: 'Stage view.' },
      region: { type: 'string', enum: Object.keys(MAP_REGION), description: 'Map region.' },
      overlay: { type: 'string', enum: Object.keys(MAP_OVERLAY), description: 'Map overlay.' },
    }),
    run: async (a: { mode?: Mode; region?: keyof typeof MAP_REGION; overlay?: keyof typeof MAP_OVERLAY }) => {
      const onMap = a.region != null || a.overlay != null;
      if (onMap && a.mode === '3d') throw new Error('region and overlay apply to the map; leave them out with mode "3d".');
      const region = a.region ?? (a.overlay && a.overlay !== 'terrain' ? 'south_pole' : undefined);
      if (region === 'whole_moon' && a.overlay && a.overlay !== 'terrain') throw new Error('Overlays exist only for the south_pole region.');
      if (view !== 'mission') await setView('mission');
      const m = a.mode ?? (onMap ? 'map' : mode);
      if (m !== mode) setMode(m);
      if (region) map?.setMode(MAP_REGION[region]);
      if (a.overlay) map?.setOverlay(MAP_OVERLAY[a.overlay]);
      return { tab: tabNow(), view: viewState() };
    },
  });
  register({
    name: 'tab.set',
    description: 'Switch the page: "mission" (stage, inspector, timeline), "compare" (the side-by-side table of all scenarios, over the mission page) or "evidence" (validation against JPL Horizons, NASA maps and LRO photos).',
    schema: schema({ tab: { type: 'string', enum: ['mission', 'compare', 'evidence'], description: 'Tab to show.' } }, ['tab']),
    run: async ({ tab }: { tab: 'mission' | 'compare' | 'evidence' }) => {
      const focus = byUser;
      if (tab === 'evidence') { if (view !== 'evidence') await setView('evidence'); } // compare stays as it was, for coming back
      else {
        if (view !== 'mission') await setView('mission');
        if (cmpOpen !== (tab === 'compare')) setCompare(tab === 'compare', focus);
      }
      return { tab: tabNow() };
    },
  });
  setSnapshot(appState);
  if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__actions = { run, actions, snapshot, tools }; // console hook, dev server only
}

/* ------------------------------------------------------------------ shell */

export async function start(root: HTMLElement) {
  root.innerHTML = `
  <div class="shell boot" data-view="mission">
    <header class="top">
      <a class="brand" href="./" aria-label="Shackleton Live, home">
        <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M10 1.5a8.5 8.5 0 0 0 0 17 6 8.5 0 0 1 0-17z" fill="currentColor"/></svg>
        <span>Shackleton Live</span>
      </a>
      <nav class="views" role="tablist" aria-label="Views">
        <button type="button" role="tab" data-view="mission" aria-selected="true">Mission</button>
        <button type="button" role="tab" data-view="evidence">Evidence</button>
      </nav>
      <p class="tagline">Compare landing sites and dates by sunlight and Earth contact</p>
      <div class="top-r">
        <span class="clock"><span class="lbl">Time shown</span><time id="clock"></time></span>
        <button type="button" id="cmp" aria-pressed="false" title="Compare all scenarios (c)">Compare</button>
        <button type="button" id="copy">Copy link</button>
      </div>
    </header>

    <aside class="rail" aria-label="Scenarios and assistant">
      <div id="chips" class="chips" role="group" aria-label="Scenarios">
        <button type="button" id="add" class="chip chip-add" aria-label="Add scenario" title="Add scenario">${ICON.plus}</button>
      </div>
      <div class="editor-anchor"><div id="editor" class="editor" role="dialog" aria-label="Edit scenario" hidden>
        <div class="editor-head"><span class="lbl">Edit scenario</span><button type="button" id="editor-close" class="icon" aria-label="Close editor" title="Close (Esc)">${ICON.close}</button></div>
        <div id="cards"></div>
      </div></div>
      <div id="agent" class="agent"></div>
    </aside>

    <main class="stage loading" data-mode="3d" aria-label="Terrain">
      <div id="s3d" class="pane"></div>
      <div id="smap" class="pane" hidden></div>
      <div class="seg stage-switch" role="group" aria-label="Stage view">
        <button type="button" data-mode="3d" aria-pressed="true">3D</button>
        <button type="button" data-mode="map" aria-pressed="false">Map</button>
      </div>
      <p id="stage-note" class="stage-note" role="status">Loading mission data</p>
      <i class="stage-load" aria-hidden="true"></i>
    </main>

    <aside class="insp" aria-label="Selected scenario">
      <div class="pane-head"><span id="i-badge" class="badge on"></span><h2 id="i-name"></h2><span id="i-coord" class="coord"></span></div>
      <div class="insp-body">
        <p id="i-status" class="i-status" role="status"></p>
        <section>
          <h3 class="lbl">Horizon seen from the site</h3>
          <canvas id="i-pano" class="pano" role="img" aria-label="Horizon panorama: terrain silhouette with the paths of the Sun and Earth"></canvas>
          <dl class="now">
            <div><dt>Sun angle</dt><dd id="n-el">–</dd></div>
            <div><dt>Disk visible</dt><dd id="n-disk">–</dd></div>
            <div title="Share of terrain-model draws in which some of the Sun is visible"><dt>Chance lit</dt><dd id="n-plit">–</dd></div>
            <div><dt>Earth</dt><dd id="n-earth">–</dd></div>
            <div class="wide" title="NASA ground stations at Goldstone, Madrid and Canberra. A station counts when the Moon is more than 10° above its horizon."><dt>Deep Space Network</dt><dd id="n-dsn">–</dd></div>
          </dl>
        </section>
        <p id="i-cap" class="cap"></p>
        <table id="i-table" class="m"></table>
        <section>
          <div class="sec-head"><h3 class="lbl" id="i-year">12 months</h3><span class="lbl quiet">Click to set the landing date</span></div>
          <canvas id="i-strip" class="strip" role="img" aria-label="Sunlight and Earth visibility over one year"></canvas>
          <p id="i-ysum" class="ysum"></p>
        </section>
        <p class="foot">Figures cover the 29.5 days (one lunar day) after landing. ± is terrain-model uncertainty near the site, a lower bound.
          Battery assumes a 200 W Sun-tracking panel, a constant 100 W load and 1.5 kWh of storage, starting full.
          Deep Space Network contact needs Earth in view from the site and the Moon above 10° at Goldstone, Madrid or Canberra.
          Dates from 2024 to 2040 are available, plus 1969 to 1972 for the Apollo landings.</p>
      </div>
    </aside>

    <section id="sheet" class="sheet" role="dialog" aria-label="Compare scenarios" inert>
      <div class="sheet-head">
        <div><h2>Compare scenarios</h2><p>Each column covers the 29.5 days after that landing.</p></div>
        <button type="button" id="cmp-close" class="icon" aria-label="Close comparison" title="Close (Esc)">${ICON.close}</button>
      </div>
      <div class="sheet-body"><table id="cmp-table" class="cmp"></table><p id="cmp-legend" class="cmp-legend"></p></div>
    </section>

    <footer class="dock" aria-label="Timeline">
      <div class="dock-l">
        <button type="button" id="play" class="icon play" aria-label="Play one lunar day" title="Play one lunar day (space)">${ICON.play}</button>
        <div class="offset"><span class="lbl">Time after landing</span><output id="off">landing + 0 h</output></div>
        <div class="legend"><span><i class="sw sun"></i>Sunlight</span><span><i class="sw earth"></i>Earth in view</span></div>
      </div>
      <div class="lanes">
        <div id="lane-badges" class="lane-badges"></div>
        <div id="scrub" class="plot" role="slider" tabindex="0" aria-label="Time after landing" aria-valuemin="0" aria-valuemax="${STEPS - 1}" aria-valuenow="0">
          <canvas id="lanes" style="height:114px"></canvas>
          <div class="playhead"></div>
        </div>
      </div>
      <div class="dock-r">
        <div class="slip-head"><label class="lbl" for="slip">Landing delayed by</label><output id="slipv">0 d</output></div>
        <input id="slip" type="range" min="0" max="60" value="0">
        <p class="hint">Each scenario is recomputed for the later date and shown as a thin lane under the planned one.</p>
      </div>
    </footer>

    <section class="evpage"><div id="evidence"></div></section>
    <p id="err" class="fatal" role="alert"></p>
  </div>`;

  try {
    const [list, r, dem] = await Promise.all([
      fetch(dataBase + 'sites.json').then((x) => { if (!x.ok) throw new Error(`sites.json: HTTP ${x.status}`); return x.json(); }),
      core.range(),
      fetch(dataBase + 'dem/manifest.json').then((x) => (x.ok ? x.json() : { tiles: [] })).catch(() => ({ tiles: [] })), // no manifest: no 3D regions
    ]);
    sites = list; ranges = r.ranges; demTiles = dem.tiles;
  } catch (e) {
    $('#err').textContent = `Could not load data: ${(e as Error).message}`;
    return;
  }
  $('.shell').classList.remove('boot');
  $('.stage').classList.remove('loading');
  registerActions();

  const specs = loadHash();
  (specs.length ? specs : defaults()).forEach((s) => add(s, true));
  sel = Math.min(sel, scs.length - 1);
  afterCount();
  for (const s of scs) syncCard(s);
  paintInspector();
  if (mode === 'map') setMode('map', false);
  stagePolicy();

  // slip
  const slipIn = $<HTMLInputElement>('#slip');
  paintSlip();
  slipIn.oninput = () => ui('slip.set', { days: +slipIn.value });

  // timeline
  const plot = $('#scrub');
  let drag = false;
  const at = (e: PointerEvent) => { const r = plot.getBoundingClientRect(); ui('time.set', { hoursAfterLanding: hourAt(e.clientX - r.left, r.width) }); };
  plot.addEventListener('pointerdown', (e) => {
    if (e.button) return;
    drag = true; plot.setPointerCapture(e.pointerId);
    at(e);
  });
  plot.addEventListener('pointermove', (e) => { if (drag) at(e); });
  const end = () => { drag = false; };
  plot.addEventListener('pointerup', end); plot.addEventListener('pointercancel', end);
  plot.addEventListener('keydown', (e) => {
    const k = e.shiftKey ? 24 : 1;
    const to: Record<string, number> = { ArrowLeft: hours - k, ArrowDown: hours - k, ArrowRight: hours + k, ArrowUp: hours + k, Home: 0, End: STEPS - 1 };
    if (e.key === ' ') { e.preventDefault(); return ui(playing ? 'time.pause' : 'time.play'); }
    if (!(e.key in to)) return;
    e.preventDefault();
    ui('time.set', { hoursAfterLanding: to[e.key] });
  });
  $('#play').onclick = () => ui(playing ? 'time.pause' : 'time.play');
  $('#lane-badges').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-lane]');
    if (b) ui('scenario.select', { id: LETTERS[+b.dataset.lane!] });
  });

  // inspector
  const strip = $<HTMLCanvasElement>('#i-strip');
  strip.onclick = (e) => {
    const sc = cur();
    if (!sc.strip) return;
    ui('scenario.update', { id: LETTERS[sel], t: iso(Math.round(stripTimeAt(strip, sc.strip, e.clientX) / 3600e3) * 3600e3) });
  };

  // chrome
  const toggleCompare = () => ui('tab.set', { tab: cmpOpen ? 'mission' : 'compare' });
  $('#add').onclick = () => ui('scenario.add');
  $('#editor-close').onclick = () => ui('scenario.select', { id: LETTERS[sel], editor: false });
  document.addEventListener('pointerdown', (e) => { // a click elsewhere in the rail closes the pop-over (the stage stays usable with it open)
    const t = e.target as HTMLElement;
    if (editorOpen && t.closest?.('.rail') && !t.closest('#editor, #chips')) ui('scenario.select', { id: LETTERS[sel], editor: false });
  });
  for (const b of document.querySelectorAll<HTMLElement>('.views [data-view]')) b.onclick = () => ui('tab.set', { tab: b.dataset.view === 'mission' && cmpOpen ? 'compare' : b.dataset.view }); // Mission keeps compare open
  for (const b of document.querySelectorAll<HTMLElement>('.stage-switch [data-mode]')) b.onclick = () => ui('view.set', { mode: b.dataset.mode });
  $('#cmp').onclick = toggleCompare;
  $('#cmp-close').onclick = toggleCompare;
  mountAgent($('#agent'), { sites });
  const copy = $('#copy');
  let copyTimer = 0;
  copy.onclick = async () => {
    writeHash(); // not an action: copies the link, changes nothing
    let ok = true;
    try { await navigator.clipboard.writeText(location.href); } catch { ok = false; }
    copy.textContent = ok ? 'Link copied' : 'Copy from the address bar';
    clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => { copy.textContent = 'Copy link'; }, 1800);
  };
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape' && editorOpen) return ui('scenario.select', { id: LETTERS[sel], editor: false });
    if (e.key === 'Escape' && cmpOpen && view === 'mission') return toggleCompare();
    if ((e.target as HTMLElement).closest?.('input, select, textarea')) return;
    if (e.key === 'c' && view === 'mission') toggleCompare();
  });

  setHours(hours); scrubAria();
  if (cmpOpen) setCompare(true);
  void setView(view);

  const ro = new ResizeObserver(() => { queueLanes(); lastPano = -1; paintNow(); paintStrip(); });
  ro.observe(plot); ro.observe($('#i-pano'));
  addEventListener('hashchange', () => location.reload()); // pasted share link; replaceState doesn't fire this
}
