import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

const { liveAgentPhysicsDefinition } = await import('../src/agent-physics.js');

function recipeWithBodyAtIndexOne(shape) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    nodes: [
      { id: 'marker', geometry: 'small' },
      { id: 'heavy-rock', geometry: 'big', translation: [0, 1, 0], scale: [1, 1, 1] },
    ],
    physics: { duration: 1, bodies: [{ node: 'heavy-rock', type: shape === 'trimesh' ? 'fixed' : 'dynamic', shape }] },
  };
}

function bigGeometry(vertexCount, triangleCount) {
  const positions = new Float32Array(vertexCount * 3);
  for (let index = 0; index < positions.length; index++) positions[index] = Math.sin(index * 12.9898) * 3;
  const indices = new Uint32Array(triangleCount * 3);
  for (let index = 0; index < indices.length; index++) indices[index] = index % vertexCount;
  return { positions, indices };
}

function limitMessage(shape, geometry) {
  const recipe = recipeWithBodyAtIndexOne(shape);
  const geometries = new Map([['small', bigGeometry(3, 1)], ['big', geometry]]);
  try {
    liveAgentPhysicsDefinition(recipe.physics, recipe, geometries);
  } catch (error) {
    return error.message;
  }
  return null;
}

for (const [label, shape, geometry] of [
  ['convex source vertex limit', 'convex', bigGeometry(65537, 1)],
  ['convex hull point limit', 'convex', bigGeometry(5000, 1)],
  ['trimesh triangle limit', 'trimesh', bigGeometry(30, 20001)],
]) {
  test(`${label} names the list index of the node, not its id`, () => {
    const message = limitMessage(shape, geometry);
    assert.ok(message, 'the limit refuses the geometry');
    assert.ok(message.includes('nodes[1].geometry'), `message names nodes[1].geometry: ${message}`);
    assert.ok(!message.includes('heavy-rock]'), `message does not put the id in an index: ${message}`);
  });
}
