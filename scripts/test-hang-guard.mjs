// Preloaded into every test file process (node --import ./scripts/test-hang-guard.mjs, see the test scripts in package.json).
//
// `--test-timeout` fails a test that runs too long and names it, but the file's process then stays alive for as long as
// a Chrome, a dev server or any other child it started keeps a handle open (#1320: one CI shard printed nothing for 14
// minutes until the job was cancelled). This guard adds two things:
//   1. a file limit: when the process is still alive after CRUCIBLE_TEST_FILE_LIMIT_MS, it says which file hung, kills every
//      child process the file started (and their trees) and exits 1, so the shard fails with the file named;
//   2. a cleanup at exit: a child the file started and left running is killed, so a green file leaves nothing behind.
// A child started with `detached: true` on purpose is left alone at a normal exit, but not at the file limit.
import { ChildProcess, spawnSync } from 'node:child_process';

export const DEFAULT_FILE_LIMIT_MS = 660000;

const startedChildren = [];
const originalSpawn = ChildProcess.prototype.spawn;

// `node --test` loads preloaded modules in its own runner process too. Only the processes that run one test file are guarded.
const runsOneTestFile = process.env.NODE_TEST_CONTEXT !== undefined;

if (runsOneTestFile) {
  ChildProcess.prototype.spawn = function trackedSpawn(options) {
    const result = originalSpawn.call(this, options);
    startedChildren.push({ child: this, detached: Boolean(options?.detached) });
    return result;
  };
}

function isRunning(child) {
  return child.pid !== undefined && child.exitCode === null && child.signalCode === null;
}

function killTree(child, detached) {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      return;
    }
    if (detached) process.kill(-child.pid, 'SIGKILL');
  } catch {
    // The group may already be gone.
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // The child may have exited between the check and the kill.
  }
}

export function killStartedChildren({ includeDetached }) {
  const killedProcessIds = [];
  for (const { child, detached } of startedChildren) {
    if (!isRunning(child)) continue;
    if (detached && !includeDetached) continue;
    killedProcessIds.push(child.pid);
    killTree(child, detached);
  }
  return killedProcessIds;
}

export function fileLimitMilliseconds(environment = process.env) {
  const raw = environment.CRUCIBLE_TEST_FILE_LIMIT_MS;
  if (raw === undefined || raw === '') return DEFAULT_FILE_LIMIT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`CRUCIBLE_TEST_FILE_LIMIT_MS must be a positive number of milliseconds, got "${raw}". Unset it to use ${DEFAULT_FILE_LIMIT_MS}.`);
  }
  return parsed;
}

function describeHang(limitMilliseconds, killedProcessIds) {
  const killed = killedProcessIds.length === 0 ? 'none' : killedProcessIds.join(', ');
  return (
    `\nTEST FILE HUNG: ${process.argv[1] ?? 'unknown file'} was still running after ${limitMilliseconds} ms and was stopped. ` +
    `Child processes killed: ${killed}. ` +
    'The test that timed out is named above by node:test ("test timed out after ..."); run the file alone with node --test <file> to reproduce.\n'
  );
}

function startWatchdog() {
  const limitMilliseconds = fileLimitMilliseconds();
  const watchdog = setTimeout(() => {
    const killedProcessIds = killStartedChildren({ includeDetached: true });
    process.stderr.write(describeHang(limitMilliseconds, killedProcessIds));
    process.exit(1);
  }, limitMilliseconds);
  watchdog.unref();
  process.on('exit', () => {
    killStartedChildren({ includeDetached: false });
  });
}

if (runsOneTestFile) startWatchdog();
