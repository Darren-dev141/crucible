import assert from 'node:assert/strict';
import test from 'node:test';
import { mat4 } from 'gl-matrix';
import { exportGlb } from '../src/export.js';
import { box } from '../src/geometry.js';

const plainMaterial = { color: [1, 1, 1], metallic: 0, roughness: 1 };

function readJson(binary) {
  const view = new DataView(binary);
  const jsonLength = view.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(binary, 20, jsonLength)));
}

function skinnedPartWithoutMatrix() {
  const geometry = box();
  const vertexCount = geometry.positions.length / 3;
  geometry.skinIndices = new Uint16Array(vertexCount * 4);
  geometry.skinWeights = new Float32Array(vertexCount * 4);
  for (let vertex = 0; vertex < vertexCount; vertex++) geometry.skinWeights[vertex * 4] = 1;
  const skin = {
    jointMatrices: mat4.create(),
    joints: [{ name: 'root', parent: -1 }],
    inverseBindMatrices: mat4.create(),
    jointWorldMatrices: mat4.create(),
  };
  return { name: 'Rod', geometry, material: plainMaterial, skin };
}

test('GLB export of a skinned part without a matrix works', () => {
  assert.doesNotThrow(() => exportGlb([skinnedPartWithoutMatrix()]));
});

test('GLB emissiveStrength is never below the glTF minimum of 1', () => {
  const part = { name: 'Lamp', geometry: box(), matrix: mat4.create(), material: { ...plainMaterial, color: [0.8, 0.4, 0.2], emission: 0.5 } };
  const json = readJson(exportGlb([part]));
  const strength = json.materials[0].extensions?.KHR_materials_emissive_strength?.emissiveStrength;
  assert.ok(strength === undefined || strength >= 1, `emissiveStrength ${strength}`);
  assert.deepEqual(json.materials[0].emissiveFactor.map(value => Math.round(value * 1000) / 1000), [0.4, 0.2, 0.1]);
});

test('an animated mirrored node keeps its negative scale in the exported translation, rotation and scale', () => {
  const matrix = mat4.fromScaling(mat4.create(), [-1, 1, 1]);
  const part = { name: 'Mirror', geometry: box(), matrix, material: plainMaterial };
  const clip = { name: 'c', tracks: [{ target: 'Mirror', property: 'translation', keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 1, value: [1, 0, 0] }] }] };
  const node = readJson(exportGlb([part], { clips: [clip] })).nodes.find(candidate => candidate.name === 'Mirror');
  const composed = mat4.fromRotationTranslationScale(mat4.create(), node.rotation ?? [0, 0, 0, 1], node.translation ?? [0, 0, 0], node.scale ?? [1, 1, 1]);
  for (let index = 0; index < 16; index++) assert.ok(Math.abs(composed[index] - matrix[index]) < 1e-6, `element ${index}`);
});
