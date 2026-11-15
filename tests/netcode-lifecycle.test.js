import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentScene } from '../src/agent-scene.js';
import { loadPhysicsEngine } from '../src/agent-physics.js';
import { createNetcode } from '../src/netcode.js';

test('init twice without dispose does not subscribe the transport twice', () => {
  let subscriptions = 0;
  let unsubscriptions = 0;
  const transport = {
    id: 'a',
    peers: () => [],
    send() {},
    receive() {
      subscriptions += 1;
      return () => { unsubscriptions += 1; };
    },
  };
  const netcode = createNetcode({ role: 'authority', transport });
  const context = { fixedStepSeconds: 1 / 50 };
  netcode.init(context);
  netcode.init(context);
  assert.equal(subscriptions - unsubscriptions, 1, 'one live subscription after two inits');
  netcode.dispose();
  assert.equal(subscriptions - unsubscriptions, 0, 'dispose leaves none');
});

test('a failed physics rebuild is reported, not left as a silent dead world', async () => {
  await loadPhysicsEngine();
  const { createGamePhysics } = await import('../src/game-physics.js');
  const scene = createAgentScene({
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'block', type: 'box', bevel: 0 }],
    materials: [{ id: 'paint', color: [0.5, 0.5, 0.5] }],
    nodes: [
      { id: 'floor', geometry: 'block', material: 'paint', translation: [0, -0.25, 0], scale: [10, 0.5, 10] },
      { id: 'hero', geometry: 'block', material: 'paint', translation: [4, 0.8, 0], scale: [0.6, 1.6, 0.6] },
      { id: 'crate', geometry: 'block', material: 'paint', translation: [0, 3, 0] },
    ],
    physics: { duration: 1, bodies: [{ node: 'floor', type: 'fixed', shape: 'box' }, { node: 'hero', type: 'kinematic', shape: 'capsule' }, { node: 'crate', shape: 'box' }] },
    game: { player: { node: 'hero', footOffset: 0.8 }, camera: 'follow', input: 'keyboard', physics: true, ground: 0 },
  });
  const recipe = scene.exportRecipe();
  const physics = await createGamePhysics({ recipe, scene, playerNode: 'hero' });
  recipe.nodes.find(node => node.id === 'crate').translation[1] = Number.NaN;
  await assert.rejects(physics.restart());
  assert.ok(physics.failure instanceof Error, 'the failure is readable');
  assert.throws(() => physics.fixedUpdate(1 / 60, {}, null, 0), /rebuilt/i, 'steps say why instead of doing nothing');
  recipe.nodes.find(node => node.id === 'crate').translation[1] = 3;
  await physics.restart();
  assert.equal(physics.failure, null, 'a good restart clears the failure');
  assert.doesNotThrow(() => physics.fixedUpdate(1 / 60, {}, null, 0));
  physics.dispose();
});
