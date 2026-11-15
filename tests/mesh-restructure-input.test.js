import { test } from 'node:test';
import assert from 'node:assert/strict';
import { box } from '../src/geometry.js';
import { meshFromGeometry, triangulateFaces, splitSharpEdges } from '../src/mesh.js';

const createBoxMesh = () => meshFromGeometry(box(0, 1));

test('triangulateFaces refuses a NaN or fractional minVertices instead of silently doing nothing', () => {
  const box = createBoxMesh();
  assert.throws(() => triangulateFaces(box, { minVertices: Number.NaN }), /minVertices/);
  assert.throws(() => triangulateFaces(box, { minVertices: 2.5 }), /minVertices/);
});

test('splitSharpEdges refuses a NaN or out-of-range angle', () => {
  const box = createBoxMesh();
  assert.throws(() => splitSharpEdges(box, { angle: Number.NaN }), /angle/);
  assert.throws(() => splitSharpEdges(box, { angle: -5 }), /angle/);
  assert.throws(() => splitSharpEdges(box, { angle: 181 }), /angle/);
});

test('valid values still work', () => {
  const box = createBoxMesh();
  assert.ok(triangulateFaces(box, { minVertices: 4 }).triangulated > 0);
  assert.ok(splitSharpEdges(box, { angle: 30 }).mesh);
});
