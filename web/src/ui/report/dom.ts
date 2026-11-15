// Small HTML builders shared by every section, so the paper looks the same throughout. All take and return HTML
// strings except section(); escape your own text with esc(). Sections, figures and tables are numbered by CSS
// counters in report.css, so never write "Figure 3" by hand.
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** <section class="r-sec" id="r-<id>"><h2>title</h2>html</section>. Use <h3> inside for subsections. */
export function section(id: string, title: string, html: string): HTMLElement {
  const el = document.createElement('section');
  el.className = 'r-sec';
  el.id = 'r-' + id;
  el.innerHTML = `<h2>${esc(title)}</h2>${html}`;
  return el;
}

/** A numbered figure. `src` is a canvas (frozen to a PNG so it prints and survives resizes) or an image URL.
 *  `caption` is HTML. */
export function figure(src: HTMLCanvasElement | string, caption: string, alt: string, cls = ''): string {
  const url = typeof src === 'string' ? src : src.toDataURL('image/png');
  return `<figure class="r-fig ${cls}"><img src="${esc(url)}" alt="${esc(alt)}"><figcaption>${caption}</figcaption></figure>`;
}

/** A numbered table. `caption`, `head` and cells are HTML. A row whose first cell starts with '<th' is used as is. */
export function table(caption: string, head: string[], rows: string[][], cls = ''): string {
  const tr = (r: string[]) => `<tr>${r.map((c, i) => (i === 0 ? `<th scope="row">${c}</th>` : `<td>${c}</td>`)).join('')}</tr>`;
  return `<div class="r-tabwrap"><table class="r-tab ${cls}"><caption>${caption}</caption>`
    + `<thead><tr>${head.map((h) => `<th scope="col">${h}</th>`).join('')}</tr></thead>`
    + `<tbody>${rows.map(tr).join('')}</tbody></table></div>`;
}

/** Scenario letter as a coloured chip (dark background, so A's near-white shows on white paper). */
export const chip = (letter: string, color: string) => `<span class="r-chip" style="--c:${esc(color)}">${esc(letter)}</span>`;

/** An off-screen canvas of CSS size w x h at 2x, for drawing figures before they are frozen with figure(). */
export function canvas(w: number, h: number, scale = 2): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale); c.height = Math.round(h * scale);
  c.style.width = `${w}px`; c.style.height = `${h}px`;
  return c;
}
