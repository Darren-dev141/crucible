import assert from 'node:assert/strict';
import test from 'node:test';
import { inflateSync } from 'node:zlib';
import { cookInstalled, cookModule } from './support/cook.js';
import { encodeOpaquePng } from '../scripts/native-png.mjs';
import { POST_TOLERANCE_BYTES, mapLookToCookPost } from '../scripts/native-post-look.mjs';
import { traceFrameNative } from '../scripts/agent-native-trace.mjs';
import { encodePng } from '../src/export-png.js';
import { createCamera, toneMapToRgba8 } from '../src/path-tracer.js';

const cook = (await cookModule()) ?? {};
const addonIsBuilt = cookInstalled && cook.findNativeAddon?.() !== null;
const skipWithoutAddon = addonIsBuilt ? false : 'the native addon is not built';
const emptyExport = {
  triangleCount: 0, triangles: 0, ignored: [],
  tables: Object.fromEntries(['triangles', 'materials', 'lights', 'atlas', 'environmentColors', 'environmentTables', 'parameters'].map(name => [name, ''])),
};

// ---- The mapping ----

test('a plain frame maps to Cook post with its view transform and exposure', () => {
  assert.deepEqual(mapLookToCookPost(), { post: { viewTransform: 'aces', exposure: 1 } });
  assert.deepEqual(mapLookToCookPost({ viewTransform: 'agx', exposure: 2.5 }), { post: { viewTransform: 'agx', exposure: 2.5 } });
  assert.deepEqual(mapLookToCookPost({ viewTransform: 'neutral' }).post, { viewTransform: 'neutral', exposure: 1 });
});

test('a look table, an unknown curve or an exposure outside Cook range keeps the JavaScript path and says why', () => {
  const withLook = mapLookToCookPost({ look: { size: 2, data: new Float32Array(24) } });
  assert.equal(withLook.post, undefined);
  assert.match(withLook.reason, /3D look table/);
  const unknownCurve = mapLookToCookPost({ viewTransform: 'uchimura' });
  assert.equal(unknownCurve.post, undefined);
  assert.match(unknownCurve.reason, /"uchimura".*aces, agx, neutral/);
  assert.match(mapLookToCookPost({ exposure: 40 }).reason, /exposure 40/);
  assert.match(mapLookToCookPost({ exposure: Number.NaN }).reason, /exposure NaN/);
});

// ---- The frame loop's choice between Cook's display and the JavaScript helper ----

function sessionSequence({ withDisplay = true } = {}) {
  const calls = [];
  const pixels = 4 * 4;
  return {
    calls,
    trace(input, traceOptions) {
      calls.push(traceOptions);
      const traced = { rgba: new Float32Array(pixels * 4).fill(0.5), albedo: new Float32Array(pixels * 3), normal: new Float32Array(pixels * 3),
        depth: new Float32Array(pixels), variance: new Float32Array(pixels), adapter: 'test adapter', backend: 'test' };
      if (withDisplay) Object.assign(traced, { display: new Uint8Array(pixels * 4).fill(255), postSeconds: 0.01 });
      return { traced, route: { path: 'new-session' } };
    },
  };
}

const frame = { tracer: {}, exported: emptyExport, width: 4, height: 4, samples: 8, denoise: 'none', kernel: 'cycles' };

test('a session frame without a JavaScript filter asks for Cook post and encodes its display', async () => {
  const sequence = sessionSequence();
  const traced = await traceFrameNative({ ...frame, sequence, viewTransform: 'agx', exposure: 2 });
  assert.deepEqual(sequence.calls[0].post, { viewTransform: 'agx', exposure: 2 });
  assert.equal(traced.report.display.path, 'cook-post');
  assert.equal(traced.report.display.postSeconds, 0.01);
  assert.ok(traced.report.encodeSeconds >= 0);
});

test('a JavaScript denoiser, a temporal blend, a look table or nativePost false use the JavaScript helper', async () => {
  const wavelet = sessionSequence();
  const afterWavelet = await traceFrameNative({ ...frame, sequence: wavelet, denoise: 'wavelet' });
  assert.equal(wavelet.calls[0].post, undefined);
  assert.equal(afterWavelet.report.display.path, 'javascript');
  assert.match(afterWavelet.report.display.reason, /denoiser or temporal blend/);
  const withLook = sessionSequence();
  const lookFrame = await traceFrameNative({ ...frame, sequence: withLook, look: { size: 2, data: new Float32Array(24) } });
  assert.equal(withLook.calls[0].post, undefined);
  assert.match(lookFrame.report.display.reason, /3D look table/);
  const switchedOff = sessionSequence();
  const off = await traceFrameNative({ ...frame, sequence: switchedOff, nativePost: false });
  assert.equal(switchedOff.calls[0].post, undefined);
  assert.match(off.report.display.reason, /switched off/);
});

test('a frame whose session returned no display, or that has no session, falls back to JavaScript', async () => {
  const noDisplay = await traceFrameNative({ ...frame, sequence: sessionSequence({ withDisplay: false }) });
  assert.equal(noDisplay.report.display.path, 'javascript');
  const oneShot = await traceFrameNative({ ...frame, tracer: { traceNative: () => ({ rgba: new Float32Array(64), albedo: new Float32Array(48), normal: new Float32Array(48),
    depth: new Float32Array(16), variance: new Float32Array(16) }) } });
  assert.equal(oneShot.report.display.path, 'javascript');
  assert.match(oneShot.report.display.reason, /did not render through a session/);
});

test('the JavaScript path applies exposure as a linear multiplier and the chosen curve', async () => {
  const brighter = await traceFrameNative({ ...frame, sequence: sessionSequence({ withDisplay: false }), exposure: 2 });
  const plain = await traceFrameNative({ ...frame, sequence: sessionSequence({ withDisplay: false }) });
  assert.ok(brighter.data.length > 0 && plain.data.length > 0);
  assert.notEqual(brighter.data, plain.data, 'doubling exposure changes the picture');
});

// ---- PNG encoding ----

function decodeRaw(png) {
  const idat = [];
  for (let offset = 8; offset < png.length;) {
    const length = new DataView(png.buffer, png.byteOffset + offset).getUint32(0);
    const type = Buffer.from(png.subarray(offset + 4, offset + 8)).toString('latin1');
    if (type === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  return inflateSync(Buffer.concat(idat));
}

test('encodeOpaquePng writes the same picture as the portable encoder', () => {
  const rgba = new Uint8Array(5 * 3 * 4);
  rgba.forEach((_, index) => { rgba[index] = index % 4 === 3 ? 255 : (index * 37) % 256; });
  const fast = encodeOpaquePng(rgba, 5, 3);
  assert.deepEqual(Array.from(fast.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.deepEqual(decodeRaw(fast), decodeRaw(encodePng(rgba, 5, 3)));
});

// ---- Cook post against the JavaScript reference, on the real addon ----

function rgbOnly(rgba, pixelCount) {
  const linear = new Float32Array(pixelCount * 3);
  for (let pixel = 0; pixel < pixelCount; pixel++) linear.set(rgba.subarray(pixel * 4, pixel * 4 + 3), pixel * 3);
  return linear;
}

function litScene() {
  const quad = corners => ({ positions: new Float32Array(corners.flat()), normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]), colors: new Float32Array(12).fill(1), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) });
  return {
    materials: [{ color: [0.55, 0.5, 0.42], roughness: 0.7 }, { color: [1, 0.95, 0.9], emission: 12, roughness: 1 }],
    instances: [
      { geometry: quad([[-6, 0, 6], [6, 0, 6], [6, 0, -6], [-6, 0, -6]]), matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], materialIndex: 0 },
      { geometry: quad([[-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0]]), matrix: [2, 0, 0, 0, 0, 0, -2, 0, 0, 2, 0, 0, 1, 4, -1, 1], materialOverride: 1 },
    ],
  };
}

for (const look of [{ viewTransform: 'aces', exposure: 1 }, { viewTransform: 'agx', exposure: 1.5 }, { viewTransform: 'neutral', exposure: 0.7 }]) {
  test(`Cook post ${look.viewTransform} at exposure ${look.exposure} stays within ${POST_TOLERANCE_BYTES}/255 of the JavaScript helper`, { skip: skipWithoutAddon }, () => {
    const width = 96;
    const height = 54;
    const imageOptions = { width, height, samples: 4, bounces: 3, seed: 3 };
    const camera = createCamera({ eye: [0, 1.8, 6.5], target: [0, 0.2, 0], fov: 50 }, width, height);
    const session = cook.createNativeSession(cook.buildNativeInputV2(litScene(), camera, imageOptions), imageOptions);
    try {
      const { post } = mapLookToCookPost(look);
      const traced = session.render({ samples: 4, post });
      assert.equal(traced.display.length, width * height * 4);
      const linear = rgbOnly(traced.rgba, width * height).map(value => value * look.exposure);
      const reference = toneMapToRgba8(linear, width, height, { viewTransform: look.viewTransform });
      let largest = 0;
      for (let index = 0; index < reference.length; index++) {
        if (index % 4 !== 3) largest = Math.max(largest, Math.abs(reference[index] - traced.display[index]));
      }
      assert.ok(largest <= POST_TOLERANCE_BYTES, `largest channel difference ${largest}/255 is above ${POST_TOLERANCE_BYTES}/255`);
    } finally {
      session.close();
    }
  });
}
