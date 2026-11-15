import assert from 'node:assert/strict';
import test from 'node:test';
import { triangulate } from '../src/triangulate.js';
import { createStreaming } from '../src/streaming.js';
import { createInput } from '../src/input.js';
import { crowdFrameBlend } from '../src/crowd-skinning.js';

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

test('crowdFrameBlend rejects non-finite seconds', () => {
  const palette = { frameCount: 10, frameStep: 0.1, duration: 0.9, jointCount: 4, loop: true };
  for (const seconds of [Number.NaN, Infinity]) assert.throws(() => crowdFrameBlend(palette, seconds), /seconds must be a finite/);
});
