import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { worldBounds } from '../src/probe-trace.js';
import { applyFloorSkyVisibility } from '../src/floor-sky-visibility.js';
import { startGame, lastOperationPerKey } from '../src/game.js';

const PART_COUNT = 60;

function gridRecipe() {
  const nodes = [];
  for (let index = 0; index < PART_COUNT; index++) {
    nodes.push({ id: `part${index}`, geometry: index % 2 ? 'block' : 'ball', material: index % 3 ? 'wall' : 'floor', translation: [(index % 8) * 1.2, 0.5, Math.floor(index / 8) * 1.2] });
  }
  nodes.push({ id: 'player', geometry: 'block', material: 'wall' });
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'block', type: 'box' }, { id: 'ball', type: 'sphere' }],
    materials: [{ id: 'wall', color: [0.8, 0.8, 0.7] }, { id: 'floor', color: [0.3, 0.3, 0.3] }],
    nodes,
  };
}

function partMatrices(scene) {
  return scene.parts.map(part => [part.name, Array.from(part.matrix)]);
}

function sceneState(scene) {
  return { recipe: scene.exportRecipe(), parts: partMatrices(scene), sky: scene.parts.map(part => Array.from(part.geometry.skyVisibility ?? [])) };
}

test('a pose edit of a grid of parts gives the scene a fresh build of the edited recipe would give', () => {
  const scene = createAgentScene(gridRecipe(), { maxNodes: 200 });
  const edits = [
    { type: 'set-node', id: 'player', translation: [1.5, 0.5, -0.5], rotation: [0, 0.3826834, 0, 0.9238795] },
    { type: 'set-node', id: 'player', translation: [-1, 0.5, 2], scale: [1.5, 1, 1] },
  ];
  for (const edit of edits) {
    scene.apply([edit], { expectedRevision: scene.revision });
    const fresh = createAgentScene(scene.exportRecipe(), { maxNodes: 200 });
    assert.deepEqual(sceneState(scene), sceneState(fresh));
  }
});

test('a field edit that grows the recipe past maxRecipeBytes is still refused', () => {
  const base = createAgentScene(gridRecipe(), { maxNodes: 200 }).exportRecipe();
  const limit = smallestCreatableLimit(base);
  const scene = createAgentScene(base, { maxNodes: 200, maxRecipeBytes: limit });
  // Label one node after another with a long label. Each label passes the field rules and fits the operation copy, so the
  // first refusal can only come from the recipe size check, and it must leave the scene as it was.
  const labelOperation = id => ({ type: 'set-node', id, label: 'x'.repeat(200) });
  let applied = 0;
  for (const node of base.nodes) {
    const revisionBefore = scene.revision;
    try {
      scene.apply([labelOperation(node.id)], { expectedRevision: revisionBefore });
      applied++;
    } catch (error) {
      assert.match(error.message, /maxRecipeBytes/);
      assert.doesNotMatch(error.message, /label/);
      assert.equal(scene.revision, revisionBefore, 'the refused edit leaves the scene alone');
      assert.ok(applied > 0, 'a first label fits and only a later one is refused');
      return;
    }
  }
  assert.fail('labelling every node never pushed the recipe past maxRecipeBytes');
});

function smallestCreatableLimit(recipe) {
  let refused = 0;
  let accepted = JSON.stringify(recipe).length * 2;
  while (accepted - refused > 1) {
    const middle = Math.floor((accepted + refused) / 2);
    if (canCreate(recipe, middle)) accepted = middle;
    else refused = middle;
  }
  return accepted;
}

function canCreate(recipe, maxRecipeBytes) {
  try {
    createAgentScene(recipe, { maxNodes: 200, maxRecipeBytes });
    return true;
  } catch {
    return false;
  }
}

function closedRoomRecipe() {
  const slab = (id, translation, scale) => ({ id, geometry: 'slab', material: 'stone', translation, scale });
  return {
    format: 'crucible.scene', schemaVersion: 1,
    // The default sky trace of a closed room spends about 20 seconds of wall clock, and gives up when the machine is slow, so the
    // scene skips it and the test runs the trace itself with a small budget on the parts the scene holds.
    environment: { floorSkyTrace: false },
    geometries: [{ id: 'slab', type: 'box' }], materials: [{ id: 'stone', color: [0.7, 0.7, 0.7] }],
    nodes: [
      slab('floor', [0, 0, 0], [6, 0.1, 6]),
      slab('roof', [0, 3, 0], [6, 0.1, 6]),
      slab('wallNorth', [0, 1.5, 3], [6, 3, 0.1]),
      slab('wallSouth', [0, 1.5, -3], [6, 3, 0.1]),
      slab('wallEast', [3, 1.5, 0], [0.1, 3, 6]),
      slab('wallWest', [-3, 1.5, 0], [0.1, 3, 6]),
      { id: 'crate', geometry: 'slab', material: 'stone', translation: [0, 0.5, 0] },
    ],
  };
}

const SMALL_TRACE = { includeClosedRooms: true, maximumTexels: 300, raysPerTexel: 8, maxSeconds: 1000 };

function tracedSky(scene) {
  const traced = applyFloorSkyVisibility(scene.parts, SMALL_TRACE);
  assert.equal(traced.report.reason, null, 'the small trace ran to the end');
  return traced.parts.map(part => Array.from(part.geometry.skyVisibility ?? []));
}

test('floor sky visibility after a pose edit in a closed room matches a fresh build', () => {
  const scene = createAgentScene(closedRoomRecipe());
  for (let step = 0; step < 2; step++) {
    scene.apply([{ type: 'set-node', id: 'crate', translation: [step * 0.7, 0.5, 0.2] }], { expectedRevision: scene.revision });
    const fresh = createAgentScene(scene.exportRecipe());
    assert.deepEqual(scene.exportRecipe(), fresh.exportRecipe());
    assert.deepEqual(partMatrices(scene), partMatrices(fresh));
    const actual = tracedSky(scene);
    const expected = tracedSky(fresh);
    assert.ok(actual[0].length > 0, 'the floor carries sky visibility, so the cached part bounds are read');
    assert.deepEqual(actual, expected);
  }
});

test('worldBounds follows a part whose matrix changes in place', () => {
  const geometry = { positions: Float32Array.from([-1, -1, -1, 1, 1, 1]) };
  const part = { geometry, matrix: Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) };
  assert.deepEqual(worldBounds(part), { minimum: [-1, -1, -1], maximum: [1, 1, 1] });
  part.matrix[12] = 5;
  assert.deepEqual(worldBounds(part), { minimum: [4, -1, -1], maximum: [6, 1, 1] });
  const answer = worldBounds(part);
  answer.minimum[0] = 99;
  assert.deepEqual(worldBounds(part).minimum, [4, -1, -1], 'a caller changing its answer does not change the next one');
});

const STEP_MILLISECONDS = 1000 / 60;
const HOLD_FORWARD = { version: 1, samples: 600, events: [[1, 'keyboard/KeyW', 1]] };
const EMPTY_RECORDING = { version: 1, samples: 0, events: [] };

function gameRecipe() {
  const scene = createAgentScene({
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'block', type: 'box' }], materials: [{ id: 'paint', color: [0.5, 0.5, 0.5] }],
    nodes: [{ id: 'creature', geometry: 'block', material: 'paint' }],
  });
  scene.apply([{ type: 'set-game', game: { player: { node: 'creature' } } }], { expectedRevision: scene.revision });
  return scene.exportRecipe();
}

async function revisionsAfterFrames(replay, frames) {
  const previous = { request: globalThis.requestAnimationFrame, cancel: globalThis.cancelAnimationFrame };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  try {
    const renderer = { render() {}, resize() {}, updateParts() {}, replaceParts() {}, dispose() {} };
    const game = await startGame({}, gameRecipe(), { replay, showStatus: false, createRenderer: () => renderer });
    const revisions = [];
    for (let frame = 0; frame < frames; frame++) {
      game.runtime.step(STEP_MILLISECONDS);
      revisions.push(game.scene.revision);
    }
    game.dispose();
    return revisions;
  } finally {
    globalThis.requestAnimationFrame = previous.request;
    globalThis.cancelAnimationFrame = previous.cancel;
  }
}

test('a game frame that sends the same pose as the last one does not call scene.apply again', async () => {
  const revisions = await revisionsAfterFrames(EMPTY_RECORDING, 12);
  assert.ok(revisions[11] <= 1, `standing still edits the scene at most once, saw revision ${revisions[11]}`);
});

test('a game frame that moves the player still applies the pose', async () => {
  const revisions = await revisionsAfterFrames(HOLD_FORWARD, 30);
  assert.ok(revisions[29] > revisions[10], 'walking keeps bumping the scene revision');
});

test('lastOperationPerKey keeps the last of two operations that write the same fields of one node', () => {
  const first = { type: 'set-node', id: 'crate', translation: [1, 0, 0] };
  const second = { type: 'set-node', id: 'crate', translation: [2, 0, 0] };
  const other = { type: 'set-node', id: 'crate', visible: false };
  const elsewhere = { type: 'set-node', id: 'ball', translation: [1, 0, 0] };
  assert.deepEqual(lastOperationPerKey([first, other, elsewhere, second]), [second, other, elsewhere]);
});
