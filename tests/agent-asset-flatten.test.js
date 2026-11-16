import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGltf } from '../src/gltf.js';
import { createAgentScene, loadAllAgentSceneModules } from '../src/agent-scene.js';
import { assetCopyKey, materialOutput, normalizeAssetPlacement } from '../src/agent-scene-assets.js';
import { skinnedStripAsset } from './fixtures/skinned-strip.js';

const ASSET_ID = 'ab'.repeat(32);

await loadAllAgentSceneModules();

// The strip with a second primitive that uses a second named material, so the asset has two materials.
async function twoMaterialAssets() {
  const document = skinnedStripAsset(gltf => {
    gltf.materials[0].name = 'Skin';
    gltf.materials.push({ name: 'Cloth', pbrMetallicRoughness: { baseColorFactor: [0.1, 0.3, 0.9, 1], metallicFactor: 0.8, roughnessFactor: 0.2 }, emissiveFactor: [0.5, 0, 0] });
    gltf.meshes[0].primitives.push({ ...gltf.meshes[0].primitives[0], material: 1 });
  });
  return new Map([[assetCopyKey(ASSET_ID, 0), await parseGltf(document)]]);
}

function recipe(asset) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'ground', type: 'box' }],
    materials: [{ id: 'grass', color: [0.2, 0.5, 0.2] }],
    nodes: [
      { id: 'floor', geometry: 'ground', material: 'grass' },
      { id: 'coat', asset: { id: ASSET_ID, ...asset } },
      { id: 'untouched', translation: [3, 0, 0], asset: { id: ASSET_ID } },
    ],
  };
}

async function materialsOf(asset) {
  const scene = createAgentScene(recipe(asset), {}, { assets: await twoMaterialAssets() });
  const named = prefix => scene.parts.filter(part => part.name.startsWith(prefix)).map(part => part.material);
  return { scene, coat: named('coat/'), untouched: named('untouched/') };
}

test('unlit flatten sets the unlit tag on every material of one placement and leaves the other alone', async () => {
  const { coat, untouched } = await materialsOf({ flatten: { unlit: true } });
  assert.equal(coat.length, 2);
  for (const material of coat) {
    assert.equal(material.tag, 'unlit');
    assert.equal(material.emission, 0);
  }
  for (const material of untouched) assert.notEqual(material.tag, 'unlit');
  assert.equal(untouched[1].metallic, 0.8, 'the other placement keeps its source material');
});

test('a flatten colour paints every material one flat lit colour', async () => {
  const { coat } = await materialsOf({ flatten: { color: [0.4, 0.4, 0.4] } });
  for (const material of coat) {
    assert.deepEqual(Array.from(material.color), [0.4, 0.4, 0.4]);
    assert.equal(material.metallic, 0);
    assert.equal(material.roughness, 1);
    assert.equal(material.emission, 0);
    assert.notEqual(material.tag, 'unlit');
  }
});

test('a named override wins over flatten for its material only', async () => {
  const { coat } = await materialsOf({ flatten: { unlit: true, color: [0.4, 0.4, 0.4] }, materials: [{ name: 'Cloth', color: [1, 0, 0] }] });
  const skin = coat.find(material => material.name === 'Skin');
  const cloth = coat.find(material => material.name === 'Cloth');
  assert.deepEqual(Array.from(cloth.color), [1, 0, 0]);
  assert.deepEqual(Array.from(skin.color), [0.4, 0.4, 0.4]);
  assert.equal(cloth.tag, 'unlit');
});

test('materialOutput drops the listed maps and keeps the source untouched', () => {
  const source = { color: [1, 1, 1], map: { id: 'base' }, normalMap: { id: 'normal' } };
  const output = materialOutput(source, { emission: 0 }, ['map', 'normalMap']);
  assert.equal(output.map, undefined);
  assert.equal(output.normalMap, undefined);
  assert.ok(source.map && source.normalMap);
});

test('flatten rejects bad input with an error that says what to pass', () => {
  assert.throws(() => normalizeAssetPlacement({ id: ASSET_ID, flatten: {} }), /at least one of color or unlit/);
  assert.throws(() => normalizeAssetPlacement({ id: ASSET_ID, flatten: { unlit: 'yes' } }), /true or false/);
  assert.throws(() => normalizeAssetPlacement({ id: ASSET_ID, flatten: { color: [2, 0, 0] } }), /from 0 to 1/);
  assert.throws(() => normalizeAssetPlacement({ id: ASSET_ID, flatten: { colour: [1, 0, 0] } }), /no such field/);
  assert.deepEqual(normalizeAssetPlacement({ id: ASSET_ID, flatten: { unlit: true } }).flatten, { unlit: true });
});
