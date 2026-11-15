import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_FILE_LIMIT_MS, fileLimitMilliseconds } from '../scripts/test-hang-guard.mjs';

const repositoryRoot = join(import.meta.dirname, '..');
const guardPath = join(repositoryRoot, 'scripts', 'test-hang-guard.mjs');
const hangingFixturePath = join(repositoryRoot, 'tests', 'fixtures', 'hanging-test-file.js');

function isProcessAlive(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

test('a test file that hangs fails in seconds, names the test and leaves no child process behind', () => {
  const startedAt = Date.now();
  // The runner this test runs in marks its environment; a nested runner must not think it is already inside one.
  const { NODE_TEST_CONTEXT: _outerRunner, ...environment } = process.env;
  const result = spawnSync(
    process.execPath,
    ['--test', '--import', pathToFileURL(guardPath).href, '--test-timeout=2000', hangingFixturePath],
    { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true, timeout: 110000, env: { ...environment, CRUCIBLE_TEST_FILE_LIMIT_MS: '6000' } },
  );
  const seconds = (Date.now() - startedAt) / 1000;
  const output = `${result.stdout}\n${result.stderr}`;

  assert.notEqual(result.status, 0, `the hanging file must fail the run, output:\n${output}`);
  assert.ok(seconds < 110, `the run took ${seconds} s and was cut off by the outer timeout`);
  assert.match(output, /this test hangs on purpose while a child process runs/, 'the hanging test is named');
  assert.match(output, /test timed out after 2000ms/);
  assert.match(output, /TEST FILE HUNG: .*hanging-test-file\.js/, 'the guard names the file');

  const childProcessId = Number(/HANGING_CHILD_PID=(\d+)/.exec(output)?.[1]);
  assert.ok(Number.isInteger(childProcessId), `the fixture prints the child's process id, output:\n${output}`);
  assert.equal(isProcessAlive(childProcessId), false, `child ${childProcessId} was left running`);
});

test('the file limit has a default and rejects a value that is not a positive number', () => {
  assert.equal(fileLimitMilliseconds({}), DEFAULT_FILE_LIMIT_MS);
  assert.equal(fileLimitMilliseconds({ CRUCIBLE_TEST_FILE_LIMIT_MS: '5000' }), 5000);
  assert.throws(() => fileLimitMilliseconds({ CRUCIBLE_TEST_FILE_LIMIT_MS: 'soon' }), /must be a positive number of milliseconds/);
  assert.throws(() => fileLimitMilliseconds({ CRUCIBLE_TEST_FILE_LIMIT_MS: '-1' }), /must be a positive number of milliseconds/);
});
