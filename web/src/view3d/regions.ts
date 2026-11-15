// Which 20 m DEM tile ("region") the 3D view can show for a point. No three.js / CSS imports:
// the app shell imports this statically and loads the view itself lazily.
import { spFwd } from '../core/geom';

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
