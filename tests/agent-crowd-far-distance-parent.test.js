import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseGltf } from '../src/gltf.js';
import { createAgentScene, loadAllAgentSceneModules } from '../src/agent-scene.js';
import { assetCopyKey } from '../src/agent-scene-assets.js';

await loadAllAgentSceneModules();

const ASSET_ID = 'ef'.repeat(32);
const bytes = readFileSync(new URL('./fixtures/RobotExpressive.glb', import.meta.url));

async function loadRobot() {
  return parseGltf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { maxVertices: 500000 });
}

/** A crowd of 30 under an optional parent group at `offset`, watched from a camera that keeps the same view of the crowd. */
async function crowdSceneUnder(offset) {
  const robot = await loadRobot();
  const walking = robot.animations.findIndex(animation => animation.name === 'Walking');
  const crowd = { clip: walking, count: 30, seed: 5, spacing: 2, rateJitter: 0, farDistance: 15, farRate: 2 };
  const placement = { id: 'people', asset: { id: ASSET_ID, crowd }, ...(offset ? { parent: 'stage' } : {}) };
  const recipe = {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [], materials: [],
    camera: { eye: [(offset?.[0] ?? 0), 3, 14 + (offset?.[2] ?? 0)], target: [(offset?.[0] ?? 0), 1, (offset?.[2] ?? 0)] },
    nodes: [...(offset ? [{ id: 'stage', translation: offset }] : []), placement],
  };
  const assets = new Map([[assetCopyKey(ASSET_ID, 0), await loadRobot()], [assetCopyKey(ASSET_ID, 1), robot]]);
  return createAgentScene(recipe, {}, { assets });
}

function blendsAt(scene, time) {
  scene.sampleMotion(time);
  return scene.parts.filter(part => part.crowd).map(part => Array.from(part.assembly.offset));
}

test('farDistance measures in world space when the crowd placement has a moved parent', async () => {
  const unmoved = await crowdSceneUnder(null);
  const moved = await crowdSceneUnder([100, 0, 40]);
  for (const time of [0.37, 1.13, 2.41]) {
    assert.deepEqual(blendsAt(moved, time), blendsAt(unmoved, time), `the moved crowd shows the same poses as the unmoved one at ${time} s`);
  }
});
