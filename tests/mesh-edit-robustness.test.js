import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { box } from '../src/geometry.js';
import { applyMeshEdits, createMeshData, lintMesh, meshFromGeometry } from '../src/mesh.js';
import { MESH_EDIT_OPERATIONS } from '../src/mesh-operations.js';
import { GEOMETRY_PROBLEMS, MESH_PROBLEMS } from '../src/mesh-lint.js';
import { assertNoHoles } from '../src/mesh-remesh.js';
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
