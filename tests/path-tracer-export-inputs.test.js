import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTraceScene, resolveTexture, skinnedGeometry, WRAP_CLAMP, WRAP_MIRROR, WRAP_REPEAT } from '../src/path-tracer-scene.js';
import { wrapTexelIndex } from '../src/path-tracer.js';
import { textureFlags } from '../src/path-tracer-gpu-pack.js';
import { box } from '../src/geometry.js';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const image = { data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]), width: 2, height: 1 };

function sceneWith(environment) {
  const part = { name: 'floor', geometry: box(0, 1), matrix: IDENTITY, material: { color: [1, 1, 1] } };
  return buildTraceScene([part], environment);
}

function closeTo(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-6, `expected ${expected}, got ${actual}`);
}

test('an area light aimed along the default up keeps a rectangle with two perpendicular axes', () => {
  for (const direction of [[0, -1, 0], [0, 1, 0]]) {
    const [area] = sceneWith({ areaLights: [{ position: [0, 3, 0], direction, width: 1, height: 1, intensity: 10, color: [1, 1, 1] }] }).lights.areas;
    assert.deepEqual(area.across, [1, 0, 0]);
    closeTo(Math.hypot(...area.along), 1);
    closeTo(area.along[0] * area.normal[0] + area.along[1] * area.normal[1] + area.along[2] * area.normal[2], 0);
  }
});

test('an area light with an up parallel to its direction is refused with a fix', () => {
  const light = { position: [0, 3, 0], direction: [0, -1, 0], up: [0, 1, 0], width: 1, height: 1, color: [1, 1, 1], intensity: 1 };
  assert.throws(() => sceneWith({ areaLights: [light] }), /areaLights\[0\]\.up must not be parallel.*Pass an up/);
});

test('texture wrapS and wrapT resolve on their own axes, with mirrored repeat kept', () => {
  const texture = resolveTexture({ image, wrapS: 10497, wrapT: 33071 });
  assert.equal(texture.wrapU, WRAP_REPEAT);
  assert.equal(texture.wrapV, WRAP_CLAMP);
  assert.equal(texture.repeat, false);
  const mirrored = resolveTexture({ image, wrapS: 33648, wrapT: 10497 });
  assert.equal(mirrored.wrapU, WRAP_MIRROR);
  assert.equal(mirrored.wrapV, WRAP_REPEAT);
  assert.throws(() => resolveTexture({ image, wrapT: 1234 }), /wrapT is 10497.*got 1234/);
});

test('the CPU and GPU samplers fold indices by wrap code', () => {
  assert.deepEqual([-1, 0, 1, 2, 3, 4].map(index => wrapTexelIndex(index, 2, WRAP_REPEAT)), [1, 0, 1, 0, 1, 0]);
  assert.deepEqual([-1, 0, 1, 2, 3, 4].map(index => wrapTexelIndex(index, 2, WRAP_CLAMP)), [0, 0, 1, 1, 1, 1]);
  assert.deepEqual([-2, -1, 0, 1, 2, 3, 4].map(index => wrapTexelIndex(index, 2, WRAP_MIRROR)), [1, 0, 0, 1, 1, 0, 0]);
  const flags = textureFlags({ wrapU: WRAP_REPEAT, wrapV: WRAP_MIRROR, colorLookup: new Float32Array(256) });
  assert.equal(Math.floor(flags / 2) % 2, 1);
  assert.equal(Math.floor(flags / 4) % 4, WRAP_REPEAT);
  assert.equal(Math.floor(flags / 16) % 4, WRAP_MIRROR);
  assert.equal(Math.floor(textureFlags({ wrapU: WRAP_CLAMP, wrapV: WRAP_CLAMP, colorLookup: null }) / 2) % 2, 0);
  // The two low bits keep the meaning Cook's v1 table reduction reads: bit 0 repeats both axes, bit 1 is sRGB.
  assert.equal(textureFlags({ repeat: true, wrapU: WRAP_REPEAT, wrapV: WRAP_REPEAT, colorLookup: new Float32Array(256) }) & 3, 3);
  assert.equal(textureFlags({ wrapU: WRAP_REPEAT, wrapV: WRAP_CLAMP, colorLookup: null }) & 3, 0);
});

test('a skinned normal follows the inverse transpose of a joint that scales unevenly', () => {
  const scaleX = [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const half = Math.SQRT1_2;
  const geometry = {
    positions: new Float32Array([0, 0, 0]),
    normals: new Float32Array([half, half, 0]),
    skinWeights: new Float32Array([1]),
    skinIndices: new Uint16Array([0]),
    indices: new Uint32Array([]),
  };
  const { normals } = skinnedGeometry({ geometry, skin: { jointMatrices: new Float32Array(scaleX) } });
  closeTo(normals[0], 0.4472136);
  closeTo(normals[1], 0.8944272);
  closeTo(normals[2], 0);
});

test('a rigid skinned joint still turns the normal with it', () => {
  const quarterTurnAroundZ = [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const geometry = { positions: new Float32Array([0, 0, 0]), normals: new Float32Array([1, 0, 0]), skinWeights: new Float32Array([1]), skinIndices: new Uint16Array([0]), indices: new Uint32Array([]) };
  const { normals } = skinnedGeometry({ geometry, skin: { jointMatrices: new Float32Array(quarterTurnAroundZ) } });
  closeTo(normals[0], 0);
  closeTo(normals[1], 1);
});

test('point, spot and area lights default colour to white and intensity to 1', () => {
  const lights = sceneWith({
    pointLights: [{ position: [0, 2, 0] }],
    spotLights: [{ position: [0, 2, 0], direction: [0, -1, 0], angle: 0.5 }],
    areaLights: [{ position: [0, 3, 0], direction: [0, -1, 0], width: 1, height: 1 }],
  }).lights;
  for (const light of [lights.points[0], lights.spots[0], lights.areas[0]]) {
    assert.deepEqual(Array.from(light.color), [1, 1, 1]);
    assert.equal(light.intensity, 1);
  }
});

test('a light with an unusable colour or intensity names the field and what to pass', () => {
  assert.throws(() => sceneWith({ pointLights: [{ position: [0, 2, 0], color: [1, 1] }] }), /pointLights\[0\]\.color is three finite numbers/);
  assert.throws(() => sceneWith({ pointLights: [{ position: [0, 2, 0], intensity: NaN }] }), /pointLights\[0\]\.intensity is a finite number/);
  assert.throws(() => sceneWith({ spotLights: [{ position: [0, 2, 0], direction: [0, -1, 0], angle: 0.5, intensity: -1 }] }), /spotLights\[0\]\.intensity/);
  assert.throws(() => sceneWith({ areaLights: [{ position: [0, 3, 0], direction: [0, -1, 0], width: 1, height: 1, color: [0, Infinity, 0] }] }), /areaLights\[0\]\.color/);
});
