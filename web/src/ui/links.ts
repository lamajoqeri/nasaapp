// Deep links that open a site in the expert tools named in the challenge: LROC QuickMap and NASA Moon Trek.
// URL forms were checked by loading them (Nov 2026): both apps re-centre on the point given.
import { spFwd } from '../core/geom';

const r = (v: number, n: number) => String(+v.toFixed(n));

/** South of 60S both tools take south-polar stereographic metres (the same projection as our polar DEM). */
// ponytail: north of 60N still uses the cylindrical view; add the north-polar form (QuickMap proj=26, Trek IAU2000::30118) if a far-north site is ever added
export function externalLinks(lat: number, lon: number): { quickmap: string; trek: string } {
  if (lat <= -60) {
    const [x, y] = spFwd(lat, lon), h = 5000; // 10 km box
    return {
      quickmap: `https://quickmap.lroc.im-ldi.com/?prjExtent=${[x - h, y - h, x + h, y + h].map((v) => r(v, 1)).join(',')}&proj=27`,
      trek: `https://trek.nasa.gov/moon/#v=0.1&x=${r(x, 1)}&y=${r(y, 1)}&z=7&p=urn:ogc:def:crs:IAU2000::30120`,
    };
  }
  const h = 0.1; // degrees, about 3 km at the equator
  return {
    quickmap: `https://quickmap.lroc.im-ldi.com/?extent=${[lon - h, lat - h, lon + h, lat + h].map((v) => r(v, 4)).join(',')}&proj=16`,
    trek: `https://trek.nasa.gov/moon/#v=0.1&x=${r(lon, 4)}&y=${r(lat, 4)}&z=10&p=urn:ogc:def:crs:EPSG::104903`,
  };
}
