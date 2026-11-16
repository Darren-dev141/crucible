import assert from 'node:assert/strict';
import test from 'node:test';

import { box } from '../src/geometry.js';
import { createEnvironmentMap } from '../src/environment.js';
import { normalizePathTracerOptions, renderPathTracedImage, toneMapToRgba8 } from '../src/path-tracer.js';
import { buildTraceScene } from '../src/path-tracer-scene.js';

// The path tracer lights a scene with the terms the rasterizer reads: keyColor scaled by keyIntensity, the environment map at
// its intensity and effects.exposure on the traced picture. A scene with none of them is black (issue #1833).
const FLOOR = [{
  name: 'floor',
  geometry: box(0, 1),
  matrix: new Float32Array([8, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 8, 0, 0, -0.05, 0, 1]),
  material: { tag: 'surface', metallic: 0, roughness: 1, emission: 0, color: [0.5, 0.5, 0.5] },
}];
const CAMERA = { eye: [0, 3, 0], target: [0, 0, 0], up: [0, 0, -1], fov: 40 };
const OPTIONS = { width: 16, height: 16, samples: 8, bounces: 2, denoise: false, threads: 1 };
const SUN = { keyColor: [3, 3, 3], lightDirection: [0, 1, 0] };

function skyMap(intensity) {
  return createEnvironmentMap({ width: 8, height: 4, data: new Float32Array(8 * 4 * 3).fill(0.5), intensity });
}

function meanOf(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

async function meanLinear(environment, options = {}) {
  const { linear } = await renderPathTracedImage({ parts: FLOOR, environment, camera: CAMERA }, { ...OPTIONS, ...options });
  return meanOf(Array.from(linear));
}

test('keyIntensity scales the sun and 0 switches it off', () => {
  const sunOf = environment => buildTraceScene(FLOOR, environment).lights.sun;
  assert.equal(sunOf({ ...SUN, keyIntensity: 0 }), null);
  assert.deepEqual(sunOf({ ...SUN, keyIntensity: 0.5 }).color, [1.5, 1.5, 1.5]);
  assert.deepEqual(sunOf(SUN).color, [3, 3, 3]);
});

test('a scene with no light at all traces black', async () => {
  assert.equal(await meanLinear({}), 0);
  assert.equal(await meanLinear({ ...SUN, keyIntensity: 0, map: skyMap(0) }), 0);
});

test('the environment intensity and the sun intensity change the traced light', async () => {
  const dark = await meanLinear({ map: skyMap(0) });
  const lit = await meanLinear({ map: skyMap(1) });
  assert.equal(dark, 0);
  assert.ok(lit > 0.05, `an intensity 1 sky lights the floor (mean ${lit})`);
  const fullSun = await meanLinear({ ...SUN, keyIntensity: 1 });
  const halfSun = await meanLinear({ ...SUN, keyIntensity: 0.5 });
  assert.ok(Math.abs(halfSun / fullSun - 0.5) < 0.02, `half the key intensity gives half the light (${halfSun} against ${fullSun})`);
});

test('exposure scales the traced picture and the display bytes', async () => {
  const environment = { ...SUN, keyIntensity: 0.2 };
  const base = await renderPathTracedImage({ parts: FLOOR, environment, camera: CAMERA }, OPTIONS);
  const doubled = await renderPathTracedImage({ parts: FLOOR, environment, camera: CAMERA }, { ...OPTIONS, exposure: 2 });
  assert.deepEqual(doubled.linear, base.linear, 'exposure is a display step: the traced radiance does not change');
  assert.ok(meanOf(Array.from(doubled.rgba)) > meanOf(Array.from(base.rgba)) + 5, 'exposure 2 brightens the display bytes');
  const dimmed = await renderPathTracedImage({ parts: FLOOR, environment, camera: CAMERA }, { ...OPTIONS, exposure: 0.25 });
  assert.ok(meanOf(Array.from(dimmed.rgba)) < meanOf(Array.from(base.rgba)) - 5, 'exposure 0.25 darkens the display bytes');
});

test('toneMapToRgba8 multiplies the linear pixels by the exposure before the curve', () => {
  const linear = new Float32Array([0.2, 0.2, 0.2]);
  const base = toneMapToRgba8(linear, 1, 1);
  assert.deepEqual(toneMapToRgba8(new Float32Array([0.4, 0.4, 0.4]), 1, 1), toneMapToRgba8(linear, 1, 1, { exposure: 2 }));
  assert.notDeepEqual(base, toneMapToRgba8(linear, 1, 1, { exposure: 2 }));
});

test('an exposure that is not a positive number is refused with what to pass', () => {
  assert.equal(normalizePathTracerOptions().exposure, 1);
  for (const exposure of [0, -1, Number.NaN, '2']) assert.throws(() => normalizePathTracerOptions({ exposure }), /exposure must be a finite number above 0/);
});
