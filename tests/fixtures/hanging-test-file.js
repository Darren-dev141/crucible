// A test file that hangs on purpose, run by tests/test-hang-guard.test.js (its name has no .test.js, so `node --test` never picks it up).
// It starts a child that never exits, prints the child's process id, and then waits forever.
import test from 'node:test';
import { spawn } from 'node:child_process';

test('a quick test before the hang passes', () => {});

test('this test hangs on purpose while a child process runs', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  console.log(`HANGING_CHILD_PID=${child.pid}`);
  await new Promise(() => {});
});
