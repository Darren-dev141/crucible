// A test file that hangs on purpose, run by tests/test-hang-guard.test.js (its name has no .test.js, so `node --test` never picks it up).
// It starts a child that starts a grandchild, both never exit, prints both process ids, and then waits forever.
import test from 'node:test';
import { spawn } from 'node:child_process';

const idleScript = 'setInterval(() => {}, 1000)';
const childScript = `
const { spawn } = require('node:child_process');
const grandchild = spawn(process.execPath, ['-e', ${JSON.stringify(idleScript)}], { stdio: 'ignore', windowsHide: true });
console.log('HANGING_GRANDCHILD_PID=' + grandchild.pid);
setInterval(() => {}, 1000);
`;

test('a quick test before the hang passes', () => {});

test('this test hangs on purpose while a child process runs', async () => {
  const child = spawn(process.execPath, ['-e', childScript], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  console.log(`HANGING_CHILD_PID=${child.pid}`);
  child.stdout.on('data', chunk => process.stdout.write(chunk));
  await new Promise(() => {});
});
