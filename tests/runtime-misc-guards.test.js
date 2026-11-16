import assert from 'node:assert/strict';
import test from 'node:test';
import { triangulate } from '../src/triangulate.js';
import { createStreaming } from '../src/streaming.js';
import { createInput } from '../src/input.js';
import { crowdFrameBlend, createCrowdParts } from '../src/crowd-skinning.js';

test('triangulate rejects an empty contour with a named error and keeps two points empty', () => {
  assert.deepEqual(triangulate([[0, 0], [1, 0]], []), []);
  assert.throws(() => triangulate([], []), /empty contour/);
});

test('triangulate refuses a non-finite coordinate and names the point', () => {
  assert.throws(() => triangulate([[0, 0], [1, 0], [Number.NaN, 1]], []), /finite/);
});

test('createStreaming refuses a fractional maximumConcurrentLoads', () => {
  assert.throws(() => createStreaming({ budgetBytes: 100, loaders: {}, maximumConcurrentLoads: 2.5 }), /maximumConcurrentLoads/);
});

test('input dispose disposes every source even when one throws, then reports the failure', () => {
  const disposed = [];
  const input = createInput();
  const make = (name, fails) => ({ name, attach() {}, dispose() { disposed.push(name); if (fails) throw new Error(`${name} failed`); } });
  input.registerSource(make('first', false)).registerSource(make('second', true)).registerSource(make('third', false));
  assert.throws(() => input.dispose(), /second failed/);
  assert.deepEqual(disposed.sort(), ['first', 'second', 'third']);
});

test('input unregisterSource still removes the source when its dispose throws', () => {
  const input = createInput();
  input.registerSource({ name: 'pad', attach() {}, dispose() { throw new Error('pad failed'); } });
  assert.throws(() => input.unregisterSource('pad'), /pad failed/);
  assert.deepEqual(input.sources, []);
});

test('crowdFrameBlend never throws and maps non-finite seconds to the first frame', () => {
  const palette = { frameCount: 10, frameStep: 0.1, duration: 0.9, jointCount: 4, loop: true };
  for (const loop of [true, false]) {
    for (const seconds of [Number.NaN, Infinity]) {
      assert.deepEqual([...crowdFrameBlend({ ...palette, loop }, seconds)], [0, 16, 0]);
    }
  }
});

test('crowd setTimes refuses non-finite seconds and names the instance', () => {
  const geometry = { positions: new Float32Array(9), indices: new Uint32Array([0, 1, 2]) };
  const rig = { parts: [{ geometry, material: {} }], jointCount: 1 };
  const palette = { frameCount: 2, frameStep: 0.5, duration: 1, jointCount: 1, loop: true, data: new Float32Array(32) };
  const instances = [{ matrix: new Float32Array(16) }, { matrix: new Float32Array(16) }];
  const crowd = createCrowdParts({ rig, palette, instances, lods: false });
  assert.throws(() => crowd.setTimes([0, Number.NaN]), /setTimes instance 1 needs finite seconds/);
});
