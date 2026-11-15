import { S_END, S_START, STEP_K, STEP_MAX, STEP_MIN, SUN_RADIUS_DEG } from './march';

const f = (v: number) => v.toFixed(6);
/** Block sizes (texels) of the max-height textures: two over the 20 m tile, one over the 240 m tile. */
export const BLOCK_HI = 16, BLOCK_MID = 64, BLOCK_LO = 16;

/**
 * Coordinates: "S" = Moon-fixed MOON_ME metres with z shifted by +R. Near the south pole x, y are small
 * and only z is ~ -R, so after the shift everything fits float32 with millimetre resolution, and the ray
 * height |Q| - R is evaluated without cancellation as (x^2 + y^2 + 2Rw + w^2) / (|Q| + R), w = -S.z.
 * sunFraction() mirrors sunFractionAt() in march.ts: same samples, same exits. Two things only make it
 * faster without changing which samples can matter: block-maximum textures let it pass over stretches of
 * the schedule where the ray is provably too far above all terrain to lower the result, and beyond 500 m
 * the height lookup may use hardware bilinear filtering (when float filtering exists) instead of 4 fetches.
 */
const MARCH_GLSL = /* glsl */ `
precision highp float;
precision highp sampler2D;
uniform sampler2D uHi, uLo;     // heights in metres above R, R32F
uniform vec4 uHiGeo, uLoGeo;    // x0, y0, px, w - 1 (square tiles)
uniform sampler2D uMaxHi, uMaxMid, uMaxLo;         // max height per block, dilated by one block
uniform vec4 uMaxHiGeo, uMaxMidGeo, uMaxLoGeo;     // x0, y0, block size (m), n - 1
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
// Stereographic (x, y) + height -> S.
vec3 posS(vec2 xy, float h) {
  float r2 = dot(xy, xy), d = 4.0 * R * R + r2;
  float k = (R + h) * 4.0 * R / d;
  return vec3(k * xy.y, k * xy.x, (R + h) * 2.0 * r2 / d - h);
}
vec3 normalAt(vec2 xy, float d) {
  vec2 ex = vec2(d, 0.0), ey = vec2(0.0, d);
  vec3 a = posS(xy + ex, heightAt(xy + ex)) - posS(xy - ex, heightAt(xy - ex));
  vec3 b = posS(xy + ey, heightAt(xy + ey)) - posS(xy - ey, heightAt(xy - ey));
  vec3 n = normalize(cross(a, b));
  return n.z > 0.0 ? -n : n;   // outward is -z at the south pole
}
float sunFraction(vec3 P) {
  float minC = 1.0e9, s = ${f(S_START)};
  for (int i = 0; i < 900; i++) {
    if (s > ${f(S_END)}) break;
    vec3 q = P + s * uSun;
    float w = -q.z, xy2 = dot(q.xy, q.xy);
    float rr = sqrt(xy2 + (R + w) * (R + w));               // |Q|
    float rayH = (xy2 + 2.0 * R * w + w * w) / (rr + R);     // |Q| - R
    if ((rayH - uHMax) / s >= min(minC, SUN_TAN)) break;     // nothing further out can matter
    vec2 xy = (2.0 * R / (rr + R + w)) * q.yx;
    // Skip: if even the lowest the ray gets over the next L metres (it is convex in s, so its tangent
    // bounds it) clears the highest terrain there by the current threshold, those samples cannot matter.
    float thr = min(minC, SUN_TAN);
    float slope = min(0.0, (dot(q.xy, uSun.xy) + (q.z - R) * uSun.z) / rr);
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
attribute vec2 xy;          // stereographic metres relative to uXY0
varying vec2 vXY;
void main() {
  vXY = xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SHADE_GLSL = MARCH_GLSL + /* glsl */ `
uniform vec2 uXY0;
uniform vec3 uCam;          // S
uniform float uExposure, uAmbient;
vec4 shade(vec2 xy) {
  // Shade the true surface under this pixel, not the decimated mesh: the march then starts exactly
  // on the height field it tests against (no acne) and matches the CPU reference.
  vec3 P = posS(xy, heightAt(xy));
  vec3 n = normalAt(xy, inHi(xy, 1.0) ? uHiGeo.z : uLoGeo.z);
  float ci = dot(n, uSun);
  float ce = max(dot(n, normalize(uCam - P)), 0.0);
  float lit = 0.0;
  if (ci > 0.0) lit = sunFraction(P) * mix(ci, 2.0 * ci / (ci + max(ce, 0.12)), 0.5);  // Lambert / Lommel-Seeliger (emission floored: no blown-out limb in site view)
  float b = 1.0 - exp(-uExposure * lit);
  b += uAmbient * (0.2 + 0.8 * ce);
  return vec4(pow(vec3(b) * vec3(1.0, 0.985, 0.955), vec3(1.0 / 2.2)), 1.0);
}
`;

/** Forward path (no float render targets): march in the terrain's own fragment shader, after a depth pre-pass. */
export const TERRAIN_FRAG = SHADE_GLSL + /* glsl */ `
varying vec2 vXY;
void main() { gl_FragColor = shade(vXY + uXY0); }
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
  gl_FragColor = shade(g.rg + uXY0);
}
`;

/** Sun fraction at one stereographic point, packed into RG (16 bit), for the GPU-vs-CPU self-check. */
export const PROBE_FRAG = MARCH_GLSL + /* glsl */ `
uniform vec2 uProbe;
void main() {
  float v = sunFraction(posS(uProbe, heightAt(uProbe))) * 65535.0;
  float hi = floor(v / 256.0);
  gl_FragColor = vec4(hi / 255.0, (v - hi * 256.0) / 255.0, 0.0, 1.0);
}
`;
