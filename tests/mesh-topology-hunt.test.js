import test from 'node:test';
import assert from 'node:assert/strict';
import { meshFromGeometry, withFaceAttributes } from '../src/mesh-convert.js';
import { selectFaces, countSelected } from '../src/mesh-select.js';
import { sculptMesh } from '../src/mesh-sculpt.js';

function triangleGeometry() {
  return { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) };
}

test('meshFromGeometry refuses uvs or colors that do not fit the positions', () => {
  assert.throws(() => meshFromGeometry({ ...triangleGeometry(), uvs: new Float32Array(4) }), /uvs must be a Float32Array of 6/);
  assert.throws(() => meshFromGeometry({ ...triangleGeometry(), colors: new Float32Array(3) }), /colors must be a Float32Array of 9/);
  const fitting = meshFromGeometry({ ...triangleGeometry(), uvs: new Float32Array(6) });
  assert.equal(fitting.attributes.corner.uv.size, 2);
});

test('a tag stored with values above 1 selects like any other tag', () => {
  const base = meshFromGeometry(triangleGeometry(), { tags: 'none' });
  const tagged = withFaceAttributes(base, { 'tag:t': { data: new Uint8Array([2]), size: 1 } });
  assert.equal(countSelected(selectFaces(tagged, { tag: 't' })), 1);
  assert.equal(countSelected(selectFaces(tagged, { and: [{ tag: 't' }, { all: true }] })), 1);
});

test('sculptMesh names the strokes field when it is not an array', () => {
  const mesh = meshFromGeometry(triangleGeometry(), { tags: 'none' });
  assert.throws(() => sculptMesh(mesh, { select: { all: true }, strokes: 'x' }), /needs strokes: an array/);
});
