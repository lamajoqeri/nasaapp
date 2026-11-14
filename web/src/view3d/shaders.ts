// GLSL for the terrain view. Geometry follows CONTRACT.md: positions are Moon-fixed (MOON_ME) metres,
// relative to the tile centre uC; heights are |P| - R; DEM lookups go through south-polar stereographic xy.

export const vert = /* glsl */ `
out vec3 vP;
void main() {
  vP = position;
#ifdef PROBE
  gl_PointSize = 1.0;
  gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
#else
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
#endif
}`;

export const frag = /* glsl */ `
precision highp float;
precision highp sampler2D;
in vec3 vP;
layout(location = 0) out vec4 outColor;
uniform sampler2D uT20, uT240;   // R32F heights in metres above R
uniform sampler2D uM20, uM240;   // dilated block-max heights, uB = block size in pixels
uniform vec2 uB;
uniform vec4 uG20, uG240;        // x0, y0, px, w (square tiles; x0/y0 = centre of pixel (0,0), row 0 = max y)
uniform vec3 uC;                 // tile centre, Moon-fixed metres
uniform float uRc, uRcR;         // |uC| and |uC| - R
uniform vec3 uSun;               // unit vector to the Sun, Moon-fixed
uniform float uSunR;             // Sun angular radius, rad
uniform float uMaxH;             // highest terrain in either texture
uniform float uSteps, uGrow;     // march step clamp(uGrow * t, 10, 12000 * uGrow), at most uSteps steps
uniform float uExposure;
uniform vec3 uSite;              // site marker (relative coords); uMark = 0 hides it
uniform float uMark;
const float R2 = 3474800.0;      // 2R
const float RM = 1737400.0;

bool inTile(vec4 g, vec2 xy, out vec2 cr) {
  cr = vec2((xy.x - g.x) / g.z, (g.y - xy.y) / g.z);
  return cr.x >= 0.0 && cr.y >= 0.0 && cr.x <= g.w - 1.0 && cr.y <= g.w - 1.0;
}
// Manual bilinear: R32F is not filterable everywhere.
float bil(sampler2D t, vec2 cr, float w) {
  vec2 c0 = min(floor(cr), vec2(w - 2.0));
  vec2 f = cr - c0;
  ivec2 i = ivec2(c0);
  float a = texelFetch(t, i, 0).r, b = texelFetch(t, i + ivec2(1, 0), 0).r;
  float c = texelFetch(t, i + ivec2(0, 1), 0).r, d = texelFetch(t, i + ivec2(1, 1), 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
// First containing tile wins, as core/dem.ts (20 m, then 240 m).
float H(vec2 xy) {
  vec2 cr;
  if (inTile(uG20, xy, cr)) return bil(uT20, cr, uG20.w);
  if (inTile(uG240, xy, cr)) return bil(uT240, cr, uG240.w);
  return -1e5;
}
// Upper bound of the terrain within one block length of xy, and that length (m).
vec2 Hmax(vec2 xy) {
  vec2 cr, cr2;
  bool in2 = inTile(uG240, xy, cr2);
  float m240 = in2 ? texelFetch(uM240, ivec2(cr2 / uB.y), 0).r : -1e5;
  if (inTile(uG20, xy, cr)) return vec2(max(texelFetch(uM20, ivec2(cr / uB.x), 0).r, m240), uB.x * uG20.z);
  return vec2(m240, in2 ? uB.y * uG240.z : 1e4);
}
// spstere forward without trig: x = 2R py/(1-pz), y = 2R px/(1-pz); |P|-Pz avoids normalising.
vec2 toXY(vec3 P, float L) { return R2 * vec2(P.y, P.x) / (L - P.z); }
// |uC + q| - R without float32 cancellation.
float hAbove(vec3 q, float L) { return uRcR + (2.0 * dot(uC, q) + dot(q, q)) / (L + uRc); }

// Smallest angle (rad) between the Sun ray from o and the terrain under it; negative = terrain above the ray.
float march(vec3 o) {
  float minA = 1.0, t = 0.0, dt = 10.0;
  for (int k = 0; k < 2048; k++) {
    if (float(k) >= uSteps || t > 3e5) break;
    t += dt;
    vec3 q = o + uSun * t;
    vec3 P = uC + q;
    float L = length(P);
    float hq = hAbove(q, L);
    float slack = t * uSunR;                     // terrain this far below the ray cannot touch the disk
    if (hq - uMaxH > slack) break;
    vec2 xy = toXY(P, L);
    float d = hq - H(xy);
    float c = dot(P / L, uSun);
    minA = min(minA, atan(d * sqrt(max(1.0 - c * c, 0.0)), t - d * c));
    if (minA < -uSunR) break;                    // disk fully hidden
    dt = clamp(uGrow * t, 10.0, 12000.0 * uGrow);
    vec2 hm = Hmax(xy);
    if (hq - hm.x > slack + max(-c, 0.0) * hm.y) dt = max(dt, hm.y);   // neighbourhood below the ray: skip a block
  }
  return minA;
}
// Visible fraction of the Sun disk whose centre is a rad above the terrain (same formula as core frac()).
float diskFrac(float a) {
  float x = clamp(a / uSunR, -1.0, 1.0);
  return 1.0 - (acos(x) - x * sqrt(1.0 - x * x)) / 3.14159265;
}

vec3 normalAt(vec2 xy, float h) {
  vec2 cr;
  float d = inTile(uG20, xy, cr) ? uG20.z : uG240.z;
  float hx = (H(xy + vec2(d, 0.0)) - H(xy - vec2(d, 0.0))) / (2.0 * d);
  float hy = (H(xy + vec2(0.0, d)) - H(xy - vec2(0.0, d))) / (2.0 * d);
  // Inverse stereographic u(a,b), a = x/2R, b = y/2R, and its partials.
  vec2 ab = xy / R2;
  float q = dot(ab, ab), q1 = q + 1.0, k = 1.0 / (q1 * q1);
  vec3 u = vec3(2.0 * ab.y, 2.0 * ab.x, q - 1.0) / q1;
  vec3 ua = vec3(-4.0 * ab.x * ab.y, 2.0 * q1 - 4.0 * ab.x * ab.x, 4.0 * ab.x) * k;
  vec3 ub = vec3(2.0 * q1 - 4.0 * ab.y * ab.y, -4.0 * ab.x * ab.y, 4.0 * ab.y) * k;
  float s = (RM + h) / R2;
  vec3 n = normalize(cross(s * ua + hx * u, s * ub + hy * u));
  return dot(n, u) < 0.0 ? -n : n;
}

void main() {
#ifdef PROBE
  float a = march(vP);
  outColor = vec4(diskFrac(a), a, 0.0, 1.0);
#else
  vec3 P = uC + vP;
  float L = length(P);
  vec2 xy = toXY(P, L);
#ifdef FAR
  vec2 cr;
  if (inTile(vec4(uG20.x + 200.0, uG20.y - 200.0, uG20.z, uG20.w - 400.0 / uG20.z), xy, cr)) discard;
#endif
  float h = H(xy);
  vec3 n = normalAt(xy, h);
  float mu0 = dot(n, uSun);
  float lit = 0.0;
  if (mu0 > 0.0) lit = diskFrac(march(vP + (P / L) * (h - hAbove(vP, L) + 0.5)));
  float mu = max(dot(n, normalize(cameraPosition - vP)), 0.0);
  // Lommel-Seeliger + Lambert mix, typical for lunar regolith.
  float br = lit * (1.2 * mu0 / (mu0 + mu + 1e-4) + 0.4 * mu0);
  vec3 col = vec3(0.004) + vec3(1.0, 0.98, 0.94) * br * uExposure;
  if (uMark > 0.0 && distance(vP, uSite) < max(25.0, 0.008 * distance(cameraPosition, uSite))) col = vec3(1.0, 0.25, 0.2);
  outColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
#endif
}`;
