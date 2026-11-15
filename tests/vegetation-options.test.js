import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlowerPatch, createGrassClump, scatterVegetation } from '../src/vegetation.js';

const AREA = { minX: 0, maxX: 20, minZ: 0, maxZ: 20 };

function scatter(options) {
  return () => scatterVegetation({ area: AREA, mix: { grass: 1 }, density: 0.5, ...options });
}

test('scatter variants must be a whole number of at least 1', () => {
  for (const variants of [0, NaN, 1.5, -2, 1000]) {
    assert.throws(scatter({ variants }), /Scatter variants must be a whole number from 1 to 16/, `variants ${variants}`);
  }
});

test('scatter mix needs finite weights, known species and one positive weight', () => {
  assert.throws(scatter({ mix: { grass: 0 } }), /at least one positive weight/);
  assert.throws(scatter({ mix: {} }), /at least one positive weight/);
  assert.throws(scatter({ mix: { grass: NaN } }), /mix weight for grass must be a finite number/);
  assert.throws(scatter({ mix: { grass: -1, flowers: 2 } }), /mix weight for grass/);
  assert.throws(scatter({ mix: { oakk: 1 } }), /unknown species "oakk"; use broadleaf/);
});

test('scatter spacing and density that would exhaust memory fail with what to pass', () => {
  for (const spacing of [0, -1, NaN, Infinity]) {
    assert.throws(scatter({ spacing }), /Scatter spacing must be a finite number/, `spacing ${spacing}`);
  }
  assert.throws(scatter({ density: Infinity }), /Scatter density must be a finite number/);
  assert.throws(scatter({ density: NaN }), /Scatter density must be a finite number/);
  assert.throws(scatter({ spacing: 1e-4 }), /over the limit of 16000000; raise spacing/);
});

test('scatter scale must be a positive range and the seed finite', () => {
  assert.throws(scatter({ scale: [-1, 1] }), /scale minimum must be a finite number from 0.001/);
  assert.throws(scatter({ scale: [2, 1] }), /scale maximum must be a finite number from 2/);
  assert.throws(scatter({ scale: [1] }), /\[minimum, maximum\]/);
  assert.throws(scatter({ seed: NaN }), /Scatter seed must be a finite number/);
});

test('valid scatter options still place instances', () => {
  const result = scatter({ variants: 2, spacing: 2, scale: [0.5, 1.5], seed: 3 })();
  assert.ok(result.instances.length > 10);
  assert.ok(result.instances.every(instance => instance.scale >= 0.5 && instance.scale <= 1.5));
});

test('grass clump and flower patch counts and sizes are bounded', () => {
  for (const blades of [0, -3, NaN, 2.5, 1e9]) {
    assert.throws(() => createGrassClump({ blades }), /grass blades must be a whole number from 1 to 2048/, `blades ${blades}`);
  }
  assert.throws(() => createGrassClump({ height: NaN }), /grass height must be a finite number/);
  assert.throws(() => createGrassClump({ radius: -1 }), /grass radius must be a finite number/);
  for (const flowers of [0, -3, NaN, 1e9]) {
    assert.throws(() => createFlowerPatch({ flowers }), /flowers flowers must be a whole number from 1 to 256/, `flowers ${flowers}`);
  }
  assert.throws(() => createFlowerPatch({ height: 0 }), /flowers height must be a finite number/);
  assert.ok(createGrassClump({ blades: 3 }).bounds.maximum.every(Number.isFinite));
});
