# Southern-Luna v2: design

Status: draft, 2026-11-14. Open questions are at the bottom.

## Goals

1. Fix the two map seams: the hillshade square and the overlay square.
2. Replace the left Scenarios panel with an AI agent that can do anything a user can.
3. Give the 3D view two render modes: Realistic and Clear.
4. Replace the right inspector's stat wall with mission-planning graphs. Keep the
   horizon panorama, put the raw stats behind a button, and add a sky pop-up next
   to the horizon.

## The shared seam: the action layer (build first)

Right now every control calls `app.ts` internals directly (`add`, `remove`,
`select`, `nudge`, `syncCard`...). v2 routes **every user-visible change**
through one typed registry. The UI buttons and the agent's tools call the same
functions, so "the agent can do everything a user can" holds by construction,
not by keeping two code paths in sync.

```ts
// web/src/ui/actions.ts
export interface Action<A> {
  name: string;             // 'scenario.add', 'view.set', ...
  description: string;      // shown to the model as the tool description
  schema: JSONSchema;       // input_schema, additionalProperties:false
  run(args: A): Promise<unknown>;   // returns a short result the model can read
}
export const actions = new Map<string, Action<any>>();
export function register(a: Action<any>): void;
export function snapshot(): AppState;   // everything on screen, as JSON
```

Rules:
- An action is the *only* way its change happens. The UI handler is
  `actions.get(name).run(args)`.
- `snapshot()` returns the visible state: scenarios (site, lat/lon, landing
  time, mast), the selected scenario, view (3D/Map, region, overlay, render
  mode, camera preset), time scrubber, slip, open pop-ups, and the headline
  metrics of each scenario. The agent calls it to "look at the screen".
- Each owner registers the actions for the controls they build (see the split
  below). A control without an action fails review.

Initial action list (owner in brackets):

| Action | Args | Owner |
|---|---|---|
| `state.get` | none | 1 |
| `sites.search` | `query` | 1 |
| `scenario.add` | `site` or `lat`,`lon`; `t?`, `mast?` | 1 |
| `scenario.update` | `id`, any of `site`,`lat`,`lon`,`t`,`mast` | 1 |
| `scenario.nudge` | `id`, `dir` N/E/S/W, `m` | 1 |
| `scenario.remove` / `scenario.select` | `id` | 1 |
| `time.set` | `hoursAfterLanding` | 1 |
| `time.play` / `time.pause` | none | 1 |
| `slip.set` | `days` 0..60 | 1 |
| `view.set` | `mode` 3d/map, `region`, `overlay` | 1 |
| `tab.set` | mission/evidence/compare | 1 |
| `render.set` | `mode` realistic/clear | 2 |
| `camera.set` | `preset` overview/stand-at-site, `scenario?` | 2 |
| `inspector.details` | `open` bool | 2 |
| `sky.open` / `sky.close` | `scenario?` | 2 |
| `chart.set` | `metric`, `durationDays` | 2 |

## 1. Map seams (Effort 1)

**Hillshade square (Image 2).** `map.ts` draws the 20 m Shackleton hillshade
(`shackleton_hillshade.png`, bounds ±30/10 km) over the 240 m polar
hillshade. The two were shaded with different sharpness and contrast, so the
edge shows as a hard square. Fix: feather the detail layer into the base
layer with a radial or edge alpha mask over its outer ~15%, and match its
histogram to the base layer at load time. Pure web change, no data change.

**Overlay square (Image 4).** The Sunlight and Earth-view overlays
(`sp_sun.png` and `sp_earth.png`, NASA PGDA product 69) cover only ±151.7 km,
which is poleward of about 85°S. The hillshade covers ±304 km, so the colour
stops at a square. The overlay doesn't cover the whole area because the data
we have stops there. Options:
- **a.** Short term: draw the overlay inside a feathered circle (r ≈ 150 km)
  and mark "no NASA data beyond 85°S" in the legend. Web only, a few hours.
- **b.** Proper fix: `prep/` computes our own average sun/earth visibility on
  a 1 km grid out to 304 km with the horizon engine we already have, then
  blends it with PGDA inside 85°S. This is a `prep/` + `web/public/data` change
  and needs the data owner's agreement.
- Recommendation: ship (a) now and do (b) if time allows.

## 2. AI agent panel (Effort 1)

Replaces the left column (`makeCard`/Scenarios list).

The panel:
- Chat thread with streaming text, plus one compact line per tool call
  ("Added scenario C: Malapert Massif, 2027-03-02").
- A slim **scenario strip** stays at the top of the panel: A–D chips showing
  name and date, with headline sunlit, Earth and longest-dark numbers. Clicking
  a chip selects it and opens the full editor (today's card) as a pop-over.
  Manual editing stays possible, and the agent's changes are visible.
- Suggested prompts when empty: "Find the best-lit site for a 14-day mission
  starting March 2027", "What happens if we slip 2 weeks?".

Runtime (static site, no backend):
- `@anthropic-ai/sdk` in the browser (`dangerouslyAllowBrowser: true`), model
  `claude-opus-5-5`, streaming, adaptive thinking. Tools are generated from the
  action registry: `name`, `description`, `input_schema` and `strict: true`.
- Agent loop: SDK tool runner over the registry. Parallel tool calls are run in
  order, and all their results go back in one message.
- System prompt: what the app computes, the units used, the catalogue of
  sites, the mission-planning criteria (power, comms, longest dark), plus "call
  `state.get` before acting if unsure".
- Long actions (`scenario.add` triggers worker compute) resolve only after the
  worker returns, so the model reads real metrics, not placeholders.

Auth, phase 1: the user pastes their own API key, which is kept in
`localStorage` only and never sent to the URL, the hash or any server but
api.anthropic.com. If there's no key, the panel shows a key form; everything
else still works.
Auth, phase 2: "Sign in with Anthropic" (OAuth) or a small proxy function that
holds a server key (for example on Vercel). Only the client factory in
`agent/client.ts` changes.

Files: `web/src/agent/{client,loop,panel,prompt}.ts`, `web/src/ui/actions.ts`.

## 3. 3D render modes (Effort 2)

- **Realistic** (current): terrain lit only by the Sun with ray-marched
  shadows, and black shadows.
- **Clear**: shadow areas lifted to about 35% albedo with a cool tint, plus a
  sky/ambient term and a hillshade term from a fixed light at 45° elevation,
  so relief is readable everywhere. Sunlit areas are still drawn warm and
  shadowed areas cool, so lit vs dark stays obvious. It's a uniform toggle
  in `shaders.ts`; no geometry or march changes.
- Toggle in the 3D toolbar, next to the region buttons. The mode is stored in
  the URL. Action `render.set`.

## 4. Inspector redesign (Effort 2)

Top to bottom:
1. **Horizon panorama**: kept as it is, with Sun and Earth paths. It gets a
   ⤢ **Sky** button that opens item 5.
2. **Power chart**: a line plot over the mission duration (default 14 days,
   adjustable). It plots the available solar power fraction for every
   scenario, overlaid in the A–D colours. Power ∝ visible disk fraction ×
   the panel-geometry term (see Q3). A thin band shows the Monte Carlo
   10–90% spread.
3. **Sun elevation chart**: Sun elevation minus the horizon over the same
   window. Being above 0 means lit, and the height affects panel efficiency.
4. **Windows bar**: Gantt-style rows per scenario showing sunlit periods,
   Earth visible periods and DSN contact periods, so durations read at a
   glance (this covers the "duration of sunlight" and "Earth visibility
   windows" requirements).
5. **Viability badge** per scenario: Power OK / Marginal / No and Comms OK /
   Gaps / No, with thresholds stated under the badge.
6. **Details** button: opens today's raw-stats table and the 12-month strip
   unchanged.

Data: everything above already exists in `Series` (`sunFrac`, `sunEl`,
`earthVis`, `dsn`) and `monteCarlo().pLit`. No core changes, only drawing.
Use the existing canvas helpers; no new chart library.

## 5. Sky pop-up (Effort 2)

A modal with a fisheye (azimuthal equidistant) all-sky view from the site:
the zenith is in the centre, the horizon is the outer ring, and north is up.
- The terrain horizon is filled as a dark band around the edge (from
  `Horizon.el`).
- Sun and Earth tracks are drawn over the mission window, with a playhead tied
  to the main time scrubber. Play/pause animates the bodies moving around the
  sky. The Sun's disk is drawn at true size and partly clipped where the
  terrain cuts it.
- The Sun's track is dashed where it is behind terrain, and so is Earth's.
- Canvas 2D, about 200 lines, no three.js.

## Split

| | Effort 1: agent & map | Effort 2: inspector & 3D |
|---|---|---|
| Day 0 | Writes `actions.ts` + `snapshot()`, wires the existing controls to it, pushes it | Reviews the action API, starts the charts on a branch |
| Main | Agent panel, client, loop, prompt, key form, scenario strip | Power, elevation and windows charts, badges, Details, sky pop-up |
| Second | Map seam (feather + overlay circle) | 3D Clear mode |
| Registers | state, sites, scenario, time, slip, view, tab | render, camera, inspector, sky, chart |
| Files | `agent/*`, `ui/actions.ts`, `ui/app.ts` (left panel), `ui/map.ts` | `ui/inspector*.ts`, `ui/sky.ts`, `ui/charts.ts`, `view3d/*` |

The only cross-file edit is `app.ts`: Effort 1 owns the left panel and the
action wiring, and Effort 2 owns `paintInspector` and below. Effort 2 calls
`register()` from its own modules, so it doesn't need to edit `actions.ts`
after day 0.

## Open questions

- Q1. Sign-in: is a pasted API key fine for the demo, or is "Sign in with
  Anthropic" a must for judging day?
- Q2. With the left panel gone, should scenario editing stay manual
  (a pop-over from the chips), or should it be agent-only?
- Q3. Power model: is the panel a vertical Sun-tracking panel (power ≈ visible
  fraction; this is the usual polar assumption) or fixed-horizontal (× sin el)?
  And what is the default mission length?
- Q4. Overlay: should we feather the overlay now (a), or ask the data owner
  for wider coverage (b)?
