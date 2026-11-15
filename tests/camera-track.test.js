import test from 'node:test';
import assert from 'node:assert/strict';
import { createCameraSampler } from '../src/camera-track.js';

const twoFrames = [[[0, 0, 1], [0, 0, 0]], [[0, 0, 3], [0, 0, 0]]];

test('createCameraSampler blends neighbouring frames', () => {
  const sampler = createCameraSampler({ fps: 2, frames: twoFrames });
  assert.equal(sampler.duration, 1);
  assert.deepEqual(sampler.sample(0.25).eye, [0, 0, 2]);
});

test('createCameraSampler rejects empty frames and bad fps with a message that says what to pass (#1407)', () => {
  assert.throws(() => createCameraSampler({ frames: [] }), /at least one \[eye, target\]/);
  assert.throws(() => createCameraSampler({ fps: 0, frames: twoFrames }), /fps must be a positive finite number/);
  assert.throws(() => createCameraSampler({ fps: -24, frames: twoFrames }), /fps must be a positive finite number/);
});

test('createCameraSampler rejects malformed frames and a non-finite sample time (#1407)', () => {
  assert.throws(() => createCameraSampler({ frames: [[[0, 0], [0, 0, 0]]] }), /frames\[0\]/);
  assert.throws(() => createCameraSampler({ frames: twoFrames }).sample(NaN), /finite number of seconds/);
});
