// A passing test file that leaves a child running, run by tests/test-hang-guard.test.js (its name has no .test.js, so `node --test` never picks it up).
// The child is unref'd, so the file's process exits normally and the guard's exit cleanup is what ends the child.
import test from 'node:test';
import { spawn } from 'node:child_process';

test('a passing test that leaves a child process running', () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  child.unref();
  console.log(`LEFTOVER_CHILD_PID=${child.pid}`);
});
