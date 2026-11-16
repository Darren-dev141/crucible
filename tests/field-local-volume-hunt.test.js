// Bug hunt over surface, field and local volume sources: a sliver face must not bend an edge angle, and a rebuilt part
// geometry must not keep the bounds of its old positions.
import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { meshFromGeometry } from '../src/mesh.js';
import { evaluateField, meshFieldContext } from '../src/mesh-fields.js';
import { bindLocalVolumeParts } from '../src/local-volume-parts.js';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

test('edgeAngle ignores a zero-area face instead of reading it as a right angle', () => {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0.5, 0, 0]);
  const indices = new Uint32Array([0, 1, 2, 0, 3, 1]);
  const mesh = meshFromGeometry({ positions, indices }, { quads: false, tags: 'none' });
  const { values } = evaluateField({ edgeAngle: {} }, meshFieldContext(mesh, 'face'), { kind: 'scalar' });
  assert.deepEqual(Array.from(values), [0, 0]);
});

function boxGeometry(size) {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]).map(value => value * size);
  const indices = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5]);
  return { positions, indices, normals: new Float32Array(positions.length) };
}

test('a mesh volume reads the bounds of the positions a geometry holds now', () => {
  const geometry = boxGeometry(1);
  const part = { name: 'room', geometry, matrix: IDENTITY };
  const volume = { shape: 'mesh', part: 'room', fit: 'bounds', density: 1, falloff: 0, steps: 8 };
  assert.deepEqual(bindLocalVolumeParts([volume], [part])[0].size, [1, 1, 1]);
  geometry.positions = boxGeometry(3).positions;
  assert.deepEqual(bindLocalVolumeParts([volume], [part])[0].size, [3, 3, 3]);
});

test('a mesh volume on a part with no finite positions says so instead of blaming thickness', () => {
  const volume = { shape: 'mesh', part: 'room', fit: 'bounds', density: 1, falloff: 0, steps: 8 };
  for (const positions of [new Float32Array(0), new Float32Array([Number.NaN, 0, 0, 1, 1, 1, 0, 1, 0])]) {
    const part = { name: 'room', geometry: { positions, indices: new Uint32Array([0, 1, 2]) }, matrix: IDENTITY };
    assert.throws(() => bindLocalVolumeParts([volume], [part]), /part "room" has no finite vertex positions/);
  }
});

test('a closed-mesh check reads the indices a geometry holds now', async () => {
  const { assertClosedMesh } = await import('../src/local-volume-parts.js');
  const geometry = boxGeometry(1);
  const part = { name: 'room', geometry, matrix: IDENTITY };
  assertClosedMesh(part, 'volume');
  geometry.indices = geometry.indices.slice(0, 33);
  assert.throws(() => assertClosedMesh(part, 'volume'), /not a closed mesh/);
});
