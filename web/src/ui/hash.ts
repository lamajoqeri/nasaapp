// URL hash keys for the stage: 3D camera (cam=site:B), map layer (ov=slope), map region (mr=g) and map centre/zoom
// (mc=lat,lon,kmAcross). Pure, so a share link's round trip is unit-tested.
import type { LayerId, Mode } from './map';
import type { CameraState } from '../view3d/actions';

export interface MapView { mode: Mode; overlay: LayerId; center?: [number, number]; kmAcross?: number }
const LAYER_IDS: LayerId[] = ['none', 'sp_sun', 'sp_earth', 'sp_psr', 'elevation', 'slope'];

/** The coordinates the app accepts everywhere (editor, actions, links): lon east, -180 to 360. */
export const okLatLon = (lat: number, lon: number) => Math.abs(lat) <= 90 && lon >= -180 && lon <= 360;

export function writeStageHash(p: URLSearchParams, s: { cam?: CameraState; map?: MapView }) {
  if (s.cam?.preset === 'stand-at-site') p.set('cam', 'site' + (s.cam.scenario ? ':' + s.cam.scenario : ''));
  const m = s.map;
  if (!m) return;
  if (m.overlay !== 'none') p.set('ov', m.overlay);
  if (m.mode === 'global') p.set('mr', 'g');
  if (m.center && m.kmAcross) p.set('mc', `${+m.center[0].toFixed(4)},${+m.center[1].toFixed(4)},${+m.kmAcross.toPrecision(3)}`);
}

export function readStageHash(p: URLSearchParams): { cam?: CameraState; map?: MapView } {
  const out: { cam?: CameraState; map?: MapView } = {};
  const cam = /^site(?::([A-D]))?$/.exec(p.get('cam') ?? '');
  if (cam) out.cam = { preset: 'stand-at-site', scenario: cam[1] ?? null };
  if (p.has('ov') || p.has('mr') || p.has('mc')) {
    const ov = p.get('ov') as LayerId, [lat, lon, km] = (p.get('mc') ?? '').split(',').map(Number);
    const m: MapView = { mode: p.get('mr') === 'g' ? 'global' : 'polar', overlay: LAYER_IDS.includes(ov) ? ov : 'none' };
    if (okLatLon(lat, lon) && km > 0) { m.center = [lat, lon]; m.kmAcross = km; }
    out.map = m;
  }
  return out;
}
