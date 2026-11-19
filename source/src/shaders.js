// ============================================================================
// WGSL sources
// ============================================================================

const W_NOISE = /*wgsl*/`
fn ss(a: f32, b: f32, x: f32) -> f32 { let t = clamp((x - a) / (b - a), 0., 1.); return t * t * (3. - 2. * t); }
fn h31(p: vec3f) -> f32 { var q = fract(p * vec3f(.1031, .1030, .0973)); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
fn h33(p: vec3f) -> vec3f { var q = fract(p * vec3f(.1031, .1030, .0973)); q += dot(q, q.yxz + 33.33); return fract((q.xxy + q.yxx) * q.zyx); }
fn vn(p: vec3f) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3. - 2. * f);
  return mix(mix(mix(h31(i), h31(i + vec3f(1., 0., 0.)), u.x), mix(h31(i + vec3f(0., 1., 0.)), h31(i + vec3f(1., 1., 0.)), u.x), u.y),
             mix(mix(h31(i + vec3f(0., 0., 1.)), h31(i + vec3f(1., 0., 1.)), u.x), mix(h31(i + vec3f(0., 1., 1.)), h31(i + vec3f(1., 1., 1.)), u.x), u.y), u.z);
}
fn fbm(p: vec3f, n: i32) -> f32 {
  var a = .5; var s = 0.; var q = p;
  for (var i = 0; i < n; i++) { s += a * vn(q); q = q * 2.03 + vec3f(17.1, 31.7, 5.3); a *= .5; }
  return s / (1. - 2. * a);
}
fn wor(p: vec3f) -> f32 {
  let i = floor(p); let f = fract(p); var d = 9.;
  for (var x = -1; x <= 1; x++) { for (var y = -1; y <= 1; y++) { for (var z = -1; z <= 1; z++) {
    let o = vec3f(f32(x), f32(y), f32(z)); let r = o + h33(i + o) - f; d = min(d, dot(r, r));
  } } }
  return sqrt(d);
}
`;

// ---------------------------------------------------------------- terrain density (compute)
const W_DENS = W_NOISE + /*wgsl*/`
struct U { n: vec4u, o: vec4f, c: vec4u };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read_write> D: array<f32>;
@group(0) @binding(2) var<storage, read> P: array<vec4f>;
fn smax(a: f32, b: f32, k: f32) -> f32 { let h = max(k - abs(a - b), 0.) / k; return max(a, b) + h * h * k * .25; }
fn smin(a: f32, b: f32, k: f32) -> f32 { return -smax(-a, -b, k); }
fn seg2(p: vec2f, a: vec2f, b: vec2f) -> f32 { let pa = p - a; let ba = b - a; let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0., 1.); return length(pa - ba * h); }
fn seg3(p: vec3f, a: vec3f, b: vec3f) -> f32 { let pa = p - a; let ba = b - a; let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0., 1.); return length(pa - ba * h); }
fn dens(p: vec3f) -> f32 {
  let w = vec3f(fbm(p * .04 + 11., 3), fbm(p * .04 + 47., 3), fbm(p * .04 + 83., 3)) - .5;
  let q = p + w * vec3f(15., 6., 15.);
  let g0 = -45.5 + 7. * (fbm(vec3f(q.xz * .011, 3.), 4) - .5) + 1.6 * (fbm(vec3f(q.xz * .07, 9.), 3) - .5);
  let tn = 3. * (fbm(vec3f(q.xz * .09, 2.), 3) - .5);
  var dm = -1e3; var de = 1e3;
  var k = 0u;
  for (var i = 0u; i < u.c.x; i++) {
    let a = P[k]; let b = P[k + 1u]; k += 2u;
    let yr = clamp((p.y - g0) / (b.y - g0), 0., 1.3);
    var e = seg2(q.xz, a.xy, a.zw) - b.x;
    e -= b.z * ss(.3, .92, yr) + 3. * (1. - yr) * (1. - yr) - b.w * ss(.0, .5, yr) * (1. - ss(.5, 1., yr));
    dm = smax(dm, smin(-e, b.y + tn - p.y, 3.), 2.5);
    de = min(de, e);
  }
  var clr = 0.;
  let kc = (u.c.x + u.c.y + u.c.z) * 2u;
  for (var i = 0u; i < u.c.w; i++) {
    let a = P[kc + i * 2u]; let b = P[kc + i * 2u + 1u];
    clr = max(clr, 1. - ss(0., b.y, seg2(q.xz, a.xy, a.zw) - b.x));
  }
  let rad = length(p.xz) + w.x * 14.;
  let n = fbm(vec3f(q.xz * .0125, 1.7), 4);
  let ring = ss(156., 172., rad);
  let plat = max(ss(.5, .565, n) * (1. - clr), ring);
  let th = g0 + plat * mix(26. + 17. * fbm(vec3f(q.xz * .03, 5.), 2), 60., ring);
  var d = smax(g0 + 4.5 * ss(10., 0., de) - p.y, dm, 3.);
  d = smax(d, (th - p.y) * .7, 3.);
  k = u.c.x * 2u;
  for (var i = 0u; i < u.c.y; i++) {
    let a = P[k]; let b = P[k + 1u]; k += 2u;
    var r = p + w * 3. - a.xyz;
    let cs = cos(a.w); let sn = sin(a.w);
    r = vec3f(cs * r.x + sn * r.z, r.y / b.z, -sn * r.x + cs * r.z);
    d = smax(d, b.y - length(vec2f(length(r.xy) - b.x, r.z)), 1.5);
  }
  let hg = p.y - g0;
  let rk = mix(.25, 1., ss(.5, 5., hg));
  d += rk * ((.5 - wor(p * .17 + w * 2.)) * 3.4 + (.5 - wor(p * .41 + 7.)) * 1.3 + (fbm(p * .3, 3) - .5) * 2.2);
  d += rk * 2.2 * (abs(fract(p.y * .21 + w.y * 2.2) - .5) - .25);
  for (var i = 0u; i < u.c.z; i++) {
    let a = P[k]; let b = P[k + 1u]; k += 2u;
    d = smin(d, seg3(p + w * 2., a.xyz, b.xyz) - a.w, 2.);
  }
  return min(d, 3. - p.y);
}
@compute @workgroup_size(4, 4, 4) fn main(@builtin(global_invocation_id) id: vec3u) {
  let g = vec3u(id.x, id.y, id.z + u.n.w); // u.n.w: the slab's first z-slice; D holds only the slab
  if (any(g >= u.n.xyz)) { return; }
  var d = dens(u.o.xyz + vec3f(g) * u.o.w);
  if (g.x == 0u || g.z == 0u || g.x == u.n.x - 1u || g.z == u.n.z - 1u || g.y == u.n.y - 1u) { d = -1.; }
  D[id.x + u.n.x * (id.y + u.n.y * id.z)] = d;
}
`;

// ---------------------------------------------------------------- fullscreen helpers
const W_FS = /*wgsl*/`
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return vec4f(f32(i32(i & 1u) * 4 - 1), f32(i32(i >> 1u) * 4 - 1), 0., 1.); }
`;

// rock detail texture (tileable): rg = slope, b = height, a = mottling
const W_DETAIL = W_NOISE + W_FS + /*wgsl*/`
fn hp(p: vec2f, per: f32) -> f32 { return h31(vec3f(p - per * floor(p / per), per)); }
fn tn(p: vec2f, per: f32) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3. - 2. * f);
  return mix(mix(hp(i, per), hp(i + vec2f(1., 0.), per), u.x), mix(hp(i + vec2f(0., 1.), per), hp(i + vec2f(1., 1.), per), u.x), u.y);
}
fn tf(uv: vec2f, per: f32, n: i32) -> f32 { var a = .5; var s = 0.; var pr = per; for (var i = 0; i < n; i++) { s += a * tn(uv * pr + f32(i) * 7.3, pr); pr *= 2.; a *= .5; } return s / (1. - 2. * a); }
fn tw(p: vec2f, per: f32) -> vec3f {
  let i = floor(p); let f = fract(p); var d = vec2f(9.); var id = 0.;
  for (var x = -1; x <= 1; x++) { for (var y = -1; y <= 1; y++) {
    let o = vec2f(f32(x), f32(y)); let c = i + o; let cw = c - per * floor(c / per);
    let hh = h33(vec3f(cw, per)); let r = o + hh.xy - f; let l = dot(r, r);
    if (l < d.x) { d.y = d.x; d.x = l; id = hh.z; } else if (l < d.y) { d.y = l; }
  } }
  return vec3f(sqrt(d), id);
}
fn H(uv: vec2f) -> f32 {
  let wq = uv + .11 * (vec2f(tf(uv, 3., 4), tf(uv + .5, 3., 4)) - .5);
  let f = tf(wq, 3., 8);
  let r1 = 1. - abs(tf(wq + 1.7, 5., 6) * 2. - 1.);
  let cr = min(abs(tf(wq + 4.1, 4., 5) * 2. - 1.) * 7., 1.);
  let cr2 = min(abs(tf(wq.yx + 2.3, 9., 4) * 2. - 1.) * 9., 1.);
  let pt = tw(wq * 29., 29.);
  let pit = (1. - ss(.0, .34, pt.x)) * step(.62, pt.z);
  return f * .50 + r1 * r1 * .24 + cr * cr2 * .26 - pit * .07;
}
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = fc.xy / 1024.; let e = 1. / 1024.;
  let h = H(uv);
  let gx = H(uv + vec2f(e, 0.)) - H(uv - vec2f(e, 0.)); let gy = H(uv + vec2f(0., e)) - H(uv - vec2f(0., e));
  let s = clamp(vec2f(gx, gy) * 1024. * .5 * .075, vec2f(-1.), vec2f(1.));
  return vec4f(-s * .5 + .5, h, tf(uv + 3.7, 3., 5));
}
`;

// blit / mip / bloom chain
const W_BLIT = W_FS + /*wgsl*/`
@group(0) @binding(0) var t: texture_2d<f32>;
@group(0) @binding(1) var s: sampler;
fn uvOf(fc: vec4f, k: f32) -> vec2f { return fc.xy * k / vec2f(textureDimensions(t)); }
@fragment fn fsMip(@builtin(position) fc: vec4f) -> @location(0) vec4f { return textureSampleLevel(t, s, uvOf(fc, 2.), 0.); }
fn kar(c: vec3f) -> vec4f { let w = 1. / (1. + max(c.r, max(c.g, c.b))); return vec4f(c * w, w); }
@fragment fn fsDown0(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = uvOf(fc, 2.); let e = 1. / vec2f(textureDimensions(t));
  let a = kar(min(textureSampleLevel(t, s, uv + e * vec2f(-1., -1.), 0.).rgb, vec3f(24.)));
  let b = kar(min(textureSampleLevel(t, s, uv + e * vec2f(1., -1.), 0.).rgb, vec3f(24.)));
  let c = kar(min(textureSampleLevel(t, s, uv + e * vec2f(-1., 1.), 0.).rgb, vec3f(24.)));
  let d = kar(min(textureSampleLevel(t, s, uv + e * vec2f(1., 1.), 0.).rgb, vec3f(24.)));
  let m = a + b + c + d;
  return vec4f(m.rgb / m.a, 1.);
}
@fragment fn fsDown(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = uvOf(fc, 2.); let e = 1. / vec2f(textureDimensions(t));
  return (textureSampleLevel(t, s, uv + e * vec2f(-1., -1.), 0.) + textureSampleLevel(t, s, uv + e * vec2f(1., -1.), 0.)
        + textureSampleLevel(t, s, uv + e * vec2f(-1., 1.), 0.) + textureSampleLevel(t, s, uv + e * vec2f(1., 1.), 0.)) * .25;
}
@fragment fn fsUp(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = uvOf(fc, .5); let e = .75 / vec2f(textureDimensions(t));
  return (textureSampleLevel(t, s, uv + e * vec2f(-1., -1.), 0.) + textureSampleLevel(t, s, uv + e * vec2f(1., -1.), 0.)
        + textureSampleLevel(t, s, uv + e * vec2f(-1., 1.), 0.) + textureSampleLevel(t, s, uv + e * vec2f(1., 1.), 0.)) * .25;
}
`;

// animated water texture: r = caustic, ba = surface slope
const W_WATER = W_FS + /*wgsl*/`
@group(0) @binding(0) var<uniform> tm: vec4f;
fn caus(uv: vec2f, t: f32) -> f32 {
  let p = uv * 6.2831853;
  var i = p; var c = 0.;
  for (var n = 1; n <= 5; n++) {
    let tt = t * (1. - 3.5 / f32(n));
    i = p + vec2f(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));
    let s = sin(i.x + tt); let k = cos(i.y + tt);
    c += abs(s * k) / (1.25 * sqrt(s * s + k * k) + 1e-4);
  }
  c = 1.17 - pow(c / 5., 1.4);
  return pow(abs(c), 8.);
}
const WK = array<vec3f, 10>(vec3f(1., 2., 1.), vec3f(-2., 1., .9), vec3f(3., 1., .6), vec3f(1., -4., .5), vec3f(4., 3., .4),
  vec3f(-3., 5., .32), vec3f(6., -2., .28), vec3f(5., 7., .2), vec3f(-8., 3., .18), vec3f(2., 11., .14));
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = fc.xy / ${WATER}.; let t = tm.x;
  let c = caus(uv, t * .45 + 23.);
  let wu = uv + .02 * vec2f(sin(6.2831853 * (uv.y * 2. + .1 * t)), cos(6.2831853 * (uv.x * 3. - .07 * t)));
  var s = vec2f(0.);
  for (var i = 0; i < 10; i++) {
    let k = WK[i];
    s += k.xy * k.z * cos(dot(k.xy, wu) * 6.2831853 + t * (.5 + .35 * sqrt(length(k.xy))) * select(-1., 1., (i & 1) == 0) + f32(i) * 1.7);
  }
  return vec4f(c, c, s * .06);
}
`;

// ---------------------------------------------------------------- shared scene code
const S_G = /*wgsl*/`
// jit: xy this frame's sub-pixel jitter (NDC), z 1 = history invalid, w temporal noise offset; pvp: last frame's
// view-projection without jitter
struct G { vp: mat4x4f, sm: mat4x4f, cam: vec4f, right: vec4f, up: vec4f, fwd: vec4f, sun: vec4f, res: vec4f, mis: vec4f, jit: vec4f, pvp: mat4x4f };
const SIG = vec3f(.058, .0235, .0195);
const KD = vec3f(.056, .0245, .0170);
const WCOL = vec3f(.16, .58, .90);
const KDZ = vec3f(.034, .023, .018);
const PCOL = vec3f(.58, .66, .98);
const SUNC = vec3f(1.7, 1.6, 1.45);
const TAU = 6.2831853;
const LOW = ${LV > 1};
fn sat(x: f32) -> f32 { return clamp(x, 0., 1.); }
fn ss(a: f32, b: f32, x: f32) -> f32 { let t = clamp((x - a) / (b - a), 0., 1.); return t * t * (3. - 2. * t); }
fn ign(p: vec2f) -> f32 { return fract(52.9829189 * fract(dot(p, vec2f(.06711056, .00583715)))); }
fn hs(x: f32) -> f32 { return fract(sin(x * 127.1) * 43758.5453); }
fn kd(z: f32) -> vec3f { return mix(KD, KDZ, z); }
fn sg(z: f32) -> vec3f { return mix(SIG, vec3f(.034, .026, .022), z); }
fn fin(c: vec3f) -> vec4f { return vec4f(min(max(c, vec3f(0.)), vec3f(40.)), 1.); }
const KDF = vec3f(.043, .045, .042);
fn fogIn(ro: vec3f, rd: vec3f, d: f32, z: f32, sun: vec3f) -> vec3f {
  let k = mix(KD, KDF, z);
  let a = sg(z) - k * rd.y;
  let I = (1. - exp(-a * d)) / a;
  let mu = max(dot(rd, sun), 0.);
  let m2 = mu * mu;
  return mix(WCOL, PCOL, z) * sg(z) * exp(k * ro.y) * I * (1.22 + .3 * m2 * m2);
}
`;

const S_B = S_G + /*wgsl*/`
@group(0) @binding(0) var<uniform> g: G;
@group(0) @binding(1) var sR: sampler;
@group(0) @binding(2) var sC: sampler;
@group(0) @binding(3) var sS: sampler_comparison;
@group(0) @binding(4) var tSh: texture_depth_2d;
@group(0) @binding(5) var tW: texture_2d<f32>;
@group(0) @binding(6) var tD: texture_2d<f32>;
@group(0) @binding(7) var tV: texture_3d<f32>;
@group(0) @binding(8) var tM: texture_2d<f32>;
fn shUV(p: vec3f) -> vec3f { let s = g.sm * vec4f(p, 1.); return vec3f(s.x * .5 + .5, .5 - s.y * .5, s.z - .0007); }
fn shadow1(p: vec3f) -> f32 { let s = shUV(p); return textureSampleCompareLevel(tSh, sS, s.xy, s.z); }
fn shadow4(p: vec3f) -> f32 {
  let s = shUV(p); let e = 1.8 / ${SHADOW}.;
  return (textureSampleCompareLevel(tSh, sS, s.xy + vec2f(-e, -e), s.z) + textureSampleCompareLevel(tSh, sS, s.xy + vec2f(e, -e), s.z)
        + textureSampleCompareLevel(tSh, sS, s.xy + vec2f(-e, e), s.z) + textureSampleCompareLevel(tSh, sS, s.xy + vec2f(e, e), s.z)) * .25;
}
fn shadow9(p: vec3f) -> f32 {
  if (LOW) { return shadow1(p); }
  let s = shUV(p); let e = 2.1 / ${SHADOW}.; var a = 0.;
  for (var x = -1; x <= 1; x++) { for (var y = -1; y <= 1; y++) { a += textureSampleCompareLevel(tSh, sS, s.xy + vec2f(f32(x), f32(y)) * e, s.z); } }
  return a / 9.;
}
fn cuv(p: vec3f) -> vec2f { return p.xz - g.sun.xz * (p.y / g.sun.y); }
// the scene is shaded in a full-screen pass (visibility buffer), so texture lookups get their gradients explicitly
fn tg(t: texture_2d<f32>, uv: vec2f, dx: vec2f, dy: vec2f) -> vec4f { return textureSampleGrad(t, sR, uv, dx, dy); }
fn caus(p: vec3f, d: f32, px: vec3f, py: vec3f) -> vec3f {
  let q = cuv(p); let qx = cuv(px) / 3.3; let qy = cuv(py) / 3.3;
  let o = vec2f(.004, .0025);
  let a = vec3f(tg(tW, q / 3.3 + o, qx, qy).r, tg(tW, q / 3.3, qx, qy).r, tg(tW, q / 3.3 - o, qx, qy).r);
  let b = tg(tW, q.yx / 6.9 + .37, cuv(px).yx / 6.9, cuv(py).yx / 6.9).r;
  let c = min(pow(a, vec3f(2.3)) * 5. * (.45 + b * 1.3), vec3f(4.));
  return mix(c, vec3f(.33), ss(35., 100., d));
}
fn caus2(p: vec3f, d: f32, px: vec3f, py: vec3f) -> f32 {
  let q = cuv(p); let qx = cuv(px); let qy = cuv(py);
  let c = min(pow(tg(tW, q / 4.1, qx / 4.1, qy / 4.1).r, 1.4) * 2.6 * (.45 + tg(tW, q.yx / 6.9 + .37, qx.yx / 6.9, qy.yx / 6.9).r * 1.3), 2.6);
  return mix(c, .33, ss(35., 100., d));
}
fn sunE(y: f32, z: f32) -> vec3f { return SUNC * exp(kd(z) * (min(y, 0.) / g.sun.y)) * (.5 + .5 * sat(-y / 30.)); }
fn vol(p: vec3f) -> vec4f { return textureSampleLevel(tV, sC, (p - vec3f(-192., -56., -192.)) / vec3f(384., 60., 384.), 0.); }
fn amb(p: vec3f, n: vec3f, sky: f32, z: f32) -> vec3f {
  let up = n.y * .5 + .5;
  return mix(vec3f(.22, .60, .80), vec3f(.34, .56, .82), z) * exp(kd(z) * min(p.y, 0.) * 1.2) * (.3 + .7 * sky) * (.24 + .76 * up * up) * 1.3 * (.55 + .45 * sat(-p.y / 30.)) + vec3f(.003, .010, .016);
}
fn zone(p: vec3f) -> f32 { return mix(g.sun.w, textureSampleLevel(tM, sC, p.xz / 384. + .5, 0.).b, .2); }
fn side(p: vec3f, n: vec3f, open: f32, z: f32) -> vec3f { return mix(WCOL, PCOL, z) * exp(kd(z) * min(p.y, 0.)) * open * (1. - abs(n.y)) * .7; }
// skylight at most 150 m along the ray: past that, terrain and the background behind it (vsB) get the same haze
fn fog(c: vec3f, wp: vec3f, z: f32) -> vec3f {
  let v = wp - g.cam.xyz; let d = length(v); let rd = v / d;
  return c * exp(-sg(z) * d) * ss(230., 185., d) + fogIn(g.cam.xyz, rd, d, z, g.sun.xyz) * (.58 + .42 * vol(g.cam.xyz + rd * min(d, 150.)).g);
}
fn qrot(q: vec4f, v: vec3f) -> vec3f { return v + 2. * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
`;

// ---------------------------------------------------------------- solid meshes (terrain, rocks, set pieces, sponges, coral)
// solidV places a vertex of an instance (a: position + scale, b: rotation, c: material, seed, texture scale, bob),
// shadeSolid lights a point of the surface
const S_SOLID = /*wgsl*/`
struct SA { wp: vec3f, n: vec3f, op: vec3f, on: vec3f, ao: f32 };
fn solidV(p: vec3f, nr: vec4f, a: vec4f, b: vec4f, c: vec4f) -> SA {
  var o: SA;
  var sc = a.w;
  if (c.x < 1.5 && c.z > 1.5 && g.res.x > 0.) { sc *= 1. - ss(c.z * .7, c.z, distance(a.xyz, g.cam.xyz) / g.mis.z); }
  var w = a.xyz + qrot(b, p * sc);
  w.y += sin(g.cam.w * .3 + c.y * 40.) * c.w;
  o.wp = w; o.n = qrot(b, nr.xyz); o.op = p * a.w + c.y * 37.; o.on = nr.xyz; o.ao = nr.w;
  return o;
}
struct TP { h: f32, c: f32, n: vec3f };
fn tri(p: vec3f, n: vec3f, s: f32, px: vec3f, py: vec3f) -> TP {
  var w = pow(abs(n), vec3f(4.)); w /= (w.x + w.y + w.z);
  let x = tg(tD, p.zy * s, px.zy * s, py.zy * s); let y = tg(tD, p.xz * s, px.xz * s, py.xz * s); let z = tg(tD, p.xy * s, px.xy * s, py.xy * s);
  var o: TP;
  o.h = x.b * w.x + y.b * w.y + z.b * w.z;
  o.c = x.a * w.x + y.a * w.y + z.a * w.z;
  let a = x.rg * 2. - 1.; let b = y.rg * 2. - 1.; let c = z.rg * 2. - 1.;
  o.n = vec3f(0., a.y, a.x) * w.x + vec3f(b.x, 0., b.y) * w.y + vec3f(c.x, c.y, 0.) * w.z;
  return o;
}
// i: the surface point, m: the instance's c, q: its rotation, ff: front facing, ox/oy and wx/wy: change of op and wp per pixel
fn shadeSolid(i: SA, m: vec4f, q: vec4f, ff: bool, ox: vec3f, oy: vec3f, wx: vec3f, wy: vec3f) -> vec4f {
  let mat = i32(m.x + .5); let sd = m.y; let fl_ = select(-1., 1., ff);
  let on = normalize(i.on) * fl_; let n0 = normalize(i.n) * fl_;
  let dist = length(i.wp - g.cam.xyz);
  let ts = select(1., m.z, mat >= 2);
  let A = tri(i.op, on, .1 * ts, ox, oy); let B = tri(i.op, on, .43 * ts, ox, oy); let C = tri(i.op, on, 1.9 * ts, ox, oy); let fk = ss(10., 1.5, dist) * f32(mat <= 1);
  var F: TP; if (fk > 0.) { F = tri(i.op, on, 6.7 * ts, ox, oy); } // the finest rock detail only up close
  let big = tg(tD, i.op.xz * .013 + i.op.y * .021, ox.xz * .013 + ox.y * .021, oy.xz * .013 + oy.y * .021).a;
  let big2 = tg(tD, i.op.zx * .031 + i.op.y * .043 + .37, ox.zx * .031 + ox.y * .043, oy.zx * .031 + oy.y * .043).a;
  var sgro = 0.;
  let gm = textureSampleLevel(tM, sC, i.wp.xz / 384. + .5, 0.);
  let ca = caus(i.wp, dist, wx, wy);
  let hgt = A.h * .5 + B.h * .35 + C.h * .15;
  var bump = 1.7; var gloss = .1; var alb = vec3f(0.); var emi = vec3f(0.); var vao = 1.; var flu = 0.;
  let flt = ss(.72, .93, n0.y);
  if (mat <= 1) {
    // layered rock: grey / olive / brown beds, warm encrustation patches, algae on up-facing parts
    let st = i.op.y * .55 + A.h * 1.6 + big * 5. + big2 * 3.;
    let bed = hs(floor(st)); let sf = fract(st);
    alb = mix(vec3f(.11, .12, .13), vec3f(.33, .30, .25), sat(A.c * 1.5 - .25));
    alb = mix(alb, mix(vec3f(.26, .19, .10), vec3f(.20, .22, .14), bed), ss(.42, .66, big) * .7);
    alb *= mix(.72, 1.15, bed) * (1. - .45 * ss(.12, .0, sf) * (1. - abs(on.y)));
    let enc = ss(.46, .6, big2 * .6 + B.c * .5) * ss(.3, .6, hgt);
    alb = mix(alb, mix(vec3f(.34, .07, .10), vec3f(.40, .25, .07), ss(.45, .6, A.c)) * (.5 + .8 * B.h), enc * .75);
    alb = mix(alb, vec3f(.50, .50, .46) * (.5 + .7 * C.h), ss(.60, .70, B.c * .6 + C.c * .5) * .5);
    let alg = ss(-.1, .6, n0.y) * ss(.3, .52, B.c * .55 + big * .5);
    alb = mix(alb, vec3f(.035, .14, .07), alg * .8);
    alb *= (.22 + 1.3 * hgt) * mix(1., .62 + .76 * F.h, fk);
    sgro = -ss(.14, .0, sf) * (1. - abs(on.y)) * 1.2;
    if (mat == 0) {
      alb = mix(alb, vec3f(.13, .15, .14) * (.55 + .6 * B.h), flt * gm.a * .7);
      let mg = flt * sat(gm.r * 1.5 - .45 + (B.c - .5) * 1.6) * ss(.35, .6, A.h) * ss(-34., -40., i.wp.y);
      alb = mix(alb, vec3f(.20, .02, .12) * (.4 + .9 * B.h), mg * .8);
      flu = mg * .35;
      alb = mix(alb, alb * vec3f(.85, .8, 1.4) + vec3f(.015, .0, .05), gm.b * .8);
    }
  } else if (mat == 2) {
    // whale fluke: smooth pale stone with dark streaks running along its length
    let sk = tg(tD, vec2f((i.op.x + i.op.z) * .33, i.op.y * .035), vec2f((ox.x + ox.z) * .33, ox.y * .035), vec2f((oy.x + oy.z) * .33, oy.y * .035));
    let sk2 = tg(tD, vec2f((i.op.x - i.op.z) * 1.1, i.op.y * .11), vec2f((ox.x - ox.z) * 1.1, ox.y * .11), vec2f((oy.x - oy.z) * 1.1, oy.y * .11));
    alb = mix(vec3f(.42, .47, .48), vec3f(.10, .13, .15), ss(.40, .62, sk.a * .6 + sk2.b * .5)) * (.75 + .3 * B.h);
    alb = mix(alb, vec3f(.60, .64, .62), ss(.62, .75, sk2.a) * .5);
    gloss = .9; bump = .3;
  } else if (mat == 3) {
    let Wd = tg(tD, vec2f(i.op.x * .06, (i.op.y + i.op.z) * .7), vec2f(ox.x * .06, (ox.y + ox.z) * .7), vec2f(oy.x * .06, (oy.y + oy.z) * .7));
    alb = mix(vec3f(.13, .085, .05), vec3f(.36, .25, .14), Wd.b) * (.6 + .5 * B.h);
    let pk = fract(atan2(i.op.z, 2. - i.op.y) * 7.);
    alb *= .35 + .65 * ss(0., .12, min(pk, 1. - pk));
    alb = mix(alb, vec3f(.08, .22, .16), ss(.5, .7, A.c) * .6);
    gloss = .2; bump = .7;
  } else if (mat == 4) {
    let hue = fract(sd * 7.31);
    alb = mix(vec3f(.60, .17, .08), vec3f(.64, .35, .10), fract(hue * 3.));
    if (hue > .75) { alb = vec3f(.44, .18, .42); }
    alb *= (.45 + .75 * B.h) * (.7 + .3 * C.h);
    vao = i.ao * i.ao; gloss = .2; bump = 1.4; flu = .55;
  } else {
    let hue = fract(sd * 5.73);
    alb = mix(vec3f(.80, .08, .10), vec3f(.90, .22, .40), fract(hue * 4.));
    if (hue > .7) { alb = vec3f(.88, .42, .10); }
    if (hue > .9) { alb = vec3f(.55, .22, .75); }
    alb *= (.4 + .8 * B.h) * (.5 + .9 * i.ao * i.ao);
    alb = mix(alb, vec3f(1., .75, .6), ss(.8, 1., i.ao) * .35);
    emi = alb * .01; flu = .75; gloss = .25; bump = 1.5;
  }
  let rip = select(0., flt * gm.a * cos((i.wp.x * .8 + i.wp.z * .35) * 5. + A.c * 9.) * .65, mat == 0);
  let N = normalize(qrot(q, normalize(on + (A.n * .85 + B.n * .65 + C.n * .45 * ss(60., 12., dist) + F.n * .5 * fk) * bump + vec3f(.8, sgro, .35) * vec3f(rip, 1., rip))));
  let L = g.sun.xyz; let V = normalize(g.cam.xyz - i.wp);
  let v1 = vol(i.wp + n0 * 1.5); let v2 = vol(i.wp + n0 * 4.5);
  let ao = (sat((v1.r - .5) * 8.) * .55 + sat((v2.r - .5) * 2.7) * .45) * vao * ss(.12, .6, hgt);
  let z = zone(i.wp);
  // shadow filtering: 9 taps up close, 4 at mid range, 1 (the sampler's own 2x2) far away
  let sp = i.wp + n0 * .35; var sh: f32;
  if (dist < 18.) { sh = shadow9(sp); } else if (dist < 45.) { sh = shadow4(sp); } else { sh = shadow1(sp); }
  let E = sunE(i.wp.y, z) * sh;
  let ndl = sat(dot(N, L));
  let am = (amb(i.wp, N, v1.g, z) + side(i.wp, N, sat((v2.r - .5) * 2.7), z)) * ao;
  let dl = E * ndl * (.10 + mix(vec3f(.33), ca, ss(.1, .45, dot(n0, L))) * 2.5);
  var c = alb * (dl + am) + emi + alb * flu * dot(dl + am, vec3f(.1, .5, .5));
  let H = normalize(V + L);
  c += E * (.25 + ca) * pow(sat(dot(N, H)), mix(10., 70., gloss)) * gloss * ndl * 1.8;
  c += (amb(i.wp, reflect(-V, N), v1.g, z) + side(i.wp, reflect(-V, N), sat((v2.r - .5) * 2.7), z)) * ao * (.08 + gloss) * .6 * pow(1. - sat(dot(N, V)), 2.5);
  return fin(fog(c, i.wp, z));
}
`;

// ---------------------------------------------------------------- leaves (kelp, grasses, ground cover)
// leafV places vertex vi of a blade's strip of `rows` rows (instance a, b, c), shadeLeaf lights a point of it
const S_LEAF = /*wgsl*/`
struct LA { wp: vec3f, n: vec3f, uv: vec2f, col: vec3f, pr: vec4f, sd: vec2f, spc: vec3f };
fn sway(p: vec2f, h: f32, t: f32) -> vec2f {
  let ph = dot(p, vec2f(.031, .017));
  let a = .024 * pow(max(h, 0.), 1.25);
  return a * (vec2f(sin(t * .5 + ph + h * .09), cos(t * .37 + ph * 1.3 + h * .07)) + .35 * vec2f(sin(t * 1.3 + ph * 3. + h * .3), cos(t * 1.1 + ph * 2. + h * .23)));
}
fn shape2(v: f32) -> f32 { return sin(3.14159 * sat(v)); }
fn pal(h: f32) -> vec3f {
  if (h < .3) { return vec3f(1., .62, .08); }
  if (h < .6) { return vec3f(.12, 1., .22); }
  if (h < .8) { return vec3f(.2, .85, 1.); }
  return vec3f(1., .3, .8);
}
fn leafV(vi: u32, ia: vec4f, ib: vec4f, ic: vec4f, rows: f32, farD: f32) -> LA {
  var o: LA;
  let u = f32(vi & 1u) * 2. - 1.; let v = sin(f32(vi >> 1u) / (rows - 1.) * 1.5708);
  let ty = i32(ic.x * 255. + .5); let s1 = ic.y; let s2 = ic.z;
  let t = g.cam.w;
  let len = ia.w; let hA = ib.w;
  let cy = cos(ib.x); let sy = sin(ib.x); let ct = cos(ib.y); let st = sin(ib.y);
  let d = vec3f(st * cy, ct, st * sy); let pe = vec3f(ct * cy, -st, ct * sy); let sd = vec3f(-sy, 0., cy);
  // per type: x sparkle prob, y translucency, z iridescence, w emissive
  var col = vec3f(0.); var pr = vec4f(0.); var spc = vec3f(0.); var shp = vec2f(.75, .7); var wav = 1.; var fls = 1.;
  let hsel = hs(s1 * 13.7 + s2 * 71.3);
  switch ty {
    case 0 { col = mix(vec3f(.11, .125, .022), vec3f(.04, .10, .04), s1); col = mix(col, vec3f(.25, .17, .025), step(.72, s2)); pr = vec4f(.24, .9, 0., 0.); spc = pal(hsel * .72); shp = vec2f(.5, .32); wav = 1.9; }
    case 1 { col = vec3f(.10, .11, .035); pr = vec4f(0., .2, 0., 0.); shp = vec2f(.05, .1); wav = .3; fls = .3; }
    case 2 { col = mix(vec3f(.05, .20, .16), vec3f(.12, .26, .22), s1); col = mix(col, vec3f(.30, .14, .24), step(.85, s2)); pr = vec4f(.05, 1.0, .25, 0.); spc = vec3f(.6, 1., .9); shp = vec2f(.45, .35); wav = 2.2; }
    case 3 { col = mix(vec3f(.02, .05, .065), vec3f(.05, .03, .08), s1); col = mix(col, vec3f(.09, .03, .09), step(.8, s2)); pr = vec4f(.2, .85, .55, .02); spc = mix(vec3f(.5, .35, 1.), vec3f(.2, 1., .7), step(.6, hsel)); shp = vec2f(.7, .6); wav = 2.4; }
    case 4 { col = mix(vec3f(.30, .15, .02), vec3f(.42, .25, .04), s1); pr = vec4f(.2, 1., .1, 0.); spc = vec3f(1., .85, .5); shp = vec2f(.5, .4); wav = 1.8; }
    case 5 { col = mix(vec3f(.85, .05, .40), vec3f(.60, .10, .80), step(.7, s1)); col = mix(col, vec3f(.95, .25, .55), step(.75, s2)); pr = vec4f(.22, .8, 0., .30); spc = vec3f(1., .35, .8); shp = vec2f(.6, .6); fls = 2.; }
    case 6 { col = mix(vec3f(.80, .16, .16), vec3f(.92, .36, .42), s1); pr = vec4f(.06, 1., 0., .10); spc = vec3f(1., .5, .5); shp = vec2f(.4, .3); wav = 2.; }
    default { col = mix(vec3f(.05, .40, .36), vec3f(.10, .52, .58), s1); pr = vec4f(.1, .9, .2, .04); spc = vec3f(.3, 1., .9); shp = vec2f(.6, .5); }
  }
  pr.x = step(hs(s1 * 91.7 + s2 * 37.1 + ib.x), pr.x);
  let k = (ic.w - .3) * 2.0 + sin(t * (.8 + s1) * fls + s2 * 40. + hA * .25) * .10 * fls;
  let wph = v * (3. + 5. * s2) + s1 * 30. + t * 1.1;
  let wv = sin(wph) * .12 * wav;
  let kq = k * 1.7; let ka = select(kq, .06, abs(kq) < .06);
  let sK = sin(ka * v); let cK = cos(ka * v);
  let c = ia.xyz + len * (d * (sK / ka) + pe * ((1. - cK) / ka + wv * v));
  let sl = sK + wv + cos(wph) * .10 * wav * v * (3. + 5. * s2);
  let N = normalize(pe * cK - d * sl); let T0 = normalize(d * cK + pe * sl);
  let tw = (s1 - .5) * 2.4 * v + sin(t * .9 + s2 * 20.) * .25 * v;
  let S = sd * cos(tw) + N * sin(tw); let N2 = N * cos(tw) - sd * sin(tw);
  let shape = pow(max(sin(3.14159 * pow(v, shp.x)), 0.), shp.y);
  let shp_ = g.res.x == 0.;
  let cd = distance(ia.xyz, g.cam.xyz); let far = farD * g.mis.z;
  let nearK = select(1. - ss(26., 40., cd), 0., shp_);
  let farK = select((1. - ss(far * .8, far, cd)) * ss(.6, 2.2, distance(c, g.cam.xyz)) * ss(len * 1.1 + .5, len * 2.2 + 1.2, distance(ia.xyz + d * (len * .5), g.cam.xyz)), 1., shp_);
  let ruf = sin(v * 10. + s2 * 30. + t * .6) * ib.z * .36 * u * shape2(v) * nearK;
  var p = c + S * (u * farK * select(ib.z * .5 * shape, select(max(ib.z * .5, .09) * shape, 0., ty == 1), shp_));
  p += N2 * ruf;
  let sw = sway(ia.xz, hA + (p.y - ia.y), t);
  p.x += sw.x; p.z += sw.y;
  o.wp = p; o.n = normalize(N2 + S * u * .55 - T0 * cos(v * 10. + s2 * 30. + t * .6) * u * .7 * nearK); o.uv = vec2f(u, v);
  o.col = col; o.pr = pr; o.sd = vec2f(s1, s2); o.spc = spc;
  return o;
}
// wx/wy and ux/uy: change of the world position and of uv per pixel
fn shadeLeaf(i: LA, ff: bool, wx: vec3f, wy: vec3f, ux: vec2f, uy: vec2f) -> vec4f {
  let dist = length(i.wp - g.cam.xyz);
  let ca = caus2(i.wp, dist, wx, wy);
  var n = normalize(i.n); if (!ff) { n = -n; }
  let V = normalize(g.cam.xyz - i.wp); let L = g.sun.xyz;
  let z = zone(i.wp);
  let lt = tg(tD, vec2f(i.uv.x * .13 + i.sd.x * 3.7, i.uv.y * .8 + i.sd.y * 5.3), vec2f(ux.x * .13, ux.y * .8), vec2f(uy.x * .13, uy.y * .8));
  let vv = vol(i.wp + vec3f(0., .8, 0.));
  let E = sunE(i.wp.y, z) * shadow1(i.wp + L * .3);
  let ndl = dot(n, L);
  var alb = i.col * (.72 + .28 * ss(0., .25, abs(i.uv.x))) * mix(.5, 1.12, i.uv.y) * (1. - .45 * ss(30., 8., dist) * ss(.6, 1., sin(i.uv.y * 40. - abs(i.uv.x) * 7. + i.sd.x * 40.))) * (.58 + .42 * ss(0., .13, abs(i.uv.x))) * (.5 + 1.0 * lt.b) * (.65 + .7 * lt.a);
  let ndv = sat(dot(n, V));
  let ir = .5 + .5 * cos(TAU * (vec3f(0., .33, .67) + ndv * 1.1 + i.sd.x * .22 + i.uv.y * .5 + .55));
  alb = mix(alb, alb * .5 + ir * vec3f(.15, .13, .30), i.pr.z * (1. - ndv) * .8);
  let tr = (max(-ndl, 0.) * .85 + .15) * i.pr.y;
  let trc = alb * mix(vec3f(1.), vec3f(1.5, 1.4, .75), sat(i.pr.y) * (1. - i.pr.z));
  let aov = sat((vv.r - .5) * 6.) * mix(.4, 1., i.uv.y);
  let am = (amb(i.wp, n, vv.g, z) + amb(i.wp, -n, vv.g, z) * i.pr.y * .55 * vec3f(1.1, 1.15, .7) + side(i.wp, n, sat((vv.r - .5) * 4.), z) * .6) * (.3 + .7 * aov);
  var c = E * (.06 + ca * 1.5) * (alb * max(ndl, 0.) + trc * tr) + alb * am;
  let H = normalize(V + L);
  c += E * (pow(sat(dot(n, H)), 40.) * (.45 + ir * i.pr.z * 2.) + pow(sat(dot(n, H)), 9.) * .07) + am * ir * i.pr.z * pow(1. - ndv, 3.) * 1.5;
  c += E * trc * i.pr.y * pow(sat(dot(-V, L)), 3.) * 1.2;
  c += alb * i.pr.w * (.5 + 3. * dot(am + E * .3, vec3f(.1, .5, .5)));
  // sparkle: whole-leaf glints that twinkle slowly
  let tw = pow(.5 + .5 * sin(g.cam.w * (.5 + i.sd.y * 1.4) + i.sd.x * 90.), 5.);
  let m = ss(.2, .0, abs(i.uv.y - (.35 + .45 * i.sd.y))) * (1. - i.uv.x * i.uv.x);
  let lit = .35 + E.g * 1.2;
  c += i.spc * i.pr.x * (.1 + tw) * m * lit * .6;
  return fin(fog(c, i.wp, z));
}
`;

// glints on the leaves (forward, additive) and the leaves' shadow-map vertex shader (bake)
const W_LEAF = S_B + S_LEAF + /*wgsl*/`
override ROWS: f32 = 7.;
struct GO { @builtin(position) cp: vec4f, @location(0) uv: vec2f, @location(1) @interpolate(flat) col: vec3f };
@vertex fn vsGl(@builtin(vertex_index) vi: u32, @location(0) a: vec4f, @location(1) b: vec4f) -> GO {
  var o: GO; let q = vec2f(f32(vi & 1u), f32(vi >> 1u)) * 2. - 1.; let t = g.cam.w;
  var p = a.xyz; let sw = sway(a.xz, a.w, t); p.x += sw.x; p.z += sw.y;
  p += .1 * vec3f(sin(t * .7 + b.x * 50.), sin(t * .9 + b.x * 70.), cos(t * .8 + b.x * 90.));
  let d = length(p - g.cam.xyz);
  if (d > 120. || dot(p - g.cam.xyz, g.fwd.xyz) < -1.) { o.cp = vec4f(0., 0., 2., 1.); return o; }
  let tw = pow(.5 + .5 * sin(t * (.35 + .9 * hs(b.x)) + b.x * 100.), 4.);
  let sz = min(max(b.z, d * .0026), d * .0045);
  let w = p + (g.right.xyz * q.x + g.up.xyz * q.y) * sz;
  o.cp = g.vp * vec4f(w, 1.); o.uv = q;
  let z = zone(p);
  let lit = .3 + 1.8 * shadow1(p) * sunE(p.y, z).g;
  let e = b.z / sz;
  o.col = pal(b.y) * (.12 + tw * 1.7) * lit * e * e * exp(-SIG.g * d) * ss(.4, 1.5, d) * 17.;
  return o;
}
@fragment fn fsGl(i: GO) -> @location(0) vec4f {
  let r = dot(i.uv, i.uv);
  return vec4f(min(i.col * exp(-r * 7.) * (1. - ss(.7, 1., r)), vec3f(10.)), 0.);
}
struct LI { @location(0) a: vec4f, @location(1) b: vec4f, @location(2) c: vec4f };
@vertex fn vs(@builtin(vertex_index) vi: u32, i: LI) -> @builtin(position) vec4f { return g.vp * vec4f(leafV(vi, i.a, i.b, i.c, ROWS, 150.).wp, 1.); }
`;

// ---------------------------------------------------------------- fish + mantas
// fishV / mantaV place a vertex (mesh position p, normal n) of an animal swimming its loop (instance a, b)
const S_ANIM = /*wgsl*/`
struct AA { wp: vec3f, n: vec3f, op: vec3f, sd: f32 };
fn fishV(ip: vec3f, inr: vec4f, ia: vec4f, ib: vec4f) -> AA {
  var o: AA;
  let s = ib.x; let h = vec3f(hs(s), hs(s + .37), hs(s + .71));
  let R = ia.w; let t = g.cam.w;
  let ta = t * ib.y + ib.w * 6.3 + (h.x - .5) * (26. / R);
  let ph = ib.w * 17.;
  let P = ia.xyz + vec3f(R * cos(ta), 2.2 * sin(3. * ta + ph), R * .6 * sin(ta));
  let T = normalize(vec3f(-R * sin(ta), 6.6 * cos(3. * ta + ph), R * .6 * cos(ta))) * sign(ib.y);
  let S = normalize(cross(vec3f(0., 1., 0.), T)); let Up = cross(T, S);
  let off = S * ((h.y - .5) * 5. + sin(t * .6 + s * 40.) * .5) + Up * ((h.z - .5) * 3.2 + cos(t * .5 + s * 31.) * .4);
  var l = ip * ib.z * (.75 + .5 * h.z);
  l.z += sin(t * 9. + s * 50. + l.x * 5.) * .22 * (.25 * ib.z - l.x);
  let w = P + off + T * l.x + Up * l.y + S * l.z;
  o.wp = w; o.n = T * inr.x + Up * inr.y + S * inr.z; o.op = ip; o.sd = s;
  return o;
}
fn shadeFish(i: AA) -> vec4f {
  let n = normalize(i.n); let L = g.sun.xyz; let V = normalize(g.cam.xyz - i.wp);
  let z = zone(i.wp); let vv = vol(i.wp);
  var alb = mix(vec3f(.50, .68, .80), vec3f(.10, .22, .40), ss(-.05, .2, i.op.y));
  alb = mix(alb, vec3f(.95, .8, .3), step(.86, fract(i.sd * 7.7)) * .6);
  let E = sunE(i.wp.y, z) * shadow1(i.wp);
  var c = alb * (E * (.25 + .75 * sat(dot(n, L))) + amb(i.wp, n, vv.g, z) * 1.3);
  c += E * pow(sat(dot(n, normalize(V + L))), 24.) * 1.6 + vec3f(.3, .6, .7) * pow(1. - sat(dot(n, V)), 3.) * .25 * vv.g;
  return fin(fog(c, i.wp, z));
}
fn mantaV(ip: vec3f, inr: vec4f, ia: vec4f, ib: vec4f) -> AA {
  var o: AA;
  let t = g.cam.w; let R = ia.w; let sz = ib.z;
  let ta = t * ib.y + ib.x;
  let P = ia.xyz + vec3f(R * cos(ta), 2.5 * sin(2. * ta + ib.w), R * .75 * sin(ta));
  let T = normalize(vec3f(-R * sin(ta), 5. * cos(2. * ta + ib.w) * 1., R * .75 * cos(ta))) * sign(ib.y);
  var S = normalize(cross(vec3f(0., 1., 0.), T)); var Up = cross(T, S);
  let bank = -.28 * sign(ib.y);
  let S2 = S * cos(bank) + Up * sin(bank); Up = Up * cos(bank) - S * sin(bank); S = S2;
  let u = inr.w; let au = abs(u);
  let fp = t * 1.25 + ib.w * 5. - au * 1.2;
  let amp = .36 * pow(au, 1.6);
  var l = ip;
  l.y += amp * sin(fp) - .1 * sin(t * 1.25 + ib.w * 5.);
  let tail = ss(-.5, -1.9, l.z) * step(au, .001);
  l.x += tail * sin(t * .8 + l.z * 2.) * .12;
  let sl = (.576 * pow(au, .6) * sin(fp) - .43 * pow(au, 1.6) * cos(fp)) * sign(u);
  let ln = normalize(vec3f(inr.x - sl * inr.y, inr.y + sl * inr.x, inr.z));
  let w = P + (S * l.x + Up * l.y + T * l.z) * sz;
  o.wp = w; o.n = S * ln.x + Up * ln.y + T * ln.z; o.op = ip; o.sd = ib.w;
  return o;
}
fn shadeManta(i: AA, ox: vec3f, oy: vec3f, wx: vec3f, wy: vec3f) -> vec4f {
  let dist = length(i.wp - g.cam.xyz);
  let ca = caus(i.wp, dist, wx, wy);
  let tx = tg(tD, i.op.xz * .9 + i.sd, ox.xz * .9, oy.xz * .9);
  let n = normalize(i.n + (vec3f(tx.r, 0., tx.g) - vec3f(.5, 0., .5)) * .5); let L = g.sun.xyz; let V = normalize(g.cam.xyz - i.wp);
  let z = zone(i.wp); let vv = vol(i.wp);
  let top = ss(-.2, .25, normalize(i.n).y);
  let au = abs(i.op.x);
  let gill = ss(.25, .0, abs(au - .13) * 8.) * ss(.04, .12, i.op.z) * ss(.34, .26, i.op.z) * ss(.2, .8, sin(i.op.z * 110.));
  var belly = vec3f(.13, .17, .21) * (.6 + .6 * tx.b) * (1. - .7 * gill);
  belly = mix(belly, vec3f(.05, .08, .11), sat(ss(.45, .9, au + tx.a * .35) + ss(-.1, -.4, i.op.z + tx.b * .2) * .7));
  var back = vec3f(.04, .065, .10) + vec3f(.10, .16, .2) * ss(.5, .75, tx.a);
  back = mix(back, vec3f(.36, .46, .52), ss(.25, .0, abs(au - .26) * 3.5 + abs(i.op.z - .12) * 5.) * .8);
  var alb = mix(belly, back, top);
  let E = sunE(i.wp.y, z) * shadow4(i.wp + n * .3);
  let ndv = sat(dot(n, V));
  let ir = .5 + .5 * cos(TAU * (vec3f(0., .33, .67) + ndv * 1.1 + tx.a * 1.5 + .55));
  let fillN = vec3f(n.x, abs(n.y) * .55 + .25, n.z);
  var c = alb * (E * sat(dot(n, L)) * (.3 + ca) + amb(i.wp, fillN, vv.g, z) * 1.1 + side(i.wp, n, 1., z) * .8);
  c += ir * vec3f(.35, .16, .6) * (.07 + .22 * tx.b) * (.4 + E.g * .2 * ca.g) * (1. - top * .3);
  c += E * pow(sat(dot(n, normalize(V + L))), 30.) * .5 * (.3 + ca);
  let sky = amb(i.wp, vec3f(0., 1., 0.), vv.g, z);
  c += alb * sky * ca * .45 * (1. - top) + sky * pow(1. - ndv, 3.) * .35;
  return fin(fog(c, i.wp, z));
}
`;

// ---------------------------------------------------------------- visibility buffer
// The opaque geometry is drawn once into a visibility buffer that keeps, per pixel, which triangle of which instance
// is there: x = kind << 28 | instance, y = triangle. Kinds: 0 terrain, 1 solids (rocks, props, set pieces), 2 fish,
// 3 mantas, 4-7 leaves (9 / 5 / 3 rows from the near set, 3 rows from the small plants). The resolve pass rebuilds that
// triangle with the same vertex code, intersects the pixel's ray with it and shades every pixel exactly once.
// Geometry is pulled from storage buffers: VB vertices (terrain, then the meshes; 16 bytes: position + snorm8 normal and
// aux), IB absolute indices (the terrain in clusters of 256 triangles, then the meshes), SIB / AIB / LB instances of the
// solids, the animals and the leaves (36 bytes each), VIS the instances that passed culling.
const S_GEO = /*wgsl*/`
struct SI_ { a: vec4f, b: vec4f, c: vec4f };
struct AI_ { a: vec4f, b: vec4f };
@group(1) @binding(0) var<storage, read> VB: array<vec4u>;
@group(1) @binding(1) var<storage, read> IB: array<u32>;
@group(1) @binding(2) var<storage, read> SIB: array<SI_>;
@group(1) @binding(3) var<storage, read> AIB: array<AI_>;
@group(1) @binding(4) var<storage, read> LB: array<u32>;
fn vpos(k: u32) -> vec3f { return bitcast<vec3f>(VB[k].xyz); }
fn vnrm(k: u32) -> vec4f { return unpack4x8snorm(VB[k].w); }
fn leafA(k: u32) -> vec4f { let o = k * 9u; return bitcast<vec4f>(vec4u(LB[o], LB[o + 1u], LB[o + 2u], LB[o + 3u])); }
fn leafB(k: u32) -> vec4f { let o = k * 9u + 4u; return bitcast<vec4f>(vec4u(LB[o], LB[o + 1u], LB[o + 2u], LB[o + 3u])); }
fn leafC(k: u32) -> vec4f { return unpack4x8unorm(LB[k * 9u + 8u]); }
fn leafRows(kind: u32) -> f32 { return select(select(3., 5., kind == 5u), 9., kind == 4u); }
fn leafFar(kind: u32) -> f32 { return select(150., 70., kind == 7u); }
`;

const W_SCENE = S_B + W_FS + S_GEO + S_SOLID + S_LEAF + S_ANIM + /*wgsl*/`
@group(1) @binding(5) var<storage, read> VIS: array<u32>;
@group(1) @binding(6) var tVis: texture_2d<u32>;
// raster: the draw's segment of VIS and its kind
struct DI { base: u32, kind: u32 };
@group(2) @binding(0) var<uniform> di: DI;
struct RO { @builtin(position) cp: vec4f, @location(0) @interpolate(flat) id: vec2u };
@vertex fn vsT(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> RO {
  let t = VIS[di.base + ii] * 768u + vi;
  return RO(g.vp * vec4f(vpos(IB[t]), 1.), vec2u(0u, t / 3u));
}
@vertex fn vsS(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> RO {
  let k = VIS[di.base + ii]; let s = SIB[k]; let v = IB[vi];
  return RO(g.vp * vec4f(solidV(vpos(v), vnrm(v), s.a, s.b, s.c).wp, 1.), vec2u((1u << 28u) | k, vi / 3u));
}
@vertex fn vsA(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> RO {
  let k = VIS[di.base + ii]; let s = AIB[k]; let v = IB[vi];
  var w: vec3f;
  if (di.kind == 2u) { w = fishV(vpos(v), vnrm(v), s.a, s.b).wp; } else { w = mantaV(vpos(v), vnrm(v), s.a, s.b).wp; }
  return RO(g.vp * vec4f(w, 1.), vec2u((di.kind << 28u) | k, vi / 3u));
}
@vertex fn vsL(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> RO {
  let k = VIS[di.base + ii];
  let w = leafV(vi, leafA(k), leafB(k), leafC(k), leafRows(di.kind), leafFar(di.kind)).wp;
  return RO(g.vp * vec4f(w, 1.), vec2u((di.kind << 28u) | k, vi)); // strip: triangle t starts at vertex t (provoking)
}
@fragment fn fsId(@location(0) @interpolate(flat) id: vec2u) -> @location(0) vec2u { return id; }

// the pixel's view ray (forward component 1), undoing this frame's jitter
fn pray(px: vec2f) -> vec3f {
  let nd = vec2f(px.x * 2. * g.res.z - 1., 1. - px.y * 2. * g.res.w) - g.jit.xy;
  return g.fwd.xyz + g.right.xyz * (nd.x * g.right.w) + g.up.xyz * (nd.y * g.up.w);
}
// barycentrics of the pixel on triangle p0 p1 p2 (its plane hit by the view ray, so also outside the triangle and for
// triangles crossing the near plane), their change to the next pixel right (x) and down (y), and which side faces us
struct BC { w: vec3f, x: vec3f, y: vec3f, ff: bool };
fn bw(r: vec3f, A: vec3f, B: vec3f, N: vec3f) -> vec3f {
  let d = -dot(r, N); let k = 1. / select(d, 1e-20, abs(d) < 1e-20);
  let u = dot(r, A) * k; let v = dot(r, B) * k;
  return vec3f(1. - u - v, u, v);
}
fn bary(p0: vec3f, p1: vec3f, p2: vec3f, px: vec2f) -> BC {
  let e1 = p1 - p0; let e2 = p2 - p0; let o = g.cam.xyz - p0;
  let N = cross(e1, e2); let A = cross(e2, o); let B = cross(o, e1);
  var r: BC;
  r.w = bw(pray(px), A, B, N);
  r.x = bw(pray(px + vec2f(1., 0.)), A, B, N) - r.w;
  r.y = bw(pray(px + vec2f(0., 1.)), A, B, N) - r.w;
  r.ff = dot(N, o) > 0.;
  return r;
}
fn ip3(a: vec3f, b: vec3f, c: vec3f, w: vec3f) -> vec3f { return a * w.x + b * w.y + c * w.z; }
fn ip2(a: vec2f, b: vec2f, c: vec2f, w: vec3f) -> vec2f { return a * w.x + b * w.y + c * w.z; }
@fragment fn fsRes(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let id = textureLoad(tVis, vec2i(fc.xy), 0).xy;
  if (id.x == 0xffffffffu) { return vec4f(0.); } // nothing: the water and the background are drawn after
  let kind = id.x >> 28u; let k = id.x & 0xfffffffu; let t = id.y;
  if (kind <= 3u) {
    let i0 = IB[t * 3u]; let i1 = IB[t * 3u + 1u]; let i2 = IB[t * 3u + 2u];
    if (kind <= 1u) {
      var a = vec4f(0., 0., 0., 1.); var b = vec4f(0., 0., 0., 1.); var c = vec4f(0., 0., 1., 0.); // terrain: identity
      if (kind == 1u) { let s = SIB[k]; a = s.a; b = s.b; c = s.c; }
      let v0 = solidV(vpos(i0), vnrm(i0), a, b, c); let v1 = solidV(vpos(i1), vnrm(i1), a, b, c); let v2 = solidV(vpos(i2), vnrm(i2), a, b, c);
      let B = bary(v0.wp, v1.wp, v2.wp, fc.xy);
      var s: SA;
      s.wp = ip3(v0.wp, v1.wp, v2.wp, B.w); s.n = ip3(v0.n, v1.n, v2.n, B.w); s.op = ip3(v0.op, v1.op, v2.op, B.w); s.on = ip3(v0.on, v1.on, v2.on, B.w);
      s.ao = dot(vec3f(v0.ao, v1.ao, v2.ao), B.w);
      return shadeSolid(s, c, b, B.ff, ip3(v0.op, v1.op, v2.op, B.x), ip3(v0.op, v1.op, v2.op, B.y), ip3(v0.wp, v1.wp, v2.wp, B.x), ip3(v0.wp, v1.wp, v2.wp, B.y));
    }
    let s = AIB[k];
    var v0: AA; var v1: AA; var v2: AA;
    if (kind == 2u) { v0 = fishV(vpos(i0), vnrm(i0), s.a, s.b); v1 = fishV(vpos(i1), vnrm(i1), s.a, s.b); v2 = fishV(vpos(i2), vnrm(i2), s.a, s.b); }
    else { v0 = mantaV(vpos(i0), vnrm(i0), s.a, s.b); v1 = mantaV(vpos(i1), vnrm(i1), s.a, s.b); v2 = mantaV(vpos(i2), vnrm(i2), s.a, s.b); }
    let B = bary(v0.wp, v1.wp, v2.wp, fc.xy);
    var a = v0; a.wp = ip3(v0.wp, v1.wp, v2.wp, B.w); a.n = ip3(v0.n, v1.n, v2.n, B.w); a.op = ip3(v0.op, v1.op, v2.op, B.w);
    if (kind == 2u) { return shadeFish(a); }
    return shadeManta(a, ip3(v0.op, v1.op, v2.op, B.x), ip3(v0.op, v1.op, v2.op, B.y), ip3(v0.wp, v1.wp, v2.wp, B.x), ip3(v0.wp, v1.wp, v2.wp, B.y));
  }
  let la = leafA(k); let lb = leafB(k); let lc = leafC(k); let rows = leafRows(kind); let fr = leafFar(kind);
  let v0 = leafV(t, la, lb, lc, rows, fr); let v1 = leafV(t + 1u, la, lb, lc, rows, fr); let v2 = leafV(t + 2u, la, lb, lc, rows, fr);
  let B = bary(v0.wp, v1.wp, v2.wp, fc.xy);
  var l = v0; l.wp = ip3(v0.wp, v1.wp, v2.wp, B.w); l.n = ip3(v0.n, v1.n, v2.n, B.w); l.uv = ip2(v0.uv, v1.uv, v2.uv, B.w);
  // a strip's odd triangles are wound the other way round
  return shadeLeaf(l, B.ff != ((t & 1u) == 1u), ip3(v0.wp, v1.wp, v2.wp, B.x), ip3(v0.wp, v1.wp, v2.wp, B.y), ip2(v0.uv, v1.uv, v2.uv, B.x), ip2(v0.uv, v1.uv, v2.uv, B.y));
}

// shadow map bake (vertex buffers)
struct VI { @location(0) p: vec3f, @location(1) n: vec4f, @location(2) a: vec4f, @location(3) b: vec4f, @location(4) c: vec4f };
@vertex fn vsSh(i: VI) -> @builtin(position) vec4f { return g.vp * vec4f(solidV(i.p, i.n, i.a, i.b, i.c).wp, 1.); }
`;

// ---------------------------------------------------------------- culling (compute, every frame)
// Tests every terrain cluster and instance against the view frustum and its draw distance (scaled by the detail
// `det`), picks a level of detail and appends what is visible to its draw's segment of VIS, counting it in the
// draw's indirect arguments. Draws: 0 terrain, 1 + m solid mesh m, 27 fish, 28 mantas, 29-32 leaf kinds 4-7.
// Occlusion in two phases (PHASE): 1 draws what was visible last frame (VB, one word per object), without testing it;
// then a depth pyramid (HZB) is built from what that drew, and 2 tests everything against it, keeps the result for
// the next frame and draws what 1 left out (draws 33-65, the same order).
const W_CULL = /*wgsl*/`
override PHASE: u32 = 1u;
struct SI_ { a: vec4f, b: vec4f, c: vec4f };
struct AI_ { a: vec4f, b: vec4f };
// pl: frustum planes; cam: camera, w = det; n: clusters, solids, animals, leaves; ln: end of the near leaves, end of
// the far leaves, number of fish; base: segment of VIS per draw; cls: per solid class near mesh, far mesh (< 0 none),
// near and far distance (< 0: no limit); rad: bounding radius per mesh; vp: view-projection (no jitter);
// hz: screen size, pyramid levels; vo: where the solids, animals and leaves start in VB
struct CU { pl: array<vec4f, 5>, cam: vec4f, n: vec4u, ln: vec4u, base: array<vec4u, 17>, cls: array<vec4f, 32>, rad: array<vec4f, 7>,
  vp: mat4x4f, hz: vec4f, vo: vec4u };
@group(0) @binding(0) var<uniform> u: CU;
@group(0) @binding(1) var<storage, read> TB: array<vec4f>;
@group(0) @binding(2) var<storage, read> SIB: array<SI_>;
@group(0) @binding(3) var<storage, read> CLS: array<u32>;
@group(0) @binding(4) var<storage, read> AIB: array<AI_>;
@group(0) @binding(5) var<storage, read> LB: array<u32>;
@group(0) @binding(6) var<storage, read_write> VIS: array<u32>;
@group(0) @binding(7) var<storage, read_write> ARGS: array<atomic<u32>>;
@group(0) @binding(8) var<storage, read_write> VB: array<u32>;
@group(0) @binding(9) var hzb: texture_2d<f32>;
fn emit(d: u32, k: u32) { let s = atomicAdd(&ARGS[d * 4u + 1u], 1u); VIS[u.base[d >> 2u][d & 3u] + s] = k; }
fn inF(c: vec3f, r: f32) -> bool {
  for (var i = 0; i < 5; i++) { if (dot(u.pl[i].xyz, c) + u.pl[i].w < -r) { return false; } }
  return true;
}
fn d2(p: vec3f) -> f32 { let v = p.xz - u.cam.xz; return dot(v, v); }
// is any of box lo-hi possibly in front of what phase 1 drew? (reversed depth: larger is nearer)
fn seen(lo: vec3f, hi: vec3f) -> bool {
  var mn = vec2f(1e9); var mx = vec2f(-1e9); var zn = 0.;
  for (var i = 0u; i < 8u; i++) {
    let p = select(lo, hi, vec3<bool>((i & 1u) != 0u, (i & 2u) != 0u, (i & 4u) != 0u));
    let c = u.vp * vec4f(p, 1.);
    if (c.w < .2) { return true; } // reaches the camera
    let q = c.xy / c.w; mn = min(mn, q); mx = max(mx, q); zn = max(zn, c.z / c.w);
  }
  let a = max(vec2f(mn.x * .5 + .5, .5 - mx.y * .5) * u.hz.xy - 1., vec2f(0.));
  let b = min(vec2f(mx.x * .5 + .5, .5 - mn.y * .5) * u.hz.xy + 1., u.hz.xy - 1.);
  if (any(b < a)) { return false; }
  // the pyramid level where the box spans at most 2x2 texels (level l texel = pixel / 2^(l + 1))
  let top = i32(u.hz.z) - 1;
  var l = clamp(i32(ceil(log2(max(max(b.x - a.x, b.y - a.y), 1.)))) - 1, 0, top);
  var t0: vec2i; var t1: vec2i;
  loop {
    let s = exp2(f32(l + 1)); let dm = vec2i(textureDimensions(hzb, l)) - 1;
    t0 = min(vec2i(a / s), dm); t1 = min(vec2i(b / s), dm);
    if (all(t1 - t0 <= vec2i(1)) || l >= top) { break; }
    l++;
  }
  var m = 1.;
  for (var y = t0.y; y <= t1.y; y++) { for (var x = t0.x; x <= t1.x; x++) { m = min(m, textureLoad(hzb, vec2i(x, y), l).r); } }
  return zn >= m;
}
// phase logic for object v (index into VB) about to be drawn by draw d as instance k, with bounds lo-hi
fn pick(v: u32, d: u32, k: u32, lo: vec3f, hi: vec3f) {
  let was = VB[v];
  if (PHASE == 1u) { if (was != 0u) { emit(d, k); } return; }
  let s = seen(lo, hi); VB[v] = u32(s);
  if (s && was == 0u) { emit(d + 33u, k); }
}
fn gone(v: u32) { if (PHASE == 2u) { VB[v] = 0u; } }
@compute @workgroup_size(64) fn cullT(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x; if (k >= u.n.x) { return; }
  let lo = TB[k * 2u].xyz; let hi = TB[k * 2u + 1u].xyz; let c = (lo + hi) * .5; let h = (hi - lo) * .5;
  let dx = max(abs(u.cam.xz - c.xz) - h.xz, vec2f(0.)); if (dot(dx, dx) > 240. * 240.) { gone(k); return; }
  for (var i = 0; i < 5; i++) { let p = u.pl[i]; if (dot(p.xyz, c) + dot(abs(p.xyz), h) + p.w < 0.) { gone(k); return; } }
  pick(k, 0u, k, lo, hi);
}
@compute @workgroup_size(64) fn cullS(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x; if (k >= u.n.y) { return; }
  let cl = CLS[k]; if (cl >= 32u) { return; }
  let v = u.vo.x + k; let s = SIB[k]; let C = u.cls[cl]; var m = u32(C.x);
  if (C.z >= 0.) {
    let q = d2(s.a.xyz) / (u.cam.w * u.cam.w);
    if (q >= C.w * C.w) { gone(v); return; }
    if (q >= C.z * C.z) { if (C.y < 0.) { gone(v); return; } m = u32(C.y); }
  }
  let r = s.a.w * u.rad[m >> 2u][m & 3u] + abs(s.c.w);
  if (!inF(s.a.xyz, r)) { gone(v); return; }
  pick(v, 1u + m, k, s.a.xyz - r, s.a.xyz + r);
}
@compute @workgroup_size(64) fn cullA(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x; if (k >= u.n.z) { return; }
  let v = u.vo.y + k; let s = AIB[k]; let fish = k < u.ln.z;
  // the loop's farthest reach from its centre (radius a.w, bobbing up and down), then the mesh at its size (b.z): for
  // a manta, plus the flapping wings and the swaying tail (< .6); for a fish, scaled up to 1.25x, plus the tail's
  // wiggle (< .25) and its offset from the school's path (< 3.65 m). See mantaV and fishV.
  let rm = u.rad[3][select(0u, 1u, fish)];
  let r = select(length(vec2f(s.a.w, 2.5)) + (rm + .6) * s.b.z, length(vec2f(s.a.w, 2.2)) + 3.65 + (rm * 1.25 + .25) * s.b.z, fish);
  if (!inF(s.a.xyz, r)) { gone(v); return; }
  pick(v, select(28u, 27u, fish), k, s.a.xyz - r, s.a.xyz + r);
}
@compute @workgroup_size(64) fn cullL(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x; if (k >= u.n.w) { return; }
  let v = u.vo.z + k; let o = k * 9u; let a = bitcast<vec4f>(vec4u(LB[o], LB[o + 1u], LB[o + 2u], LB[o + 3u]));
  let q = d2(a.xyz) / (u.cam.w * u.cam.w);
  var d = 32u;
  if (k < u.ln.x) { if (q < 24. * 24.) { d = 29u; } else if (q < 58. * 58.) { d = 30u; } else { gone(v); return; } }
  else if (k < u.ln.y) { if (q < 58. * 58. || q >= 150. * 150.) { gone(v); return; } d = 31u; }
  else if (q >= 70. * 70.) { gone(v); return; }
  // the blade's length, its width and how far the current sways it at its top (see sway(): .024 h^1.25 x 1.35)
  let hA = bitcast<f32>(LB[o + 7u]); let wd = bitcast<f32>(LB[o + 6u]);
  let r = a.w + wd + .5 + .0325 * pow(max(hA + a.w, 0.), 1.25);
  if (!inF(a.xyz, r)) { gone(v); return; }
  pick(v, d, k, a.xyz - r, a.xyz + r);
}
`;

// depth pyramid for the occlusion test: level 0 = the farthest depth of each 2x2 pixels, each next level the farthest
// of the 3x3 texels below it (3, not 2: a level of odd size has a row or column more than twice the next)
const W_HZB = /*wgsl*/`
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<r32float, write>;
@group(0) @binding(2) var dep: texture_depth_2d;
@compute @workgroup_size(8, 8) fn mip0(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= textureDimensions(dst))) { return; }
  let s = vec2i(id.xy) * 2; let mx = vec2i(textureDimensions(dep)) - 1;
  let m = min(min(textureLoad(dep, min(s, mx), 0), textureLoad(dep, min(s + vec2i(1, 0), mx), 0)),
              min(textureLoad(dep, min(s + vec2i(0, 1), mx), 0), textureLoad(dep, min(s + vec2i(1, 1), mx), 0)));
  textureStore(dst, id.xy, vec4f(m));
}
@compute @workgroup_size(8, 8) fn mipN(@builtin(global_invocation_id) id: vec3u) {
  if (any(id.xy >= textureDimensions(dst))) { return; }
  let s = vec2i(id.xy) * 2; let mx = vec2i(textureDimensions(src)) - 1; var m = 1.;
  for (var y = 0; y < 3; y++) { for (var x = 0; x < 3; x++) { m = min(m, textureLoad(src, min(s + vec2i(x, y), mx), 0).r); } }
  textureStore(dst, id.xy, vec4f(m));
}
`;

// ---------------------------------------------------------------- water surface seen from below
const W_SURF = S_B + /*wgsl*/`
struct VO { @builtin(position) cp: vec4f, @location(0) wp: vec3f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> VO {
  var o: VO;
  let p = vec2f(f32(i & 1u), f32(i >> 1u)) * 2. - 1.;
  o.wp = vec3f(g.cam.x + p.x * 900., 0., g.cam.z + p.y * 900.);
  o.cp = g.vp * vec4f(o.wp, 1.);
  return o;
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let v = i.wp - g.cam.xyz; let d = length(v); let V = v / d;
  let fl = ss(260., 60., d);
  let s = (textureSample(tW, sR, i.wp.xz / 13.).ba + textureSample(tW, sR, i.wp.zx / 4.7 + .2).ba * .7 + textureSample(tW, sR, i.wp.xz / 37. + .6).ba * .8) * fl;
  let n = normalize(vec3f(-s.x * .8, -1., -s.y * .8));
  let ci = sat(dot(V, -n));
  let k = 1. - 1.769 * (1. - ci * ci);
  let win = ss(0., .22, k);
  let rr = refract(V, n, 1.33);
  let sd = max(dot(rr, g.sun.xyz), 0.);
  let fr = pow(1. - sqrt(max(k, 0.)), 5.);
  let sky = (vec3f(.30, .78, 1.) * 1.3 * clamp(1. + 3.8 * (s.x * .6 - s.y * .8), .25, 3.) + vec3f(1., .95, .85) * (pow(sd, 60.) * 1.3 + pow(sd, 500.) * 12.)) * (1. - fr);
  let z = zone(i.wp);
  let R = reflect(V, n);
  let refl = fogIn(i.wp, R, 300., z, g.sun.xyz) * 1.15;
  let c = mix(refl, sky, win);
  return fin(fog(c, i.wp, z));
}
// behind everything: where no terrain is drawn (it stops at ~240 m) the water looks as it does at that distance
@vertex fn vsB(@builtin(vertex_index) i: u32) -> VO {
  var o: VO;
  let p = vec2f(f32(i & 1u), f32(i >> 1u)) * 2. - 1.;
  o.wp = g.cam.xyz + g.fwd.xyz + g.right.xyz * (p.x * g.right.w) + g.up.xyz * (p.y * g.up.w);
  o.cp = vec4f(p, 1e-7, 1.);
  return o;
}
@fragment fn fsB(i: VO) -> @location(0) vec4f {
  let p = g.cam.xyz + normalize(i.wp - g.cam.xyz) * 240.;
  return fin(fog(vec3f(0.), p, zone(p)));
}
`;

// ---------------------------------------------------------------- sprites: bubbles (alpha) and drifting particles (additive)
const W_SPR = S_B + /*wgsl*/`
struct VO { @builtin(position) cp: vec4f, @location(0) uv: vec2f, @location(1) @interpolate(flat) pr: vec4f, @location(2) wp: vec3f };
fn quad(i: u32) -> vec2f { return vec2f(f32(i & 1u), f32(i >> 1u)) * 2. - 1.; }
@vertex fn vsBub(@builtin(vertex_index) vi: u32, @location(0) a: vec4f, @location(1) b: vec4f) -> VO {
  var o: VO; let q = quad(vi); let t = g.cam.w;
  let life = fract(t * b.y / b.z + b.x);
  let h = life * b.z;
  var p = a.xyz + vec3f(0., h, 0.);
  let wob = b.w * (.3 + h * .035);
  p.x += sin(t * 1.7 + b.x * 50. + h * .6) * wob + sin(h * .13 + b.x * 9.) * b.w * 2.;
  p.z += cos(t * 1.3 + b.x * 33. + h * .5) * wob + cos(h * .11 + b.x * 7.) * b.w * 2.;
  let sz = a.w * (.55 + .7 * life) * ss(0., .03, life) * ss(0., -1.2, p.y);
  let w = p + (g.right.xyz * q.x + g.up.xyz * q.y) * sz;
  o.cp = g.vp * vec4f(w, 1.); o.uv = q; o.wp = p;
  o.pr = vec4f(b.x, sz, shadow1(p), 0.);
  return o;
}
@fragment fn fsBub(i: VO) -> @location(0) vec4f {
  let t = g.cam.w;
  let an = atan2(i.uv.y, i.uv.x + 1e-4);
  let big = ss(.04, .22, i.pr.y);
  let r = length(i.uv) / (.9 + big * .05 * sin(an * 3. + t * 5. + i.pr.x * 40.) + big * .02 * sin(an * 5. - t * 7.));
  let aa = fwidth(r) * 1.5;
  let disc = 1. - ss(1. - aa, 1., r);
  let rim = ss(.55, .98, r);
  let hl = ss(.34, .0, length(i.uv - vec2f(-.36, .42))) + .5 * ss(.2, .0, length(i.uv - vec2f(.4, -.42)));
  let z = zone(i.wp);
  let E = sunE(i.wp.y, z) * (.25 + .75 * i.pr.z);
  let hi = fogIn(i.wp, vec3f(0., 1., 0.), 80., z, g.sun.xyz) * 1.5;
  let lo = fogIn(i.wp, vec3f(0., -1., 0.), 80., z, g.sun.xyz);
  var c = mix(lo, hi, ss(-.5, .8, i.uv.y + rim * .4)) * (.5 + 1.2 * rim) + E * hl * 1.6;
  var al = disc * sat(.03 + rim * rim * rim * .9 + hl);
  let v = i.wp - g.cam.xyz; let d = length(v);
  let T = exp(-SIG.g * d) * ss(1.2, 3., d);
  c = c * T + fogIn(g.cam.xyz, v / d, d, z, g.sun.xyz) * (1. - T);
  al *= mix(.35, 1., T);
  return vec4f(min(max(c * al, vec3f(0.)), vec3f(20.)), al);
}
@vertex fn vsSnow(@builtin(vertex_index) vi: u32, @location(0) a: vec4f) -> VO {
  var o: VO; let q = quad(vi); let t = g.cam.w;
  let B = 44.;
  var p = a.xyz * B + vec3f(t * .22, t * .05, t * .13) + .5 * vec3f(sin(t * .3 + a.x * 60.), sin(t * .23 + a.y * 50.), cos(t * .27 + a.z * 70.));
  p = g.cam.xyz + (fract((p - g.cam.xyz) / B + .5) - .5) * B;
  let d = length(p - g.cam.xyz);
  let sz = (.012 + .045 * a.w * a.w * a.w);
  let w = p + (g.right.xyz * q.x + g.up.xyz * q.y) * max(sz, d * .0011);
  o.cp = g.vp * vec4f(w, 1.); o.uv = q; o.wp = p;
  let fade = ss(B * .5, B * .32, d) * ss(.6, 2.5, d) * min(1., sz / (d * .0011)) * ss(-.3, -1.5, p.y);
  let tw = .6 + .4 * sin(t * (1. + a.w * 2.) + a.x * 100.);
  o.pr = vec4f(fade * tw, shadow1(p), a.w, d);
  return o;
}
@fragment fn fsSnow(i: VO) -> @location(0) vec4f {
  let r = length(i.uv);
  let m = ss(1., .2, r);
  let z = zone(i.wp);
  let c = (sunE(i.wp.y, z) * i.pr.y * .8 + amb(i.wp, vec3f(0., 1., 0.), 1., z) * .3) * mix(vec3f(1.), vec3f(.7, 1., .9), i.pr.z);
  return vec4f(min(max(c * m * m * i.pr.x * exp(-SIG.g * i.pr.w), vec3f(0.)), vec3f(8.)), 0.);
}
`;

// ---------------------------------------------------------------- volumetric light shafts (half res)
const W_RAYS = S_G + W_FS + /*wgsl*/`
@group(0) @binding(0) var<uniform> g: G;
@group(0) @binding(1) var sR: sampler;
@group(0) @binding(2) var sS: sampler_comparison;
@group(0) @binding(3) var tSh: texture_depth_2d;
@group(0) @binding(4) var tW: texture_2d<f32>;
@group(0) @binding(5) var tDp: texture_depth_2d;
@group(0) @binding(6) var tV: texture_3d<f32>;
@group(0) @binding(7) var sC: sampler;
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let dp = textureLoad(tDp, vec2i(fc.xy) * 2, 0);
  let uv = fc.xy * 2. * g.res.zw;
  let nd = vec2f(uv.x * 2. - 1., 1. - uv.y * 2.);
  let rv = g.fwd.xyz + g.right.xyz * (nd.x * g.right.w) + g.up.xyz * (nd.y * g.up.w);
  let rl = length(rv); let rd = rv / rl;
  let zl = g.fwd.w / max(dp, 1e-6);
  var tm = min(zl * rl, 120.);
  if (rd.y > 1e-4) { tm = min(tm, -g.cam.y / rd.y); }
  let ro = g.cam.xyz; let sx = g.sun.xyz; let k = kd(g.sun.w); let sgz = sg(g.sun.w);
  let dt = tm / ${RAYN}.;
  let j = fract(ign(fc.xy) + g.jit.w); // a different offset every frame: the temporal filter averages them
  var acc = vec3f(0.);
  for (var n = 0; n < ${RAYN}; n++) {
    let t = (f32(n) + j) * dt;
    let p = ro + rd * t;
    let s = g.sm * vec4f(p, 1.);
    let vis = textureSampleCompareLevel(tSh, sS, vec2f(s.x * .5 + .5, .5 - s.y * .5), s.z - .0006);
    let q = p.xz - sx.xz * (p.y / sx.y);
    let pat = ss(.3, .7, textureSampleLevel(tW, sR, q / 27., 2.5).r) * ss(.15, .6, textureSampleLevel(tW, sR, q.yx / 11. + .3, 2.).r);
    let o = textureSampleLevel(tV, sC, (p - vec3f(-192., -56., -192.)) / vec3f(384., 60., 384.), 0.).r;
    let mist = sat(1. - (o - .5) * 3.4);
    acc += exp(-sgz * t + k * (p.y / sx.y)) * (vis * (.012 + pat * 6.) * (1. + 1.2 * mist * mist));
  }
  let mu = max(dot(rd, sx), 0.);
  let ph = mix(.2 + 2.0 * mu * mu * mu, .8, g.sun.w);
  let wc = mix(WCOL + vec3f(.04, .07, .05), PCOL + vec3f(.28, .16, .12), g.sun.w);
  return vec4f(min(acc * dt * sgz * wc * SUNC * ph * g.mis.y * (1. - .55 * g.sun.w), vec3f(20.)), zl);
}
`;
// Depth-aware 3x3 blur of the half-res shafts, accumulated over frames: last frame's result is reprojected, kept only
// where it saw the same depth, clipped to the spread of this frame's samples and blended in.
const W_RTEMP = S_G + W_FS + /*wgsl*/`
@group(0) @binding(0) var<uniform> g: G;
@group(0) @binding(1) var sC: sampler;
@group(0) @binding(2) var tR: texture_2d<f32>;
@group(0) @binding(3) var tH: texture_2d<f32>;
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let p = vec2i(fc.xy); let mx = vec2i(textureDimensions(tR)) - 1;
  let c = textureLoad(tR, p, 0);
  var acc = vec3f(0.); var ws = 0.; var m1 = vec3f(0.); var m2 = vec3f(0.);
  for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
    let r = textureLoad(tR, clamp(p + vec2i(x, y) , vec2i(0), mx), 0);
    let w = 1. / (.03 + abs(r.a - c.a) / c.a);
    acc += r.rgb * w; ws += w; m1 += r.rgb * w; m2 += r.rgb * r.rgb * w;
  } }
  let b = acc / ws; let mu = m1 / ws; let sg = sqrt(max(m2 / ws - mu * mu, vec3f(0.)));
  let uv = fc.xy * 2. * g.res.zw;
  let nd = vec2f(uv.x * 2. - 1., 1. - uv.y * 2.);
  let wp = g.cam.xyz + (g.fwd.xyz + g.right.xyz * (nd.x * g.right.w) + g.up.xyz * (nd.y * g.up.w)) * c.a;
  let cp = g.pvp * vec4f(wp, 1.); let pu = vec2f(cp.x / cp.w * .5 + .5, .5 - cp.y / cp.w * .5);
  var o = b;
  if (g.jit.z < .5 && cp.w > 0. && all(pu > vec2f(0.)) && all(pu < vec2f(1.))) {
    let h = textureSampleLevel(tH, sC, pu, 0.);
    if (abs(h.a - cp.w) < .1 * cp.w) { o = mix(clamp(h.rgb, mu - sg * 1.5, mu + sg * 1.5), b, .2); }
  }
  return vec4f(o, c.a);
}
`;

// Temporal anti-aliasing: the scene is drawn with a sub-pixel jitter that changes every frame; last frame's result is
// reprojected (camera motion, by the depth of the nearest surface around), clipped to the colour spread of this
// pixel's neighbourhood (in YCoCg, after a soft tone curve) and blended with this frame.
const W_TAA = S_G + W_FS + /*wgsl*/`
@group(0) @binding(0) var<uniform> g: G;
@group(0) @binding(1) var sC: sampler;
@group(0) @binding(2) var tS: texture_2d<f32>;
@group(0) @binding(3) var tH: texture_2d<f32>;
@group(0) @binding(4) var tDp: texture_depth_2d;
fn tw(c: vec3f) -> vec3f { return c / (1. + max(c.r, max(c.g, c.b))); }
fn itw(c: vec3f) -> vec3f { return c / max(1. - max(c.r, max(c.g, c.b)), 1e-3); }
fn ycc(c: vec3f) -> vec3f { return vec3f(dot(c, vec3f(.25, .5, .25)), dot(c, vec3f(.5, 0., -.5)), dot(c, vec3f(-.25, .5, -.25))); }
fn rgb(y: vec3f) -> vec3f { return vec3f(y.x + y.y - y.z, y.x + y.z, y.x - y.y - y.z); }
// Catmull-Rom history lookup from 5 bilinear taps (keeps it sharp)
fn hist(uv: vec2f) -> vec3f {
  let sz = vec2f(textureDimensions(tH)); let sp = uv * sz; let tp = floor(sp - .5) + .5; let f = sp - tp;
  let w0 = f * (-.5 + f * (1. - .5 * f)); let w1 = 1. + f * f * (-2.5 + 1.5 * f); let w2 = f * (.5 + f * (2. - 1.5 * f)); let w3 = f * f * (-.5 + .5 * f);
  let w12 = w1 + w2; let t0 = (tp - 1.) / sz; let t3 = (tp + 2.) / sz; let t12 = (tp + w2 / w12) / sz;
  let r = textureSampleLevel(tH, sC, vec2f(t12.x, t0.y), 0.).rgb * (w12.x * w0.y) + textureSampleLevel(tH, sC, vec2f(t0.x, t12.y), 0.).rgb * (w0.x * w12.y)
        + textureSampleLevel(tH, sC, t12, 0.).rgb * (w12.x * w12.y) + textureSampleLevel(tH, sC, vec2f(t3.x, t12.y), 0.).rgb * (w3.x * w12.y)
        + textureSampleLevel(tH, sC, vec2f(t12.x, t3.y), 0.).rgb * (w12.x * w3.y);
  return max(r / (w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y), vec3f(0.));
}
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let px = vec2i(fc.xy); let mx = vec2i(textureDimensions(tS)) - 1;
  var m1 = vec3f(0.); var m2 = vec3f(0.); var cur = vec3f(0.); var dn = 0.;
  for (var y = -1; y <= 1; y++) { for (var x = -1; x <= 1; x++) {
    let q = clamp(px + vec2i(x, y), vec2i(0), mx);
    let c = ycc(tw(textureLoad(tS, q, 0).rgb)); m1 += c; m2 += c * c;
    if (x == 0 && y == 0) { cur = c; }
    dn = max(dn, textureLoad(tDp, q, 0)); // reversed depth: the largest is the nearest
  } }
  let mu = m1 / 9.; let sg = sqrt(max(m2 / 9. - mu * mu, vec3f(0.)));
  // this pixel's point at the nearest depth, in homogeneous form (s = 1 / view depth, 0 = infinitely far)
  let nd = vec2f(fc.x * 2. * g.res.z - 1., 1. - fc.y * 2. * g.res.w) - g.jit.xy;
  let v = g.fwd.xyz + g.right.xyz * (nd.x * g.right.w) + g.up.xyz * (nd.y * g.up.w);
  let s = dn / g.fwd.w;
  let cp = g.pvp * vec4f(g.cam.xyz * s + v, s);
  let pu = vec2f(cp.x / cp.w * .5 + .5, .5 - cp.y / cp.w * .5);
  var o = cur;
  if (g.jit.z < .5 && cp.w > 0. && all(pu > vec2f(0.)) && all(pu < vec2f(1.))) {
    var h = ycc(tw(hist(pu)));
    let e = sg + 1e-4; let d = h - mu; let k = max(abs(d.x) / e.x, max(abs(d.y) / e.y, abs(d.z) / e.z));
    if (k > 1.) { h = mu + d / k; }
    o = mix(h, cur, .1);
  }
  return vec4f(itw(max(rgb(o), vec3f(0.))), 1.);
}
`;

// ---------------------------------------------------------------- final composite
const W_POST = S_G + W_FS + /*wgsl*/`
@group(0) @binding(0) var<uniform> g: G;
@group(0) @binding(1) var sC: sampler;
@group(0) @binding(2) var tS: texture_2d<f32>;
@group(0) @binding(3) var tR: texture_2d<f32>;
@group(0) @binding(4) var tB: texture_2d<f32>;
@group(0) @binding(5) var tDp: texture_depth_2d;
fn tmap(x: vec3f) -> vec3f { return sat3((x * (2.51 * x + .03)) / (x * (2.43 * x + .59) + .14)); }
fn sat3(x: vec3f) -> vec3f { return clamp(x, vec3f(0.), vec3f(1.)); }
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let px = vec2i(fc.xy);
  let uv = fc.xy * g.res.zw;
  let zf = g.fwd.w / max(textureLoad(tDp, px, 0), 1e-6);
  // depth-aware upsample of the half-res shafts
  let h = fc.xy * .5 - .5; let b = floor(h); let f = h - b; let bi = vec2i(b);
  let mx = vec2i(textureDimensions(tR)) - 1;
  var acc = vec3f(0.); var ws = 0.;
  for (var k = 0; k < 4; k++) {
    let o = vec2i(k & 1, k >> 1);
    let r = textureLoad(tR, clamp(bi + o, vec2i(0), mx), 0);
    let bw = mix(1. - f.x, f.x, f32(o.x)) * mix(1. - f.y, f.y, f32(o.y));
    let w = (bw + .02) / (.02 + abs(r.a - zf) / zf);
    acc += r.rgb * w; ws += w;
  }
  var c = textureLoad(tS, px, 0).rgb + acc / ws;
  let bl = textureSampleLevel(tB, sC, uv, 0.).rgb;
  c = mix(c, bl, .06) + bl * .03;
  c *= g.mis.x;
  let q = uv - .5;
  c *= 1. - dot(q, q) * .55;
  c = tmap(c);
  let l0 = dot(c, vec3f(.2126, .7152, .0722));
  let l = mix(l0, l0 * l0 * (3. - 2. * l0), .55);
  c *= l / max(l0, 1e-4);
  c = mix(c, vec3f(l), ss(.55, 1., l) * .1);
  c = mix(vec3f(l), c, .93) + vec3f(.008, .002, 0.);
  c = pow(max(c, vec3f(0.)), vec3f(1. / 2.2));
  let n = ign(fc.xy) + ign(fc.xy + 37.) - 1.;
  return vec4f(c + n / 255., 1.);
}
`;
