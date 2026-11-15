import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLineArt, lineNodeTable, LINE_ART_LIMITS } from '../src/line-art.js';
import { installRenderPasses } from '../src/render-passes.js';
import { parseGltf } from '../src/gltf.js';
import { createAgentScene, loadAllAgentSceneModules } from '../src/agent-scene.js';
import { assetCopyKey } from '../src/agent-scene-assets.js';
import { skinnedStripAsset } from './fixtures/skinned-strip.js';

await loadAllAgentSceneModules();

test('lines.nodes fills each entry with defaults, the colour following lines.color', () => {
  const lines = resolveLineArt({ color: [1, 0, 0], nodes: { basket: { silhouetteOnly: true }, rug: { lines: false }, vase: { color: [0, 0, 1] } } });
  assert.deepEqual(lines.nodes.basket, { lines: true, silhouetteOnly: true, color: [1, 0, 0] });
  assert.deepEqual(lines.nodes.rug, { lines: false, silhouetteOnly: false, color: [1, 0, 0] });
  assert.deepEqual(lines.nodes.vase, { lines: true, silhouetteOnly: false, color: [0, 0, 1] });
  assert.equal(resolveLineArt({}).nodes, undefined);
});

test('lines.nodes errors name the node and the fix', () => {
  assert.throws(() => resolveLineArt({ nodes: [] }), /lines\.nodes must be a JSON object/);
  assert.throws(() => resolveLineArt({ nodes: { basket: { outline: true } } }), /lines\.nodes\["basket"\] has unknown field: outline/);
  assert.throws(() => resolveLineArt({ nodes: { basket: { lines: 'no' } } }), /lines\.nodes\["basket"\]\.lines must be true or false/);
  assert.throws(() => resolveLineArt({ nodes: { basket: { color: [1] } } }), /lines\.nodes\["basket"\]\.color must be three/);
  assert.throws(() => resolveLineArt({ nodes: { basket: { lines: false, silhouetteOnly: true } } }), /Fix: drop lines:false/);
  assert.throws(() => resolveLineArt({ nodes: { '': {} } }), /node IDs of 1 to 256 characters/);
  const tooMany = Object.fromEntries(Array.from({ length: LINE_ART_LIMITS.maxNodes + 1 }, (unused, index) => [`node-${index}`, {}]));
  assert.throws(() => resolveLineArt({ nodes: tooMany }), /limit is 64/);
});

test('the per-ID table carries the mode, node index and colour of each object ID', () => {
  const lines = resolveLineArt({ nodes: { basket: { silhouetteOnly: true, color: [1, 0, 0] }, rug: { lines: false }, ghost: { lines: false } } });
  const table = lineNodeTable(lines, { floor: [1], basket: [2, 3, 4], rug: [5] });
  assert.equal(table.count, 6);
  const texel = identifier => [...table.data.subarray(identifier * 4, identifier * 4 + 4)];
  assert.deepEqual(texel(1), [...lines.color.map(Math.fround), 0 + 4 * 1], 'a node the recipe does not name draws normally');
  assert.deepEqual(texel(2), [1, 0, 0, 2 + 4 * 2]);
  assert.deepEqual(texel(4), texel(2).map((value, index) => (index === 3 ? 2 + 4 * 2 : value)), 'the parts of one node share colour, mode and index');
  assert.deepEqual(texel(5), [...lines.color.map(Math.fround), 1 + 4 * 3]);
  assert.equal(lineNodeTable(resolveLineArt({}), { floor: [1] }).count, 0, 'no per-node settings, no table');
});

test('objectNodes groups the object IDs by node, and a placed asset is one node', async () => {
  const assetId = 'ab'.repeat(32);
  const asset = await parseGltf(skinnedStripAsset());
  const recipe = {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'ground', type: 'box' }],
    materials: [{ id: 'grass', color: [0.2, 0.5, 0.2] }],
    nodes: [{ id: 'floor', geometry: 'ground', material: 'grass' }, { id: 'prop', asset: { id: assetId } }],
  };
  const scene = createAgentScene(recipe, {}, { assets: new Map([[assetCopyKey(assetId, 0), asset]]) });
  const renderer = { batches: [{ parts: scene.parts }], drawsInOpaqueLoop: () => true };
  installRenderPasses(renderer);
  const names = renderer.passSupport.objectNames();
  const nodes = renderer.passSupport.objectNodes();
  assert.deepEqual(Object.keys(nodes).sort(), ['floor', 'prop']);
  assert.equal(nodes.prop.length, names.filter(name => name.startsWith('prop/')).length);
  assert.ok(nodes.prop.length >= 1);
  assert.deepEqual(nodes.prop.map(identifier => names[identifier - 1].split('/')[0]), nodes.prop.map(() => 'prop'));
  assert.deepEqual(nodes.floor.map(identifier => names[identifier - 1]), ['floor']);
});

function sceneWithNodeIds(ids, lines) {
  const recipe = {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'ground', type: 'box' }],
    materials: [{ id: 'grass', color: [0.2, 0.5, 0.2] }],
    nodes: ids.map(id => ({ id, geometry: 'ground', material: 'grass' })),
  };
  if (lines) recipe.environment = { lines };
  return createAgentScene(recipe, {});
}

test('a node named like an Object.prototype member is an ordinary node', () => {
  const ids = ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__'];
  const scene = sceneWithNodeIds(ids);
  const renderer = { batches: [{ parts: scene.parts }], drawsInOpaqueLoop: () => true };
  installRenderPasses(renderer);
  const nodes = renderer.passSupport.objectNodes();
  assert.deepEqual(Object.keys(nodes).sort(), [...ids].sort());
  assert.deepEqual(Object.getOwnPropertyDescriptor(nodes, 'constructor').value.length, 1);
});

test('lines.nodes does not read inherited members for a node named constructor or valueOf', () => {
  const lines = resolveLineArt({ nodes: { floor: { lines: false } } });
  const table = lineNodeTable(lines, Object.assign(Object.create(null), { constructor: [1], valueOf: [2], floor: [3] }));
  const texel = identifier => [...table.data.subarray(identifier * 4, identifier * 4 + 4)];
  assert.equal(texel(1)[3], 0 + 4 * 1, 'constructor draws normally');
  assert.equal(texel(2)[3], 0 + 4 * 2, 'valueOf draws normally');
  assert.equal(texel(3)[3], 1 + 4 * 3, 'floor is off');
});

test('lines.nodes names that match no node of the recipe fail and name the fix', () => {
  assert.throws(() => sceneWithNodeIds(['floor'], { nodes: { flooor: { lines: false } } }), /environment\.lines\.nodes.*flooor.*scene_inspect/s);
  assert.doesNotThrow(() => sceneWithNodeIds(['floor', 'constructor'], { nodes: { floor: { lines: false }, constructor: { lines: false } } }));
});
