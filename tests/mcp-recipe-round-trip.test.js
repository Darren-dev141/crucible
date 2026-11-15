import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentMcpServer } from '../scripts/mcp-server.mjs';
import { walkerRecipe } from '../bench/agent-modeling/walker.mjs';
import { createAgentScene, loadPhysicsEngine, AGENT_SCENE_CAPABILITIES } from '../src/agent-scene.js';

await loadPhysicsEngine();

function oneBoxRecipe(extra = {}) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box', bevel: 0 }],
    materials: [{ id: 'red', color: [1, 0, 0] }],
    nodes: [{ id: 'a', geometry: 'cube', material: 'red' }],
    ...extra,
  };
}

function fractureRecipe() {
  return oneBoxRecipe({
    nodes: [
      { id: 'floor', geometry: 'cube', material: 'red', scale: [10, 0.2, 10], translation: [0, -0.1, 0] },
      { id: 'crate', geometry: 'cube', material: 'red', translation: [0, 2, 0] },
    ],
    physics: { duration: 1, bodies: [{ node: 'floor', type: 'fixed' }] },
  });
}

async function withRoundTripClient(use) {
  let scene;
  const runtime = {
    activeSessionId() { return scene ? 'round-trip' : null; },
    async capabilities() { return { scene: AGENT_SCENE_CAPABILITIES, phase: 'idle', availableIn: 'test' }; },
    async create({ recipe }) {
      scene = createAgentScene(recipe);
      return { sessionId: 'round-trip', revision: scene.revision };
    },
    async apply({ expectedRevision, operations }) {
      scene.apply(operations, { expectedRevision });
      return { sessionId: 'round-trip', revision: scene.revision };
    },
    async exportRecipe() { return { sessionId: 'round-trip', revision: scene.revision, recipe: scene.exportRecipe() }; },
    async close() {},
  };
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: 'crucible-recipe-round-trip-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await use(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function call(client, name, argumentsValue) {
  const result = await client.callTool({ name, arguments: argumentsValue });
  const text = result.content?.find(item => item.type === 'text')?.text ?? '';
  return { isError: result.isError === true, text, structured: result.structuredContent };
}

async function exportedRecipe(client) {
  const exported = await call(client, 'scene_export_recipe', {});
  assert.equal(exported.isError, false, exported.text);
  return exported.structured.recipe;
}

async function applyOperations(client, operations) {
  const revision = (await call(client, 'scene_export_recipe', {})).structured.revision;
  return call(client, 'scene_apply', { expectedRevision: revision, operations });
}

async function assertAccepted(client, recipe) {
  const created = await call(client, 'scene_create', { recipe });
  assert.equal(created.isError, false, created.text);
}

test('an exported one-box recipe is accepted by scene_create unchanged', async () => {
  await withRoundTripClient(async client => {
    await assertAccepted(client, oneBoxRecipe());
    await assertAccepted(client, await exportedRecipe(client));
    await assertAccepted(client, oneBoxRecipe({ environment: { setup: 'sunset' } }));
    const sunset = await exportedRecipe(client);
    await assertAccepted(client, sunset);
    const applied = await applyOperations(client, [{ type: 'set-environment', environment: sunset.environment }]);
    assert.equal(applied.isError, false, applied.text);
  });
});

test('an exported recipe with fracture joints is accepted by scene_create', async () => {
  await withRoundTripClient(async client => {
    await assertAccepted(client, fractureRecipe());
    const fractured = await applyOperations(client, [{ type: 'fracture-node', node: 'crate', cells: 4, strength: 10, seed: 1 }]);
    assert.equal(fractured.isError, false, fractured.text);
    const recipe = await exportedRecipe(client);
    const joint = recipe.physics.joints[0];
    assert.equal(typeof joint.name, 'string');
    assert.equal(joint.breakImpulse, 10);
    await assertAccepted(client, recipe);
  });
});

test('scene_create accepts physics events, fields and ragdoll', async () => {
  await withRoundTripClient(async client => {
    const withEvents = fractureRecipe();
    withEvents.physics.bodies.push({ node: 'crate', type: 'dynamic' });
    withEvents.physics.events = [{ time: 0.1, body: 'crate', impulse: [1, 0, 0] }];
    withEvents.physics.fields = [{ type: 'wind', direction: [1, 0, 0], strength: 2 }];
    await assertAccepted(client, withEvents);
    await assertAccepted(client, await exportedRecipe(client));
    const ragdoll = fractureRecipe();
    ragdoll.physics.ragdoll = { armature: 'missing-rig' };
    const refused = await call(client, 'scene_create', { recipe: ragdoll });
    assert.doesNotMatch(refused.text, /Unrecognized key/);
    assert.match(refused.text, /armature/);
  });
});

test('scene_create accepts effects flash and distortion', async () => {
  await withRoundTripClient(async client => {
    const recipe = oneBoxRecipe({
      effects: {
        flash: { node: 'a', startTime: 0, attack: 0, decay: 0.15, intensity: 3.5, radius: 6, ambient: 0.15 },
        distortion: [{ shape: 'ring', node: 'a', startTime: 0, speed: 45, thickness: 2.2, strength: 1 }],
      },
    });
    await assertAccepted(client, recipe);
    const applied = await applyOperations(client, [{ type: 'set-effects', effects: recipe.effects }]);
    assert.equal(applied.isError, false, applied.text);
  });
});

test('scene_create accepts the grid mesh base the docs use for decals', async () => {
  await withRoundTripClient(async client => {
    const recipe = oneBoxRecipe({
      geometries: [{ id: 'badge', type: 'mesh', base: { type: 'grid', segments: 16 }, edits: [{ op: 'solidify', thickness: 0.02, offset: -1 }] }],
      nodes: [{ id: 'a', geometry: 'badge', material: 'red' }],
    });
    await assertAccepted(client, recipe);
  });
});

test('scene_create names the bad field and the allowed ones for a malformed motion track', async () => {
  await withRoundTripClient(async client => {
    const recipe = oneBoxRecipe({
      motion: { duration: 1, tracks: [{ node: 'a', property: 'translation', keyframes: [{ time: 0, value: [0, 0, 0] }] }] },
    });
    const created = await call(client, 'scene_create', { recipe });
    assert.equal(created.isError, true);
    assert.match(created.text, /Unknown or unsupported motion track field: node/);
    assert.match(created.text, /Allowed fields: kind, id, property/);
  });
});

test('scene_create accepts a recipe ragdoll on a real armature', async () => {
  await withRoundTripClient(async client => {
    const recipe = walkerRecipe();
    delete recipe.motion;
    recipe.geometries.push({ id: 'slab', type: 'box' });
    recipe.nodes.push({ id: 'floor', geometry: 'slab', material: 'cloth', translation: [0, -0.25, 0], scale: [8, 0.5, 8] });
    recipe.armatures[0].translation = [0, 1, 0];
    recipe.physics = { duration: 1, bodies: [{ node: 'floor', type: 'fixed' }], ragdoll: { armature: 'rig' } };
    await assertAccepted(client, recipe);
  });
});

test('scene_create accepts the plane mesh base and refuses segments outside 1 to 64', async () => {
  await withRoundTripClient(async client => {
    const withSegments = segments => oneBoxRecipe({
      geometries: [{ id: 'sheet', type: 'mesh', base: { type: 'plane', segments } }],
      nodes: [{ id: 'a', geometry: 'sheet', material: 'red' }],
    });
    await assertAccepted(client, withSegments(8));
    for (const segments of [0, 65]) {
      const refused = await call(client, 'scene_create', { recipe: withSegments(segments) });
      assert.equal(refused.isError, true);
    }
  });
});

test('scene_create names the valid kinds and properties for a motion track with a wrong kind or property', async () => {
  await withRoundTripClient(async client => {
    const keyframes = [{ time: 0, value: [0, 0, 0] }];
    const createdWith = track => call(client, 'scene_create', { recipe: oneBoxRecipe({ motion: { duration: 1, tracks: [track] } }) });
    const missingKind = await createdWith({ id: 'a', property: 'translation', keyframes });
    assert.match(missingKind.text, /needs kind \(node, material, camera, geometry, light, sun, environment, effects\)/);
    const wrongKind = await createdWith({ kind: 'sky', id: 'a', property: 'translation', keyframes });
    assert.match(wrongKind.text, /Unknown motion track kind: "sky"\. Kinds: node, material/);
    const wrongProperty = await createdWith({ kind: 'node', id: 'a', property: 'bogus', keyframes });
    assert.match(wrongProperty.text, /Unknown node track property: "bogus"\. node properties: translation, rotation, scale\./);
  });
});
