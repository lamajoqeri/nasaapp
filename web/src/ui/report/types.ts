// Contract between the app and the report sections. The app builds a ReportInput from its live state; index.ts adds
// the abort signal and runs every section. Sections never touch app state: everything they need is here.
import type { Scenario } from '../scenario';

export interface SiteRec { id: string; name: string; lat: number; lon: number; program: string; date: string | null; note: string }

export interface ReportScenario {
  letter: string;   // 'A'..'D', as in the app
  name: string;     // site name, or 'Custom point'
  color: string;    // SCENARIO_COLORS[i] (A is near-white: draw it on a dark chip or dark figure panel)
  sc: Scenario;     // spec (site, lat, lon, t, mast) and worker results; sc.base is always defined here
  site?: SiteRec;   // sites.json record when the scenario uses a catalogue site
}

export interface ReportInput {
  scenarios: ReportScenario[]; // only scenarios with results; at least one
  skipped: string[];           // letters of scenarios left out (still computing or failed)
  selected: number;            // index into scenarios of the one selected in the app
  slip: number;                // landing delay set in the app, days (0 = none); sc.slipped/srows hold the delayed run
  missionDays: number;         // mission length chosen in the inspector chart (7, 14 or 29.5)
  dataBase: string;            // URL of the data folder (web/public/data/), ends in '/'
  link: string;                // link that reopens the app in this exact state
  generatedAt: number;         // ms UTC
  close(): void;               // back to the mission view
}

export interface ReportCtx extends ReportInput {
  signal: AbortSignal;         // aborted when the report is closed or regenerated: stop work, don't touch the DOM
}

/** One numbered section of the paper. Resolve with a `section(...)` element (dom.ts). Throwing shows an error box
 *  in that section only. */
export type SectionFn = (ctx: ReportCtx) => Promise<HTMLElement>;
