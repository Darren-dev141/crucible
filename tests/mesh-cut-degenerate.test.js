import assert from 'node:assert/strict';
import test from 'node:test';
import { createMeshData } from '../src/mesh-data.js';
import { knifeCut } from '../src/mesh-knife.js';
import { gridFill } from '../src/mesh-bridge.js';
import { fillHoles } from '../src/mesh-dissolve.js';

function flatGrid(size) {
  const positions = [];
  for (let row = 0; row <= size; row++) {
    for (let column = 0; column <= size; column++) positions.push(column, row, 0);
  }
  const cornerVertices = [];
  const faceOffsets = [0];
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const first = row * (size + 1) + column;
      cornerVertices.push(first, first + 1, first + size + 2, first + size + 1);
      faceOffsets.push(cornerVertices.length);
    }
  }
  return createMeshData({ positions: Float32Array.from(positions), faceOffsets: Uint32Array.from(faceOffsets), cornerVertices: Uint32Array.from(cornerVertices) });
}

function openPolygon(sides) {
  const positions = [];
  const cornerVertices = [];
  for (let index = 0; index < sides; index++) {
    positions.push(Math.cos(index * 2 * Math.PI / sides), Math.sin(index * 2 * Math.PI / sides), 0);
    cornerVertices.push(index);
  }
  return createMeshData({ positions: Float32Array.from(positions), faceOffsets: Uint32Array.from([0, sides]), cornerVertices: Uint32Array.from(cornerVertices) });
}

test('a knife line along existing grid edges leaves no two-corner face', () => {
  const grid = flatGrid(3);
  const alongEdges = { path: [[-1, 1, 0], [4, 1, 0]], direction: [0, 0, 1] };
  assert.throws(() => knifeCut(grid, alongEdges), /does not cross any face/);
});

test('a knife line that crosses cells and also runs along an edge keeps every face valid', () => {
  const grid = flatGrid(3);
  const bent = knifeCut(grid, { path: [[-1, 1.5, 0], [1, 1.5, 0], [1, 3, 0]], direction: [0, 0, 1] });
  for (let face = 0; face < bent.mesh.faceCount; face++) {
    assert.ok(bent.mesh.faceOffsets[face + 1] - bent.mesh.faceOffsets[face] >= 3);
  }
  assert.ok(bent.cutFaces >= 1);
});

test('grid_fill refuses a loop too long for any grid within the vertex budget', () => {
  const huge = openPolygon(70000);
  assert.throws(() => gridFill(huge, new Uint8Array(huge.edgeCount).fill(1)), /pass 65536 grid vertices/);
});

test('grid_fill still fills a long thin loop that fits the budget', () => {
  const polygon = openPolygon(600);
  const outcome = gridFill(polygon, new Uint8Array(polygon.edgeCount).fill(1));
  assert.equal(outcome.loops, 1);
  assert.ok(outcome.mesh.faceCount > 1);
});

test('fill_holes does not report an unlimited side count as more than Infinity sides', () => {
  const fin = createMeshData({
    positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1]),
    faceOffsets: Uint32Array.from([0, 3, 6, 9]),
    cornerVertices: Uint32Array.from([0, 1, 2, 0, 1, 3, 0, 1, 4]),
  });
  assert.throws(() => fillHoles(fin), error => /open chains/.test(error.message) && !/Infinity/.test(error.message));
});

test('grid_fill on a 2000-edge loop builds a grid within the budget instead of overflowing the stack', () => {
  const polygon = openPolygon(2000);
  const outcome = gridFill(polygon, new Uint8Array(polygon.edgeCount).fill(1));
  assert.ok(outcome.mesh.vertexCount <= 65536 + 2000);
  assert.ok(outcome.mesh.faceCount > 1);
});
