import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectFastTests, usesNativeAddon } from '../scripts/fast-tests.mjs';
import { planChecks } from '../scripts/preflight.mjs';

const existing = ['tests/a.test.js', 'tests/b.test.js', 'tests/c.test.js', 'tests/slow.test.js'];
const timings = { 'tests/a.test.js': 100, 'tests/b.test.js': 400, 'tests/c.test.js': 50, 'tests/slow.test.js': 900, 'tests/gone.test.js': 10 };

test('only files recorded under the threshold are picked, and deleted files are dropped', () => {
  const { files, recordedMilliseconds } = selectFastTests(timings, existing, { thresholdMs: 500, budgetMs: 10000 });
  assert.deepEqual(files, ['tests/a.test.js', 'tests/b.test.js', 'tests/c.test.js']);
  assert.equal(recordedMilliseconds, 550);
});

test('a file with no recorded time is not run', () => {
  const { files } = selectFastTests({}, existing);
  assert.deepEqual(files, []);
});

test('the budget keeps the fastest files and drops the rest', () => {
  const { files, recordedMilliseconds } = selectFastTests(timings, existing, { thresholdMs: 500, budgetMs: 200 });
  assert.deepEqual(files, ['tests/a.test.js', 'tests/c.test.js']);
  assert.equal(recordedMilliseconds, 150);
});

test('a test that loads the native Cook helper is recognised', () => {
  assert.equal(usesNativeAddon("import { x } from './support/cook.js';"), true);
  assert.equal(usesNativeAddon("import { x } from './support/scene.js';"), false);
});

test('preflight runs the fast tests only when the slow pass is skipped', () => {
  const skipped = planChecks(['docs/guide.md'], { skipTests: true }).find(check => check.name === 'fast tests');
  assert.equal(skipped.skipped, null);
  assert.deepEqual(skipped.command, ['node', 'scripts/fast-tests.mjs']);
  const full = planChecks(['docs/guide.md']).find(check => check.name === 'fast tests');
  assert.match(full.skipped, /full unit test pass/);
});
