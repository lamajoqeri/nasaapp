// Compare sheet: one table, rows = metrics, columns = scenarios. Pure (string in, string out) so it is unit-tested.
import { delta, type Row, type RowKey } from './format';

/**
 * Indices of the best cells in one metric row; empty when nothing should be marked.
 * A cell in the good state (lit, Earth in view, battery survives) beats one that is not; within a state the
 * row's `good` direction decides. Neutral rows, a lone value, and rows where everything ties are unmarked.
 */
export function bestOf(cells: (Row | undefined)[]): Set<number> {
  const c = cells
    .map((r, i) => ({ r, i }))
    .filter((x): x is { r: Row; i: number } => !!x.r && x.r.num !== null && x.r.good !== 0)
    .map(({ r, i }) => ({ i, eps: r.eps, rank: r.ok === undefined ? 0 : r.ok ? 1 : 0, score: r.num! * r.good }));
  if (c.length < 2) return new Set();
  const top = c.reduce((a, b) => (b.rank > a.rank || (b.rank === a.rank && b.score > a.score) ? b : a));
  const win = c.filter((x) => x.rank === top.rank && top.score - x.score < top.eps);
  return win.length === c.length ? new Set() : new Set(win.map((x) => x.i));
}

export interface CompareCol {
  letter: string; name: string; when: string; selected: boolean;
  rows?: Row[];   // shown values (Monte Carlo mean where available)
  cmp?: Row[];    // deterministic base rows, for the slip delta
  srows?: Row[];  // deterministic rows at the delayed date
  error?: string;
}

const LABELS: Record<RowKey, [string, string]> = {
  sunEl: ['Sun elevation', 'at landing'],
  sunDisk: ['Sun disk visible', 'at landing'],
  sunEvent: ['Next sunset or sunrise', ''],
  earthEvent: ['Next Earthset or Earthrise', ''],
  lit: ['Sunlit', 'share of the 29.5 days'],
  dark: ['Longest dark', 'unbroken stretch'],
  earth: ['Earth in view', 'direct link possible'],
  dsn: ['Deep Space Network', 'a ground station can hear the site'],
  battery: ['Battery', '200 W panel, 100 W load, 1.5 kWh'],
};
const ORDER: RowKey[] = ['lit', 'dark', 'earth', 'dsn', 'battery', 'sunEvent', 'earthEvent', 'sunEl', 'sunDisk'];
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`);
const find = (rs: Row[] | undefined, k: RowKey) => rs?.find((r) => r.key === k);

/** "sunset in 8 d 12 h", "Earthrise in 2 d 7 h", or "no sunset in 29.5 d" when the event is not in the window. */
function eventCell(r: Row): string {
  const noun = r.label.replace(/ in$/, '').replace(/^Sun/, 'sun'); // Earth keeps its capital
  return /^(<|\d)/.test(r.text) ? `<small>${noun} in</small> ${esc(r.text)}` : `no ${noun} in 29.5 d`;
}

export function compareTable(cols: CompareCol[], slip: number): string {
  const head = cols.map((c) => `<th scope="col"${c.selected ? ' class="sel"' : ''}><span class="badge">${c.letter}</span><span class="cn">${esc(c.name)}</span><span class="cw">${esc(c.when)}</span></th>`).join('');
  const body = ORDER.map((k) => {
    const cells = cols.map((c) => find(c.rows, k));
    const best = bestOf(cells);
    const event = k === 'sunEvent' || k === 'earthEvent';
    const tds = cols.map((c, i) => {
      const r = cells[i];
      if (!r) return `<td class="na">${c.error ? 'no result' : '…'}</td>`;
      const b = find(c.cmp, k), s = find(c.srows, k);
      const d = slip ? (b && s ? delta(b, s) : { text: '…', cls: 'pending' }) : null;
      return `<td${best.has(i) ? ' class="best"' : ''}><span class="v">${best.has(i) ? '<i class="dot" title="Best in this row"></i>' : ''}${event ? eventCell(r) : esc(r.text)}${r.sd ? `<small>${esc(r.sd)}</small>` : ''}</span>${d ? `<span class="d ${d.cls}">${esc(d.text) || '&nbsp;'}</span>` : ''}</td>`;
    }).join('');
    const [label, sub] = LABELS[k];
    return `<tr><th scope="row">${label}${sub ? `<small>${sub}</small>` : ''}</th>${tds}</tr>`;
  }).join('');
  return `<thead><tr><td></td>${head}</tr></thead><tbody>${body}</tbody>`;
}
