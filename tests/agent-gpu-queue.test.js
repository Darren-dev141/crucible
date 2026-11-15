import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGpuQueue, parseGpuQueueCommand, parseGpuQueueWaitSeconds } from '../scripts/agent-gpu-queue.mjs';
import { mcpHelpText } from '../bin/crucible-mcp-flags.mjs';

// A stand-in for a person's queue wrapper: it logs the weight, waits `delayMilliseconds`, runs the program it is given and
// logs when that program ends, which is when a real queue would give the card back.
const FAKE_QUEUE = `
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const [logPath, delayText, mode, ...program] = process.argv.slice(2);
appendFileSync(logPath, 'request:' + process.env.CRUCIBLE_GPU_WEIGHT + '\\n');
if (mode === 'exit') { console.error('queue is down'); process.exit(3); }
if (mode === 'never') setInterval(() => {}, 1000);
else setTimeout(() => {
  appendFileSync(logPath, 'granted\\n');
  const child = spawn(program[0], program.slice(1), { stdio: 'inherit' });
  child.on('exit', () => { appendFileSync(logPath, 'released\\n'); process.exit(0); });
}, Number(delayText));
`;

async function fixture(mode = 'run', delayMilliseconds = 0) {
  const directory = await mkdtemp(join(tmpdir(), 'gpu-queue-'));
  const queuePath = join(directory, 'queue.mjs');
  const logPath = join(directory, 'log.txt');
  await writeFile(queuePath, FAKE_QUEUE);
  await writeFile(logPath, '');
  const command = parseGpuQueueCommand(JSON.stringify([process.execPath, queuePath, logPath, String(delayMilliseconds), mode]));
  const readLog = async () => (await readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean);
  return { directory, command, readLog };
}

test('the queue grants the card around the work and releases it afterwards', async () => {
  const { directory, command, readLog } = await fixture('run', 50);
  try {
    const queue = createGpuQueue({ command });
    const during = [];
    const result = await queue.run('heavy', async () => {
      during.push(...await readLog());
      return 'done';
    });
    assert.equal(result, 'done');
    assert.deepEqual(during, ['request:heavy', 'granted']);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.deepEqual(await readLog(), ['request:heavy', 'granted', 'released']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the queue releases the card when the work fails and passes the light weight', async () => {
  const { directory, command, readLog } = await fixture();
  try {
    const queue = createGpuQueue({ command });
    await assert.rejects(queue.run('light', async () => { throw new Error('render failed'); }), /render failed/);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.deepEqual(await readLog(), ['request:light', 'granted', 'released']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a queue that never grants the card fails the call with the wait and how to fix it', async () => {
  const { directory, command } = await fixture('never');
  try {
    const queue = createGpuQueue({ command, waitSeconds: 1 });
    let worked = false;
    await assert.rejects(queue.run('light', async () => { worked = true; }), /did not grant the card within 1 seconds.*--gpu-queue-wait/);
    assert.equal(worked, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a queue command that exits early reports its exit code and output', async () => {
  const { directory, command } = await fixture('exit');
  try {
    const queue = createGpuQueue({ command });
    await assert.rejects(queue.run('light', async () => {}), /exited with code 3 before it granted the card\. It printed: queue is down/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('aborting the wait stops the queue command and fails the call', async () => {
  const { directory, command } = await fixture('never');
  try {
    const queue = createGpuQueue({ command });
    const controller = new AbortController();
    const pending = queue.run('heavy', async () => {}, { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(pending, /cancelled/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the queue command is validated at startup with advice', () => {
  assert.throws(() => parseGpuQueueCommand(''), /--gpu-queue is empty/);
  assert.throws(() => parseGpuQueueCommand('[not json'), /not valid JSON/);
  assert.throws(() => parseGpuQueueCommand('["a",""]'), /non-empty list/);
  assert.throws(() => parseGpuQueueCommand('relative/queue.sh'), /existing absolute path/);
  assert.throws(() => parseGpuQueueCommand(join(tmpdir(), 'missing-queue-command.sh')), /existing absolute path/);
  assert.deepEqual(parseGpuQueueCommand('["bash","/queue.sh"]'), { executable: 'bash', arguments: ['/queue.sh'] });
  assert.deepEqual(parseGpuQueueCommand(process.execPath), { executable: process.execPath, arguments: [] });
});

test('the wait is a bounded whole number of seconds', async () => {
  assert.equal(parseGpuQueueWaitSeconds(undefined), 600);
  assert.equal(parseGpuQueueWaitSeconds('30'), 30);
  for (const bad of ['0', '3601', '1.5', 'soon']) assert.throws(() => parseGpuQueueWaitSeconds(bad), /1 to 3600/);
  await assert.rejects(createGpuQueue({ command: { executable: 'x', arguments: [] } }).run('medium', async () => {}), /light or heavy/);
});

test('--help lists the queue flags', () => {
  const help = mcpHelpText('0.0.0');
  assert.match(help, /--gpu-queue /);
  assert.match(help, /--gpu-queue-wait /);
});
