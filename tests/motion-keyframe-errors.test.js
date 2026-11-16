import assert from 'node:assert/strict';
import test from 'node:test';
import { loadAllAgentSceneModules } from '../src/agent-scene.js';
import { normalizeAgentMotion } from '../src/agent-motion.js';

await loadAllAgentSceneModules();

// A rejected keyframe names its track and keyframe, so an agent knows which entry to fix.

const RECIPE = { nodes: [{ id: 'body' }] };

function motionWithKeyframes(keyframes) {
  const track = { kind: 'node', id: 'body', property: 'translation', keyframes };
  return { duration: 1, tracks: [{ kind: 'node', id: 'body', property: 'scale', keyframes: [{ time: 0, value: [1, 1, 1] }] }, track] };
}

function rejection(keyframes) {
  try {
    normalizeAgentMotion(motionWithKeyframes(keyframes), RECIPE);
  } catch (error) {
    return error.message;
  }
  assert.fail('expected the motion to be rejected');
}

test('a keyframe value that is not an array names its track and keyframe', () => {
  const message = rejection([{ time: 0, value: [0, 0, 0] }, { time: 0.5, value: 5 }]);
  assert.match(message, /^motion\.tracks\[1\]\.keyframes\[1\]\.value /);
});

test('two keyframes at one time name the track and the repeated keyframe', () => {
  const message = rejection([{ time: 0, value: [0, 0, 0] }, { time: 0.5, value: [1, 0, 0] }, { time: 0.5, value: [2, 0, 0] }]);
  assert.match(message, /^motion\.tracks\[1\]\.keyframes\[2\]\.time: got 0\.5/);
});

test('a track without keyframes names the track', () => {
  const message = rejection([]);
  assert.match(message, /^motion\.tracks\[1\]\.keyframes: got \[\]/);
});

test('a keyframe list that is not an array names the track', () => {
  const message = rejection({ time: 0 });
  assert.match(message, /^motion\.tracks\[1\]\.keyframes /);
});
