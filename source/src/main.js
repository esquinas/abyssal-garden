// ============================================================================
// renderer, camera and input
// ============================================================================
const $ = (id) => document.getElementById(id);
const canvas = $('c'), info = $('i'), body = document.body;
// a phone held upright gets the page turned on its side (see template.html)
const rot = matchMedia('(orientation:portrait) and (pointer:coarse)');
// loading bar: each stage glides it to `to` (the share done) over ~`ms` on the compositor, so it moves while this
// thread is busy
let loaded = 0, dead; // dead: the graphics device was lost
const say = (m, to, ms) => {
  if (!dead) $('s').textContent = m;
  const a = $('b').animate({ transform: [`scaleX(${loaded})`, `scaleX(${to})`] }, { duration: ms, fill: 'forwards', easing: 'cubic-bezier(.3,.5,.5,1)' });
  loaded = to;
  // go on once the animation runs: one not started before the thread gets busy stays stuck (timer: hidden tabs)
  return new Promise((r) => { a.ready.then(() => setTimeout(r)); setTimeout(r, document.hidden ? 0 : 1e3); });
};
const fail = (m) => { throw new Error(m, { cause: 1 }); }; // cause marks a message that is shown as it is
if (!navigator.gpu) fail('This scene needs WebGPU. Try a current Chrome or Edge.');
// Right after a reload or a graphics crash the browser can refuse an adapter for a few seconds: ask again, waiting
// longer each time, and from the third try without asking for the faster chip (some phone drivers refuse that)
let adapter = null;
for (let i = 0; i < 7 && !adapter; i++) {
  if (i) { $('s').textContent = 'Waiting for the graphics chip…'; await new Promise((r) => setTimeout(r, [300, 600, 1e3, 2e3, 3e3, 5e3][i - 1])); }
  adapter = await navigator.gpu.requestAdapter(i < 2 ? { powerPreference: 'high-performance' } : {});
}
if (!adapter) fail("The browser isn't letting this page use the graphics chip right now. This can happen after a crash. Close this tab and open the page again, or restart the browser.");
$('w').hidden = !!navigator.userAgentData; // only Chromium-based browsers have it
const hasTS = adapter.features.has('timestamp-query');
// the terrain's vertex and index buffers are read as storage buffers, which can be larger than the default limit
const AL = adapter.limits;
const device = await adapter.requestDevice({ requiredFeatures: hasTS ? ['timestamp-query'] : [],
  requiredLimits: { maxStorageBufferBindingSize: AL.maxStorageBufferBindingSize, maxBufferSize: AL.maxBufferSize } });
device.addEventListener('uncapturederror', (e) => console.error('GPU: ' + e.error.message));
// Restarts the page (at level lv, if given) after releasing the GPU, so the next page finds the memory free.
// `leaving` stops the device loss this causes from being taken for a crash.
let leaving = 0;
const restart = (lv) => { leaving = 1; if (lv != null) keep('abyssal', lv); device.destroy(); setTimeout(() => location.reload(), 150); };
// out of memory or a GPU timeout: restart a level lower, or on Low say what happened
device.lost.then((l) => {
  if (leaving || l.reason === 'destroyed') return; // the page is closing or restarting
  if (LV < 2) return restart(LV + 1);
  dead = body.className = 'l e'; $('s').textContent = 'The graphics device was lost. Reload the page to try again.';
});
const ctx = canvas.getContext('webgpu'), FMT = navigator.gpu.getPreferredCanvasFormat();
const Q = device.queue, HDR = 'rgba16float', DEPTH = 'depth32float';
const TU = GPUTextureUsage, BU = GPUBufferUsage, SS = GPUShaderStage;

const mod = (code) => device.createShaderModule({ code });
const buf = (data, usage) => { const b = device.createBuffer({ size: (data.byteLength + 3) & ~3, usage: usage | BU.COPY_DST }); Q.writeBuffer(b, 0, data.buffer || data, data.byteOffset || 0, data.byteLength); return b; };
const tex = (w, h, format, usage, o = {}) => device.createTexture({ size: [w, h, o.d || 1], format, usage, mipLevelCount: o.mips || 1, sampleCount: o.samples || 1, dimension: o.d ? '3d' : '2d' });

// ---------------------------------------------------------------- static resources
const sRep = device.createSampler({ addressModeU: 'repeat', addressModeV: 'repeat', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', maxAnisotropy: LV > 1 ? 1 : 8 });
const sClamp = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
const sCmp = device.createSampler({ compare: 'less-equal', magFilter: 'linear', minFilter: 'linear' });
const tShadow = tex(SHADOW, SHADOW, DEPTH, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING);
const tDummy = tex(1, 1, DEPTH, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING);
const tWater = tex(WATER, WATER, HDR, TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING, { mips: 5 });
const tDetail = tex(1024, 1024, 'rgba8unorm', TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING, { mips: 11 });
const tVol = tex(NX / 2, NY / 2, 'rg8unorm', TU.TEXTURE_BINDING | TU.COPY_DST, { d: NZ / 2 });
const tMap = tex(512, 512, 'rgba8unorm', TU.TEXTURE_BINDING | TU.COPY_DST);

// struct G in shaders.js: 0 vp, 16 sm, 32 cam, 36 right, 40 up, 44 fwd, 48 sun, 52 res, 56 mis, 60 jit, 64 pvp
const UB = new Float32Array(80), UBS = new Float32Array(80);
const ubo = device.createBuffer({ size: 320, usage: BU.UNIFORM | BU.COPY_DST }), uboS = device.createBuffer({ size: 320, usage: BU.UNIFORM | BU.COPY_DST });
const WT = new Float32Array(4), uboW = device.createBuffer({ size: 16, usage: BU.UNIFORM | BU.COPY_DST });

const VF = SS.VERTEX | SS.FRAGMENT;
const bgl0 = device.createBindGroupLayout({ entries: [
  { binding: 0, visibility: VF, buffer: {} },
  { binding: 1, visibility: VF, sampler: {} }, { binding: 2, visibility: VF, sampler: {} }, { binding: 3, visibility: VF, sampler: { type: 'comparison' } },
  { binding: 4, visibility: VF, texture: { sampleType: 'depth' } },
  { binding: 5, visibility: VF, texture: {} }, { binding: 6, visibility: VF, texture: {} },
  { binding: 7, visibility: VF, texture: { viewDimension: '3d' } }, { binding: 8, visibility: VF, texture: {} }] });
const mkBG0 = (u, sh) => device.createBindGroup({ layout: bgl0, entries: [
  { binding: 0, resource: { buffer: u } }, { binding: 1, resource: sRep }, { binding: 2, resource: sClamp }, { binding: 3, resource: sCmp },
  { binding: 4, resource: sh.createView() }, { binding: 5, resource: tWater.createView() }, { binding: 6, resource: tDetail.createView() },
  { binding: 7, resource: tVol.createView() }, { binding: 8, resource: tMap.createView() }] });
const bg0 = mkBG0(ubo, tShadow), bg0s = mkBG0(uboS, tDummy);
const pl0 = device.createPipelineLayout({ bindGroupLayouts: [bgl0] });

const bglBlit = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: SS.FRAGMENT, texture: {} }, { binding: 1, visibility: SS.FRAGMENT, sampler: {} }] });
const plBlit = device.createPipelineLayout({ bindGroupLayouts: [bglBlit] });
const mBlit = mod(W_BLIT);
const blitPipe = (entry, format, add) => device.createRenderPipeline({ layout: plBlit, vertex: { module: mBlit, entryPoint: 'vs' },
  fragment: { module: mBlit, entryPoint: entry, targets: [{ format, blend: add ? { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } } : undefined }] } });
const pMip8 = blitPipe('fsMip', 'rgba8unorm'), pMip16 = blitPipe('fsMip', HDR), pDown0 = blitPipe('fsDown0', HDR), pDown = blitPipe('fsDown', HDR), pUp = blitPipe('fsUp', HDR, true);
const blitBG = (view) => device.createBindGroup({ layout: bglBlit, entries: [{ binding: 0, resource: view }, { binding: 1, resource: sClamp }] });
const colorAtt = (view, clear) => ({ view, loadOp: clear ? 'clear' : 'load', storeOp: 'store', clearValue: [0, 0, 0, 0] });

// vertex layouts (the shadow bake; everything else pulls its geometry from storage buffers)
const A = (shaderLocation, offset, format) => ({ shaderLocation, offset, format });
const vbSolid = { arrayStride: 16, attributes: [A(0, 0, 'float32x3'), A(1, 12, 'snorm8x4')] };
const ibSolid = { arrayStride: 48, stepMode: 'instance', attributes: [A(2, 0, 'float32x4'), A(3, 16, 'float32x4'), A(4, 32, 'float32x4')] };
const ibLeaf = { arrayStride: 36, stepMode: 'instance', attributes: [A(0, 0, 'float32x4'), A(1, 16, 'float32x4'), A(2, 32, 'unorm8x4')] };
const ibBub = { arrayStride: 32, stepMode: 'instance', attributes: [A(0, 0, 'float32x4'), A(1, 16, 'float32x4')] };
const ibSnow = { arrayStride: 16, stepMode: 'instance', attributes: [A(0, 0, 'float32x4')] };

const scenePipe = (m, vsE, fsE, buffers, o = {}) => device.createRenderPipeline({ layout: o.layout || pl0,
  vertex: { module: m, entryPoint: vsE, buffers, constants: o.constants },
  fragment: { module: m, entryPoint: fsE, targets: [{ format: o.format || HDR, blend: o.blend }] },
  primitive: { topology: o.strip ? 'triangle-strip' : 'triangle-list', cullMode: o.cull || 'none' },
  depthStencil: { format: DEPTH, depthWriteEnabled: o.write ?? !o.blend, depthCompare: o.cmp || 'greater' } });
const shadowPipe = (m, vsE, buffers, o = {}) => device.createRenderPipeline({ layout: pl0,
  vertex: { module: m, entryPoint: vsE, buffers, constants: o.constants },
  primitive: { topology: o.strip ? 'triangle-strip' : 'triangle-list', cullMode: o.cull || 'none' },
  depthStencil: { format: DEPTH, depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 1.5 } });

// visibility buffer (see W_SCENE): geometry + visible instances for the raster, geometry + the buffer for the resolve
const RO = { type: 'read-only-storage' }, VFC = VF | SS.COMPUTE;
const geoEntries = [0, 1, 2, 3, 4].map((binding) => ({ binding, visibility: VFC, buffer: RO }));
const bglGeo = device.createBindGroupLayout({ entries: [...geoEntries, { binding: 5, visibility: VF, buffer: RO }] });
const bglGeoR = device.createBindGroupLayout({ entries: [...geoEntries, { binding: 6, visibility: SS.FRAGMENT, texture: { sampleType: 'uint' } }] });
const bglDI = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: SS.VERTEX, buffer: { hasDynamicOffset: true } }] });
const plVis = device.createPipelineLayout({ bindGroupLayouts: [bgl0, bglGeo, bglDI] }), plRes = device.createPipelineLayout({ bindGroupLayouts: [bgl0, bglGeoR] });
const bglCull = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: SS.COMPUTE, buffer: {} },
  ...[1, 2, 3, 4, 5].map((binding) => ({ binding, visibility: SS.COMPUTE, buffer: RO })),
  { binding: 6, visibility: SS.COMPUTE, buffer: { type: 'storage' } }, { binding: 7, visibility: SS.COMPUTE, buffer: { type: 'storage' } }] });

await say('Compiling shaders…', 0.05, 300);
const mScene = mod(W_SCENE), mLeaf = mod(W_LEAF), mSurf = mod(W_SURF), mSpr = mod(W_SPR), mCull = mod(W_CULL);
const VISF = 'rg32uint';
const visPipe = (vs, o = {}) => scenePipe(mScene, vs, 'fsId', [], { ...o, layout: plVis, format: VISF, write: true });
const pVisT = visPipe('vsT', { cull: 'back' }), pVisS = visPipe('vsS'), pVisA = visPipe('vsA'), pVisL = visPipe('vsL', { strip: true });
const pRes = scenePipe(mScene, 'vs', 'fsRes', [], { layout: plRes, write: false, cmp: 'always' });
const pSurf = scenePipe(mSurf, 'vs', 'fs', [], { strip: true }), pBack = scenePipe(mSurf, 'vsB', 'fsB', [], { strip: true });
const pBub = scenePipe(mSpr, 'vsBub', 'fsBub', [ibBub], { strip: true, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } });
const ADD = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } };
const pSnow = scenePipe(mSpr, 'vsSnow', 'fsSnow', [ibSnow], { strip: true, blend: ADD });
const pGl = scenePipe(mLeaf, 'vsGl', 'fsGl', [ibBub], { strip: true, blend: ADD });
const pSolidSh = shadowPipe(mScene, 'vsSh', [vbSolid, ibSolid]), pTerrSh = shadowPipe(mScene, 'vsSh', [vbSolid, ibSolid], { cull: 'front' });
const pLeafSh = shadowPipe(mLeaf, 'vs', [ibLeaf], { strip: true, constants: { ROWS: 3 } });
const plCull = device.createPipelineLayout({ bindGroupLayouts: [bglCull] });
const [pCullT, pCullS, pCullA, pCullL] = ['cullT', 'cullS', 'cullA', 'cullL'].map((entryPoint) => device.createComputePipeline({ layout: plCull, compute: { module: mCull, entryPoint } }));

const mWater = mod(W_WATER);
const pWater = device.createRenderPipeline({ layout: 'auto', vertex: { module: mWater, entryPoint: 'vs' }, fragment: { module: mWater, entryPoint: 'fs', targets: [{ format: HDR }] } });
const bgWater = device.createBindGroup({ layout: pWater.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: uboW } }] });
const waterViews = [0, 1, 2, 3, 4].map((m) => tWater.createView({ baseMipLevel: m, mipLevelCount: 1 }));
const waterBG = waterViews.map((v) => blitBG(v));
const waterPass = waterViews.map((v) => ({ colorAttachments: [colorAtt(v, true)] }));

const fsPipe = (w) => { const m = mod(w); return device.createRenderPipeline({ layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: 'fs', targets: [{ format: HDR }] } }); };
const pRays = fsPipe(W_RAYS), pRT = fsPipe(W_RTEMP), pTAA = fsPipe(W_TAA);
const mPost = mod(W_POST);
const pPost = device.createRenderPipeline({ layout: 'auto', vertex: { module: mPost, entryPoint: 'vs' }, fragment: { module: mPost, entryPoint: 'fs', targets: [{ format: FMT }] } });

// ---------------------------------------------------------------- sun + shadow matrix
const SUN = (() => { const v = [0.27, 1, -0.24], l = hypot(...v); return v.map((c) => c / l); })();
{
  const L = SUN, lr = [L[1], -L[0], 0], ll = hypot(...lr); lr[0] /= ll; lr[1] /= ll;
  const lu = [L[1] * lr[2] - L[2] * lr[1], L[2] * lr[0] - L[0] * lr[2], L[0] * lr[1] - L[1] * lr[0]];
  const R = 225, d0 = -175, d1 = 125, m = UBS;
  m[0] = lr[0] / R; m[4] = lr[1] / R; m[8] = lr[2] / R; m[12] = 0;
  m[1] = lu[0] / R; m[5] = lu[1] / R; m[9] = lu[2] / R; m[13] = 0;
  m[2] = -L[0] / (d1 - d0); m[6] = -L[1] / (d1 - d0); m[10] = -L[2] / (d1 - d0); m[14] = d1 / (d1 - d0);
  m[3] = 0; m[7] = 0; m[11] = 0; m[15] = 1;
  for (let i = 0; i < 16; i++) { UBS[16 + i] = m[i]; UB[16 + i] = m[i]; }
  for (let i = 0; i < 3; i++) { UB[48 + i] = UBS[48 + i] = SUN[i]; }
  UBS[32] = 0; UBS[33] = -20; UBS[34] = 0; UBS[35] = 0; UBS[58] = 1;
  Q.writeBuffer(uboS, 0, UBS);
}

// ---------------------------------------------------------------- world generation
await say('Sculpting the seabed…', 0.25, 1200);
// marks a load in progress (quality.js); leaving the page before it ends is not a crash
keep('abyssalLoad', 1);
addEventListener('pagehide', () => { keep('abyssalLoad', ''); leaving = 1; device.destroy(); });
addEventListener('pageshow', (e) => e.persisted && location.reload()); // back from the page cache with no device
let D;
{
  const prims = primBuffer();
  const m = mod(W_DENS), p = device.createComputePipeline({ layout: 'auto', compute: { module: m, entryPoint: 'main' } });
  const size = NX * NY * NZ * 4;
  const u = new ArrayBuffer(48), uu = new Uint32Array(u), uf = new Float32Array(u);
  uu[0] = NX; uu[1] = NY; uu[2] = NZ; uf[4] = OX; uf[5] = OY; uf[6] = OZ; uf[7] = VS;
  uu[8] = MESAS.length; uu[9] = ARCHES.length; uu[10] = HOLES.length; uu[11] = CLEARS.length;
  const bu = buf(new Uint8Array(u), BU.UNIFORM), bp = buf(prims, BU.STORAGE);
  const bd = device.createBuffer({ size, usage: BU.STORAGE | BU.COPY_SRC }), br = device.createBuffer({ size, usage: BU.MAP_READ | BU.COPY_DST });
  const bg = device.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: bu } }, { binding: 1, resource: { buffer: bd } }, { binding: 2, resource: { buffer: bp } }] });
  const e = device.createCommandEncoder(), c = e.beginComputePass();
  c.setPipeline(p); c.setBindGroup(0, bg); c.dispatchWorkgroups(NX / 4, NY / 4, NZ / 4); c.end();
  e.copyBufferToBuffer(bd, 0, br, 0, size);
  Q.submit([e.finish()]);
  await br.mapAsync(GPUMapMode.READ);
  D = new Float32Array(br.getMappedRange().slice(0));
  br.unmap(); br.destroy(); bd.destroy();
  // rock connected to the seabed: each column's unbroken run up from the bottom is, and the rock above a gap
  // (overhangs, specks) is when it touches rock that is. What never connects is a speck of noise floating in
  // the water (surface nets would make it a small box), so it becomes water
  const S = NX * NY, R = new Uint8Array(D.length), O = [1, -1, NX, -NX, S, -S], b = new Uint8Array(NX), L = [];
  for (let i = 0; i < D.length;) { b.fill(1); for (let y = 0; y < NY; y++) for (let x = 0; x < NX; x++, i++) if (D[i] <= 0) b[x] = 0; else if (b[x]) R[i] = 1; else L.push(i); }
  for (let k = 1; k; L.reverse()) { k = 0; for (const i of L) if (!R[i] && O.some((o) => R[i + o])) R[i] = k = 1; }
  for (const i of L) if (!R[i]) D[i] = -D[i];
}
// Distance to the rock for collide(), in 1/127 m (> 0 in rock, clamped to ±1 m), kept only in the 4x4x4-voxel
// bricks near the surface within the camera's reach (~2 MB). CI per brick: 0 all water, 1 all rock, n brick n-2 in CG.
const CO = 52, CN = 102, CI = new Uint16Array(CN * CN * NY / 4);
let CG = new Int8Array(64 * 65534);
{
  let n = 0;
  for (let bz = 0; bz < CN; bz++) for (let by = 1; by < NY / 4 - 1; by++) for (let bx = 0; bx < CN; bx++) {
    if (hypot(bx - CN / 2 + 0.5, bz - CN / 2 + 0.5) > 52) continue; // more than 156 m out: never reached
    let lo = 127, hi = -127;
    for (let z = 0; z < 4; z++) for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const i = CO + bx * 4 + x + NX * (by * 4 + y + NY * (CO + bz * 4 + z)), gz = D[i + NX * NY] - D[i - NX * NY];
      const gx = D[i + 1] - D[i - 1], g = D[i + NX] - D[i - NX], l = sqrt(gx * gx + g * g + gz * gz) / 1.5;
      const q = round(clamp(D[i] / max(l, 0.05), -1, 1) * 127);
      CG[n * 64 + x + 4 * y + 16 * z] = q; if (q < lo) lo = q; if (q > hi) hi = q;
    }
    CI[bx + CN * (by + NY / 4 * bz)] = lo === hi && lo * lo === 16129 ? +(lo > 0) : (n++, n + 1);
  }
  CG = CG.slice(0, n * 64);
}
await say('Carving canyons…', 0.32, 400);
const T = buildTerrain(D);

// preset viewpoints (position, look-at), keys 1-6; the world generator dresses the scene around them
const POSES = [
  [10, 1.3, 7, -9, -31, -10],
  [50, 1.3, 34, 58, -23, 8],
  [-26, 2.2, -100, 0, -9, -108],
  [-55, 1.5, -18, -60, -30, 8],
  [10, 1.2, -62, 6, -22, -90],
  [3, 1.6, 62, 1, -28, 100],
];
// 60 s camera path (position + look-at, Catmull-Rom): the world generator keeps it clear, dev.js flies along it
const FLY = new Float32Array([
  10, -42.2, 7, -9, -31, -10,
  7.5, -41.8, 5.5, -10, -31, -12,
  9, -40.5, 18, 17, -37, 42,
  22, -39.2, 40, 48, -36, 45,
  38, -39.2, 46, 57, -27, 18,
  50, -40.4, 35, 58, -24, 8,
  55, -39, 20, 60, -18, -10,
  58, -34, -12, 40, -26, -60,
  50, -30, -44, 10, -26, -80,
  30, -30, -70, 4, -28, -90,
  12, -38.5, -62, 6, -27, -90,
  -4, -36.5, -70, 0, -14, -100,
  -16, -37, -84, 0, -22, -108,
  -29, -38, -90, -44, -34, -60,
  -41, -38, -70, -56, -34, -40,
  -53, -38, -50, -60, -34, -20,
  -58, -38, -28, -60, -32, 0,
  -57, -38, -10, -60, -30, 16,
  -60, -38, 10, -50, -36, 40,
  -52, -37, 36, -20, -35, 44,
  -22, -38, 43, 4, -38, 52,
  -6, -39.2, 44.5, 4, -37, 70,
  3, -40.6, 53, 3, -35, 84,
  3, -41.5, 62, 1, -30, 100,
  4, -39, 76, 3, -22, 100,
]);
const FLYN = FLY.length / 6, FLYT = 60, LUTN = 1024, flyLUT = new Float32Array(LUTN + 1);
const flyPts = [];
// per-frame float state lives in one preallocated array, so the frame loop allocates no heap numbers
const F = new Float64Array(32), P6 = new Float64Array(6);
const CX = 0, CY = 1, CZ = 2, YAW = 3, PIT = 4, FX = 5, FY = 6, FZ = 7, RX = 8, RZ = 9, UX = 10, UY = 11, UZ = 12, VX = 13, VY = 14, VZ = 15, TIME = 16, FLT = 17, LAST = 18, GPU = 19, HUDT = 20, SPL = 21, MX = 22, MY = 23, MZ = 24;
// aim the camera from P6 = position + look-at point
function aim() {
  const dx = P6[3] - P6[0], dy = P6[4] - P6[1], dz = P6[5] - P6[2];
  F[CX] = P6[0]; F[CY] = P6[1]; F[CZ] = P6[2];
  F[YAW] = atan2(dx, -dz); F[PIT] = atan2(dy, sqrt(dx * dx + dz * dz));
}
const lookAt = (x, y, z, tx, ty, tz) => { P6[0] = x; P6[1] = y; P6[2] = z; P6[3] = tx; P6[4] = ty; P6[5] = tz; aim(); taaReset = 1; }; // a jump: no history
// camera spline (Catmull-Rom over position + look-at) at parameter F[SPL]
function flyRaw() {
  const s = F[SPL]; let i = floor(s) | 0; if (i > FLYN - 2) i = FLYN - 2;
  const u = s - i, i0 = (i > 0 ? i - 1 : 0) * 6, i1 = i * 6, i2 = (i + 1) * 6, i3 = (i + 2 < FLYN ? i + 2 : FLYN - 1) * 6;
  for (let o = 0; o < 6; o++) {
    const a = FLY[i0 + o], b = FLY[i1 + o], c = FLY[i2 + o], d = FLY[i3 + o];
    P6[o] = 0.5 * (2 * b + (c - a) * u + (2 * a - 5 * b + 4 * c - d) * u * u + (3 * b - a - 3 * c + d) * u * u * u);
  }
  aim();
}
{ // arc-length table: flyLUT[k] = spline parameter at fraction k/LUTN of the total path length
  const M = 4096, len = new Float32Array(M + 1); let px = 0, py = 0, pz = 0;
  for (let k = 0; k <= M; k++) { F[SPL] = k / M * (FLYN - 1); flyRaw(); if (k) len[k] = len[k - 1] + hypot(F[CX] - px, F[CY] - py, F[CZ] - pz); px = F[CX]; py = F[CY]; pz = F[CZ]; }
  for (let k = 0, j = 0; k <= LUTN; k++) { const d = k / LUTN * len[M]; while (j < M - 1 && len[j + 1] < d) j++; flyLUT[k] = (j + (d - len[j]) / max(len[j + 1] - len[j], 1e-6)) / M * (FLYN - 1); }
}
// camera on the scripted path at time F[FLT]
function flyAt() {
  let s = F[FLT] / FLYT; s = s < 0 ? 0 : s > 1 ? 1 : s; s = s * s * (3 - 2 * s) * 0.25 + s * 0.75;
  s *= LUTN; let k = floor(s) | 0; if (k > LUTN - 1) k = LUTN - 1;
  F[SPL] = flyLUT[k] + (flyLUT[k + 1] - flyLUT[k]) * (s - k); flyRaw();
}
for (let t = 0; t <= FLYT; t += 0.1) { F[FLT] = t; flyAt(); flyPts.push([F[CX], F[CY], F[CZ]]); }
for (const p of POSES) flyPts.push([p[0], -40, p[2]]);

await say('Growing kelp…', 0.73, 2500);
const Wd = makeWorld(D, T, flyPts, POSES);
for (const p of POSES) p[1] += Wd.gy(p[0], p[2]);
D = Wd.gy = T.smp = null; // with gy goes the generator's working memory (about 200 MB)

await say('Building set pieces…', 0.94, 1200);
// mesh ids: 0-3 boulders, 4-6 sponges, 7-8 coral, 9 tube sponge, 10 whale fluke, 11 ship, 12 manta, 13 fish,
// 14-20 rock chunks + pebbles, 21-22 coral LOD, 23-25 far LOD of the large rock chunks
const meshes = [meshChunk(1, 3), meshChunk(7, 3), meshChunk(13, 3), meshChunk(22, 3),
  meshLathe([[0, 0, 0.5], [0.34, 0, 0.6], [0.5, 0.2, 0.85], [0.6, 0.6, 1], [0.55, 0.95, 1], [0.47, 1.08, 1], [0.38, 1.1, 0.9], [0.3, 1.0, 0.45], [0.26, 0.6, 0.15], [0, 0.35, 0.05]], 18, 0.3, 9),
  meshLathe([[0, 0, 0.5], [0.2, 0, 0.6], [0.26, 0.5, 0.85], [0.4, 1.25, 1], [0.4, 1.42, 1], [0.33, 1.48, 0.9], [0.26, 1.38, 0.4], [0.18, 0.8, 0.12], [0, 0.5, 0.05]], 16, 0.35, 8),
  meshLathe([[0, 0, 0.5], [0.5, 0, 0.7], [0.72, 0.18, 1], [0.74, 0.38, 1], [0.62, 0.5, 0.9], [0.48, 0.42, 0.45], [0.4, 0.2, 0.15], [0, 0.14, 0.06]], 18, 0.25, 10),
  meshCoral(0), meshCoral(1), meshTubes()].map((m) => m.build());
meshes.push(meshFluke(), meshShip().build(), meshManta().build(), meshFish().build(),
  meshChunk(3).build(), meshChunk(11).build(), meshChunk(29).build(), meshChunk(5, 3).build(), meshChunk(17, 3).build(), meshChunk(41, 3).build(), meshChunk(9, 1).build(), meshCoral(0, 1).build(), meshCoral(1, 1).build(), meshChunk(5, 2, 1).build(), meshChunk(17, 2, 1).build(), meshChunk(41, 2, 1).build());
// ---------------------------------------------------------------- geometry for the GPU
// One vertex buffer (the terrain's vertices, then the meshes') and one index buffer of absolute indices (the terrain in
// clusters, then the meshes), read by the visibility pass as storage and by the shadow bake as vertex / index buffers.
const TC = clusterTerrain(T), nT = T.nv, I0 = TC.ib.length;
let nV = nT, nI = I0;
for (const m of meshes) { m.v0 = nV; m.i0 = nI; nV += m.nv; nI += m.ib.length; }
const allV = new Uint8Array(nV * 16), allI = new Uint32Array(nI);
allV.set(new Uint8Array(T.vb)); allI.set(TC.ib);
for (const m of meshes) { allV.set(new Uint8Array(m.vb), m.v0 * 16); for (let j = 0; j < m.ib.length; j++) allI[m.i0 + j] = m.ib[j] + m.v0; }
// bounding radius of each mesh around its origin
const meshR = meshes.map((m) => { const f = new Float32Array(m.vb); let r = 0; for (let k = 0; k < m.nv; k++) r = max(r, hypot(f[k * 4], f[k * 4 + 1], f[k * 4 + 2])); return r; });
const SV_ = BU.VERTEX | BU.STORAGE;
const vbAll = buf(allV, SV_), ibAll = buf(allI, BU.INDEX | BU.STORAGE), tbClusters = buf(TC.box, BU.STORAGE);
// solid instances, 48 bytes each: the set pieces and boulders (by mesh), the terrain's identity, the rock chunks and the
// props. Each belongs to a class (CLS) that says which mesh it is drawn with up to which distance (see W_CULL).
const nSolid = Wd.solids.data.length / 12, chunkAt = [], propAt = [];
let nSI = nSolid + 1;
for (const c of Wd.chunks) { chunkAt.push(nSI); nSI += c.n; }
for (const c of Wd.props) { propAt.push(nSI); nSI += c.n; }
const solidData = new Float32Array(nSI * 12), cls = new Uint32Array(nSI).fill(~0), CLASSES = [];
solidData.set(Wd.solids.data); solidData.set([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0], nSolid * 12);
const addClass = (at, n, near, far, d0, d1) => { cls.fill(CLASSES.length, at, at + n); CLASSES.push([near, far, d0, d1, n]); };
for (let m = 0; m < 12; m++) { const g = Wd.solids.ranges[m]; addClass(g[0], g[1], m, -1, -1, -1); }
Wd.chunks.forEach((c, i) => { const big = i > 2 && i < 6, d = i > 5 ? 30 : big ? 40 : 96; solidData.set(c.data, chunkAt[i] * 12); addClass(chunkAt[i], c.n, 14 + i, big ? 20 + i : -1, d, big ? 150 : d); });
Wd.props.forEach((c, i) => { const lod = i === 3 || i === 4; solidData.set(c.data, propAt[i] * 12); addClass(propAt[i], c.n, 4 + i, lod ? 18 + i : -1, lod ? 6 : 110, 110); });
const siAll = buf(solidData, SV_), clsBuf = buf(cls, BU.STORAGE);
const nFish = Wd.fish.length / 8, nManta = Wd.mantas.length / 8, nAnim = nFish + nManta;
const animData = new Float32Array(nAnim * 8); animData.set(Wd.fish); animData.set(Wd.mantas, nFish * 8);
const aiAll = buf(animData, BU.STORAGE);
// leaves, 36 bytes each: the near set (big), its decimated far version (bigF), the small plants
const nBig = Wd.big.n, nBigF = Wd.bigF.n, nLeaf = nBig + nBigF + Wd.small.n;
const leafData = new Uint8Array(nLeaf * 36);
leafData.set(new Uint8Array(Wd.big.buf)); leafData.set(new Uint8Array(Wd.bigF.buf), nBig * 36); leafData.set(new Uint8Array(Wd.small.buf), (nBig + nBigF) * 36);
const lbAll = buf(leafData, SV_);
const ibBubbles = buf(Wd.bubbles, BU.VERTEX), ibSnowB = buf(Wd.snow, BU.VERTEX);
const ibGl = buf(Wd.glints, BU.VERTEX), nGl = Wd.glints.length / 8;
const nBub = Wd.bubbles.length / 8, nSnow = Wd.snow.length / 4;
const MANTA = meshes[12], FISH = meshes[13];
Q.writeTexture({ texture: tVol }, Wd.volD, { bytesPerRow: NX, rowsPerImage: NY / 2 }, [NX / 2, NY / 2, NZ / 2]);
Q.writeTexture({ texture: tMap }, Wd.gm, { bytesPerRow: 2048 }, [512, 512]);

// ---------------------------------------------------------------- draws (GPU-driven)
// 33 indirect draws: 0 terrain clusters, 1 + m solid mesh m, 27 fish, 28 mantas, 29-32 leaves (9, 5 and 3 rows of the
// near set, the far set, the small plants). The cull pass fills each draw's segment of the visible list and its count.
const ND = 33, DKIND = (d) => d === 0 ? 0 : d < 27 ? 1 : d < 29 ? d - 25 : d - 25;
const cap = new Uint32Array(ND), ARGT = new Uint32Array(ND * 4);
cap[0] = TC.nCl; ARGT.set([768, 0, 0, 0], 0);
for (const [near, far, , , n] of CLASSES) { cap[1 + near] += n; if (far >= 0) cap[1 + far] += n; }
for (let m = 0; m < 26; m++) ARGT.set([meshes[m].ib.length, 0, meshes[m].i0, 0], (1 + m) * 4);
cap[27] = nFish; ARGT.set([FISH.ib.length, 0, FISH.i0, 0], 27 * 4);
cap[28] = nManta; ARGT.set([MANTA.ib.length, 0, MANTA.i0, 0], 28 * 4);
cap[29] = cap[30] = nBig; cap[31] = nBigF; cap[32] = Wd.small.n;
[18, 10, 6, 6].forEach((v, i) => ARGT.set([v, 0, 0, 0], (29 + i) * 4));
const base = new Uint32Array(ND); let nVis = 0;
for (let d = 0; d < ND; d++) { base[d] = nVis; nVis += cap[d]; }
const visBuf = device.createBuffer({ size: max(4, nVis * 4), usage: BU.STORAGE });
const argsBuf = device.createBuffer({ size: ND * 16, usage: BU.INDIRECT | BU.STORAGE | BU.COPY_DST });
const diData = new Uint32Array(ND * 64);
for (let d = 0; d < ND; d++) { diData[d * 64] = base[d]; diData[d * 64 + 1] = DKIND(d); }
const diBuf = buf(diData, BU.UNIFORM);
// cull uniforms (struct CU): 0 planes, 20 camera + det, 24 counts, 28 leaf ranges, 32 segment bases, 68 classes, 196 radii
const CUB = new ArrayBuffer(896), CUF = new Float32Array(CUB), CUU = new Uint32Array(CUB);
CUU.set([TC.nCl, nSI, nAnim, nLeaf], 24); CUU.set([nBig, nBig + nBigF, nFish, 0], 28); CUU.set(base, 32);
CLASSES.forEach(([near, far, d0, d1], i) => CUF.set([near, far, d0, d1], 68 + i * 4));
CUF.set(meshR.slice(0, 26), 196);
const cullU = device.createBuffer({ size: 896, usage: BU.UNIFORM | BU.COPY_DST });
const bgCull = device.createBindGroup({ layout: bglCull, entries: [cullU, tbClusters, siAll, clsBuf, aiAll, lbAll, visBuf, argsBuf].map((b, binding) => ({ binding, resource: { buffer: b } })) });
const geo = [vbAll, ibAll, siAll, aiAll, lbAll].map((b, binding) => ({ binding, resource: { buffer: b } }));
const bgGeo = device.createBindGroup({ layout: bglGeo, entries: [...geo, { binding: 5, resource: { buffer: visBuf } }] });
const bgDI = device.createBindGroup({ layout: bglDI, entries: [{ binding: 0, resource: { buffer: diBuf, size: 8 } }] });
// the visibility pass never changes: record it once
const visBundle = (() => {
  const r = device.createRenderBundleEncoder({ colorFormats: [VISF], depthStencilFormat: DEPTH });
  r.setBindGroup(0, bg0); r.setBindGroup(1, bgGeo);
  for (let d = 0; d < ND; d++) {
    if (!cap[d]) continue;
    const k = DKIND(d); r.setPipeline(k === 0 ? pVisT : k === 1 ? pVisS : k < 4 ? pVisA : pVisL);
    r.setBindGroup(2, bgDI, [d * 256]); r.drawIndirect(argsBuf, d * 16);
  }
  return r.finish();
})();

// ---------------------------------------------------------------- one-time bakes: detail texture, shadow map
{
  const m = mod(W_DETAIL), p = device.createRenderPipeline({ layout: 'auto', vertex: { module: m, entryPoint: 'vs' }, fragment: { module: m, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] } });
  const e = device.createCommandEncoder();
  let r = e.beginRenderPass({ colorAttachments: [colorAtt(tDetail.createView({ baseMipLevel: 0, mipLevelCount: 1 }), true)] });
  r.setPipeline(p); r.draw(3); r.end();
  for (let i = 1; i < 11; i++) {
    r = e.beginRenderPass({ colorAttachments: [colorAtt(tDetail.createView({ baseMipLevel: i, mipLevelCount: 1 }), true)] });
    r.setPipeline(pMip8); r.setBindGroup(0, blitBG(tDetail.createView({ baseMipLevel: i - 1, mipLevelCount: 1 }))); r.draw(3); r.end();
  }
  r = e.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: tShadow.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } });
  r.setBindGroup(0, bg0s);
  r.setPipeline(pTerrSh);
  r.setVertexBuffer(0, vbAll); r.setVertexBuffer(1, siAll); r.setIndexBuffer(ibAll, 'uint32');
  r.drawIndexed(I0, 1, 0, 0, nSolid);
  r.setPipeline(pSolidSh);
  for (let i = 0; i < 12; i++) { const g = Wd.solids.ranges[i]; if (g[1]) r.drawIndexed(meshes[i].ib.length, g[1], meshes[i].i0, 0, g[0]); }
  // small rocks, sponges and corals (~35M triangles) only on High: too much for a phone's driver
  if (!LV) for (let i = 0; i < NCHUNK; i++) if (Wd.chunks[i].n) r.drawIndexed(meshes[14 + i].ib.length, Wd.chunks[i].n, meshes[14 + i].i0, 0, chunkAt[i]);
  if (!LV) for (let i = 0; i < 6; i++) if (Wd.props[i].n) r.drawIndexed(meshes[4 + i].ib.length, Wd.props[i].n, meshes[4 + i].i0, 0, propAt[i]);
  r.setPipeline(pLeafSh); r.setVertexBuffer(0, lbAll); r.draw(6, nBig);
  r.end();
  Q.submit([e.finish()]);
}
// the GPU has its own copies now: let go of the generator's (about 300 MB)
for (const o of [Wd.big, Wd.bigF, Wd.small, ...Wd.chunks, ...Wd.props]) o.buf = o.data = 0;
Wd.glints = Wd.volD = Wd.gm = T.vb = T.ib = T.wp = T.wn = 0;

// ---------------------------------------------------------------- render targets (rebuilt on resize)
// The scene is drawn at `pix` pixels and scaled up to the window. frame() tunes it and the draw distance scale `det`
// for 60 fps; both start where the last visit left them.
const PIXMAX = 2560 * 1440, PIXMIN = mob ? 25e4 : 5e5, DETMIN = 0.4;
let W = 0, H = 0, DW = 0, DH = 0, pix = +SV[1] || (LV > 1 ? 41e4 : mob ? 1280 * 720 : PIXMAX), det = +SV[2] || 1, dynN = 0, dynT = 0, dynG = 0, dynGN = 0, dynBad = 0, dynOk = 0, dynWait = 3;
let passVis, passScene, passRays, bgRes, bgRays, bloomPass = [], targets = [];
// ping-pong: [k] reads last frame's history k ^ 1 and writes k
let passRT = [], bgRT = [], passTAA = [], bgTAA = [], bgPost = [], bgBloom0 = [], ping = 0, taaReset = 1;
const NB = 6;
function resize() {
  DW = max(2, round(canvas.clientWidth * devicePixelRatio)); DH = max(2, round(canvas.clientHeight * devicePixelRatio));
  const s = min(1, sqrt(pix / (DW * DH)));
  const w = max(2, round(DW * s) & ~1), h = max(2, round(DH * s) & ~1);
  if (w === W && h === H) return;
  dynN = dynG = dynGN = 0; dynT = -300; // let the new size settle before measuring again
  W = w; H = h; canvas.width = W; canvas.height = H; taaReset = 1;
  ctx.configure({ device, format: FMT, alphaMode: 'opaque' });
  for (const t of targets) t.destroy();
  const RT = TU.RENDER_ATTACHMENT | TU.TEXTURE_BINDING;
  const tVis = tex(W, H, VISF, RT), tDp = tex(W, H, DEPTH, RT), tRes = tex(W, H, HDR, RT), tRay = tex(W / 2, H / 2, HDR, RT);
  const tRH = [0, 1].map(() => tex(W / 2, H / 2, HDR, RT)), tHist = [0, 1].map(() => tex(W, H, HDR, RT));
  targets = [tVis, tDp, tRes, tRay, ...tRH, ...tHist];
  const bl = [];
  for (let i = 0; i < NB; i++) { const t = tex(max(1, W >> (i + 1)), max(1, H >> (i + 1)), HDR, RT); bl.push(t); targets.push(t); }
  const vDp = tDp.createView(), vRes = tRes.createView(), vRay = tRay.createView(), vRH = tRH.map((t) => t.createView()), vHist = tHist.map((t) => t.createView()), vBl = bl.map((t) => t.createView());
  passVis = { colorAttachments: [{ view: tVis.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [4294967295, 0, 0, 0] }],
    depthStencilAttachment: { view: vDp, depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'store' } };
  passScene = { colorAttachments: [{ view: vRes, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    depthStencilAttachment: { view: vDp, depthLoadOp: 'load', depthStoreOp: 'store' } };
  bgRes = device.createBindGroup({ layout: bglGeoR, entries: [...geo, { binding: 6, resource: tVis.createView() }] });
  passRays = { colorAttachments: [colorAtt(vRay, true)] };
  bgRays = device.createBindGroup({ layout: pRays.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubo } }, { binding: 1, resource: sRep }, { binding: 2, resource: sCmp },
    { binding: 3, resource: tShadow.createView() }, { binding: 4, resource: tWater.createView() }, { binding: 5, resource: vDp }, { binding: 6, resource: tVol.createView() }, { binding: 7, resource: sClamp }] });
  const ub = { binding: 0, resource: { buffer: ubo } }, sc = { binding: 1, resource: sClamp };
  for (let k = 0; k < 2; k++) {
    passRT[k] = { colorAttachments: [colorAtt(vRH[k], true)] };
    bgRT[k] = device.createBindGroup({ layout: pRT.getBindGroupLayout(0), entries: [ub, sc, { binding: 2, resource: vRay }, { binding: 3, resource: vRH[k ^ 1] }] });
    passTAA[k] = { colorAttachments: [colorAtt(vHist[k], true)] };
    bgTAA[k] = device.createBindGroup({ layout: pTAA.getBindGroupLayout(0), entries: [ub, sc, { binding: 2, resource: vRes }, { binding: 3, resource: vHist[k ^ 1] }, { binding: 4, resource: vDp }] });
    bgPost[k] = device.createBindGroup({ layout: pPost.getBindGroupLayout(0), entries: [ub, sc, { binding: 2, resource: vHist[k] },
      { binding: 3, resource: vRH[k] }, { binding: 4, resource: vBl[0] }, { binding: 5, resource: vDp }] });
    bgBloom0[k] = blitBG(vHist[k]);
  }
  passPost = { colorAttachments: [{ view: null, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] };
  // bloom: down hist -> b0 -> ... -> b5 ; up: b5 -> b4 (additive) ... -> b0
  bloomPass = []; bloomBG = [null];
  for (let i = 0; i < NB; i++) { bloomPass.push({ colorAttachments: [colorAtt(vBl[i], true)] }); if (i) bloomBG.push(blitBG(vBl[i - 1])); }
  for (let i = NB - 1; i > 0; i--) { bloomPass.push({ colorAttachments: [colorAtt(vBl[i - 1], false)] }); bloomBG.push(blitBG(vBl[i])); }
  UB[52] = W; UB[53] = H; UB[54] = 1 / W; UB[55] = 1 / H;
}
let passPost, bloomBG = [];
resize();
addEventListener('resize', resize);

// ---------------------------------------------------------------- timing (GPU timestamp queries)
let qs, qResolve, qRead = [], tsBegin, tsEnd;
if (hasTS) {
  qs = device.createQuerySet({ type: 'timestamp', count: 2 });
  qResolve = device.createBuffer({ size: 16, usage: BU.QUERY_RESOLVE | BU.COPY_SRC });
  for (let i = 0; i < 6; i++) {
    const b = device.createBuffer({ size: 16, usage: BU.MAP_READ | BU.COPY_DST });
    const o = { b, busy: false, done: null };
    o.done = () => {
      const a = new BigInt64Array(b.getMappedRange());
      const ms = Number(a[1] - a[0]) / 1e6; F[GPU] = ms; b.unmap(); o.busy = false;
      if (dynT > 0 && ms > 0 && ms < 1e3) { dynG += ms; dynGN++; }
    };
    qRead.push(o);
  }
  tsBegin = { querySet: qs, beginningOfPassWriteIndex: 0 }; tsEnd = { querySet: qs, endOfPassWriteIndex: 1 };
}

// ---------------------------------------------------------------- frame
let hud = false;
let kf = 0, kb = 0, kl = 0, kr = 0, ku = 0, kd = 0, ks = 0, mdx = 0, mdy = 0, lkx = 0, lky = 0, l2x = 0, l2y = 0, hN = 0, hMax = 0, hMin = 1e9, hPer = 1e9, hLate = 0, hTot = 0, jx = 0, jy = 0;
const TANH = 0.6, NEAR = 0.1, EXPO = 0.62, RAYS = 0.54;
const submitList = [null];
// sub-pixel jitter for the temporal anti-aliasing: Halton (2, 3), 8 positions
const halton = (i, b) => { let f = 1, r = 0; for (; i > 0; i = floor(i / b)) { f /= b; r += f * (i % b); } return r; };
const JIT = Array.from({ length: 16 }, (_, k) => halton((k >> 1) + 1, k & 1 ? 3 : 2) - 0.5);
const PVP = new Float32Array(16);
let nFrame = 0, waterAt = -1e9;
function render() {
  // camera basis (right vector is horizontal)
  const cx = F[CX], cy = F[CY], cz = F[CZ], pitch = F[PIT], yaw = F[YAW];
  const cp = cos(pitch), fy = sin(pitch), rx = cos(yaw), rz = sin(yaw), fx = cp * rz, fz = -cp * rx;
  const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
  F[FX] = fx; F[FY] = fy; F[FZ] = fz; F[RX] = rx; F[RZ] = rz; F[UX] = ux; F[UY] = uy; F[UZ] = uz;
  const asp = W / H, sx = 1 / (TANH * asp), sy = 1 / TANH, m = UB;
  m[0] = rx * sx; m[4] = 0; m[8] = rz * sx; m[12] = -(rx * cx + rz * cz) * sx;
  m[1] = ux * sy; m[5] = uy * sy; m[9] = uz * sy; m[13] = -(ux * cx + uy * cy + uz * cz) * sy;
  m[2] = 0; m[6] = 0; m[10] = 0; m[14] = NEAR;
  m[3] = fx; m[7] = fy; m[11] = fz; m[15] = -(fx * cx + fy * cy + fz * cz);
  // frustum planes for culling (left, right, bottom, top, near), from the matrix before the jitter
  for (let i = 0; i < 5; i++) {
    const r = i >> 1, sg = i & 1 ? -1 : 1, k = i < 4 ? 1 : 0;
    let a = m[3] + sg * m[r] * k, b = m[7] + sg * m[4 + r] * k, c = m[11] + sg * m[8 + r] * k, d = m[15] + sg * m[12 + r] * k;
    if (i === 4) { a = m[3] - m[2]; b = m[7] - m[6]; c = m[11] - m[10]; d = m[15] - m[14]; }
    const l = sqrt(a * a + b * b + c * c); CUF[i * 4] = a / l; CUF[i * 4 + 1] = b / l; CUF[i * 4 + 2] = c / l; CUF[i * 4 + 3] = d / l;
  }
  CUF[20] = cx; CUF[21] = cy; CUF[22] = cz; CUF[23] = det;
  // last frame's view-projection, then this frame's with the jitter
  if (taaReset) PVP.set(m.subarray(0, 16));
  m.set(PVP, 64); PVP.set(m.subarray(0, 16));
  const j = (nFrame & 7) * 2, jx = JIT[j] * 2 / W, jy = JIT[j + 1] * 2 / H;
  for (let c = 0; c < 4; c++) { m[c * 4] += jx * m[c * 4 + 3]; m[c * 4 + 1] += jy * m[c * 4 + 3]; }
  m[60] = jx; m[61] = jy; m[62] = taaReset; m[63] = (nFrame * 0.618034) % 1;
  m[32] = cx; m[33] = cy; m[34] = cz; m[35] = F[TIME];
  m[36] = rx; m[37] = 0; m[38] = rz; m[39] = TANH * asp;
  m[40] = ux; m[41] = uy; m[42] = uz; m[43] = TANH;
  m[44] = fx; m[45] = fy; m[46] = fz; m[47] = NEAR;
  const zx = cx - PURPLE[0], zz = cz - PURPLE[1]; let zt = (44 - sqrt(zx * zx + zz * zz)) / 18; zt = zt < 0 ? 0 : zt > 1 ? 1 : zt;
  m[51] = zt * zt * (3 - 2 * zt);
  let ek = (-cy - 8) / 26; ek = ek < 0 ? 0 : ek > 1 ? 1 : ek;
  m[56] = EXPO * (0.6 + 0.4 * ek); m[57] = RAYS; m[58] = det;
  Q.writeBuffer(ubo, 0, UB);
  Q.writeBuffer(cullU, 0, CUB);
  Q.writeBuffer(argsBuf, 0, ARGT); // the visible counts start at 0

  const e = device.createCommandEncoder();
  let slot = null;
  if (hasTS) { for (let i = 0; i < qRead.length; i++) if (!qRead[i].busy) { slot = qRead[i]; break; } }
  passPost.timestampWrites = slot ? tsEnd : undefined;
  // culling
  const c = e.beginComputePass(slot ? { timestampWrites: tsBegin } : undefined);
  c.setBindGroup(0, bgCull);
  c.setPipeline(pCullT); c.dispatchWorkgroups(ceil(TC.nCl / 64));
  c.setPipeline(pCullS); c.dispatchWorkgroups(ceil(nSI / 64));
  c.setPipeline(pCullA); c.dispatchWorkgroups(ceil(nAnim / 64));
  c.setPipeline(pCullL); c.dispatchWorkgroups(ceil(nLeaf / 64));
  c.end();
  // animated water texture + mips, at most ~60 times a second
  let r;
  if (F[LAST] - waterAt > 15.5 || F[LAST] < waterAt) {
    waterAt = F[LAST]; WT[0] = F[TIME]; Q.writeBuffer(uboW, 0, WT);
    r = e.beginRenderPass(waterPass[0]); r.setPipeline(pWater); r.setBindGroup(0, bgWater); r.draw(3); r.end();
    for (let i = 1; i < 5; i++) { r = e.beginRenderPass(waterPass[i]); r.setPipeline(pMip16); r.setBindGroup(0, waterBG[i - 1]); r.draw(3); r.end(); }
  }
  // visibility buffer, then each pixel shaded once; the water, the background and the sprites forward on top
  r = e.beginRenderPass(passVis); r.executeBundles([visBundle]); r.end();
  r = e.beginRenderPass(passScene);
  r.setBindGroup(0, bg0); r.setBindGroup(1, bgRes);
  r.setPipeline(pRes); r.draw(3);
  r.setPipeline(pSurf); r.draw(4);
  r.setPipeline(pBack); r.draw(4);
  r.setPipeline(pBub); r.setVertexBuffer(0, ibBubbles); r.draw(4, nBub);
  r.setPipeline(pGl); r.setVertexBuffer(0, ibGl); r.draw(4, nGl);
  r.setPipeline(pSnow); r.setVertexBuffer(0, ibSnowB); r.draw(4, nSnow);
  r.end();
  const k = ping ^= 1;
  // light shafts (half res), accumulated over frames
  r = e.beginRenderPass(passRays); r.setPipeline(pRays); r.setBindGroup(0, bgRays); r.draw(3); r.end();
  r = e.beginRenderPass(passRT[k]); r.setPipeline(pRT); r.setBindGroup(0, bgRT[k]); r.draw(3); r.end();
  // temporal anti-aliasing
  r = e.beginRenderPass(passTAA[k]); r.setPipeline(pTAA); r.setBindGroup(0, bgTAA[k]); r.draw(3); r.end();
  // bloom
  for (let i = 0; i < bloomPass.length; i++) {
    r = e.beginRenderPass(bloomPass[i]); r.setPipeline(i === 0 ? pDown0 : i < NB ? pDown : pUp); r.setBindGroup(0, i ? bloomBG[i] : bgBloom0[k]); r.draw(3); r.end();
  }
  // composite
  passPost.colorAttachments[0].view = ctx.getCurrentTexture().createView();
  r = e.beginRenderPass(passPost); r.setPipeline(pPost); r.setBindGroup(0, bgPost[k]); r.draw(3); r.end();
  if (slot) { e.resolveQuerySet(qs, 0, 2, qResolve, 0); e.copyBufferToBuffer(qResolve, 0, slot.b, 0, 16); }
  submitList[0] = e.finish();
  Q.submit(submitList);
  if (slot) { slot.busy = true; slot.b.mapAsync(GPUMapMode.READ).then(slot.done); }
  nFrame++; taaReset = 0;
}

// CS[j] = distance to the rock (metres, < 0 in water) at the camera + CE[3j..3j+2]: the camera, then ±0.375 m on
// each axis for the gradient
const CE = new Float64Array([0, 0, 0, .375, 0, 0, -.375, 0, 0, 0, .375, 0, 0, -.375, 0, 0, 0, .375, 0, 0, -.375]), CS = new Float64Array(7);
const cv = (x, y, z) => { const b = CI[(x >> 2) + CN * ((y >> 2) + NY / 4 * (z >> 2))]; return b > 1 ? CG[b * 64 - 128 + (x & 3) + 4 * (y & 3) + 16 * (z & 3)] : b * 254 - 127; };
function sd(j) {
  const x = (F[CX] + CE[j * 3] - OX) / VS - CO, y = (F[CY] + CE[j * 3 + 1] - OY) / VS, z = (F[CZ] + CE[j * 3 + 2] - OZ) / VS - CO;
  const ix = x | 0, iy = y | 0, iz = z | 0, u = x - ix, v = y - iy, a = cv(ix, iy, iz), b = cv(ix, iy + 1, iz), c = cv(ix, iy, iz + 1), d = cv(ix, iy + 1, iz + 1);
  const p = a + (cv(ix + 1, iy, iz) - a) * u, q = b + (cv(ix + 1, iy + 1, iz) - b) * u, r = c + (cv(ix + 1, iy, iz + 1) - c) * u, s = d + (cv(ix + 1, iy + 1, iz + 1) - d) * u;
  const e = p + (q - p) * v; CS[j] = (e + (r + (s - r) * v - e) * (z - iz)) / 127;
}
// Moves the camera by F[MX..MZ] in steps shorter than its radius CR (so it can't pass through thin rock), pushing it
// back out after each step and dropping velocity into the rock, so it slides along.
const CR = 0.5;
function collide() {
  const n = floor(sqrt(F[MX] * F[MX] + F[MY] * F[MY] + F[MZ] * F[MZ]) / 0.4) + 1;
  for (let i = 0; i < n; i++) {
    F[CX] += F[MX] / n; F[CY] += F[MY] / n; F[CZ] += F[MZ] / n;
    for (let k = 0; k < 2; k++) {
      sd(0); const s = CS[0] + CR; if (s <= 0) break;
      for (let j = 1; j < 7; j++) sd(j);
      let gx = CS[1] - CS[2], gy = CS[3] - CS[4], gz = CS[5] - CS[6]; const l = sqrt(gx * gx + gy * gy + gz * gz);
      if (l < 0.075) break; // flat: deep in rock
      gx /= l; gy /= l; gz /= l; const vn = F[VX] * gx + F[VY] * gy + F[VZ] * gz;
      F[CX] -= gx * s; F[CY] -= gy * s; F[CZ] -= gz * s;
      if (vn > 0) { F[VX] -= gx * vn; F[VY] -= gy * vn; F[VZ] -= gz * vn; }
    }
  }
}

function frame(now) {
  if (leaving) return; // the device is gone
  requestAnimationFrame(frame);
  const dtr = now - F[LAST]; F[LAST] = now;
  let dt = dtr / 1000; if (dt > 0.1) dt = 0.1;
  // Dynamic resolution for 60 fps: every second (0.4 s behind the menu) scale the load by k
  if (dtr < 1e3 && (dynT += dtr) > 0 && (dynN++, dynT > (menu ? 400 : 1000))) {
    const a = dynT / dynN, g = dynGN ? dynG / dynGN : 0; let k = 1;
    // with GPU timing: keep it between 9.8 and 13.6 ms
    if (g) { if (g > 13.6 || g < 9.8) k = 11.7 / g; }
    // without: slow for two periods in a row means fewer pixels, and twice as long before trying to go back up
    else if (a > 17.6) { dynOk = 0; if (++dynBad > 1) { k = 15 / a; dynBad = 0; dynWait = min(dynWait * 2, 60); } }
    // at the display's rate there is no telling if there is room, so try a little more now and then
    else { dynBad = 0; if (a < 12.5) k = 15 / a; else if (++dynOk > dynWait) { k = 1.17; dynOk = 0; } }
    k = k < 0.5 ? 0.5 : k > 1.7 ? 1.7 : k; const top = min(PIXMAX, DW * DH), mid = max(top / 2, PIXMIN), was = pix + det;
    // too slow: pixels down to `mid` first, then draw distance, then the remaining pixels; faster goes back the same way
    if (k < 1 ? pix > mid || det <= DETMIN : pix < mid || det >= 1) {
      const end = k < 1 ? (det > DETMIN ? mid : PIXMIN) : det < 1 ? mid : top;
      pix *= k; if (k < 1 ? pix < end : pix > end) pix = end;
    } else { det *= sqrt(k); det = det < DETMIN ? DETMIN : det > 1 ? 1 : det; }
    if (was !== pix + det) keep('abyssal', [LV, pix < top ? pix | 0 : '', det]); // nothing kept at full resolution
    dynN = dynT = dynG = dynGN = 0; resize();
  }
  F[TIME] += dt;
  {
    // mouse look through two cascaded low-pass stages
    const kq = 1 - exp(-dt * 30); lkx += mdx * 0.0022; lky += mdy * 0.0022; mdx = 0; mdy = 0;
    const ax = lkx * kq, ay = lky * kq; lkx -= ax; lky -= ay; l2x += ax; l2y += ay;
    const dyw = l2x * kq, dpt = l2y * kq; l2x -= dyw; l2y -= dpt;
    const yaw = F[YAW] + dyw; let pitch = F[PIT] - dpt; pitch = pitch < -1.55 ? -1.55 : pitch > 1.55 ? 1.55 : pitch;
    // touch stick (in stick radii): a small dead zone, full speed at the ring, faster the further past it
    let sp = ks ? 26 : 7, mf = kf - kb, mr = kr - kl;
    const jd = sqrt(jx * jx + jy * jy);
    if (jd > 0.15) {
      const m = (jd > 0.9 ? 1 : (jd - 0.15) / 0.75) / jd, f = (jd - 1.1) / 0.4;
      mf -= jy * m; mr += jx * m; if (f > 0) sp += 19 * (f > 1 ? 1 : f);
    }
    const k = 1 - exp(-dt * 4.5), mu = ku - kd, cp = cos(pitch), sy = sin(yaw), cw = cos(yaw);
    const vx = F[VX] + ((sy * cp * mf + cw * mr) * sp - F[VX]) * k, vy = F[VY] + ((sin(pitch) * mf + mu) * sp - F[VY]) * k, vz = F[VZ] + ((-cw * cp * mf + sy * mr) * sp - F[VZ]) * k;
    let x = F[CX] + vx * dt, y = F[CY] + vy * dt, z = F[CZ] + vz * dt;
    const rad = sqrt(x * x + z * z); if (rad > 150) { x *= 150 / rad; z *= 150 / rad; }
    y = y < -52 ? -52 : y > -1.2 ? -1.2 : y;
    F[YAW] = yaw; F[PIT] = pitch; F[VX] = vx; F[VY] = vy; F[VZ] = vz; F[MX] = x - F[CX]; F[MY] = y - F[CY]; F[MZ] = z - F[CZ];
    collide();
  }
  render();
  if (hud) {
    hN++; if (dtr > hMax) hMax = dtr; if (dtr < hMin) hMin = dtr; if (dtr > hPer * 1.5) { hLate++; hTot++; }
    F[HUDT] += dtr / 1000;
    if (F[HUDT] > 0.5) { info.textContent = `${(hN / F[HUDT]).toFixed(0)} fps  ·  worst frame ${hMax.toFixed(1)} ms  ·  late frames ${hLate} (total ${hTot})  ·  GPU ${F[GPU].toFixed(2)} ms  ·  ${W}x${H} (${W * 100 / DW | 0}%)`; F[HUDT] = 0; hPer = hMin; hN = 0; hMax = 0; hMin = 1e9; hLate = 0; }
  }
}

// ---------------------------------------------------------------- input
const key = (e, v) => {
  switch (e.code) {
    case 'KeyW': kf = v; break; case 'KeyS': kb = v; break; case 'KeyA': kl = v; break; case 'KeyD': kr = v; break;
    case 'KeyE': ku = v; break; case 'KeyQ': kd = v; break; case 'ShiftLeft': case 'ShiftRight': ks = v; break;
    default: if (v && !e.repeat) {
      if (e.code === 'KeyH') { hud = !hud; hTot = 0; hPer = 1e9; info.textContent = ''; }
      else if (e.code === 'KeyM') mute();
      else if (e.code === 'Escape') ui(true);
      else if (e.code >= 'Digit1' && e.code <= 'Digit6') lookAt(...POSES[vp = e.code.charCodeAt(5) - 49]);
    }
  }
};
// behind the menu only the stats and mute keys work
addEventListener('keydown', (e) => { if (menu && e.code !== 'KeyH' && e.code !== 'KeyM') return; sound(); key(e, 1); });
addEventListener('keyup', (e) => key(e, 0));
const release = () => { kf = kb = kl = kr = ku = kd = ks = 0; lId = -1; idle(); };
const capture = () => { sound(); const p = canvas.requestPointerLock({ unadjustedMovement: true }); if (p && p.catch) p.catch(() => canvas.requestPointerLock()).catch(() => 0); };
canvas.addEventListener('click', capture);
addEventListener('mousemove', (e) => { if (document.pointerLockElement === canvas) { mdx += e.movementX; mdy += e.movementY; } });
addEventListener('blur', release);
// Touch: twin sticks. A finger put down on the left half is a floating stick for swimming (its base follows a finger
// dragged far past the ring), a finger on the right half drags the view. Positions are in the page's own axes, which
// turn with it when it lies on its side.
const stick = $('j'), knob = $('n'), root = document.documentElement;
let mId = -1, lId = -1, sx0 = 0, sy0 = 0, lx0 = 0, ly0 = 0, vp = 0;
const place = (x, y) => { stick.style.left = x + 'px'; stick.style.top = y + 'px'; };
const idle = () => { mId = -1; jx = jy = 0; knob.style.transform = stick.className = ''; place(body.clientWidth * 0.16, body.clientHeight * 0.66); };
const touch = (e) => {
  e.preventDefault(); sound(); root.className = 't';
  const R = rot.matches, vm = min(innerWidth, innerHeight), r = 0.14 * vm, s = 1100 / vm, end = e.type[5] !== 'm' && e.type[5] !== 's';
  for (const t of e.changedTouches) {
    const id = t.identifier, x = R ? t.clientY : t.clientX, y = R ? innerWidth - t.clientX : t.clientY;
    if (e.type === 'touchstart') {
      if (mId < 0 && x < body.clientWidth / 2) { mId = id; sx0 = x; sy0 = y; place(x, y); stick.className = 'on'; }
      else if (lId < 0) { lId = id; lx0 = x; ly0 = y; }
    } else if (id === mId) {
      if (end) { idle(); continue; }
      let dx = (x - sx0) / r, dy = (y - sy0) / r; const d = hypot(dx, dy);
      if (d > 1.6) { const k = 1.6 / d; sx0 += (dx - dx * k) * r; sy0 += (dy - dy * k) * r; dx *= k; dy *= k; place(sx0, sy0); }
      jx = dx; jy = dy; knob.style.transform = `translate(${dx * r}px,${dy * r}px)`; stick.className = d > 1.1 ? 'on f' : 'on';
    } else if (id === lId) {
      if (end) lId = -1; else { mdx += (x - lx0) * s; mdy += (y - ly0) * s; lx0 = x; ly0 = y; }
    }
  }
};
for (const n of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) canvas.addEventListener(n, touch, { passive: false });
addEventListener('resize', () => mId < 0 && idle());
// buttons in the corner: up and down while held, next viewpoint, sound, menu
const hold = (b, f) => { for (const n of ['pointerdown', 'pointerup', 'pointercancel']) b.addEventListener(n, (e) => { e.preventDefault(); f(n === 'pointerdown' ? 1 : 0); }); };
hold($('y'), (v) => ku = v); hold($('z'), (v) => kd = v);
$('x').onclick = () => lookAt(...POSES[vp = (vp + 1) % 6]);
$('v').onclick = () => { sound(); mute(); };
addEventListener('contextmenu', (e) => e.preventDefault());
// phones: keep the screen on while swimming (the lock is dropped whenever the page is hidden)
let wake = null;
const awake = (on) => { if (!mob) return; if (on) navigator.wakeLock?.request('screen').then((w) => { if (menu) w.release(); else wake = w; }, () => 0); else { wake?.release(); wake = null; } };
document.addEventListener('visibilitychange', () => !document.hidden && !menu && awake(1));

// ---------------------------------------------------------------- menu
// The scene keeps rendering (blurred by CSS) behind the menu. Esc, losing the mouse or the corner button open it.
let menu = true;
const bDive = $('d');
const ui = (m) => {
  if (dead) return;
  menu = m; body.className = m ? 'm' : document.pointerLockElement ? 'g p' : 'g';
  // focus the dive button so Enter works (delayed: it can't take focus while still hidden)
  if (m) { release(); awake(0); setTimeout(() => menu && bDive.focus(), 100); } else { document.activeElement.blur(); awake(1); }
};
const go = () => {
  sound(); ui(false); bDive.textContent = 'Resume';
  // phones: go fullscreen and ask for landscape; where that is refused the CSS rotation still applies
  if (mob) document.documentElement.requestFullscreen?.()?.then(() => screen.orientation.lock('landscape')).catch(() => 0);
  if (!mob) capture();
};
bDive.onclick = go; $('o').onclick = () => ui(true);
if (mob) root.className = 't';
// detail buttons: the current level is lit, the others reload the page with theirs
$('q').querySelectorAll('button').forEach((b, i) => { if (i === 2 - LV) b.className = 'on'; else b.onclick = () => restart(2 - i); });
document.addEventListener('pointerlockchange', () => ui(!document.pointerLockElement));

// draw the first frame and wait for the GPU to finish it (pipelines get compiled on first use) before the reveal
lookAt(...POSES[0]);
await say('Letting the light in…', 1, 400);
render(); await Q.onSubmittedWorkDone();
setTimeout(keep, 15e3, 'abyssalLoad', ''); // the load counts as survived after 15 s of frames
ui(true);
requestAnimationFrame((t) => { F[LAST] = t; requestAnimationFrame(frame); });
