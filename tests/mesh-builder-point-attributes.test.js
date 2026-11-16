import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { box } from '../src/geometry.js';
import { meshFromGeometry, createMeshData } from '../src/mesh.js';
import { splitEdges, deleteLoose } from '../src/mesh-reshape-more.js';
import { buildPolygonMesh, facePolygons } from '../src/mesh-polygons.js';

function withPointAttributes(mesh) {
  const count = mesh.vertexCount;
  const attributes = { ...mesh.attributes, point: {
    'group:wear': { data: Float32Array.from({ length: count }, (_, vertex) => (vertex + 1) / (count + 1)), size: 1 },
    height: { data: Float32Array.from({ length: count }, (_, vertex) => vertex * 10 + 0.5), size: 1 },
    offset: { data: Float32Array.from({ length: count * 3 }, (_, index) => index + 0.25), size: 3 },
    label: { data: Int32Array.from({ length: count }, (_, vertex) => 100 + vertex), size: 1 },
  } };
  return createMeshData({
    positions: mesh.positions, faceOffsets: mesh.faceOffsets, cornerVertices: mesh.cornerVertices,
    edgeVertices: mesh.edgeVertices, cornerEdges: mesh.cornerEdges, attributes,
  });
}

function pointKey(mesh, vertex) {
  return [0, 1, 2].map(axis => mesh.positions[vertex * 3 + axis]).join(',');
}

function sourceByPosition(mesh) {
  const lookup = new Map();
  for (let vertex = 0; vertex < mesh.vertexCount; vertex++) lookup.set(pointKey(mesh, vertex), vertex);
  return lookup;
}

function assertValuesFollowSources(source, result) {
  const lookup = sourceByPosition(source);
  assert.deepEqual(Object.keys(result.attributes.point).sort(), Object.keys(source.attributes.point).sort());
  for (const [name, attribute] of Object.entries(source.attributes.point)) {
    const carried = result.attributes.point[name];
    assert.equal(carried.size, attribute.size);
    assert.equal(carried.data.constructor, attribute.data.constructor);
    for (let vertex = 0; vertex < result.vertexCount; vertex++) {
      const from = lookup.get(pointKey(result, vertex));
      assert.deepEqual(
        Array.from(carried.data.subarray(vertex * attribute.size, (vertex + 1) * attribute.size)),
        Array.from(attribute.data.subarray(from * attribute.size, (from + 1) * attribute.size)),
        `${name} of vertex ${vertex}`,
      );
    }
  }
}

test('split_edges copies point attributes onto the vertices it duplicates', () => {
  const source = withPointAttributes(meshFromGeometry(box(0, 1)));
  const result = splitEdges(source, new Uint8Array(source.edgeCount).fill(1));
  assert.ok(result.mesh.vertexCount > source.vertexCount);
  assertValuesFollowSources(source, result.mesh);
});

test('delete_loose drops the values of the vertices it removes and keeps the rest', () => {
  const base = meshFromGeometry(box(0, 1));
  const positions = new Float32Array(base.positions.length + 3);
  positions.set(base.positions);
  positions.set([9, 9, 9], base.positions.length);
  const count = base.vertexCount + 1;
  const loose = createMeshData({
    positions, faceOffsets: base.faceOffsets, cornerVertices: base.cornerVertices,
    attributes: { point: {
      'group:wear': { data: Float32Array.from({ length: count }, (_, vertex) => vertex + 0.5), size: 1 },
      offset: { data: Float32Array.from({ length: count * 3 }, (_, index) => index), size: 3 },
    } },
  });
  const result = deleteLoose(loose);
  assert.equal(result.mesh.vertexCount, base.vertexCount);
  assertValuesFollowSources(loose, result.mesh);
  assert.ok(!Array.from(result.mesh.attributes.point['group:wear'].data).includes(count - 1 + 0.5));
});

test('a mesh without point attributes rebuilds to the same bytes and gains none', () => {
  const source = meshFromGeometry(box(0, 1));
  const rebuilt = buildPolygonMesh(source, facePolygons(source));
  assert.deepEqual(Object.keys(rebuilt.attributes.point), []);
  assert.deepEqual(Array.from(rebuilt.positions), Array.from(source.positions));
  assert.deepEqual(Array.from(rebuilt.cornerVertices), Array.from(source.cornerVertices));
  assert.deepEqual(Array.from(rebuilt.cornerEdges), Array.from(source.cornerEdges));
});
