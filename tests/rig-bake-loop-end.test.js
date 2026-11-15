import test from 'node:test';
import assert from 'node:assert/strict';
import { mat4 } from 'gl-matrix';
import { createAnimationClip, compileAnimationSampler } from '../src/animation.js';
import { bakeRigExport } from '../src/rig.js';

function bakeWalk(loop) {
  const clip = createAnimationClip({
    duration: 1,
    loop,
    tracks: [{ target: 'bone', property: 'translation', keyframes: [{ time: 0, value: [0, 0, 0] }, { time: 1, value: [0, 0, 4] }] }],
  });
  const sampler = compileAnimationSampler(clip);
  const motionSampler = {
    sample(time) {
      const [track] = sampler.sample(time);
      return { nodes: new Map([['bone', { translation: track.output }]]) };
    },
  };
  const recipe = {
    nodes: [{ id: 'bone', armature: true, parent: null, translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }],
    armatures: [{ id: 'bone' }],
    motion: { duration: 1, loop },
  };
  const restGraph = { getNode: () => ({ worldMatrix: mat4.create() }) };
  const exported = bakeRigExport(recipe, restGraph, motionSampler, { frameRate: 4 });
  return exported.clips[0].tracks[0].keyframes.map(keyframe => [keyframe.time, Math.round(keyframe.value[2] * 1e6) / 1e6]);
}

test('a baked looping clip ends on its last pose instead of wrapping to the first', () => {
  const expected = [[0, 0], [0.25, 1], [0.5, 2], [0.75, 3], [1, 4]];
  assert.deepEqual(bakeWalk(true), expected);
  assert.deepEqual(bakeWalk(false), expected);
});
