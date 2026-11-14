import type { Metrics, Uncertainty } from '../core/api';

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

export interface Row {
  label: string; text: string; sd: string;
  num: number | null;      // compared for deltas (null = beyond the 29.5 d window)
  f: (x: number) => string; eps: number;
  good: 1 | -1 | 0;        // sign of a "good" change; 0 = neutral
  ok?: boolean;            // state rows: lit / Earth in view
}

/** Metric rows for one scenario. Window metrics use the Monte Carlo mean when available. */
export function rows(m: Metrics, u: Uncertainty | null): Row[] {
  const sd = (k: keyof Metrics, f: (x: number) => string) => {
    const s = u?.std[k];
    return s !== undefined && Number.isFinite(s) && f(s) !== f(0) ? ` ± ${f(s)}` : '';
  };
  const mean = (k: keyof Metrics) => (u && Number.isFinite(u.mean[k]) ? u.mean[k] : (m[k] as number));
  const dark = m.sunFrac === 0, hidden = !m.earthVisible;
  const sunH = dark ? m.hoursToSunrise : m.hoursToSunset;
  const earthH = hidden ? m.hoursToEarthrise : m.hoursToEarthset;
  const lit = mean('pctLit'), longest = mean('longestDarkHours'), dte = mean('dteHours'), comms = mean('commsHours');
  return [
    { label: 'Sun elevation', text: deg(m.sunEl), sd: '', num: m.sunEl, f: deg, eps: 0.05, good: 0 },
    { label: 'Sun disk visible', text: pct(m.sunFrac * 100), sd: sd('sunFrac', (x) => pct(x * 100)), num: m.sunFrac * 100, f: pct, eps: 0.5, good: 1 },
    {
      label: dark ? 'Sunrise in' : 'Sunset in', ok: !dark,
      text: sunH === null ? (dark ? 'not within 29.5 d' : 'none in 29.5 d') : dur(sunH),
      sd: sd(dark ? 'hoursToSunrise' : 'hoursToSunset', dur), num: sunH ?? WIN_H, f: dur, eps: 0.5, good: dark ? -1 : 1,
    },
    {
      label: hidden ? 'Earthrise in' : 'Earthset in', ok: !hidden,
      text: earthH === null ? (hidden ? 'not within 29.5 d' : 'none in 29.5 d') : dur(earthH),
      sd: sd(hidden ? 'hoursToEarthrise' : 'hoursToEarthset', dur), num: earthH ?? WIN_H, f: dur, eps: 0.5, good: hidden ? -1 : 1,
    },
    { label: 'Sunlit, 29.5 d', text: pct(lit), sd: sd('pctLit', pct), num: lit, f: pct, eps: 0.5, good: 1 },
    { label: 'Longest dark', text: longest ? dur(longest) : 'none', sd: sd('longestDarkHours', dur), num: longest, f: dur, eps: 0.5, good: -1 },
    { label: 'Direct-to-Earth', text: `${dur(dte)} (${pct((100 * dte) / WIN_H)})`, sd: sd('dteHours', dur), num: dte, f: dur, eps: 0.5, good: 1 },
    { label: 'Comms (DSN)', text: Number.isFinite(comms) ? `${dur(comms)} (${pct((100 * comms) / WIN_H)})` : 'n/a before 2024', sd: sd('commsHours', dur), num: comms, f: dur, eps: 0.5, good: 1 },
  ];
}

/** Delta of a slipped row vs the base row: text + css class (good / bad / ''). */
export function delta(base: Row, slip: Row): { text: string; cls: string } {
  if (base.label !== slip.label) {
    return { text: `→ ${slip.label.toLowerCase()} ${slip.text}`, cls: slip.ok ? 'good' : 'bad' };
  }
  const d = (slip.num ?? 0) - (base.num ?? 0);
  if (Number.isNaN(d)) return { text: '–', cls: 'same' };
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

const STATIONS = ['Goldstone', 'Madrid', 'Canberra'];
/** DSN bits -> "Madrid, Canberra". */
export const stations = (bits: number) => STATIONS.filter((_, i) => bits & (1 << i)).join(', ');

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export const compass = (bearingDeg: number) => COMPASS[Math.round((((bearingDeg % 360) + 360) % 360) / 45) % 8];
