import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { startGame } from '../src/game.js';

const EMPTY_RECORDING = { version: 1, samples: 0, events: [] };
const HOLD_FORWARD = { version: 1, samples: 600, events: [[1, 'keyboard/KeyW', 1]] };
const STEP_MILLISECONDS = 1000 / 60;

function standInRenderer() {
  return { render() {}, resize() {}, updateParts() {}, replaceParts() {}, dispose() {} };
}

function withAnimationFrameStubs() {
  const previous = { request: globalThis.requestAnimationFrame, cancel: globalThis.cancelAnimationFrame };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  return () => {
    globalThis.requestAnimationFrame = previous.request;
    globalThis.cancelAnimationFrame = previous.cancel;
  };
}

function sceneRecipe(nodes, game) {
  const scene = createAgentScene({
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'block', type: 'box' }], materials: [{ id: 'paint', color: [0.5, 0.5, 0.5] }],
    nodes,
  });
  scene.apply([{ type: 'set-game', game }], { expectedRevision: scene.revision });
  return scene.exportRecipe();
}

function parentedRecipe(parentFields = {}) {
  return sceneRecipe([
    { id: 'rig', translation: [10, 0, 0], ...parentFields },
    { id: 'creature', parent: 'rig', geometry: 'block', material: 'paint' },
  ], { player: { node: 'creature' } });
}

function playerRecipe(rules) {
  const recipe = sceneRecipe([{ id: 'creature', geometry: 'block', material: 'paint' }], { player: { node: 'creature' } });
  recipe.game = { ...recipe.game, rules: { version: 1, parts: [{ id: 'creature', tags: ['player'] }], ...rules } };
  return recipe;
}

async function start(recipe, replay = EMPTY_RECORDING) {
  return startGame({}, recipe, { replay, showStatus: false, createRenderer: () => standInRenderer() });
}

function stepFrames(game, frames) {
  for (let frame = 0; frame < frames; frame++) game.runtime.step(STEP_MILLISECONDS);
}

function worldX(game, id) {
  const byId = new Map(game.scene.exportRecipe().nodes.map(node => [node.id, node]));
  let total = 0;
  for (let node = byId.get(id); node; node = byId.get(node.parent)) total += node.translation?.[0] ?? 0;
  return total;
}

test('a player under a translated parent stays where the recipe put it on the first frame', async () => {
  const restore = withAnimationFrameStubs();
  try {
    const game = await start(parentedRecipe());
    assert.equal(worldX(game, 'creature'), 10);
    stepFrames(game, 1);
    assert.equal(worldX(game, 'creature'), 10, 'the parent offset is not counted twice');
    game.dispose();
  } finally {
    restore();
  }
});

test('a player under a rotated or scaled parent is refused with the parent and the fix', async () => {
  const restore = withAnimationFrameStubs();
  try {
    await assert.rejects(start(parentedRecipe({ scale: [2, 2, 2] })), /game\.player\.node "creature" sits under the parent "rig".*only a translation/);
    await assert.rejects(start(parentedRecipe({ rotation: [0, 0.7071068, 0, 0.7071068] })), /parent "rig"/);
  } finally {
    restore();
  }
});

test('the restart rule action puts the player back at its start as well as resetting the rules', async () => {
  const restore = withAnimationFrameStubs();
  try {
    const game = await start(playerRecipe({
      variables: { score: 0 },
      rules: [
        { id: 'score', when: { type: 'timer', seconds: 1 }, do: [{ type: 'set', variable: 'score', value: 5 }] },
        { id: 'again', when: { type: 'variable', expression: ['>=', 'score', 5] }, do: [{ type: 'restart' }] },
      ],
    }), HOLD_FORWARD);
    stepFrames(game, 70);
    assert.equal(game.rules.state.variables.score, 0, 'the rules restarted');
    assert.ok(game.controller.state.position[2] > -0.6, `the player went back to its start, z ${game.controller.state.position[2]}`);
    game.dispose();
  } finally {
    restore();
  }
});

test('restart() on a lost game starts it again: status, player and the timer', async () => {
  const restore = withAnimationFrameStubs();
  try {
    const game = await start(playerRecipe({ rules: [{ id: 'out', when: { type: 'timer', seconds: 1 }, do: [{ type: 'lose' }] }] }), HOLD_FORWARD);
    stepFrames(game, 90);
    assert.equal(game.rules.state.status, 'lost');
    assert.ok(game.controller.state.position[2] < -1);
    await game.restart();
    assert.equal(game.rules.state.status, 'playing');
    assert.deepEqual(game.controller.state.position, [0, 0, 0]);
    stepFrames(game, 1);
    assert.ok(game.controller.state.position[2] > -0.1, 'the player starts from the start again');
    stepFrames(game, 70);
    assert.equal(game.rules.state.status, 'lost', 'the timer runs again from the restart');
    game.dispose();
  } finally {
    restore();
  }
});

test('R restarts a finished game that reads the keyboard, and a replay has no such key', async () => {
  const restore = withAnimationFrameStubs();
  const listeners = [];
  const previous = { add: globalThis.addEventListener, remove: globalThis.removeEventListener };
  globalThis.addEventListener = (name, listener) => listeners.push([name, listener]);
  globalThis.removeEventListener = (name, listener) => listeners.splice(listeners.findIndex(entry => entry[1] === listener), 1);
  const keyListeners = () => listeners.filter(([name]) => name === 'keydown');
  try {
    const recipe = playerRecipe({ rules: [{ id: 'done', when: { type: 'timer', seconds: 0.5 }, do: [{ type: 'win' }] }] });
    const replayed = await start(recipe);
    assert.equal(keyListeners().length, 0);
    replayed.dispose();
    const game = await startGame({}, recipe, { showStatus: false, createRenderer: () => standInRenderer() });
    const [, onKey] = keyListeners()[0];
    onKey({ code: 'KeyR', repeat: false });
    stepFrames(game, 40);
    assert.equal(game.rules.state.status, 'won');
    onKey({ code: 'KeyR', repeat: false });
    assert.equal(game.rules.state.status, 'playing');
    game.dispose();
    assert.equal(keyListeners().length, 0);
  } finally {
    globalThis.addEventListener = previous.add;
    globalThis.removeEventListener = previous.remove;
    restore();
  }
});
