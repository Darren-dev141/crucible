import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';

function floorRecipe(extraGeometries = [], extraNodes = []) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'slab', type: 'box' }, ...extraGeometries],
    materials: [{ id: 'stone', color: [0.5, 0.5, 0.5] }],
    nodes: [{ id: 'floor', geometry: 'slab', material: 'stone', scale: [20, 0.2, 20] }, ...extraNodes],
  };
}

function terrainWithHoles(holes) {
  return () => createAgentScene(floorRecipe([{ id: 'hills', type: 'terrain', size: 10, holes }], [{ id: 'land', geometry: 'hills', material: 'stone' }]));
}

test('a terrain hole without a radius or centre names its list position and field', () => {
  assert.throws(terrainWithHoles([{ center: [0, 0], radius: 1 }, { center: [0, 0] }]), /terrain\.holes\[1\]\.radius: got undefined/);
  assert.throws(terrainWithHoles([{ center: [0, 0], radius: -1 }]), /terrain\.holes\[0\]\.radius/);
  assert.throws(terrainWithHoles([{ center: [0], radius: 1 }]), /terrain\.holes\[0\]\.center/);
  assert.throws(terrainWithHoles([null]), /terrain\.holes\[0\]\.center/);
});

test('a path query names the field that is wrong, not the navmesh internals or a generic id', () => {
  const scene = createAgentScene(floorRecipe());
  const query = path => () => scene.inspect({ path: { ground: 'floor', from: [-5, 0], to: [5, 0], ...path } });
  assert.throws(query({ from: [-5, 0, 0] }), /path\.from: got/);
  assert.throws(query({ to: 'x' }), /path\.to: got "x"/);
  assert.throws(query({ avoid: ['floor', 3] }), /path\.avoid\[1\]: got 3/);
  assert.throws(query({ ground: undefined }), /path\.ground: got undefined/);
});
