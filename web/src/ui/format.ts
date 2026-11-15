import type { Metrics, Mission, Uncertainty } from '../core/api';

export const DAY = 86400e3;
const WIN_H = 29.5 * 24;

/** Hours -> "<1 h", "17 h", "3 d 4 h". */
export function dur(h: number): string {
  const r = Math.round(h);
  if (r < 1) return '<1 h';
  if (r < 48) return `${r} h`;
  const d = Math.floor(r / 24), hh = r % 24;
  return hh ? `${d} d ${hh} h` : `${d} d`;
}

/** ms -> "YYYY-MM-DDTHH:MM" (UTC), the datetime-local value format. */
export const isoMin = (t: number) => new Date(t).toISOString().slice(0, 16);
export const utc = (t: number) => isoMin(t).replace('T', ' ') + ' UTC';

const pct = (x: number) => `${Math.round(x)}%`;
const deg = (x: number) => `${x.toFixed(1)}°`;

export type RowKey = 'sunEl' | 'sunDisk' | 'sunEvent' | 'earthEvent' | 'lit' | 'dark' | 'earth' | 'dsn' | 'battery' | 'psr';

export interface Row {
  key: RowKey;             // stable id: the event rows change label with the state
  label: string; text: string; sd: string;
  short?: string;          // headline form for scenario cards
  num: number | null;      // compared for deltas (null = beyond the 29.5 d window)
  f: (x: number) => string; eps: number;
  good: 1 | -1 | 0;        // sign of a "good" change; 0 = neutral
  ok?: boolean;            // state rows: lit / Earth in view
}

/** Metric rows for one scenario. Window metrics use the Monte Carlo mean when available. */
export function rows(m: Metrics, u: Uncertainty | null, mission?: Mission): Row[] {
  const sd = (k: keyof Metrics, f: (x: number) => string) => {
    const s = u?.std[k];
    return s !== undefined && Number.isFinite(s) && f(s) !== f(0) ? ` ± ${f(s)}` : '';
  };
  const mean = (k: keyof Metrics) => (u && Number.isFinite(u.mean[k]) ? u.mean[k] : (m[k] as number));
  const dark = m.sunFrac === 0, hidden = !m.earthVisible;
  const sunH = dark ? m.hoursToSunrise : m.hoursToSunset;
  const earthH = hidden ? m.hoursToEarthrise : m.hoursToEarthset;
  const lit = mean('pctLit'), longest = mean('longestDarkHours'), dte = mean('dteHours');
  return [
    { key: 'sunEl', label: 'Sun elevation', text: deg(m.sunEl), sd: '', num: m.sunEl, f: deg, eps: 0.05, good: 0 },
    { key: 'sunDisk', label: 'Sun disk visible', text: pct(m.sunFrac * 100), sd: sd('sunFrac', (x) => pct(x * 100)), num: m.sunFrac * 100, f: pct, eps: 0.5, good: 1 },
    {
      key: 'sunEvent', label: dark ? 'Sunrise in' : 'Sunset in', ok: !dark,
      text: sunH === null ? (dark ? 'not within 29.5 d' : 'none in 29.5 d') : dur(sunH),
      sd: sd(dark ? 'hoursToSunrise' : 'hoursToSunset', dur), num: sunH ?? WIN_H, f: dur, eps: 0.5, good: dark ? -1 : 1,
    },
    {
      key: 'earthEvent', label: hidden ? 'Earthrise in' : 'Earthset in', ok: !hidden,
      text: earthH === null ? (hidden ? 'not within 29.5 d' : 'none in 29.5 d') : dur(earthH),
      sd: sd(hidden ? 'hoursToEarthrise' : 'hoursToEarthset', dur), num: earthH ?? WIN_H, f: dur, eps: 0.5, good: hidden ? -1 : 1,
    },
    { key: 'lit', label: 'Sunlit, 29.5 d', text: pct(lit), sd: sd('pctLit', pct), num: lit, f: pct, eps: 0.5, good: 1 },
    { key: 'dark', label: 'Longest dark', text: longest ? dur(longest) : 'none', sd: sd('longestDarkHours', dur), num: longest, f: dur, eps: 0.5, good: -1 },
    { key: 'earth', label: 'Earth in view', short: pct((100 * dte) / WIN_H), text: `${dur(dte)} (${pct((100 * dte) / WIN_H)})`, sd: sd('dteHours', dur), num: dte, f: dur, eps: 0.5, good: 1 },
    ...(mission ? missionRows(mission) : []),
  ];
}

/** Metres -> "640 m" or "3.2 km". */
export const dist = (m: number) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`);

function missionRows(x: Mission): Row[] {
  const c = x.commsHours, b = x.battery;
  return [
    {
      key: 'dsn', label: 'Deep Space Network', sd: '', num: c, f: dur, eps: 0.5, good: 1,
      text: c === null ? 'no data for this era' : `${dur(c)} (${pct((100 * c) / WIN_H)})`,
    },
    {
      key: 'battery', label: 'Battery', sd: '', num: b.survivalH ?? WIN_H, f: dur, eps: 0.5, good: 1, ok: b.survivalH === null,
      text: b.survivalH === null ? `survives, lowest ${pct(b.minSoc * 100)}` : `empty after ${dur(b.survivalH)}`,
    },
    { key: 'psr', label: 'Permanent shadow', sd: '', num: x.psrM, f: dist, eps: 1, good: 0, text: x.psrM === null ? 'no data north of 85°S' : x.psrM < 1 ? 'site is inside one' : `${dist(x.psrM)} away` },
  ];
}

/** "89.474°S 137.414°W" */
export function coord(lat: number, lon: number, digits = 3): string {
  const l = ((lon + 540) % 360) - 180;
  return `${Math.abs(lat).toFixed(digits)}°${lat < 0 ? 'S' : 'N'} ${Math.abs(l).toFixed(digits)}°${l < 0 ? 'W' : 'E'}`;
}

/** Delta of a slipped row vs the base row: text + css class (good / bad / ''). */
export function delta(base: Row, slip: Row): { text: string; cls: string } {
  if (base.num === null || slip.num === null) return { text: '', cls: 'same' };
  if (base.label !== slip.label) {
    return { text: `→ ${slip.label.toLowerCase()} ${slip.text}`, cls: slip.ok ? 'good' : 'bad' };
  }
  const d = (slip.num ?? 0) - (base.num ?? 0);
  if (Math.abs(d) < base.eps) return { text: '=', cls: 'same' };
  return { text: (d > 0 ? '+' : '−') + base.f(Math.abs(d)), cls: base.good === 0 ? '' : d * base.good > 0 ? 'good' : 'bad' };
}

/** Plain-language one-liner for a scenario at landing. */
export function caption(m: Metrics): string {
  const sun = m.sunFrac > 0
    ? (m.hoursToSunset === null ? 'Sun stays up for the whole lunar day' : `Sun sets in ${dur(m.hoursToSunset)}`)
    : `${m.sunEl > 0 ? 'Sun is blocked by terrain' : 'Sun is below the horizon'} — ${m.hoursToSunrise === null ? 'no sunrise within 29.5 d' : `sunrise in ${dur(m.hoursToSunrise)}`}`;
  const earth = m.earthVisible
    ? (m.hoursToEarthset === null ? 'Earth stays in view (direct comms all window)' : `Earth sets in ${dur(m.hoursToEarthset)}`)
    : `${m.earthEl > 0 ? 'Earth is hidden behind terrain' : 'Earth is below the horizon'} — ${m.hoursToEarthrise === null ? 'no direct comms within 29.5 d' : `no direct comms for ${dur(m.hoursToEarthrise)}`}`;
  return `${sun}. ${earth}.`;
}

export const pick = (rs: Row[], k: RowKey) => rs.find((r) => r.key === k)!;

/** Delta of an hours-in-window row as a share of the 29.5 d window ("+4%"), for the scenario cards. */
export function pctDelta(base: Row, slip: Row): { text: string; cls: string } {
  if (base.num === null || slip.num === null) return { text: '', cls: 'same' };
  const d = Math.round(((slip.num - base.num) / WIN_H) * 100);
  if (!d) return { text: '=', cls: 'same' };
  return { text: `${d > 0 ? '+' : '−'}${Math.abs(d)}%`, cls: d * base.good > 0 ? 'good' : 'bad' };
}

/** One short line for a scenario card. */
export function shortCaption(m: Metrics): string {
  const sun = m.sunFrac > 0
    ? (m.hoursToSunset === null ? 'Sun up all lunar day' : `Sun sets in ${dur(m.hoursToSunset)}`)
    : (m.hoursToSunrise === null ? 'No sunrise in 29.5 d' : `Sunrise in ${dur(m.hoursToSunrise)}`);
  const earth = m.earthVisible
    ? (m.hoursToEarthset === null ? 'Earth always in view' : `Earth sets in ${dur(m.hoursToEarthset)}`)
    : (m.hoursToEarthrise === null ? 'no Earth contact' : `Earth rises in ${dur(m.hoursToEarthrise)}`);
  return `${sun} · ${earth}`;
}
