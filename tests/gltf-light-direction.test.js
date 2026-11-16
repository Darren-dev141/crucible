import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGltf } from '../src/gltf.js';

const TRIANGLE_POSITIONS = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);

function lightDocument(light, nodeEdit) {
  const bytes = new Uint8Array(TRIANGLE_POSITIONS.buffer);
  return JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    nodes: [{ name: 'Triangle', mesh: 0 }, { name: 'Lamp node', ...nodeEdit, extensions: { KHR_lights_punctual: { light: 0 } } }],
    extensionsUsed: ['KHR_lights_punctual'],
    extensions: { KHR_lights_punctual: { lights: [light] } },
    meshes: [{ name: 'Body', primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bytes.length }],
    buffers: [{ byteLength: bytes.length, uri: `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}` }],
  });
}

const length = vector => Math.hypot(...vector);

test('a scaled spot light keeps a unit direction', async () => {
  const asset = await parseGltf(lightDocument({ type: 'spot' }, { scale: [1, 1, 3] }));
  assert.ok(Math.abs(length(asset.lights.spotLights[0].direction) - 1) < 1e-6);
});

test('a scaled directional light keeps a unit key direction', async () => {
  const asset = await parseGltf(lightDocument({ type: 'directional' }, { scale: [2, 2, 3] }));
  assert.ok(Math.abs(length(asset.lights.lightDirection) - 1) < 1e-6);
});

test('a light squashed to a zero direction is skipped with a warning that names the light node', async () => {
  for (const type of ['spot', 'directional']) {
    const asset = await parseGltf(lightDocument({ type }, { scale: [1, 1, 0] }));
    assert.equal(asset.lights.spotLights, undefined);
    assert.equal(asset.lights.lightDirection, undefined);
    assert.ok(asset.warnings.some(warning => /node 1/.test(warning) && /direction/.test(warning)), asset.warnings.join('|'));
  }
});

test('a non-numeric light range is ignored with a warning', async () => {
  const asset = await parseGltf(lightDocument({ type: 'point', range: 'x' }, {}));
  assert.equal(asset.lights.pointLights[0].range, 0);
  assert.ok(asset.warnings.some(warning => /range/.test(warning)), asset.warnings.join('|'));
});
