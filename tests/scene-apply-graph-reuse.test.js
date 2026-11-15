import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';

function hierarchyRecipe(platformScale) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'block', type: 'box' }],
    materials: [{ id: 'wall', color: [0.8, 0.8, 0.7] }],
    nodes: [
      { id: 'platform', geometry: 'block', material: 'wall', scale: platformScale },
      { id: 'rider', geometry: 'block', material: 'wall', parent: 'platform', translation: [0.5, 1, 0] },
      { id: 'bystander', geometry: 'block', material: 'wall', translation: [3, 0, 0] },
    ],
  };
}

function sceneState(scene) {
  return {
    recipe: scene.exportRecipe(),
    parts: scene.parts.map(part => [part.name, Array.from(part.matrix)]),
    hidden: scene.parts.map(part => part.visibility?.visible),
  };
}

function freshState(scene) {
  return sceneState(createAgentScene(scene.exportRecipe(), { maxNodes: 50 }));
}

test('moving a parent, a child and a visibility edit give what a fresh build of the edited recipe gives', () => {
  const scene = createAgentScene(hierarchyRecipe([2, 1, 1]), { maxNodes: 50 });
  const edits = [
    [{ type: 'set-node', id: 'platform', translation: [1, 2, 3], rotation: [0, 0.3826834, 0, 0.9238795] }],
    [{ type: 'set-node', id: 'bystander', visible: false }],
    [{ type: 'set-node', id: 'rider', translation: [0, 2, 0] }, { type: 'set-node', id: 'platform', scale: [1, 3, 1] }],
  ];
  for (const edit of edits) {
    scene.apply(edit, { expectedRevision: scene.revision });
    assert.deepEqual(sceneState(scene), freshState(scene));
  }
});

test('a pose edit whose world matrix overflows is refused and leaves the poses and the next edit intact', () => {
  const scene = createAgentScene(hierarchyRecipe([1e20, 1, 1]), { maxNodes: 50 });
  const before = sceneState(scene);
  const revisionBefore = scene.revision;
  assert.throws(
    () => scene.apply([{ type: 'set-node', id: 'rider', translation: [1e30, 0, 0] }], { expectedRevision: scene.revision }),
    RangeError,
  );
  assert.equal(scene.revision, revisionBefore);
  assert.deepEqual(sceneState(scene), before);
  scene.apply([{ type: 'set-node', id: 'bystander', translation: [4, 0, 0] }], { expectedRevision: scene.revision });
  assert.deepEqual(sceneState(scene), freshState(scene));
});

test('a pose edit after earlier edits still refuses an invalid scale with the node list position', () => {
  const scene = createAgentScene(hierarchyRecipe([1, 1, 1]), { maxNodes: 50 });
  scene.apply([{ type: 'set-node', id: 'bystander', translation: [1, 0, 0] }], { expectedRevision: scene.revision });
  assert.throws(
    () => scene.apply([{ type: 'set-node', id: 'bystander', scale: [0, 1, 1] }], { expectedRevision: scene.revision }),
    /nodes\[2\]/,
  );
});

test('a node added after pose edits is built from a fresh graph and the edits before it stay', () => {
  const scene = createAgentScene(hierarchyRecipe([1, 1, 1]), { maxNodes: 50 });
  scene.apply([{ type: 'set-node', id: 'rider', translation: [0, 5, 0] }], { expectedRevision: scene.revision });
  scene.apply([{ type: 'add-node', node: { id: 'extra', geometry: 'block', material: 'wall', translation: [9, 0, 0] } }], { expectedRevision: scene.revision });
  scene.apply([{ type: 'set-node', id: 'extra', translation: [8, 0, 0] }], { expectedRevision: scene.revision });
  assert.deepEqual(sceneState(scene), freshState(scene));
});

test('a refusal raised after the in-place move restores every matrix and the next pose edit matches a fresh build', () => {
  const scene = createAgentScene(hierarchyRecipe([1e-20, 1e-20, 1e-20]), { maxNodes: 50 });
  const before = sceneState(scene);
  const boundsBefore = scene.inspect({ includeBounds: true });
  const revisionBefore = scene.revision;
  assert.throws(
    () => scene.apply([
      { type: 'set-node', id: 'bystander', translation: [5, 0, 0] },
      { type: 'set-node', id: 'rider', scale: [1e-20, 1e-20, 1e-20] },
    ], { expectedRevision: scene.revision }),
    { name: 'RangeError', message: /exceeds Float32 range/ },
  );
  assert.equal(scene.revision, revisionBefore);
  assert.deepEqual(sceneState(scene), before);
  assert.deepEqual(scene.inspect({ includeBounds: true }), boundsBefore);
  scene.apply([{ type: 'set-node', id: 'bystander', translation: [6, 0, 0] }], { expectedRevision: scene.revision });
  assert.deepEqual(sceneState(scene), freshState(scene));
});


// Building a graph allocates one 16-number Float64Array per node, so counting them tells a rebuild from an in-place move.
function graphMatrixAllocations(action) {
  const NativeFloat64Array = globalThis.Float64Array;
  let allocations = 0;
  globalThis.Float64Array = new Proxy(NativeFloat64Array, {
    construct(target, constructorArguments, newTarget) {
      if (constructorArguments[0] === 16) allocations++;
      return Reflect.construct(target, constructorArguments, newTarget);
    },
  });
  try {
    action();
  } finally {
    globalThis.Float64Array = NativeFloat64Array;
  }
  return allocations;
}

test('a pose-only batch moves the committed graph in place and any other edit builds a new one', () => {
  const recipe = hierarchyRecipe([1, 1, 1]);
  for (let index = 0; index < 40; index++) {
    recipe.nodes.push({ id: `filler${index}`, geometry: 'block', material: 'wall', translation: [index, 0, 5] });
  }
  const scene = createAgentScene(recipe, { maxNodes: 100 });
  const nodeCount = recipe.nodes.length;
  const poseAllocations = graphMatrixAllocations(() => {
    scene.apply([{ type: 'set-node', id: 'bystander', translation: [7, 0, 0] }], { expectedRevision: scene.revision });
  });
  assert.ok(poseAllocations < nodeCount / 2, `a pose edit allocated ${poseAllocations} graph matrices for ${nodeCount} nodes`);
  const addAllocations = graphMatrixAllocations(() => {
    scene.apply([{ type: 'add-node', node: { id: 'extra', geometry: 'block', material: 'wall' } }], { expectedRevision: scene.revision });
  });
  assert.ok(addAllocations >= nodeCount, `an added node allocated ${addAllocations} graph matrices for ${nodeCount} nodes`);
});
