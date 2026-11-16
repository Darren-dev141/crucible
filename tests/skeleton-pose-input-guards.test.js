import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseGltf } from '../src/gltf.js';
import { createSkeletonPose, createAssetPose, morphClipFromGltfAnimation } from '../src/skeleton-pose.js';

const restJoint = (name, parent, y) => ({ name, parent, translation: [0, y, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const chainRig = { joints: [restJoint('a', -1, 0), restJoint('b', 0, 1), restJoint('c', 1, 1)] };

test('an aim solver refuses a zero forward axis instead of silently never aiming', () => {
  const aim = { type: 'aim', joint: 'b', target: [1, 1, 1] };
  assert.throws(() => createSkeletonPose({ rig: chainRig, ik: [{ ...aim, forward: [0, 0, 0] }] }), /forward/);
  assert.throws(() => createSkeletonPose({ rig: chainRig, ik: [{ ...aim, worldForward: [0, 0, 0] }] }), /forward/);
});

test('a two-bone solver refuses a zero bendToward direction', () => {
  const twoBone = { type: 'two-bone', root: 'a', middle: 'b', end: 'c', target: [1, 1, 0] };
  assert.throws(() => createSkeletonPose({ rig: chainRig, ik: [{ ...twoBone, bendToward: [0, 0, 0] }] }), /bendToward/);
});

test('a morph-only additive layer refuses a reference time that is not finite, so weights never become NaN', async () => {
  const bytes = readFileSync(new URL('./fixtures/RobotExpressive.glb', import.meta.url));
  const asset = await parseGltf(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { maxVertices: 500000 });
  const dance = asset.animations.find(animation => animation.name === 'Dance');
  const morphs = morphClipFromGltfAnimation(dance, { loop: true });
  assert.throws(() => createAssetPose(asset, { layers: [{ morphs, additive: true, reference: Number.NaN }] }), /reference/);
});
