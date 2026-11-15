// Attribute-keeping edge collapse and the dense-scene level helper (#1163).
import test from 'node:test';
import assert from 'node:assert/strict';
import { sphere } from '../src/geometry.js';
import { simplifyGeometry, findLockedVertices } from '../src/geometry-simplify.js';
import { generateGeometryLods } from '../src/mesh-lod.js';
import { addLodsToDenseParts, trianglesPerPixel } from '../src/dense-lods.js';

// A flat grid in the xy plane whose uv is (x, y) and whose colour is a function of the vertex, so a surviving
// vertex proves it kept its own attributes.
function uvGrid(cells) {
  const side = cells + 1;
  const positions = new Float32Array(side * side * 3);
  const normals = new Float32Array(side * side * 3);
  const uvs = new Float32Array(side * side * 2);
  const colors = new Float32Array(side * side * 3);
  for (let row = 0; row < side; row++) {
    for (let column = 0; column < side; column++) {
      const vertex = row * side + column;
      positions.set([column / cells, row / cells, 0], vertex * 3);
      normals.set([0, 0, 1], vertex * 3);
      uvs.set([column / cells, row / cells], vertex * 2);
      colors.set([column / cells, row / cells, 0.5], vertex * 3);
    }
  }
  const indices = [];
  for (let row = 0; row < cells; row++) {
    for (let column = 0; column < cells; column++) {
      const corner = row * side + column;
      indices.push(corner, corner + 1, corner + side, corner + 1, corner + side + 1, corner + side);
    }
  }
  return { positions, normals, uvs, colors, indices: Uint32Array.from(indices) };
}

test('a reduced grid keeps the uv and colour of every vertex that survives', () => {
  const grid = uvGrid(24);
  const [level] = simplifyGeometry(grid, { ratios: [0.25] });
  assert.ok(level.geometry.indices.length / 3 <= grid.indices.length / 3 * 0.25 + 2);
  const vertexCount = level.geometry.positions.length / 3;
  assert.equal(level.geometry.uvs.length, vertexCount * 2);
  assert.equal(level.geometry.colors.length, vertexCount * 3);
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const [x, y] = level.geometry.positions.subarray(vertex * 3, vertex * 3 + 2);
    assert.deepEqual([...level.geometry.uvs.subarray(vertex * 2, vertex * 2 + 2)], [x, y]);
    assert.deepEqual([...level.geometry.colors.subarray(vertex * 3, vertex * 3 + 3)], [x, y, 0.5].map(Math.fround));
  }
});

test('the border of the grid stays where it was and a flat grid reduces with no error', () => {
  const grid = uvGrid(24);
  const [level] = simplifyGeometry(grid, { ratios: [0.1] });
  const border = new Set();
  for (let vertex = 0; vertex < level.geometry.positions.length / 3; vertex++) {
    const [x, y] = level.geometry.positions.subarray(vertex * 3, vertex * 3 + 2);
    if (x === 0 || y === 0 || x === 1 || y === 1) border.add(`${x},${y}`);
  }
  assert.equal(border.size, 24 * 4, 'every border vertex survives');
  assert.ok(level.error < 1e-6);
});

test('levels keep the seam of a sphere and report a growing error', () => {
  const geometry = sphere(48, 24);
  const levels = simplifyGeometry(geometry, { ratios: [0.5, 0.25] });
  assert.ok(levels[0].error > 0);
  assert.ok(levels[1].error >= levels[0].error);
  assert.ok(levels[1].triangles < levels[0].triangles);
  const locked = findLockedVertices(geometry.indices, geometry.positions.length / 3);
  const seamPositions = new Set();
  for (let vertex = 0; vertex < locked.length; vertex++) if (locked[vertex]) seamPositions.add([...geometry.positions.subarray(vertex * 3, vertex * 3 + 3)].join(','));
  const survivors = new Set();
  const finalGeometry = levels[1].geometry;
  for (let vertex = 0; vertex < finalGeometry.positions.length / 3; vertex++) survivors.add([...finalGeometry.positions.subarray(vertex * 3, vertex * 3 + 3)].join(','));
  for (const position of seamPositions) assert.ok(survivors.has(position), `seam vertex ${position} survives`);
});

test('the same input gives the same levels', () => {
  const first = simplifyGeometry(sphere(32, 16), { ratios: [0.3] })[0].geometry;
  const second = simplifyGeometry(sphere(32, 16), { ratios: [0.3] })[0].geometry;
  assert.deepEqual([...first.indices], [...second.indices]);
  assert.deepEqual([...first.positions], [...second.positions]);
});

test('generateGeometryLods keeps the uvs of a textured geometry', () => {
  const geometry = sphere(32, 16);
  assert.ok(geometry.uvs, 'the test sphere has uvs');
  const levels = generateGeometryLods(geometry, { ratios: [0.25] });
  assert.equal(levels[0].geometry, geometry);
  assert.equal(levels[1].geometry.uvs.length, levels[1].geometry.positions.length / 3 * 2);
  assert.ok(levels[1].geometry.indices.length < geometry.indices.length);
  assert.ok(levels[1].error >= 0 && levels[1].relativeError >= 0);
});

test('simplifyGeometry says what to pass when the input is wrong', () => {
  assert.throws(() => simplifyGeometry({ positions: [] }, {}), /Float32Array positions/);
  assert.throws(() => simplifyGeometry(uvGrid(4), { ratios: [0.5, 0.6] }), /strictly decreasing/);
  assert.throws(() => simplifyGeometry({ ...uvGrid(4), joints: new Uint16Array(4) }), /skinned or morphed/);
});

function surfacePart(name, geometry, extra = {}) {
  return { name, geometry, matrix: new Float32Array(16), material: { tag: 'surface', color: [0.5, 0.5, 0.5], metallic: 0, roughness: 0.5 }, ...extra };
}

test('a sparse scene gets no levels and the same array back', () => {
  const parts = [surfacePart('ball', sphere(32, 16))];
  assert.equal(addLodsToDenseParts(parts, { pixels: 1e9 }), parts);
});

test('a dense scene gives levels to big parts that can take them, sharing them between instances of one geometry', () => {
  const big = sphere(64, 32);
  const small = sphere(4, 4);
  const existing = [{ geometry: big, error: 0 }, { geometry: small, error: 1 }];
  const parts = [
    surfacePart('first', big),
    surfacePart('second', big),
    surfacePart('tiny', small),
    surfacePart('skinned', sphere(64, 32), { skin: {} }),
    surfacePart('kept', big, { lods: existing }),
  ];
  assert.ok(trianglesPerPixel(parts, 1000) > 1);
  const result = addLodsToDenseParts(parts, { pixels: 1000, minimumTriangles: 1000, ratios: [0.25] });
  assert.equal(result[0].lods.length, 2);
  assert.equal(result[0].lods, result[1].lods, 'instances of one geometry share levels');
  assert.equal(result[2].lods, undefined, 'a part under minimumTriangles is left alone');
  assert.equal(result[3].lods, undefined, 'a skinned part cannot take levels');
  assert.equal(result[4].lods, existing, 'levels that exist are kept');
});

test('addLodsToDenseParts says what to pass when the canvas size is missing', () => {
  assert.throws(() => addLodsToDenseParts([surfacePart('ball', sphere(8, 8))], {}), /canvas width times its height/);
});
