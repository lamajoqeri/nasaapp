import { describe, expect, it } from 'vitest';
import { spFwd } from '../core/geom';
import {
  clampView, detailVisible, feather, fitPoints, fitScale, formatLatLon, imgPixel, llToMap, lon180, lon360, mapToLl,
  matchStats, niceScaleKm, rampLut, rectsOverlap, toMap, toScreen, zoomAt, type Bounds, type View,
} from './map';

const SP: Bounds = [-304000, -303920, 303920, 304000];
const GLOBAL: Bounds = [0, -90, 360, 90];
const near = (a: number, b: number, tol: number) => expect(Math.abs(a - b)).toBeLessThan(tol);

describe('view transform', () => {
  const v: View = { cx: 1000, cy: -2000, scale: 0.01, w: 800, h: 500 };

  it('puts the view centre at the viewport centre, y up', () => {
    expect(toScreen(v, 1000, -2000)).toEqual([400, 250]);
    expect(toScreen(v, 1000, 8000)[1]).toBe(150);   // +y in map = up on screen
    expect(toScreen(v, 11000, -2000)[0]).toBe(500);
  });

  it('round-trips screen <-> map', () => {
    const [x, y] = toMap(v, ...toScreen(v, -12345, 6789));
    near(x, -12345, 1e-6); near(y, 6789, 1e-6);
  });

  it('known site lands at the expected stereographic point and round-trips', () => {
    const [x, y] = spFwd(-89.474, -137.414);
    near(x / 1000, -10.8, 0.1);
    near(y / 1000, -11.8, 0.1);
    expect(llToMap('polar', -89.474, -137.414)).toEqual([x, y]);
    const fit: View = { cx: 0, cy: 0, scale: fitScale(SP, 900, 480), w: 900, h: 480 };
    const [sx, sy] = toScreen(fit, x, y);
    expect(sx).toBeLessThan(450);      // west of the pole: left of centre
    expect(sy).toBeGreaterThan(240);   // toward 180°: below centre
    const [lat, lon] = mapToLl('polar', ...toMap(fit, sx, sy));
    near(lat, -89.474, 1e-9); near(lon, -137.414, 1e-9);
  });

  it('fitScale fits the limiting axis', () => {
    near(fitScale(SP, 900, 480), 480 / 607920, 1e-12);
    expect(fitScale(GLOBAL, 720, 500)).toBe(2);
  });

  it('zoomAt keeps the cursor point fixed', () => {
    const before = toMap(v, 620, 90);
    const z = zoomAt(v, 620, 90, 0.07);
    const after = toMap(z, 620, 90);
    expect(z.scale).toBe(0.07);
    near(after[0], before[0], 1e-6); near(after[1], before[1], 1e-6);
  });

  it('clampView centres a map smaller than the viewport and stops at the edges otherwise', () => {
    const s = fitScale(SP, 900, 480);
    const c = clampView({ cx: 250000, cy: 250000, scale: s, w: 900, h: 480 }, SP);
    near(c.cx, -40, 1e-6); near(c.cy, 40, 1e-6);
    const z = clampView({ cx: 1e9, cy: -1e9, scale: 0.01, w: 800, h: 500 }, SP);
    near(toMap(z, 800, 500)[0], SP[2], 1e-6);   // right edge of view = right edge of map
    near(toMap(z, 800, 500)[1], SP[1], 1e-6);   // bottom edge of view = bottom edge of map
    const inside = { cx: 5000, cy: -7000, scale: 0.01, w: 800, h: 500 };
    expect(clampView(inside, SP)).toEqual(inside);
  });
});

describe('coordinate conversion', () => {
  it('wraps longitude both ways', () => {
    expect(lon360(-137.414)).toBeCloseTo(222.586, 9);
    expect(lon360(360)).toBe(0);
    expect(lon180(222.586)).toBeCloseTo(-137.414, 9);
    expect(lon180(180)).toBe(-180);
    expect(lon180(23.473)).toBeCloseTo(23.473, 9);
  });

  it('global view: lon 0..360 left to right, output lon in -180..180', () => {
    expect(llToMap('global', 0.6741, 23.473)[0]).toBeCloseTo(23.473, 9);
    expect(llToMap('global', -41.6385, -153.9852)[0]).toBeCloseTo(206.0148, 9);
    expect(mapToLl('global', 206.0148, -41.6385)[1]).toBeCloseTo(-153.9852, 9);
    expect(mapToLl('global', 90, 10)).toEqual([10, 90]);
    const v: View = { cx: 180, cy: 0, scale: 2, w: 720, h: 360 };
    expect(toScreen(v, ...llToMap('global', 90, 0))).toEqual([0, 0]);          // top-left = 90N, 0E
    expect(toScreen(v, ...llToMap('global', -90, -0.0001))[1]).toBe(360);
  });

  it('polar view: 0° up, 90°E right, pole at origin', () => {
    const [x0, y0] = llToMap('polar', -85, 0);
    near(x0, 0, 1e-6); expect(y0).toBeGreaterThan(150000);
    const [x1, y1] = llToMap('polar', -85, 90);
    expect(x1).toBeGreaterThan(150000); near(y1, 0, 1e-6);
    near(mapToLl('polar', 0, 0)[0], -90, 1e-9);
  });

  it('formats lat/lon', () => {
    expect(formatLatLon(-89.474, -137.414)).toBe('89.47°S 137.41°W');
    expect(formatLatLon(0.6741, 23.473)).toBe('0.67°N 23.47°E');
    expect(formatLatLon(-45, 222.586)).toBe('45.00°S 137.41°W');
  });
});

describe('image sampling', () => {
  const B: Bounds = [-151740, -151740, 151740, 151740];
  it('row 0 is y_max, col 0 is x_min', () => {
    expect(imgPixel(B, 2529, 2529, -151740, 151740)).toEqual([0, 0]);
    expect(imgPixel(B, 2529, 2529, 151740, -151740)).toEqual([2528, 2528]);
    expect(imgPixel(B, 2529, 2529, 0, 0)).toEqual([1264, 1264]);
    expect(imgPixel(B, 2529, 2529, 60, 121000)![1]).toBeLessThan(300);   // toward Earth = near the top
  });
  it('is null outside the image', () => {
    expect(imgPixel(B, 2529, 2529, 151741, 0)).toBeNull();
    expect(imgPixel(B, 2529, 2529, 0, -200000)).toBeNull();
  });
});

describe('labels and furniture', () => {
  it('rectsOverlap', () => {
    const a = { x: 0, y: 0, w: 10, h: 10 };
    expect(rectsOverlap(a, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
    expect(rectsOverlap(a, { x: 2, y: 2, w: 2, h: 2 })).toBe(true);
    expect(rectsOverlap(a, { x: 10, y: 0, w: 5, h: 5 })).toBe(false);   // touching edges do not overlap
    expect(rectsOverlap(a, { x: 0, y: 11, w: 5, h: 5 })).toBe(false);
  });

  it('detail layer only when zoomed in over Shackleton', () => {
    const SH: Bounds = [-30000, -30000, 10000, 10000];
    expect(detailVisible({ cx: 0, cy: 0, scale: 800 / 60000, w: 800, h: 500 }, SH)).toBe(true);
    expect(detailVisible({ cx: 0, cy: 0, scale: 800 / 100000, w: 800, h: 500 }, SH)).toBe(false);
    expect(detailVisible({ cx: 200000, cy: 0, scale: 800 / 60000, w: 800, h: 500 }, SH)).toBe(false);
  });

  it('scale bar picks 1/2/5 steps', () => {
    expect(niceScaleKm(480 / 607920, 120)).toBe(100);
    expect(niceScaleKm(800 / 60000, 120)).toBe(5);
    expect(niceScaleKm(800 / 5000, 120)).toBe(0.5);
  });

  it('colour ramp runs from background to the token colour', () => {
    const lut = rampLut([242, 181, 68]);
    expect([...lut.slice(0, 3)]).toEqual([10, 11, 13]);
    expect([...lut.slice(765)]).toEqual([242, 181, 68]);
    expect(lut[200 * 3]).toBeGreaterThan(lut[100 * 3]);
  });
});

describe('seam blending', () => {
  it('feather ramps 0 -> 1 smoothly over its width', () => {
    expect(feather(-5, 10)).toBe(0);
    expect(feather(0, 10)).toBe(0);
    expect(feather(5, 10)).toBeCloseTo(0.5);
    expect(feather(10, 10)).toBe(1);
    expect(feather(99, 10)).toBe(1);
  });
  it('matchStats maps one mean/std onto another', () => {
    const [g, o] = matchStats([150, 40], [120, 20]);
    expect(g * 150 + o).toBeCloseTo(120);
    expect(g * 190 + o).toBeCloseTo(140);
    expect(matchStats([100, 0], [120, 20])).toEqual([1, 20]);
  });
});

describe('fitPoints', () => {
  it('centres on the points with a margin, and floors the span for a lone point', () => {
    const f = fitPoints([[0, 0], [10000, 4000]], 1000, 500, 3000);
    expect(f.cx).toBe(5000); expect(f.cy).toBe(2000);
    expect(f.scale).toBeCloseTo(1000 / 14000);           // width-limited: 10 km * 1.4
    expect(fitPoints([[5, 5]], 1000, 1000, 3000).scale).toBeCloseTo(1000 / 4200);
  });
});
