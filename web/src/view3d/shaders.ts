import { S_END, S_START, STEP_K, STEP_MAX, STEP_MIN, SUN_RADIUS_DEG } from './march';

const f = (v: number) => v.toFixed(6);
/** Block sizes (texels) of the max-height textures: two over the 20 m tile, one over the 240 m tile. */
export const BLOCK_HI = 16, BLOCK_MID = 64, BLOCK_LO = 16;

/**
 * Coordinates: everything is relative to the region centre. With C = Moon-fixed (MOON_ME) position of
 * the centre of the shown 20 m tile and (x0, y0) its stereographic coordinates, positions are p = Q - C
 * (same axes, metres) and map coordinates are "rel" = (x - x0, y - y0). Absolute values (1.7e6 m, and
 * up to 170 km of x, y in the outer regions) never enter float32 arithmetic un-cancelled:
 *   ray height   |Q| - R  = (|C|^2 - R^2 + 2 C.p + p.p) / (|Q| + R)
 *   map coords   x - x0   = (2R p.y - x0 dD) / (D0 + dD),  D0 = |C| - C.z,  dD = (|Q| - |C|) - p.z   (y: p.x, y0)
 *   surface      p        = (R + h)(u - u0) + (h - h0) u0, with u - u0 expanded analytically (posP)
 * which keeps the march millimetre-accurate in every region. Tile geometry uniforms are relative too.
 * sunFraction() mirrors sunFractionAt() in march.ts: same samples, same exits. Two things only make it
 * faster without changing which samples can matter: block-maximum textures let it pass over stretches of
 * the schedule where the ray is provably too far above all terrain to lower the result, and beyond 500 m
 * the height lookup may use hardware bilinear filtering (when float filtering exists) instead of 4 fetches.
 */
const MARCH_GLSL = /* glsl */ `
precision highp float;
precision highp sampler2D;
uniform sampler2D uHi, uLo;     // heights in metres above R, R32F
uniform vec4 uHiGeo, uLoGeo;    // x0, y0 (relative to the region centre), px, w - 1 (square tiles)
uniform vec3 uC;                // region centre C, Moon-fixed
uniform vec4 uCk;               // |C|^2 - R^2, |C|, |C| - C.z, height of C above R
uniform vec2 uXY0;              // stereographic (x0, y0) of C
uniform sampler2D uMaxHi, uMaxMid, uMaxLo;         // max height per block, dilated by one block
uniform vec4 uMaxHiGeo, uMaxMidGeo, uMaxLoGeo;     // x0, y0 (relative), block size (m), n - 1
uniform float uLinear;          // 1 when the height textures have LINEAR filtering
uniform vec3 uSun;              // unit, Moon-fixed
uniform float uHMax;            // highest terrain in either tile
uniform float uStepScale;       // 1 = reference schedule; > 1 = coarser (faster)
const float R = 1737400.0;
const float PI = 3.141592653589793;
const float SUN_TAN = ${f(Math.tan(SUN_RADIUS_DEG * Math.PI / 180))};
const float SKIP_HI = ${f(BLOCK_HI * 20 - 40)}, SKIP_MID = ${f(BLOCK_MID * 20 - 40)}, SKIP_LO = ${f(BLOCK_LO * 240 - 240)};  // a little under one block
const float SUN_RAD = ${f(SUN_RADIUS_DEG * Math.PI / 180)};

float bil(sampler2D t, vec2 c, float wm1) {
  vec2 c0 = min(floor(c), vec2(wm1 - 1.0));
  vec2 fr = c - c0;
  ivec2 i = ivec2(c0);
  float a = texelFetch(t, i, 0).r, b = texelFetch(t, i + ivec2(1, 0), 0).r;
  float c2 = texelFetch(t, i + ivec2(0, 1), 0).r, d = texelFetch(t, i + ivec2(1, 1), 0).r;
  return mix(mix(a, b, fr.x), mix(c2, d, fr.x), fr.y);
}
bool inHi(vec2 xy, float inset) {
  vec2 c = vec2(xy.x - uHiGeo.x, uHiGeo.y - xy.y) / uHiGeo.z;
  return c.x >= inset && c.y >= inset && c.x <= uHiGeo.w - inset && c.y <= uHiGeo.w - inset;
}
// Same rule as Dem.sampleUnit: finest tile containing the point, 0 outside both.
float heightAt(vec2 xy) {
  vec2 c = vec2(xy.x - uHiGeo.x, uHiGeo.y - xy.y) / uHiGeo.z;
  if (c.x >= 0.0 && c.y >= 0.0 && c.x <= uHiGeo.w && c.y <= uHiGeo.w) return bil(uHi, c, uHiGeo.w);
  c = vec2(xy.x - uLoGeo.x, uLoGeo.y - xy.y) / uLoGeo.z;
  if (c.x >= 0.0 && c.y >= 0.0 && c.x <= uLoGeo.w && c.y <= uLoGeo.w) return bil(uLo, c, uLoGeo.w);
  return 0.0;
}
// Far samples: precision of hardware filtering (1/256 texel weights) is ample beyond 500 m.
float heightFar(vec2 xy) {
  if (uLinear < 0.5) return heightAt(xy);
  vec2 c = vec2(xy.x - uHiGeo.x, uHiGeo.y - xy.y) / uHiGeo.z;
  if (c.x >= 0.0 && c.y >= 0.0 && c.x <= uHiGeo.w && c.y <= uHiGeo.w) return textureLod(uHi, (c + 0.5) / (uHiGeo.w + 1.0), 0.0).r;
  c = vec2(xy.x - uLoGeo.x, uLoGeo.y - xy.y) / uLoGeo.z;
  if (c.x >= 0.0 && c.y >= 0.0 && c.x <= uLoGeo.w && c.y <= uLoGeo.w) return textureLod(uLo, (c + 0.5) / (uLoGeo.w + 1.0), 0.0).r;
  return 0.0;
}
// Upper bound of the terrain within one block length of xy. The 20 m levels know nothing beyond that
// tile, so the march only uses them when the whole skip stays inside it.
float blockMax(sampler2D t, vec4 g, vec2 xy) {
  vec2 c = floor(vec2(xy.x - g.x, g.y - xy.y) / g.z);
  return texelFetch(t, ivec2(clamp(c, vec2(0.0), vec2(g.w))), 0).r;
}
// Relative map coords + height -> p (relative to C).
vec3 posP(vec2 rel, float h) {
  float d0 = 4.0 * R * R + dot(uXY0, uXY0);
  float dl = 2.0 * dot(uXY0, rel) + dot(rel, rel);           // rho^2 - rho0^2
  float d = d0 + dl;
  vec3 du = vec3(4.0 * R / d * (rel.y - uXY0.y * dl / d0), 4.0 * R / d * (rel.x - uXY0.x * dl / d0), 8.0 * R * R / d * dl / d0); // u - u0
  return (R + h) * du + (h - uCk.w) * (uC / uCk.y);
}
vec3 normalAt(vec2 xy, float d) {
  vec2 ex = vec2(d, 0.0), ey = vec2(0.0, d);
  vec3 a = posP(xy + ex, heightAt(xy + ex)) - posP(xy - ex, heightAt(xy - ex));
  vec3 b = posP(xy + ey, heightAt(xy + ey)) - posP(xy - ey, heightAt(xy - ey));
  vec3 n = normalize(cross(a, b));
  return dot(n, uC) < 0.0 ? -n : n;   // outward
}
float sunFraction(vec3 P) {
  float minC = 1.0e9, s = ${f(S_START)};
  for (int i = 0; i < 900; i++) {
    if (s > ${f(S_END)}) break;
    vec3 q = P + s * uSun;
    float e = 2.0 * dot(uC, q) + dot(q, q);                 // |Q|^2 - |C|^2
    float rr = sqrt(uCk.y * uCk.y + e);                      // |Q|
    float rayH = (uCk.x + e) / (rr + R);                     // |Q| - R
    if ((rayH - uHMax) / s >= min(minC, SUN_TAN)) break;     // nothing further out can matter
    float dD = e / (rr + uCk.y) - q.z;
    vec2 xy = (2.0 * R * q.yx - uXY0 * dD) / (uCk.z + dD);   // relative map coords of the sample
    // Skip: if even the lowest the ray gets over the next L metres (it is convex in s, so its tangent
    // bounds it) clears the highest terrain there by the current threshold, those samples cannot matter.
    float thr = min(minC, SUN_TAN);
    float slope = min(0.0, dot(uC + q, uSun) / rr);
    float L = 0.0;
    if (rayH + slope * SKIP_LO - blockMax(uMaxLo, uMaxLoGeo, xy) >= max(thr * s, thr * (s + SKIP_LO))) L = SKIP_LO;
    else if (inHi(xy, SKIP_MID / uHiGeo.z) && rayH + slope * SKIP_MID - blockMax(uMaxMid, uMaxMidGeo, xy) >= max(thr * s, thr * (s + SKIP_MID))) L = SKIP_MID;
    else if (inHi(xy, SKIP_HI / uHiGeo.z) && rayH + slope * SKIP_HI - blockMax(uMaxHi, uMaxHiGeo, xy) >= max(thr * s, thr * (s + SKIP_HI))) L = SKIP_HI;
    if (L > 0.0) {
      float lim = s + L;
      for (int k = 0; k < 48; k++) {
        s += clamp(${f(STEP_K)} * s, ${f(STEP_MIN)}, ${f(STEP_MAX)}) * uStepScale;
        if (s >= lim) break;
      }
      continue;
    }
    float c = (rayH - (s < 500.0 ? heightAt(xy) : heightFar(xy))) / s;
    minC = min(minC, c);
    if (minC <= -SUN_TAN) break;                             // disk fully hidden
    s += clamp(${f(STEP_K)} * s, ${f(STEP_MIN)}, ${f(STEP_MAX)}) * uStepScale;
  }
  float x = clamp(atan(minC) / SUN_RAD, -1.0, 1.0);
  return 1.0 - (acos(x) - x * sqrt(1.0 - x * x)) / PI;       // frac() in core/series.ts
}
`;

export const TERRAIN_VERT = /* glsl */ `
attribute vec2 xy;          // map coords relative to the region centre
varying vec2 vXY;
void main() {
  vXY = xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * Detail quality of the illustrative surface texture: 0 = off, 1 = craters only, 2 = craters + regolith grain.
 * Its octaves fade by on-screen size, so the cost is paid only where the detail is visible.
 */
export const DETAIL = 2;

const SHADE_GLSL = MARCH_GLSL + /* glsl */ `
uniform vec3 uCam;          // relative to C
uniform float uExposure, uAmbient;
uniform vec3 uEarth;        // unit, towards Earth
uniform float uEarthshine;  // 0 when Earth is below the local horizon
uniform float uPix;         // radians per CSS pixel (not per buffer pixel: the texture must not change with resolution)
uniform float uClear;       // 0 = realistic, 1 = "Clear" relief-map rendering
uniform vec3 uHill;         // Clear: fixed hillshade light (unit, Moon-fixed, 45 deg above the region's horizontal)
uniform float uDetail;      // DETAIL
uniform sampler2D uLit;     // low-resolution sunlit irradiance of the region (sqrt-encoded, mipmapped): source of scattered light
uniform float uScatter;     // strength of light scattered into shadow from sunlit terrain nearby

vec4 hash24(vec2 p) {
  vec4 q = fract(vec4(p.xyxy) * vec4(0.1031, 0.1030, 0.0973, 0.1099));
  q += dot(q, q.wzxy + 33.33);
  return fract((q.xxyz + q.yzzw) * q.zywx);
}
float hash21(vec2 p) {
  p = fract(p * vec2(0.1031, 0.1030));
  p += dot(p, p.yx + 33.33);
  return fract((p.x + p.y) * p.y);
}
// Gradient of smooth value noise, lattice spacing 1.
vec2 noiseGrad(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f), du = 6.0 * f * (1.0 - f);
  float a = hash21(i), b = hash21(i + vec2(1.0, 0.0)), c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
  return du * (vec2(b - a, c - a) + (a - b - c + d) * u.yx);
}
// One octave of small impact craters on a jittered grid of cell size S (metres): bowls with raised rims,
// many small and degraded, few large and fresh. Returns the height gradient (slope) in map axes.
// Cells are numbered in absolute map coordinates, so the pattern is fixed to the ground in every region.
vec2 craters(vec2 rel, float S, float seed, float density) {
  vec2 q = rel / S + fract(uXY0 / S), base = floor(q - 0.5), id0 = floor(uXY0 / S);
  vec2 g = vec2(0.0);
  for (int j = 0; j < 2; j++) for (int i = 0; i < 2; i++) {
    vec2 c = base + vec2(float(i), float(j));
    vec4 h = hash24(c + id0 + seed);
    if (h.z > density) continue;                       // empty cell
    vec2 d = q - (c + 0.25 + 0.5 * h.xy);              // centre stays in the middle half: 4 cells cover every crater
    float r = 0.29 * mix(0.28, 1.0, h.w * h.w);        // radius in cells
    float len = length(d), t = len / r;
    if (t >= 1.7 || len < 1.0e-5) continue;
    float fz = h.z / density;
    float k = mix(0.15, 1.0, fz * fz);                 // freshness: most are degraded and shallow
    float u = (t - 1.0) / 0.7;
    // Radial slope of a bowl with a rounded raised rim: zero at the centre and at the crest (t = 1), then the outer flank.
    float slope = t < 1.0 ? 0.85 * k * t * (1.0 - t * t * t * t) : -0.55 * k * u * (1.0 - u) * (1.0 - u);
    g += slope * d / len;
  }
  return g;
}
// ILLUSTRATIVE: surface texture finer than 20 m is illustrative. The DEM has 20 m samples; below that the
// Moon is cratered regolith, drawn here procedurally. It tilts the SHADING normal only: no geometry, no
// effect on the shadow march, on the lit / shadow boundary or on any reported number. It is a function of
// ground position alone (stable under camera motion and time), and every octave fades in only once its
// features span a few screen pixels, so it neither shimmers when zoomed out nor blurs when zoomed in.
// Outside the 20 m tile the DEM has 240 m samples, so there (weight "coarse") two larger crater octaves
// are added as well: illustrative in the same way, and they keep the surround from looking out of focus.
vec2 detailSlope(vec2 rel, float foot, float coarse) {       // foot: ground metres under one CSS pixel
  vec2 g = vec2(0.0);
  if (uDetail < 0.5) return g;
  float S = 990.0, seed = 3.7;
  mat2 rot = mat2(0.8, -0.6, 0.6, 0.8);
  vec2 p = rel;
  for (int i = 0; i < 6; i++) {                // crater diameters up to ~570, 190 m (surround only), then 64, 21, 7, 2.3 m
    float w = smoothstep(1.6, 4.5, 0.36 * S / foot) * (i < 2 ? 0.8 * coarse : 1.0);
    if (w > 0.0) g += w * craters(rel, S, seed, i < 3 ? 0.34 : 0.62);
    S /= 3.0; seed += 11.3;
  }
  if (uDetail > 1.5) {
    float L = 1.9;
    for (int i = 0; i < 4; i++) {              // regolith grain, 1.9 m down to 0.16 m
      float w = smoothstep(2.0, 5.0, L / foot);
      if (w > 0.0) g += 0.035 * w * noiseGrad(p / L + float(i) * 17.3);
      L *= 0.44;
      p = rot * p;
    }
  }
  return g;
}
float heightLo(vec2 xy) {
  vec2 c = clamp(vec2(xy.x - uLoGeo.x, uLoGeo.y - xy.y) / uLoGeo.z, vec2(0.0), vec2(uLoGeo.w));
  return bil(uLo, c, uLoGeo.w);
}

vec4 shade(vec2 xy) {         // xy: relative map coords
  vec2 rel = xy;
  // Shade the true surface under this pixel, not the decimated mesh: the march then starts exactly
  // on the height field it tests against (no acne) and matches the CPU reference.
  vec3 P = posP(xy, heightAt(xy));
  vec3 n = normalAt(xy, inHi(xy, 1.0) ? uHiGeo.z : uLoGeo.z);
  vec3 toCam = uCam - P;
  float dist = length(toCam);
  vec3 v = toCam / dist;
  float ci = dot(n, uSun);                      // geometric: gates and feeds the march, never the detail
  vec3 tx = normalize(vec3(0.0, 1.0, 0.0) - n * n.y), ty = normalize(vec3(1.0, 0.0, 0.0) - n * n.x); // ground directions of map x, y

  // Shading normal. (1) Near the edge of the 20 m tile, ease it into the 240 m surface so the two meet
  // without a visible step. (2) Add the illustrative sub-20 m detail.
  vec3 nb = n;
  vec2 tc = vec2(xy.x - uHiGeo.x, uHiGeo.y - xy.y) / uHiGeo.z;
  float edge = min(min(tc.x, tc.y), min(uHiGeo.w - tc.x, uHiGeo.w - tc.y)) * uHiGeo.z;   // metres inside the tile
  if (edge > 0.0 && edge < 600.0) {
    vec2 ex = vec2(uLoGeo.z, 0.0), ey = vec2(0.0, uLoGeo.z);
    vec3 a = posP(xy + ex, heightLo(xy + ex)) - posP(xy - ex, heightLo(xy - ex));
    vec3 b = posP(xy + ey, heightLo(xy + ey)) - posP(xy - ey, heightLo(xy - ey));
    vec3 nl = normalize(cross(a, b));
    nb = normalize(mix(dot(nl, uC) < 0.0 ? -nl : nl, n, smoothstep(0.0, 600.0, edge)));
  }
  float cv = max(dot(nb, v), 0.0);
  vec2 m = detailSlope(rel, dist * uPix / sqrt(max(cv, 0.04)), 1.0 - smoothstep(0.0, 600.0, edge));
  vec3 ns = normalize(nb - (m.x * tx + m.y * ty));
  float ce = max(dot(ns, v), 0.0);
  // How the detail changes the sunlit term. At grazing Sun its slopes are far steeper than the Sun is
  // high, so letting them drive cos(i) directly would turn the ground into black-and-white blotches and
  // brighten it on average. Instead the change in cos(i) is compressed: strong (rim highlights, small
  // shadowlets) when the Sun is low, gentle on slopes that face the Sun, and bounded.
  float cb = dot(nb, uSun);
  float dt = (dot(ns, uSun) - cb) / (0.55 * max(cb, 0.0) + 0.12);
  float dm = dt < 0.0 ? 0.94 * tanh(dt / 0.94) : 1.5 * tanh(dt / 1.5);
  float sun = ci > 0.0 ? sunFraction(P) : 0.0;  // the physically computed visible-Sun fraction

  // Light scattered into shadow by sunlit terrain nearby (cheap, approximate, deliberately dim): the
  // blurred sunlit irradiance around the point, weighted towards normals that face where it comes from.
  vec3 up = normalize(uC + P);
  vec2 luv = clamp(tc / uHiGeo.w, 0.0, 1.0);
  float outside = smoothstep(0.0, 1500.0, -edge);            // beyond the tile the map has no data: fade to its average, then out
  float l1 = textureLod(uLit, luv, mix(1.5, 7.0, outside)).r, l2 = textureLod(uLit, luv, mix(4.0, 7.0, outside)).r;
  float e = 0.03;
  vec2 lg = vec2(textureLod(uLit, luv + vec2(e, 0.0), 3.0).r - textureLod(uLit, luv - vec2(e, 0.0), 3.0).r,
                 textureLod(uLit, luv - vec2(0.0, e), 3.0).r - textureLod(uLit, luv + vec2(0.0, e), 3.0).r);   // towards brighter ground, map axes
  vec3 from = normalize(up + 6.0 * (1.0 - outside) * (lg.x * tx + lg.y * ty));
  float scatter = uScatter * (0.55 * l1 * l1 + 0.45 * l2 * l2) * (0.30 + 0.70 * max(dot(ns, from), 0.0)) * (1.0 - 0.6 * smoothstep(0.0, 12000.0, -edge));

  if (uClear > 0.5) {
    // "Clear" mode: a relief map with the real shadows drawn on it. The warm / cool split is the same
    // ray-marched visible-Sun fraction as in the realistic mode (so the shadow edge and penumbra are
    // identical); only the colours differ. Shadow is lifted to a cool blue-grey, sunlit ground is warm,
    // and both carry hillshading from a fixed light, so relief reads everywhere.
    float lit = sun * smoothstep(0.0, 0.03, ci);
    float hs = dot(ns, uHill) - 0.70711;        // 0 on level ground
    float relief = clamp(0.52 + 3.4 * hs, 0.0, 1.3);
    relief = mix(relief, 0.52 + 0.9 * tanh(3.4 * hs / 0.9), 0.5);   // soften the extremes: small craters should not punch black holes
    relief = max(relief, 0.30);                                     // floor: slopes facing away from the fixed light stay readable (crater walls and floors must not go black in this mode)
    vec3 cool = vec3(0.070, 0.096, 0.150) * (0.10 + 1.9 * relief);
    // Sunlit ground: hillshade plus the Sun's own slope shading, kept clearly brighter than any shadow.
    // (Large-scale relief from the fixed light; the sub-20 m detail is lit by the Sun itself here, or the two lights cancel.)
    float sunRelief = clamp(0.44 + 1.2 * (dot(nb, uHill) - 0.70711) + 0.22 * smoothstep(0.0, 0.45, cb) + 0.22 * dm + 0.9 * clamp(dot(ns, uSun) - cb, -0.35, 0.35), 0.10, 1.15);
    vec3 warm = vec3(1.000, 0.905, 0.760) * (0.36 + 0.58 * sunRelief);
    return vec4(pow(mix(cool, warm, lit), vec3(1.0 / 2.2)), 1.0);
  }
  float lit = 0.0;
  if (ci > 0.0) {
    float cs = max(cb, 0.0) * (1.0 + dm);
    lit = sun * mix(cs, 2.0 * cs / (cs + max(ce, 0.12)), 0.5);   // Lambert / Lommel-Seeliger (emission floored: no blown-out limb in site view)
  }
  // Tone: Reinhard shoulder, so steep Sun-facing slopes stay below white and keep their shading.
  float x = uExposure * lit;
  float b = 1.06 * x / (1.0 + x);
  b += uAmbient * (0.2 + 0.8 * ce);
  // Earthshine: faint, not shadow-tested, only while Earth is above the local horizon.
  float es = uEarthshine * smoothstep(-0.08, 0.3, dot(ns, uEarth));
  vec3 c = vec3(b) * vec3(1.0, 0.975, 0.935) + (scatter * vec3(0.86, 0.92, 1.0) + es * vec3(0.72, 0.84, 1.0));
  return vec4(pow(c, vec3(1.0 / 2.2)), 1.0);
}
`;

/** Sunlit irradiance (visible Sun fraction x cos i) over the 20 m tile at low resolution, sqrt-encoded. */
export const LITMAP_FRAG = MARCH_GLSL + /* glsl */ `
uniform float uLitSize;
void main() {
  vec2 uv = gl_FragCoord.xy / uLitSize;
  vec2 xy = vec2(uHiGeo.x + uv.x * uHiGeo.w * uHiGeo.z, uHiGeo.y - uv.y * uHiGeo.w * uHiGeo.z);
  float ci = dot(normalAt(xy, 3.0 * uHiGeo.z), uSun);
  float v = ci > 0.0 ? sunFraction(posP(xy, heightAt(xy))) * ci : 0.0;
  gl_FragColor = vec4(vec3(sqrt(clamp(v, 0.0, 1.0))), 1.0);
}
`;

/** Forward path (no float render targets): march in the terrain's own fragment shader, after a depth pre-pass. */
export const TERRAIN_FRAG = SHADE_GLSL + /* glsl */ `
varying vec2 vXY;
void main() { gl_FragColor = shade(vXY); }
`;
export const DEPTH_FRAG = /* glsl */ `void main() { gl_FragColor = vec4(0.0); }`;

/**
 * Deferred path: the meshes only write (x, y, depth); one full-screen pass then marches exactly once per
 * pixel. With ~1 px triangles the forward path shades every pixel several times (2x2 quads, MSAA edges).
 */
export const GBUF_FRAG = /* glsl */ `
varying vec2 vXY;
void main() { gl_FragColor = vec4(vXY, gl_FragCoord.z, 1.0); }
`;
export const SCREEN_VERT = /* glsl */ `void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;
export const RESOLVE_FRAG = SHADE_GLSL + /* glsl */ `
uniform sampler2D uG;
void main() {
  vec4 g = texelFetch(uG, ivec2(gl_FragCoord.xy), 0);
  if (g.a < 0.5) discard;            // sky: leave the Sun / Earth disks and the background
  gl_FragDepth = g.b;                // so the site pins are occluded by terrain
  gl_FragColor = shade(g.rg);
}
`;

/** Sun fraction at one stereographic point, packed into RG (16 bit), for the GPU-vs-CPU self-check. */
export const PROBE_FRAG = MARCH_GLSL + /* glsl */ `
uniform vec2 uProbe;
void main() {
  float v = sunFraction(posP(uProbe, heightAt(uProbe))) * 65535.0;
  float hi = floor(v / 256.0);
  gl_FragColor = vec4(hi / 255.0, (v - hi * 256.0) / 255.0, 0.0, 1.0);
}
`;

/** Sun glare and Earth are drawn on camera-facing unit disks in the sky. */
export const SKY_VERT = /* glsl */ `
varying vec2 vP;
void main() {
  vP = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
/** Restrained glare: tight radial falloff around the Sun, no rays, no haze over the frame. Additive. */
export const GLARE_FRAG = /* glsl */ `
uniform float uGlare;
varying vec2 vP;
void main() {
  float r = length(vP);
  float g = 0.55 * exp(-r * r * 260.0) + 0.16 * exp(-r * 22.0) + 0.035 * exp(-r * 6.0);
  g *= uGlare * (1.0 - smoothstep(0.75, 1.0, r));
  gl_FragColor = vec4(vec3(1.0, 0.95, 0.86) * g, 1.0);
}
`;
/** Earth as a small globe: oceans, cloud, a thin atmosphere at the limb, lit from uL (disk frame: x right, y up, z to the eye). Illustrative surface, true phase. */
export const EARTH_FRAG = /* glsl */ `
uniform vec3 uL;
varying vec2 vP;
float eh(vec2 p) { p = fract(p * vec2(0.1031, 0.1030)); p += dot(p, p.yx + 33.33); return fract((p.x + p.y) * p.y); }
float en(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(eh(i), eh(i + vec2(1.0, 0.0)), u.x), mix(eh(i + vec2(0.0, 1.0)), eh(i + vec2(1.0, 1.0)), u.x), u.y);
}
void main() {
  float r2 = dot(vP, vP);
  if (r2 > 1.0) discard;
  vec3 n = vec3(vP, sqrt(1.0 - r2));
  float d = dot(n, normalize(uL));
  float day = smoothstep(-0.10, 0.20, d);
  vec2 q = n.xy / (0.6 + n.z) * 2.2;
  float land = smoothstep(0.56, 0.70, en(q * 1.3 + 4.1));
  float cloud = smoothstep(0.50, 0.78, 0.6 * en(q * 2.1 + vec2(9.3, 1.7)) + 0.4 * en(q * 5.3 + 2.9));
  vec3 col = mix(vec3(0.050, 0.170, 0.420), vec3(0.200, 0.260, 0.160), land);
  col = mix(col, vec3(0.900, 0.920, 0.950), cloud);
  col *= day * (0.45 + 0.75 * max(d, 0.0));
  col += vec3(0.180, 0.380, 0.850) * pow(1.0 - n.z, 2.5) * day * 0.9;   // atmosphere at the limb
  col += vec3(0.002, 0.003, 0.006);                                        // night side
  gl_FragColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
}
`;
