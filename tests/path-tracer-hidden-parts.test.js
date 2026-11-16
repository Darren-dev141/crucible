// Issue 1806: the CPU path tracer never traces a part with `visible: false`, like the rasterizer, with or without local volumes.
// A hidden part that a mesh volume names still gives the volume its shape.
import assert from 'node:assert/strict';
import test from 'node:test';

import { box } from '../src/geometry.js';
import { buildTraceScene } from '../src/path-tracer-scene.js';
import { renderPathTracedImage } from '../src/path-tracer.js';

function placed(translation, scale) {
  return new Float32Array([scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, translation[0], translation[1], translation[2], 1]);
}

function surface(color) {
  return { tag: 'surface', metallic: 0, roughness: 1, emission: 0, color };
}

const environment = { keyColor: [3, 3, 3], lightDirection: [0, 1, 0] };
const camera = { eye: [0, 6, 0], target: [0, 0, 0], up: [0, 0, -1], fov: 30 };
const OPTIONS = { width: 16, height: 16, samples: 16, bounces: 2, denoise: false, threads: 1, backend: 'cpu' };

function floor() {
  return { name: 'floor', geometry: box(0, 1), matrix: placed([0, -0.05, 0], [20, 0.1, 20]), material: surface([0.5, 0.5, 0.5]) };
}

function hiddenBox(extra = {}) {
  return { name: 'hidden', geometry: box(0, 1), matrix: placed([0, 1.5, 0], [3, 0.2, 3]), material: surface([0.9, 0.2, 0.1]), visible: false, ...extra };
}

async function centreBrightness(parts, sceneEnvironment = environment) {
  const { linear } = await renderPathTracedImage({ parts, environment: sceneEnvironment, camera }, OPTIONS);
  const centre = (8 * 16 + 8) * 3;
  return linear[centre] + linear[centre + 1] + linear[centre + 2];
}

test('a hidden box casts no shadow and is not drawn in a scene without volumes', async () => {
  const lit = await centreBrightness([floor()]);
  const withHidden = await centreBrightness([floor(), hiddenBox()]);
  const withShown = await centreBrightness([floor(), hiddenBox({ visible: true })]);
  assert.ok(lit > 0.5, 'the bare floor is lit by the sun');
  assert.equal(withHidden, lit, 'the hidden box leaves the picture as the bare floor');
  assert.notEqual(withShown, lit, 'the same box, shown, changes the picture');
});

test('a part a posed scene hides with visibility.visible is left out like visible: false', async () => {
  const lit = await centreBrightness([floor()]);
  const keyed = await centreBrightness([floor(), hiddenBox({ visible: undefined, visibility: { visible: false } })]);
  assert.equal(keyed, lit);
});

test('the trace scene of a hidden part holds no triangles of it', () => {
  const bare = buildTraceScene([floor()], environment);
  const withHidden = buildTraceScene([floor(), hiddenBox()], environment);
  assert.equal(withHidden.indices.length, bare.indices.length);
  assert.equal(withHidden.materials.length, 1);
});

test('a hidden part that a mesh volume names still shapes the volume', async () => {
  const volumeEnvironment = { ...environment, localVolumes: [{ shape: 'mesh', part: 'hidden', fit: 'mesh', density: 1, falloff: 0, steps: 8 }] };
  const lit = await centreBrightness([floor()]);
  const inside = await centreBrightness([floor(), hiddenBox({ matrix: placed([0, 1.5, 0], [3, 3, 3]) })], volumeEnvironment);
  assert.ok(inside < lit * 0.9, `smoke fills the hidden box: ${inside} against ${lit}`);
  const sceneWithVolume = buildTraceScene([floor(), hiddenBox()], volumeEnvironment);
  assert.equal(sceneWithVolume.indices.length, buildTraceScene([floor()], environment).indices.length, 'the hidden box is not a wall');
});
