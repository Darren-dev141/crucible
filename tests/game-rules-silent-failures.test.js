import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { createAgentScene } from '../src/agent-scene.js';
import { startGame } from '../src/game.js';
import { createGameRules, GAME_RULES_LIMITS } from '../src/game-rules.js';

const STEP = 1 / 60;
const STEP_MILLISECONDS = 1000 / 60;
const EMPTY_RECORDING = { version: 1, samples: 0, events: [] };

// A heap reading without a collection counts garbage that has not been swept yet, and when V8 sweeps depends on how big the
// heap already is, so a leak check reads the heap after a full collection (issue #1772).
setFlagsFromString('--expose-gc');
const collectGarbage = runInNewContext('gc');

function retainedHeapBytes() {
  collectGarbage();
  return process.memoryUsage().heapUsed;
}

test('onEvent hears every event after the stored log is full', () => {
  const heard = [];
  const rules = createGameRules({
    version: 1,
    rules: [{ when: { type: 'timer', seconds: STEP, repeat: true }, do: [{ type: 'sound', name: 'tick' }] }],
  }, { onEvent: entry => { if (entry.action === 'sound') heard.push(entry); } });
  const steps = GAME_RULES_LIMITS.maximumEventLogEntries * 2 + 1000;
  for (let index = 0; index < steps; index += 1) rules.fixedUpdate(STEP);
  assert.equal(heard.length, steps);
  assert.ok(rules.eventLog.length <= GAME_RULES_LIMITS.maximumEventLogEntries);
  assert.ok(rules.droppedEvents > 0);
});

test('reportContact is ignored once the game is won, so a late contact does not leak into the next play', () => {
  const rules = createGameRules({
    version: 1,
    parts: [{ id: 'a', tags: ['x'] }, { id: 'b', tags: ['y'] }],
    rules: [
      { when: { type: 'contact', between: ['x', 'y'] }, do: [{ type: 'sound', name: 'bump' }] },
      { when: { type: 'timer', seconds: STEP }, do: [{ type: 'win' }] },
    ],
  });
  rules.fixedUpdate(STEP);
  assert.equal(rules.state.status, 'won');
  for (let report = 0; report < 100000; report += 1) rules.reportContact('a', 'b');
  const heapBeforeMore = retainedHeapBytes();
  for (let report = 0; report < 400000; report += 1) rules.reportContact('a', 'b');
  const heapGrowth = retainedHeapBytes() - heapBeforeMore;
  assert.ok(heapGrowth < 8 * 1024 * 1024, `400000 contacts after game over kept ${heapGrowth} bytes on the heap`);
  rules.restart();
  rules.reportContact('a', 'b');
  rules.fixedUpdate(STEP);
  const bumps = rules.eventLog.filter(entry => entry.action === 'sound');
  assert.equal(bumps.length, 1, 'only the contact reported while playing counts');
});

test('reportContact after game over still refuses an unknown part', () => {
  const rules = createGameRules({ version: 1, parts: [{ id: 'a', tags: ['x'] }], rules: [{ when: { type: 'timer', seconds: STEP }, do: [{ type: 'win' }] }] });
  rules.fixedUpdate(STEP);
  assert.throws(() => rules.reportContact('a', 'missing'), /missing/);
});

function recipeWithHiddenSecret(partFields) {
  const scene = createAgentScene({
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'block', type: 'box' }], materials: [{ id: 'paint', color: [0.5, 0.5, 0.5] }],
    nodes: [
      { id: 'creature', geometry: 'block', material: 'paint' },
      { id: 'secret', geometry: 'block', material: 'paint', visible: false },
    ],
  });
  scene.apply([{ type: 'set-game', game: { player: { node: 'creature' } } }], { expectedRevision: scene.revision });
  const recipe = scene.exportRecipe();
  recipe.game = {
    ...recipe.game,
    rules: { version: 1, parts: [{ id: 'creature', tags: ['player'] }, { id: 'secret', tags: ['item'], ...partFields }] },
  };
  return recipe;
}

async function secretVisibleAfterOneStep(partFields) {
  const previous = { request: globalThis.requestAnimationFrame, cancel: globalThis.cancelAnimationFrame };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  try {
    const renderer = { render() {}, resize() {}, updateParts() {}, replaceParts() {}, dispose() {} };
    const game = await startGame({}, recipeWithHiddenSecret(partFields), { replay: EMPTY_RECORDING, showStatus: false, createRenderer: () => renderer });
    game.runtime.step(STEP_MILLISECONDS);
    const visible = game.scene.parts.find(part => part.name === 'secret').visibility.visible;
    game.dispose();
    return visible;
  } finally {
    globalThis.requestAnimationFrame = previous.request;
    globalThis.cancelAnimationFrame = previous.cancel;
  }
}

test('a rules part named like a hidden node stays hidden on the first frame', async () => {
  assert.equal(await secretVisibleAfterOneStep({}), false);
});

test('a rules part that sets visible true overrides the hidden node', async () => {
  assert.equal(await secretVisibleAfterOneStep({ visible: true }), true);
});
