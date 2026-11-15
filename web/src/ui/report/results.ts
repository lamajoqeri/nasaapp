// Sections built from the user's scenarios: abstract, study sites, results, site-specific confidence, conclusion.
// Owner: results agent. STUBS until then.
import { section } from './dom';
import type { SectionFn } from './types';

export const abstractSection: SectionFn = async (ctx) => section('abstract', 'Abstract', `<p>Results for ${ctx.scenarios.length} scenario(s).</p>`);
export const sitesSection: SectionFn = async () => section('sites', 'Study sites and scenarios', '<p>TODO</p>');
export const resultsSection: SectionFn = async () => section('results', 'Results', '<p>TODO</p>');
export const confidenceSection: SectionFn = async () => section('confidence', 'Site-specific confidence', '<p>TODO</p>');
export const conclusionSection: SectionFn = async () => section('conclusion', 'Conclusion', '<p>TODO</p>');
