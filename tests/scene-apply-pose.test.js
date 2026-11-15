import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { worldBounds } from '../src/probe-trace.js';
import { startGame } from '../src/game.js';

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
  let limit = JSON.stringify(base).length;
  while (!canCreate(base, limit)) limit++;
  const scene = createAgentScene(base, { maxNodes: 200, maxRecipeBytes: limit });
  assert.throws(
    () => scene.apply([{ type: 'set-node', id: 'player', label: 'x'.repeat(limit) }], { expectedRevision: scene.revision }),
    /maxRecipeBytes|label/,
  );
  assert.equal(scene.revision, 0, 'the refused edit leaves the scene alone');
});

function canCreate(recipe, maxRecipeBytes) {
  try {
    createAgentScene(recipe, { maxNodes: 200, maxRecipeBytes });
    return true;
  } catch {
    return false;
  }
}

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
