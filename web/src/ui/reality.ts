// Reality check: drag a split between a real LRO NAC photo and our predicted shadow render (data/bench/index.json).

type Model = 'flat' | 'dem240' | 'slope_only' | 'ours';
interface Score { iou: number; f1: number; accuracy: number }
interface BenchImage {
  id: string; group: string; source_image: string; utc: string; sun_az: number; sun_el: number;
  photo: string; model: string; scores: Record<Model, Score>; time_matching?: { coarse_iou_ours: Record<string, number> };
}
interface Bench {
  source: string; method: string; baselines: Record<Model, string>;
  summary: Record<string, { n: number } & Record<Model, { iou: number; accuracy: number }>>;
  images: BenchImage[];
}

const MODELS: Model[] = ['flat', 'dem240', 'slope_only', 'ours'];
const SHORT: Record<Model, string> = { flat: 'Smooth sphere', dem240: '240 m terrain', slope_only: 'Local slope', ours: 'Ours' };
const GROUP: Record<string, string> = { known_time: 'Known capture time', matched_time: 'Capture time matched' };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const f2 = (x: number) => x.toFixed(2);
const pc = (x: number) => `${Math.round(x * 100)}%`;

/** Hard-wrapped text -> paragraphs (blank line separates, single newlines and indents collapse). */
export const paras = (s: string) => s.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);

export async function mountReality(el: HTMLElement, base: string) {
  el.innerHTML = '<p class="note">Loading photo comparison…</p>';
  let b: Bench;
  try {
    const r = await fetch(base + 'index.json');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    b = await r.json();
  } catch (e) {
    el.innerHTML = `<p class="status err">Could not load bench/index.json: ${esc((e as Error).message)}</p>`;
    return;
  }
  const groups = [...new Set(b.images.map((i) => i.group))];
  el.innerHTML = `
    <p>Left of the handle: a real photo from NASA's Lunar Reconnaissance Orbiter (LRO) camera. Right: what our model predicts for the
      same moment and Sun position. Drag the handle (or focus it and use the arrow keys) to compare where the shadows fall.</p>
    <label class="pick">Photo <select class="img">${groups.map((g) => `<optgroup label="${esc(GROUP[g] ?? g)}">${b.images
      .filter((i) => i.group === g).map((i) => `<option value="${esc(i.id)}">${esc(i.id)}</option>`).join('')}</optgroup>`).join('')}</select></label>
    <div class="split">
      <img class="photo" alt="LRO NAC photo" decoding="async" loading="lazy">
      <img class="model" alt="Our predicted shadows" decoding="async" loading="lazy">
      <div class="handle" role="slider" tabindex="0" aria-label="Split between photo and prediction" aria-valuemin="0" aria-valuemax="100"></div>
      <span class="tag l">Photo</span><span class="tag r">Our model</span>
    </div>
    <p class="note meta"></p>
    <table class="m sc"></table>
    <p class="note">IoU = how much the predicted and photographed shadows overlap (1 = perfect). F1 is a similar overlap score;
      accuracy = share of pixels called correctly as lit or shadow (high even for a bad model when most ground is lit).</p>
    <h3>All photos, average shadow IoU</h3>
    <table class="m sum"><tr><th></th>${MODELS.map((m) => `<th${m === 'ours' ? ' class="ours"' : ''}>${SHORT[m]}</th>`).join('')}</tr>${
      Object.entries(b.summary).map(([g, s]) => `<tr><th>${esc(GROUP[g] ?? g)} <small>(${s.n})</small></th>${MODELS.map((m) =>
        `<td${m === 'ours' ? ' class="ours"' : ''}>${f2(s[m].iou)}</td>`).join('')}</tr>`).join('')}</table>
    <details><summary>Limits of this check (read before quoting the numbers)</summary>
      ${paras(b.method).map((p) => `<p>${esc(p)}</p>`).join('')}
      <p>Models compared: ${MODELS.map((m) => `<b>${SHORT[m]}</b>: ${esc(b.baselines[m])}`).join('; ')}.</p>
      <p class="note">Images: ${esc(b.source)}.</p>
    </details>`;

  const split = el.querySelector<HTMLElement>('.split')!, handle = el.querySelector<HTMLElement>('.handle')!;
  const photo = el.querySelector<HTMLImageElement>('.photo')!, model = el.querySelector<HTMLImageElement>('.model')!;
  const sel = el.querySelector<HTMLSelectElement>('.img')!;

  let pos = 50;
  const set = (p: number) => {
    pos = Math.min(100, Math.max(0, p));
    split.style.setProperty('--pos', `${pos}%`);
    handle.setAttribute('aria-valuenow', String(Math.round(pos)));
    handle.setAttribute('aria-valuetext', `${Math.round(pos)}% photo`);
  };
  const at = (e: PointerEvent) => { const r = split.getBoundingClientRect(); set(((e.clientX - r.left) / r.width) * 100); };
  split.addEventListener('pointerdown', (e) => { split.setPointerCapture(e.pointerId); at(e); handle.focus({ preventScroll: true }); });
  split.addEventListener('pointermove', (e) => { if (split.hasPointerCapture(e.pointerId)) at(e); });
  handle.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 10 : 2;
    const k: Record<string, number> = { ArrowLeft: pos - step, ArrowDown: pos - step, ArrowRight: pos + step, ArrowUp: pos + step, Home: 0, End: 100, PageDown: pos - 10, PageUp: pos + 10 };
    if (e.key in k) { e.preventDefault(); set(k[e.key]); }
  });
  set(50);

  const show = () => {
    const im = b.images.find((i) => i.id === sel.value) ?? b.images[0];
    photo.src = base + im.photo;
    model.src = base + im.model;
    const cands = im.time_matching ? Object.keys(im.time_matching.coarse_iou_ours).length : 0;
    el.querySelector('.meta')!.textContent = `${im.utc.replace('T', ' ').replace('Z', ' UTC')} · Sun ${im.sun_el.toFixed(2)}° high, azimuth ${im.sun_az.toFixed(0)}° · `
      + (im.group === 'known_time' ? `capture time known (image ${im.source_image})`
        : `capture time picked as the best match of ${cands || 'several'} listed observations (${im.source_image} for our model)`);
    el.querySelector('.sc')!.innerHTML = `<tr><th>This photo</th><th>IoU</th><th>F1</th><th>Accuracy</th></tr>` + [...MODELS].reverse().map((m) =>
      `<tr${m === 'ours' ? ' class="ours"' : ''}><th>${SHORT[m]}</th><td>${f2(im.scores[m].iou)}</td><td>${f2(im.scores[m].f1)}</td><td>${pc(im.scores[m].accuracy)}</td></tr>`).join('');
  };
  sel.onchange = show;
  show();
}
