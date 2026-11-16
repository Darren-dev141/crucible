import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { skyOpenness, skyVisibilityGrid, CLOSED_ROOM_SHARE } from '../src/closed-room.js';
import { fittedClosedRoomShare } from '../src/fitted-closed-room.js';

function slab(id, translation, scale) {
  return { id, geometry: 'box', material: 'stone', translation, scale };
}

// A 10 x 6 x 10 room of six slabs, then every part renamed "Cube", as a glTF file with unnamed meshes arrives.
function roomWithSameNames() {
  const recipe = {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box', bevel: 0 }],
    materials: [{ id: 'stone', color: [0.5, 0.5, 0.5] }],
    nodes: [
      slab('floor', [0, -3, 0], [10, 0.2, 10]),
      slab('north', [0, 0, -5], [10, 6, 0.2]),
      slab('south', [0, 0, 5], [10, 6, 0.2]),
      slab('west', [-5, 0, 0], [0.2, 6, 10]),
      slab('east', [5, 0, 0], [0.2, 6, 10]),
      slab('roof', [0, 3, 0], [10, 0.2, 10]),
    ],
  };
  const unique = createAgentScene(recipe).parts;
  const renamed = unique.map(part => ({ ...part, name: 'Cube' }));
  return { unique, renamed };
}

test('a room of parts that share one name has the same sky openness as with unique names', () => {
  const { unique, renamed } = roomWithSameNames();
  const point = [0, 0, 0];
  assert.equal(skyOpenness(renamed, point), skyOpenness(unique, point));
});

test('a room of parts that share one name keeps its sky visibility grid', () => {
  const { unique, renamed } = roomWithSameNames();
  const bounds = [[-5, -3, -5], [5, 3, 5]];
  assert.deepEqual(skyVisibilityGrid(renamed, ...bounds), skyVisibilityGrid(unique, ...bounds));
});

test('the fitted closed room test reads each same-named part at its own matrix', async () => {
  const { unique, renamed } = roomWithSameNames();
  const { partMatrixLookup } = await import('../src/closed-room.js');
  assert.ok(fittedClosedRoomShare(unique, partMatrixLookup(unique)) >= CLOSED_ROOM_SHARE);
  assert.equal(fittedClosedRoomShare(renamed, partMatrixLookup(renamed)), fittedClosedRoomShare(unique, partMatrixLookup(unique)));
});

