// Which 20 m DEM tile ("region") the 3D view can show for a point. No three.js / CSS imports:
// the app shell imports this statically and loads the view itself lazily.
import { spFwd } from '../core/geom';

/** The 240 m far-field tile drawn around every region. */
export const LO_ID = 'sp_240m';

export interface RegionTile { id: string; proj: string; x0?: number; y0?: number; px?: number; w: number; h: number }

/** The manifest's south-polar 20 m tiles, in manifest order. */
export function regionTiles<T extends RegionTile>(tiles: T[]): T[] {
  return tiles.filter((t) => t.proj === 'spstere' && t.px === 20);
}

/** [xMin, yMin, xMax, yMax] of a tile in stereographic metres (pixel centres). */
export function tileBounds(t: RegionTile): [number, number, number, number] {
  return [t.x0!, t.y0! - (t.h - 1) * t.px!, t.x0! + (t.w - 1) * t.px!, t.y0!];
}

/** Id of the first region tile containing (lat, lon) at least `margin` metres inside its edge. */
export function regionAt(tiles: RegionTile[], lat: number, lon: number, margin = 1000): string | undefined {
  if (!(lat < -60)) return undefined; // the south polar projection is only used near the pole
  const [x, y] = spFwd(lat, lon);
  for (const t of regionTiles(tiles)) {
    const b = tileBounds(t);
    if (x > b[0] + margin && x < b[2] - margin && y > b[1] + margin && y < b[3] - margin) return t.id;
  }
  return undefined;
}

/** Is (lat, lon) on the 240 m far field, i.e. drawn (and pinned) in the 3D view whatever region is shown? */
export function inSurround(tiles: RegionTile[], lat: number, lon: number): boolean {
  const t = tiles.find((t) => t.id === LO_ID);
  if (!t || !(lat < -60)) return false;
  const [x, y] = spFwd(lat, lon), b = tileBounds(t);
  return x > b[0] && x < b[2] && y > b[1] && y < b[3];
}
