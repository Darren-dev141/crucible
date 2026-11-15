import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHairMesh, createStrandRoots } from '../src/hair.js';

const settings = { count: 20, seed: 3, spread: 0.1, length: [0.1, 0.2] };
const flatNormals = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0];
const squareIndices = [0, 1, 2, 0, 2, 3];

test('hair roots skip surface triangles with infinite or NaN positions and keep every root finite', () => {
  const positions = [0, 0, 0, 1, 0, 0, 1, 0, 1, Infinity, 0, 1];
  const strands = createStrandRoots(settings, positions, flatNormals, squareIndices);
  assert.ok(strands.roots.every(Number.isFinite), 'roots are finite');
  assert.ok(strands.directions.every(Number.isFinite), 'directions are finite');
  const mesh = buildHairMesh(strands, { segments: 2, width: 0.01, droop: 0.1 }, 0);
  assert.ok(mesh.positions.every(Number.isFinite), 'the hair mesh has no NaN vertex');
});

test('hair roots skip triangles whose normals are not finite', () => {
  const positions = [0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1];
  const normals = [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, Number.NaN, 0];
  const strands = createStrandRoots(settings, positions, normals, squareIndices);
  assert.ok(strands.directions.every(Number.isFinite));
});

test('a hair surface with only non-finite triangles is refused by name', () => {
  const positions = [0, 0, 0, Infinity, 0, 0, 1, 0, 1, 0, 0, 1];
  assert.throws(() => createStrandRoots(settings, positions, flatNormals, [0, 1, 2]), /no triangle with area/);
});
