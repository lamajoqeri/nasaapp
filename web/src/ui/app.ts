// Shell: top bar, scenario rail, stage (3D / map), inspector, timeline dock, compare sheet, evidence page.
import { core, type Range } from '../core/api';
import { DSN_NAMES } from '../core/extra';
import { DEG, enu, R, spFwd } from '../core/geom';
import { drawPanorama } from './panorama';
import { drawStrip, stripSummary, stripTimeAt } from './strips';
import { caption, coord, DAY, delta, dur, isoMin, pctDelta, pick, shortCaption, utc, type Row } from './format';
import { mountMap, type MapHandle } from './map';
import { Scenario, type Spec } from './scenario';
import { drawLanes, hourAt, lanesHeight, PITCH, STEPS, TOP, xAt } from './timeline';
import { compareTable } from './compare';
import type { View3DHandle } from '../view3d';

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
const TILE = [-29000, -29000, 9000, 9000]; // 3D view covers the Shackleton tile (1 km inside its edge), spstere metres
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
let sel = 0, slip = 0, hours = 0, playing = false, step = 100;
let view: View = 'mission', mode: Mode = '3d', autoMap = false, forced3d = false, cmpOpen = false;
let map: MapHandle | undefined, view3d: View3DHandle | undefined, loading3d = false, err3d = '', evidenceMounted = false;
let plotW = 0, lastPano = -1, lanesQueued = false;

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
const inTile = (lat: number, lon: number) => {
  if (lat > -85) return false;
  const [x, y] = spFwd(lat, lon);
  return x > TILE[0] && x < TILE[2] && y > TILE[1] && y < TILE[3];
};
const recOf = (s: Scenario) => sites.find((x) => x.id === s.spec.site);
const nameOf = (s: Scenario) => recOf(s)?.name ?? coord(s.spec.lat, s.spec.lon);
const whenOf = (s: Scenario) => isoMin(s.spec.t).replace('T', ' ');

const env = { slip: () => slip, rangeOf, onUpdate };

/* ------------------------------------------------------------------ scenario cards */

function makeCard(sc: Scenario): HTMLElement {
  const el = document.createElement('article');
  el.className = 'card';
  const kpi = (k: string, label: string) => `<div data-k="${k}"><dt>${label}</dt><dd><span class="v">–</span><small class="sd"></small></dd><dd class="d"></dd></div>`;
  el.innerHTML = `
    <div class="card-top">
      <button class="card-head" type="button">
        <span class="badge" aria-hidden="true"></span>
        <span class="card-title"><span class="name"></span><span class="when"></span></span>
      </button>
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

  site.onchange = () => {
    const s = sites.find((x) => x.id === site.value);
    sc.spec.site = site.value;
    if (s) { sc.spec.lat = s.lat; sc.spec.lon = s.lon; }
    changed(sc);
    map?.focus(sc.spec.lat, sc.spec.lon);
  };
  const lat = $<HTMLInputElement>('.lat', el), lon = $<HTMLInputElement>('.lon', el);
  lat.onchange = lon.onchange = () => {
    const a = lat.valueAsNumber, o = lon.valueAsNumber;
    if (!(Math.abs(a) <= 90) || !(o >= -180 && o <= 360)) {
      sc.error = 'Latitude must be -90 to 90 and longitude -180 to 360.';
      return paintCard(sc);
    }
    sc.spec.lat = a; sc.spec.lon = o; changed(sc);
  };
  const date = $<HTMLInputElement>('.date', el);
  date.onchange = () => {
    const t = Date.parse(date.value + 'Z');
    if (Number.isNaN(t)) return;
    sc.spec.t = clampT(t); changed(sc);
  };
  const mast = $<HTMLSelectElement>('.mast', el);
  mast.onchange = () => { sc.spec.mast = +mast.value; changed(sc); };
  $('.rm', el).onclick = (e) => { e.stopPropagation(); remove(sc); };
  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const b = t.closest<HTMLElement>('[data-t]');
    if (b) { sc.spec.t = clampT(+b.dataset.t!); changed(sc); }
    const n = t.closest<HTMLElement>('[data-nudge]');
    if (n) nudge(sc, n.dataset.nudge!, step);
    const st = t.closest<HTMLElement>('[data-step]');
    if (st) { step = +st.dataset.step!; for (const s of scs) syncCard(s); }
    if (!t.closest('.rm')) select(scs.indexOf(sc));
  });
  return el;
}

/** Move the site `m` metres along local north/east/south/west (great circle, so it is exact near the pole). */
function nudge(sc: Scenario, dir: string, m: number) {
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
  head.setAttribute('aria-expanded', String(on));
  head.setAttribute('aria-label', `Scenario ${L}: ${nameOf(sc)}, landing ${whenOf(sc)} UTC${on ? ', selected' : ''}`);
  $('.card-more', el).toggleAttribute('inert', !on);
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
  void sc.compute();
  saveHash();
  if (sc === cur()) { paintHead(); stagePolicy(); }
  syncStage();
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
  if (matchMedia('(min-width: 1100px)').matches) setTimeout(() => cards.get(cur())?.scrollIntoView({ block: 'nearest' }), 160); // after the expand transition
  if (mode === 'map') map?.focus(cur().spec.lat, cur().spec.lon);
  if (cmpOpen) paintCompare();
}

function add(spec: Spec, quiet = false) {
  const sc = new Scenario(spec, env), el = makeCard(sc);
  scs.push(sc); cards.set(sc, el);
  $('#cards').append(el);
  void sc.compute();
  if (!quiet) { select(scs.length - 1); afterCount(); }
}
function remove(sc: Scenario) {
  if (scs.length <= 1) return;
  const i = scs.indexOf(sc);
  scs.splice(i, 1);
  cards.get(sc)?.remove(); cards.delete(sc);
  sel = Math.min(sel > i ? sel - 1 : sel, scs.length - 1);
  cards.get(cur())?.classList.remove('sel'); // force select() to repaint
  select(sel); afterCount();
}
/** Scenario count changed: letters, lane badges, dock height. */
function afterCount() {
  for (const s of scs) { syncCard(s); paintCard(s); }
  $<HTMLButtonElement>('#add').disabled = scs.length >= MAX;
  $('#count').textContent = `${scs.length} of ${MAX}`;
  $<HTMLCanvasElement>('#lanes').style.height = `${lanesHeight(scs.length)}px`;
  $('.playhead').style.height = `${TOP + scs.length * PITCH - 2}px`;
  $('#lane-badges').innerHTML = scs.map((_, i) => `<button type="button" class="badge" data-lane="${i}" aria-label="Select scenario ${LETTERS[i]}">${LETTERS[i]}</button>`).join('');
  queueLanes(); syncStage(); saveHash();
  if (cmpOpen) paintCompare();
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
  $('#i-cap').textContent = caption(b.metrics);
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

/** The 3D view only covers the Shackleton tile: fall back to the map for sites outside it, and come back. */
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
    ? '3D terrain covers the Shackleton and Connecting Ridge region. Showing the map for this site.'
    : `Click the map to place scenario ${LETTERS[sel]}.`;
  else if (err3d) text = err3d;
  else if (!inside) text = `Scenario ${LETTERS[sel]} is outside the 3D region, so it has no pin here. The lighting is for its date.`;
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
        onPick: (lat, lon, id) => {
          const c = cur();
          if (!c) return;
          c.spec.site = id ?? 'custom';
          c.spec.lat = +lat.toFixed(5); c.spec.lon = +lon.toFixed(5);
          changed(c);
        },
      });
      map.focus(cur().spec.lat, cur().spec.lon);
    }
  } else if (!view3d && !loading3d) {
    loading3d = true;
    const stage = $('.stage');
    stage.classList.add('loading');
    import('../view3d').then(({ mount3D }) => {
      view3d = mount3D($('#s3d'), {
        dataBase, startZoom: 0.62,
        onReady: () => { stage.classList.remove('loading'); syncStage(); },
        onError: () => stage.classList.remove('loading'), // the module shows its own message
      });
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
  view3d.setSites(scs.map((c, i) => ({ c, i })).filter(({ c }) => inTile(c.spec.lat, c.spec.lon))
    .map(({ c, i }) => ({ lat: c.spec.lat, lon: c.spec.lon, mast: c.spec.mast, label: LETTERS[i] })));
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
function setCompare(open: boolean) {
  cmpOpen = open;
  const sheet = $('#sheet'), btn = $('#cmp');
  sheet.classList.toggle('open', open);
  sheet.toggleAttribute('inert', !open);
  btn.setAttribute('aria-pressed', String(open));
  if (open) { paintCompare(); $('#cmp-close').focus({ preventScroll: true }); }
  else if (sheet.contains(document.activeElement)) btn.focus();
  saveHash();
}

/* ------------------------------------------------------------------ URL hash
   #c=<siteId|lat,lon>~<YYYY-MM-DDTHH:MM>~<mast>&c=...&slip=N&s=<selected>&h=<hours>&m=<3d|map>&cmp=1&v=evidence */

function saveHash() {
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

    <aside class="rail" aria-label="Scenarios">
      <div class="pane-head"><h2>Scenarios</h2><span id="count" class="lbl"></span></div>
      <div id="cards"></div>
      <button type="button" id="add" class="add">${ICON.plus}<span>Add scenario</span></button>
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
    const [list, r] = await Promise.all([
      fetch(dataBase + 'sites.json').then((x) => { if (!x.ok) throw new Error(`sites.json: HTTP ${x.status}`); return x.json(); }),
      core.range(),
    ]);
    sites = list; ranges = r.ranges;
  } catch (e) {
    $('#err').textContent = `Could not load data: ${(e as Error).message}`;
    return;
  }
  $('.shell').classList.remove('boot');
  $('.stage').classList.remove('loading');

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
  const slipLabel = () => { $('#slipv').textContent = `${slip} d`; $('.shell').classList.toggle('has-slip', slip > 0); };
  slipIn.value = String(slip); slipLabel();
  let deb = 0;
  slipIn.oninput = () => {
    slip = +slipIn.value;
    slipLabel();
    paintStrip(); queueLanes(); // marker and lane layout move now, numbers after the debounce
    clearTimeout(deb);
    deb = window.setTimeout(() => {
      for (const c of scs) void c.computeSlip();
      paintInspector(); saveHash();
    }, 120);
  };

  // timeline
  const plot = $('#scrub');
  let drag = false;
  const at = (e: PointerEvent) => { const r = plot.getBoundingClientRect(); setHours(hourAt(e.clientX - r.left, r.width)); };
  plot.addEventListener('pointerdown', (e) => {
    if (e.button) return;
    drag = true; plot.setPointerCapture(e.pointerId);
    setPlaying(false); at(e);
  });
  plot.addEventListener('pointermove', (e) => { if (drag) at(e); });
  const end = () => { if (drag) { drag = false; scrubAria(); saveHash(); } };
  plot.addEventListener('pointerup', end); plot.addEventListener('pointercancel', end);
  plot.addEventListener('keydown', (e) => {
    const k = e.shiftKey ? 24 : 1;
    const to: Record<string, number> = { ArrowLeft: hours - k, ArrowDown: hours - k, ArrowRight: hours + k, ArrowUp: hours + k, Home: 0, End: STEPS - 1 };
    if (e.key === ' ') { e.preventDefault(); return setPlaying(!playing); }
    if (!(e.key in to)) return;
    e.preventDefault();
    setPlaying(false); setHours(Math.round(to[e.key])); scrubAria(); saveHash();
  });
  $('#play').onclick = () => setPlaying(!playing);
  $('#lane-badges').addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-lane]');
    if (b) select(+b.dataset.lane!);
  });

  // inspector
  const strip = $<HTMLCanvasElement>('#i-strip');
  strip.onclick = (e) => {
    const sc = cur();
    if (!sc.strip) return;
    sc.spec.t = clampT(Math.round(stripTimeAt(strip, sc.strip, e.clientX) / 3600e3) * 3600e3);
    changed(sc);
  };

  // chrome
  $('#add').onclick = () => add({ ...cur().spec });
  for (const b of document.querySelectorAll<HTMLElement>('.views [data-view]')) b.onclick = () => setView(b.dataset.view as View);
  for (const b of document.querySelectorAll<HTMLElement>('.stage-switch [data-mode]')) b.onclick = () => setMode(b.dataset.mode as Mode);
  $('#cmp').onclick = () => setCompare(!cmpOpen);
  $('#cmp-close').onclick = () => setCompare(false);
  const copy = $('#copy');
  let copyTimer = 0;
  copy.onclick = async () => {
    saveHash();
    let ok = true;
    try { await navigator.clipboard.writeText(location.href); } catch { ok = false; }
    copy.textContent = ok ? 'Link copied' : 'Copy from the address bar';
    clearTimeout(copyTimer);
    copyTimer = window.setTimeout(() => { copy.textContent = 'Copy link'; }, 1800);
  };
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape' && cmpOpen) return setCompare(false);
    if ((e.target as HTMLElement).closest?.('input, select, textarea')) return;
    if (e.key === 'c' && view === 'mission') setCompare(!cmpOpen);
  });

  setHours(hours); scrubAria();
  if (sel) cards.get(cur())?.scrollIntoView({ block: 'nearest' });
  if (cmpOpen) setCompare(true);
  void setView(view);

  const ro = new ResizeObserver(() => { queueLanes(); lastPano = -1; paintNow(); paintStrip(); });
  ro.observe(plot); ro.observe($('#i-pano'));
  addEventListener('hashchange', () => location.reload()); // pasted share link; replaceState doesn't fire this
}
