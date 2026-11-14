import { core } from './core/api';

const app = document.getElementById('app')!;
const t = Date.parse('2026-12-01T00:00:00Z');
core.scenario({ lat: -89.474, lon: -137.414, mast: 2 }, t).then((r) => {
  app.textContent = JSON.stringify(r.metrics, null, 1);
}, (e) => { app.textContent = String(e); });
