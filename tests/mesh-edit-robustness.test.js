import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { box } from '../src/geometry.js';
import { applyMeshEdits, createMeshData, lintMesh, meshFromGeometry } from '../src/mesh.js';
import { MESH_EDIT_OPERATIONS } from '../src/mesh-operations.js';
import { GEOMETRY_PROBLEMS, MESH_PROBLEMS } from '../src/mesh-lint.js';
import { assertNoHoles, remeshMesh } from '../src/mesh-remesh.js';
import { placeCellVertices, quadsAroundEdges, splitSaddleVertices } from '../src/surface-nets.js';
import { loadMeshBooleans, meshBoolean } from '../src/mesh-boolean.js';

await loadMeshBooleans();

const cube = () => meshFromGeometry(box(0, 1));
const invertedCube = () => applyMeshEdits(cube(), [{ op: 'flip_normals', select: { all: true } }]).mesh;
const remesh = (mesh, options) => applyMeshEdits(mesh, [{ op: 'remesh', ...options }]).mesh;

function translated(mesh, offset) {
  const positions = Float32Array.from(mesh.positions, (value, index) => value + offset[index % 3]);
  return createMeshData({ positions, faceOffsets: mesh.faceOffsets, cornerVertices: mesh.cornerVertices });
}

function cubePlusLooseVertex() {
  const base = cube();
  const positions = new Float32Array(base.positions.length + 3);
  positions.set(base.positions);
  positions.set([5, 5, 5], base.positions.length);
  return createMeshData({ positions, faceOffsets: base.faceOffsets, cornerVertices: base.cornerVertices });
}

function remeshProblems(mesh, options) {
  return lintMesh(remesh(mesh, options)).problems.map(problem => `${problem.kind} ${problem.count}`);
}

test('remesh of a unit cube is clean, at every resolution from 4 to 64', () => {
  for (let resolution = 4; resolution <= 64; resolution++) {
    assert.deepEqual(remeshProblems(cube(), { resolution }), [], `resolution ${resolution}`);
  }
});

test('remesh of a unit cube is clean for odd voxel sizes and an offset cube', () => {
  const offsetCube = translated(cube(), [0.013, 0.021, 0.007]);
  for (const voxelSize of [0.07, 0.05, 0.09, 0.11, 0.13, 0.037, 0.021, 0.0625, 0.1]) {
    assert.deepEqual(remeshProblems(cube(), { voxelSize }), [], `voxelSize ${voxelSize}`);
    assert.deepEqual(remeshProblems(offsetCube, { voxelSize }), [], `offset voxelSize ${voxelSize}`);
  }
});

test('remesh and boolean reject an inverted cube and name flip_normals', () => {
  assert.throws(() => remesh(invertedCube(), { resolution: 16 }), /flip_normals/);
  assert.throws(() => meshBoolean(invertedCube(), translated(cube(), [0.5, 0, 0]), 'union'), /flip_normals/);
  assert.throws(() => meshBoolean(cube(), invertedCube(), 'difference'), /flip_normals/);
});

test('subdivide skips a loose vertex instead of failing', () => {
  const mesh = applyMeshEdits(cubePlusLooseVertex(), [{ op: 'subdivide', levels: 1 }]).mesh;
  assert.equal(mesh.faceCount, 24);
});

test('every lint fix hint names only real operations', () => {
  const hints = [...Object.values(MESH_PROBLEMS), ...Object.values(GEOMETRY_PROBLEMS)].map(problem => problem.fix);
  for (const hint of hints) {
    for (const [name] of hint.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)) {
      assert.ok(name in MESH_EDIT_OPERATIONS, `"${name}" in "${hint}" is not an operation`);
    }
  }
});

test('inconsistent-winding lists the faces to flip, and flipping them gives a clean lint', () => {
  const tagged = applyMeshEdits(cube(), [{ op: 'flip_normals', select: { tag: 'top' } }]).mesh;
  const winding = lintMesh(tagged).problems.find(problem => problem.kind === 'inconsistent-winding');
  assert.ok(winding.count > 0);
  assert.ok(winding.sample.every(face => face >= 0 && face < tagged.faceCount));
  assert.match(winding.fix, /flip_normals/);
  const fixed = applyMeshEdits(tagged, [{ op: 'flip_normals', select: { faces: winding.sample } }]).mesh;
  assert.deepEqual(lintMesh(fixed).problems, []);
});

test('meshBoolean on an inside-out cube says the mesh must be outward facing', () => {
  assert.throws(() => meshBoolean(invertedCube(), cube(), 'union'), /closed and outward facing/);
});

test('assertNoHoles rejects a surface with a one-quad edge and accepts a closed one', () => {
  const quad = createMeshData({
    positions: Float32Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    faceOffsets: Uint32Array.from([0, 4]),
    cornerVertices: Uint32Array.from([0, 1, 2, 3]),
  });
  assert.throws(() => assertNoHoles(quad), /could not close the surface/);
  assert.doesNotThrow(() => assertNoHoles(cube()));
});

test('remeshMesh throws instead of returning a surface with a hole', () => {
  const oneQuadOnly = () => [[0, 1, 2, 3]];
  assert.throws(() => remeshMesh(cube(), { resolution: 8 }, oneQuadOnly), /could not close the surface/);
});

const GOLDEN_INPUTS = JSON.parse(readFileSync(new URL('./fixtures/blender/cases.json', import.meta.url))).inputs;

function meshFromRecord({ vertices, faces }) {
  const faceOffsets = new Uint32Array(faces.length + 1);
  faces.forEach((face, index) => {
    faceOffsets[index + 1] = faceOffsets[index] + face.length;
  });
  return createMeshData({
    positions: new Float32Array(vertices.flat()),
    faceOffsets,
    cornerVertices: new Uint32Array(faces.flat()),
  });
}

test('remesh of the golden bumpy sphere has no non-manifold edge, at the voxel sizes that used to saddle', () => {
  const sphere = meshFromRecord(GOLDEN_INPUTS['sphere-bumpy']);
  for (const voxelSize of [0.1, 0.07, 0.05, 0.2]) {
    assert.deepEqual(remeshProblems(sphere, { voxelSize }), [], `voxelSize ${voxelSize}`);
  }
});

test('remesh of a plate a few voxels thick is clean', () => {
  const base = cube();
  const positions = Float32Array.from(base.positions, (value, index) => (index % 3 === 1 ? value * 0.1 : value * 2));
  const plate = createMeshData({ positions, faceOffsets: base.faceOffsets, cornerVertices: base.cornerVertices });
  for (const voxelSize of [0.05, 0.07]) {
    assert.deepEqual(remeshProblems(plate, { voxelSize }), [], `voxelSize ${voxelSize}`);
  }
});

// A block with two thin slots that nearly meet at a corner makes diagonal grid points at many voxel sizes. Whatever the
// size, remesh either returns a surface with no non-manifold edge or throws the saddle error; it never returns one silently.
function slottedBlock() {
  const placedBox = (min, max) => {
    const base = cube();
    const positions = Float32Array.from(base.positions, (value, index) => min[index % 3] + value * (max[index % 3] - min[index % 3]));
    return createMeshData({ positions, faceOffsets: base.faceOffsets, cornerVertices: base.cornerVertices });
  };
  const slotThickness = 0.08;
  let block = placedBox([0, 0, 0], [2, 2, 2]);
  block = meshBoolean(block, placedBox([1 - slotThickness / 2, 0.4, -0.1], [1 + slotThickness / 2, 1.04, 2.1]), 'difference').mesh;
  return meshBoolean(block, placedBox([1.03, 1 - slotThickness / 2, -0.1], [1.7, 1 + slotThickness / 2, 2.1]), 'difference').mesh;
}

test('remesh of a slotted block is clean or fails with the saddle error, at many voxel sizes', () => {
  const block = slottedBlock();
  for (let voxelSize = 0.08; voxelSize <= 0.16; voxelSize += 0.004) {
    let problems = [];
    try {
      problems = remeshProblems(block, { voxelSize });
    } catch (error) {
      assert.match(error.message, /could not separate/, `voxelSize ${voxelSize}`);
    }
    assert.deepEqual(problems, [], `voxelSize ${voxelSize}`);
  }
});

// Two inside grid points that touch only along a diagonal make a saddle face: all four of its grid edges cross the surface.
function quadsOfGrid(distances, pointsPerAxis) {
  const grid = { points: [pointsPerAxis, pointsPerAxis, pointsPerAxis], edge: 1 };
  const { cellVertex, positions } = placeCellVertices(distances, grid, [0, 0, 0]);
  const insidePoints = [];
  const outsidePoints = [];
  const quads = quadsAroundEdges(distances, grid, cellVertex, insidePoints, outsidePoints);
  return { quads, insidePoints, outsidePoints, positions };
}

function saddleQuads() {
  const distances = new Float32Array(125).fill(1);
  const pointIndex = (x, y, z) => (z * 5 + y) * 5 + x;
  distances[pointIndex(2, 2, 2)] = -1;
  distances[pointIndex(3, 3, 2)] = -1;
  return quadsOfGrid(distances, 5);
}

// The inverse: a solid block with two outside points on a face diagonal.
function concaveSaddleQuads() {
  const distances = new Float32Array(512).fill(-1);
  const pointIndex = (x, y, z) => (z * 8 + y) * 8 + x;
  distances[pointIndex(3, 3, 3)] = 1;
  distances[pointIndex(4, 4, 3)] = 1;
  return quadsOfGrid(distances, 8);
}

function quadsPerEdge(quads) {
  const counts = new Map();
  for (const quad of quads) {
    for (let corner = 0; corner < 4; corner++) {
      const first = quad[corner];
      const second = quad[(corner + 1) % 4];
      const key = `${Math.min(first, second)},${Math.max(first, second)}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.values()];
}

test('splitSaddleVertices gives a saddle edge exactly two quads on each side and keeps the surface closed', () => {
  const { quads, insidePoints, positions } = saddleQuads();
  assert.ok(quadsPerEdge(quads).includes(4), 'the fixture must start with a four-quad edge');
  const split = splitSaddleVertices(quads, insidePoints, positions);
  assert.ok(quadsPerEdge(split.quads).every(count => count === 2));
  assert.equal(split.quads.length, quads.length);
  assert.ok(split.positions.length > positions.length);
  const mesh = createMeshData({
    positions: Float32Array.from(split.positions),
    faceOffsets: Uint32Array.from({ length: split.quads.length + 1 }, (value, index) => index * 4),
    cornerVertices: Uint32Array.from(split.quads.flat()),
  });
  assert.doesNotThrow(() => assertNoHoles(mesh));
});

test('splitSaddleVertices also splits a concave saddle, two outside points on a diagonal in a solid block', () => {
  const { quads, insidePoints, outsidePoints, positions } = concaveSaddleQuads();
  assert.ok(quadsPerEdge(quads).includes(4), 'the fixture must start with a four-quad edge');
  const split = splitSaddleVertices(quads, insidePoints, positions, outsidePoints);
  assert.ok(quadsPerEdge(split.quads).every(count => count === 2));
  assert.equal(split.quads.length, quads.length);
});

test('remeshMesh separates a concave saddle instead of throwing', () => {
  const concaveBuilder = (distances, grid, cellVertex, insidePoints, outsidePoints) => {
    const fixture = concaveSaddleQuads();
    insidePoints.push(...fixture.insidePoints);
    outsidePoints.push(...fixture.outsidePoints);
    return fixture.quads;
  };
  const { mesh } = remeshMesh(cube(), { resolution: 8 }, concaveBuilder);
  const quads = [];
  for (let face = 0; face < mesh.faceOffsets.length - 1; face++) {
    quads.push(Array.from(mesh.cornerVertices.subarray(mesh.faceOffsets[face], mesh.faceOffsets[face + 1])));
  }
  assert.ok(quadsPerEdge(quads).every(count => count === 2));
});

function randomSignGrid(seed, pointsPerAxis) {
  let state = seed;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const distances = new Float32Array(pointsPerAxis ** 3).fill(1);
  const last = pointsPerAxis - 1;
  for (let z = 1; z < last; z++) {
    for (let y = 1; y < last; y++) {
      for (let x = 1; x < last; x++) {
        distances[(z * pointsPerAxis + y) * pointsPerAxis + x] = next() < 0.5 ? -1 : 1;
      }
    }
  }
  return distances;
}

test('splitSaddleVertices never returns a four-quad edge: it separates the sheets or throws and names the fix', () => {
  let separated = 0;
  let thrown = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const { quads, insidePoints, outsidePoints, positions } = quadsOfGrid(randomSignGrid(seed, 6), 6);
    try {
      const split = splitSaddleVertices(quads, insidePoints, positions, outsidePoints);
      assert.ok(quadsPerEdge(split.quads).every(count => count === 2), `seed ${seed}`);
      separated++;
    } catch (error) {
      assert.ok(error instanceof RangeError, `seed ${seed}: ${error.message}`);
      assert.match(error.message, /saddle.*voxelSize/);
      thrown++;
    }
  }
  assert.ok(separated > 0 && thrown > 0, `separated ${separated}, thrown ${thrown}`);
});

test('splitSaddleVertices returns a surface without saddles untouched', () => {
  const quads = [[0, 1, 2, 3]];
  const positions = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0];
  const result = splitSaddleVertices(quads, [0], positions);
  assert.equal(result.quads, quads);
  assert.equal(result.positions, positions);
});
