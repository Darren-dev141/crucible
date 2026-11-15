import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { startGame } from '../src/game.js';
import { gaitClip, standClip } from './fixtures/foot-slide.js';

// A vehicle reports its speed but no intentSpeed, so an animated vehicle player must be driven by "speed".

const FRAME_MILLISECONDS = 1000 / 60;

function plainClip(clip) {
  return {
    duration: clip.duration,
    loop: clip.loop,
    tracks: clip.tracks.map(track => ({
      target: track.target,
      property: track.property,
      keyframes: track.keyframes.map(({ time, value }) => ({ time, value: [...value] })),
    })),
  };
}

function rolloutAnimation(overrides = {}) {
  return {
    clips: { idle: plainClip(standClip()), roll: plainClip(gaitClip({ speed: 1.4, cycle: 1 })) },
    parameters: { speed: { type: 'number' } },
    rootMotion: { bone: 'Root' },
    layers: [{
      name: 'base',
      states: [{ name: 'move', blend: { parameter: 'speed', motions: [{ clip: 'idle', threshold: 0 }, { clip: 'roll', threshold: 1.4 }] } }],
    }],
    ...overrides,
  };
}

function vehicleScene() {
  return createAgentScene({
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'block', type: 'box' }], materials: [{ id: 'paint', color: [0.5, 0.5, 0.5] }],
    nodes: [
      { id: 'Cart' },
      { id: 'Root', parent: 'Cart' },
      { id: 'FootL', parent: 'Root', translation: [0.1, 0, 0], geometry: 'block', material: 'paint' },
      { id: 'FootR', parent: 'Root', translation: [-0.1, 0, 0], geometry: 'block', material: 'paint' },
    ],
  });
}

function applyGame(scene, player) {
  scene.apply([{ type: 'set-game', game: { player: { node: 'Cart', controller: 'vehicle', ...player } } }], { expectedRevision: scene.revision });
  return scene.exportRecipe();
}

test('an animated vehicle player defaults to the speed drive and keeps stepping while it drives', async () => {
  const recipe = applyGame(vehicleScene(), { animation: rolloutAnimation() });
  assert.deepEqual(recipe.game.player.animation.drive, { speed: 'speed' });
  const previous = { request: globalThis.requestAnimationFrame, cancel: globalThis.cancelAnimationFrame };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  const replay = { version: 1, samples: 60, events: [[1, 'keyboard/KeyW', 1]] };
  const game = await startGame({}, recipe, { replay, showStatus: false, createRenderer: () => ({ render() {}, resize() {}, updateParts() {}, replaceParts() {}, dispose() {} }) });
  try {
    for (let frame = 0; frame < 30; frame++) game.runtime.step(FRAME_MILLISECONDS);
    assert.ok(game.runtime.stats.fixedSteps >= 30);
  } finally {
    game.dispose();
    globalThis.requestAnimationFrame = previous.request;
    globalThis.cancelAnimationFrame = previous.cancel;
  }
});

test('a vehicle player refuses an intentSpeed drive and says to use speed', () => {
  const scene = vehicleScene();
  const refused = () => applyGame(scene, { animation: rolloutAnimation({ drive: { speed: 'intentSpeed' } }) });
  assert.throws(refused, /player\.animation\.drive\.speed is "intentSpeed", which the vehicle controller does not report\. Use "speed"/);
});
