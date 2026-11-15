import test from 'node:test';
import assert from 'node:assert/strict';
import { createModel } from '../src/model.js';
import { exportGlb } from '../src/export.js';

function firstPart() {
  return createModel()[0];
}

function readJson(binary) {
  const view = new DataView(binary);
  const jsonLength = view.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(binary, 20, jsonLength)));
}

test('GLB export rejects lightUvs that do not match the vertex count', () => {
  const part = firstPart();
  const image = { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(255) };
  const geometry = { ...part.geometry, lightUvs: new Float32Array(4) };
  const material = { ...part.material, lightMap: { image, uvChannel: 1 } };
  assert.throws(() => exportGlb([{ ...part, geometry, material }]), /lightUvs/i);
});

test('GLB light map emissive factor is a JSON array when the color is a Float32Array', () => {
  const part = firstPart();
  const image = { width: 2, height: 2, data: new Uint8ClampedArray(16).fill(255) };
  const geometry = { ...part.geometry, lightUvs: new Float32Array(part.geometry.positions.length / 3 * 2) };
  const material = { ...part.material, color: new Float32Array([0.5, 0.5, 0.5]), emission: 0, lightMap: { image, uvChannel: 1 } };
  const json = readJson(exportGlb([{ ...part, geometry, material }]));
  assert.ok(Array.isArray(json.materials[0].emissiveFactor));
});

test('GLB export rejects empty, non-finite and unsorted animation keyframes', () => {
  const part = firstPart();
  const make = keyframes => ({ name: 'c', tracks: [{ target: part.name, property: 'translation', keyframes }] });
  assert.throws(() => exportGlb([part], { clips: [make([])] }), /keyframe/i);
  assert.throws(() => exportGlb([part], { clips: [make([{ time: NaN, value: [0, 0, 0] }])] }), /finite|time/i);
  assert.throws(() => exportGlb([part], { clips: [make([{ time: 1, value: [0, 0, 0] }, { time: 0.5, value: [0, 0, 0] }])] }), /increas|order|sorted/i);
  assert.throws(() => exportGlb([part], { clips: [make([{ time: 0, value: [NaN, 0, 0] }])] }), /finite/i);
});
