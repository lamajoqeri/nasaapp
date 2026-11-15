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

const SHADE_GLSL = MARCH_GLSL + /* glsl */ `
uniform vec3 uCam;          // relative to C
uniform float uExposure, uAmbient;
uniform vec3 uEarth;        // unit, towards Earth
uniform float uEarthshine;  // 0 when Earth is below the local horizon
uniform float uPix;         // radians per CSS pixel (not per buffer pixel: the texture must not change with resolution)

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
// COSMETIC: procedural regolith micro-relief for the near field, where the 20 m DEM is featureless at
// human scale. It tilts the SHADING normal only: no geometry, no effect on the shadow march or on any
// reported number. Deterministic in ground coordinates; each octave fades out before it would alias.
vec2 microSlope(vec2 rel, float dist, float ce) {
  float near = 1.0 - smoothstep(60.0, 320.0, dist);
  if (near <= 0.0) return vec2(0.0);
  float foot = dist * uPix / max(ce, 0.06);     // ground metres under one pixel
  vec2 g = vec2(0.0);
  float L = 1.3, a = 0.6;                       // wavelength (metres) and weight of the octave
  mat2 rot = mat2(0.8, -0.6, 0.6, 0.8);
  vec2 p = rel;
  for (int i = 0; i < 5; i++) {
    g += a * smoothstep(2.5 * foot, 7.0 * foot, L) * noiseGrad(p / L + float(i) * 17.3);
    L *= 0.45; a = min(1.0, a * 1.25);
    p = rot * p;
  }
  return near * g;
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
  float ci = dot(n, uSun);
  vec3 ns = n;                                  // shading normal
  vec2 m = microSlope(rel, dist, max(dot(n, v), 0.0));
  vec3 tx = normalize(vec3(0.0, 1.0, 0.0) - n * n.y), ty = normalize(vec3(1.0, 0.0, 0.0) - n * n.x); // ground directions of map x, y
  if (m != vec2(0.0)) ns = normalize(n - 0.05 * (m.x * tx + m.y * ty));
  float ce = max(dot(ns, v), 0.0);
  float lit = 0.0;
  if (ci > 0.0) {                               // geometric normal decides; the march never sees the micro-relief
    lit = sunFraction(P) * mix(ci, 2.0 * ci / (ci + max(ce, 0.12)), 0.5);  // Lambert / Lommel-Seeliger (emission floored: no blown-out limb in site view)
    // Micro-relief: at grazing Sun any slope would swamp cos(i), so it only modulates the sunlit term
    // (brighter facing the Sun, darker facing away, +-30 % at most) and never switches it off.
    vec2 sd = vec2(dot(uSun, tx), dot(uSun, ty));
    lit *= 1.0 + 0.3 * clamp(-0.55 * dot(m, normalize(sd + 1.0e-6)), -1.0, 1.0);
  }
  float b = 1.0 - exp(-uExposure * lit);
  b += uAmbient * (0.2 + 0.8 * ce);
  // Earthshine: faint, not shadow-tested (cosmetic), only so the ground reads when the Sun is down.
  float es = uEarthshine * smoothstep(-0.08, 0.3, dot(ns, uEarth));
  vec3 c = vec3(b) * vec3(1.0, 0.985, 0.955) + es * vec3(0.72, 0.84, 1.0);
  return vec4(pow(c, vec3(1.0 / 2.2)), 1.0);
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
