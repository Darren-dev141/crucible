import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGpuQueue, createGpuQueueFromFlags, createSharedGpuCard, parseGpuQueueCommand, parseGpuQueueWaitSeconds } from '../scripts/agent-gpu-queue.mjs';
import { runMcpCli } from '../scripts/mcp-server.mjs';
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

// An in-process queue that grants one unit at a time, like a wrapper that does not run light beside heavy.
function serialFakeQueue() {
  const log = [];
  let tail = Promise.resolve();
  return {
    log,
    run(weight, work, { signal } = {}) {
      log.push(`request:${weight}`);
      const result = tail.then(async () => {
        signal?.throwIfAborted();
        log.push(`grant:${weight}`);
        try { return await work(); } finally { log.push(`release:${weight}`); }
      });
      tail = result.catch(() => {});
      return result;
    },
  };
}

test('the shared card asks the queue once while the server already holds it, and gives it back with the last user', async () => {
  const queue = serialFakeQueue();
  const card = createSharedGpuCard(queue);
  const releaseJob = await card.take('heavy');
  await card.run('light', async () => {});
  await card.run('heavy', async () => {});
  assert.deepEqual(queue.log, ['request:heavy', 'grant:heavy']);
  releaseJob();
  releaseJob();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(queue.log, ['request:heavy', 'grant:heavy', 'release:heavy']);
});

test('a heavy request while only a light hold exists asks the queue again, and a cancelled wait never takes the card', async () => {
  const queue = serialFakeQueue();
  const card = createSharedGpuCard(queue);
  const releaseLight = await card.take('light');
  const abortController = new AbortController();
  const waiting = card.take('heavy', abortController.signal);
  abortController.abort();
  await assert.rejects(waiting, /cancelled/);
  const heavy = card.take('heavy');
  releaseLight();
  (await heavy)();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(queue.log.filter(line => line.startsWith('grant')), ['grant:light', 'grant:heavy']);
  assert.equal(queue.log.at(-1), 'release:heavy');
});

test('a look while a render job still waits for the card asks the queue itself instead of joining the job wait', async () => {
  const log = [];
  const grants = [];
  const queue = {
    run(weight, work, { signal } = {}) {
      log.push(`request:${weight}`);
      return new Promise((resolve, reject) => {
        grants.push({ weight, resolve: () => work().then(resolve, reject) });
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  };
  const card = createSharedGpuCard(queue);
  const heavyWaiting = card.take('heavy');
  heavyWaiting.catch(() => {});
  const lightTaken = card.take('light');
  assert.deepEqual(log, ['request:heavy', 'request:light']);
  grants.find(grant => grant.weight === 'light').resolve();
  const releaseLight = await lightTaken;
  releaseLight();
  grants.find(grant => grant.weight === 'heavy').resolve();
  (await heavyWaiting)();
});

test('a look that arrives while a render job waits on a first-come queue joins the job once it is granted, with one grant', async () => {
  const queue = serialFakeQueue();
  let releaseBlocker;
  const blocker = queue.run('light', () => new Promise(resolve => { releaseBlocker = resolve; }));
  const card = createSharedGpuCard(queue);
  const jobTaken = card.take('heavy');
  const lookTaken = card.take('light');
  assert.deepEqual(queue.log.filter(line => line.startsWith('request')), ['request:light', 'request:heavy', 'request:light']);
  await new Promise(resolve => setTimeout(resolve, 5));
  releaseBlocker();
  await blocker;
  const releaseJob = await jobTaken;
  const releaseLook = await lookTaken;
  releaseLook();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(queue.log.includes('release:heavy'), false, 'the look finished while the job still holds the card');
  releaseJob();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(queue.log.filter(line => line.startsWith('grant')), ['grant:light', 'grant:heavy']);
  assert.equal(queue.log.at(-1), 'release:heavy');
});

test('a script path that Windows cannot start directly is refused at launch with the array form to pass', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gpu-queue-script-'));
  try {
    const script = join(directory, 'queue.cmd');
    writeFileSync(script, '');
    assert.throws(() => parseGpuQueueCommand(script, 'win32'), /\.cmd script.*JSON array.*cmd\.exe/);
    const shellScript = join(directory, 'queue.sh');
    writeFileSync(shellScript, '');
    assert.throws(() => parseGpuQueueCommand(shellScript, 'win32'), /\.sh script.*\["bash"/);
    assert.deepEqual(parseGpuQueueCommand(shellScript, 'linux'), { executable: shellScript, arguments: [] });
    assert.deepEqual(parseGpuQueueCommand(JSON.stringify(['cmd.exe', '/c', script]), 'win32').executable, 'cmd.exe');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a bare script name on Windows asks for the absolute path, and inherited object keys are not script extensions', () => {
  assert.throws(() => parseGpuQueueCommand('queue.sh', 'win32'), /\["bash","<absolute path to queue\.sh>"\].*absolute path of the script/);
  for (const name of ['queue.constructor', 'queue.toString', 'queue.valueOf']) {
    assert.deepEqual(parseGpuQueueCommand(name, 'win32'), { executable: name, arguments: [] });
  }
});

test('a queue command that fails to start after spawning gives the same launch advice', async () => {
  const queue = createGpuQueue({
    command: { executable: 'queue', arguments: [] },
    spawnProcess() {
      const holder = new EventEmitter();
      holder.stdout = new EventEmitter();
      holder.stderr = new EventEmitter();
      holder.stdin = { on() {}, end() {} };
      holder.kill = () => {};
      setImmediate(() => holder.emit('error', new Error('spawn queue ENOENT')));
      return holder;
    },
  });
  await assert.rejects(queue.run('light', async () => {}), /could not start \(spawn queue ENOENT\).*JSON array/);
});

test('a queue command the system refuses to spawn fails the call with the launch advice, not a raw spawn error', async () => {
  const queue = createGpuQueue({
    command: { executable: 'queue.cmd', arguments: [] },
    spawnProcess() { throw Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' }); },
  });
  await assert.rejects(queue.run('light', async () => {}), /could not start \(spawn EINVAL\).*JSON array/);
});

test('a queue failure reaches every caller waiting on the shared card', async () => {
  const card = createSharedGpuCard({ run: async () => { throw new Error('queue is down'); } });
  await assert.rejects(card.take('light'), /queue is down/);
  await assert.rejects(card.run('light', async () => {}), /queue is down/);
});

test('the queue flags build a queue only with --gpu-queue and refuse a wait without it', async () => {
  assert.equal(createGpuQueueFromFlags({}), undefined);
  assert.throws(() => createGpuQueueFromFlags({ wait: '5' }), /--gpu-queue-wait needs --gpu-queue/);
  assert.throws(() => createGpuQueueFromFlags({ queue: '/no/such/queue.sh' }), /existing absolute path/);
  assert.throws(() => createGpuQueueFromFlags({ queue: process.execPath, wait: '0' }), /--gpu-queue-wait must be/);
  assert.equal(typeof createGpuQueueFromFlags({ queue: process.execPath, wait: '5' }).run, 'function');
  await assert.rejects(runMcpCli({ argumentsValue: ['--gpu-queue-wait', '5'] }), /--gpu-queue-wait needs --gpu-queue/);
  await assert.rejects(runMcpCli({ argumentsValue: ['--gpu-queue', '/no/such/queue.sh'] }), /--gpu-queue executable/);
});
