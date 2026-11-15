import assert from 'node:assert/strict';
import test from 'node:test';
import { box, cylinder, sphere } from '../src/geometry.js';
import { meshFromGeometry, applyMeshEdits } from '../src/mesh.js';

test('flatten without a normal refuses a closed mesh whose face normals cancel', () => {
  const closedGeometries = { cylinder: cylinder(13, 0.1, 3), sphere: sphere(11, 7), bevelledBox: box(0.1, 3) };
  for (const [label, geometry] of Object.entries(closedGeometries)) {
    const flattenAll = () => applyMeshEdits(meshFromGeometry(geometry), [{ op: 'flatten', verts: { all: true } }]);
    assert.throws(flattenAll, /No plane direction.*Pass normal/, label);
  }
});

test('flatten without a normal still uses the face normal of a fully selected face', () => {
  const mesh = meshFromGeometry(box(0, 1));
  const topVertices = [];
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) {
    if (mesh.positions[vertex * 3 + 1] > 0) topVertices.push(vertex);
  }
  assert.equal(topVertices.length, 4);
  const outcome = applyMeshEdits(mesh, [{ op: 'flatten', verts: { vertices: topVertices } }]);
  for (const vertex of topVertices) assert.equal(outcome.mesh.positions[vertex * 3 + 1], mesh.positions[topVertices[0] * 3 + 1]);
});
