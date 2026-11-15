import test from 'node:test';
import assert from 'node:assert/strict';
import { watchPage, withDeadline } from './helpers/with-deadline.js';

test('a promise that resolves in time returns its value', async () => {
  assert.equal(await withDeadline(Promise.resolve(7), 'a value', 1000), 7);
});

test('a promise that never settles fails at its deadline and names the step', async () => {
  const started = Date.now();
  await assert.rejects(withDeadline(new Promise(() => {}), 'the websocket to open', 50), /stalled for 50 ms waiting for the websocket to open/);
  assert.ok(Date.now() - started < 1000);
});

test('a rejection passes through unchanged', async () => {
  await assert.rejects(withDeadline(Promise.reject(new Error('boom')), 'a step', 1000), /boom/);
});

test('a page promise that never settles fails at the deadline and names the step', async () => {
  const stalledPage = { evaluateHandle: () => new Promise(() => {}) };
  const watching = watchPage(stalledPage, 'the move of alice to show on the other page', () => {}, null, 50);
  await assert.rejects(watching, /stalled for 50 ms waiting for the move of alice to show on the other page/);
});

test('a page promise that settles gives back its value', async () => {
  const answeringPage = { evaluateHandle: () => Promise.resolve({ jsonValue: () => Promise.resolve(42) }) };
  assert.equal(await watchPage(answeringPage, 'an answer', () => {}, null, 1000), 42);
});
