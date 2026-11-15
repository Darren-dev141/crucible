import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export const GPU_QUEUE_WEIGHTS = Object.freeze(['light', 'heavy']);
export const DEFAULT_GPU_QUEUE_WAIT_SECONDS = 600;
export const MAXIMUM_GPU_QUEUE_WAIT_SECONDS = 3600;
const RELEASE_GRACE_MS = 2000;
const GRANTED_LINE = 'crucible-gpu-granted';

// The program the queue command runs once it has room. It tells the server the card is granted, then holds it until the
// server closes its stdin. It is fixed here and takes nothing from a tool call.
const HOLDER_SCRIPT = `process.stdout.write(${JSON.stringify(`${GRANTED_LINE}\n`)});process.stdin.on('end',()=>process.exit(0));process.stdin.resume();`;

/**
 * Reads the --gpu-queue value the person who starts the server chose: either one executable, or a JSON array of strings whose
 * first item is the executable and the rest its arguments, such as ["bash", "/home/me/gpu-lock.sh"]. The executable is an
 * absolute path to an existing file, or a bare command name looked up on PATH (like --ffmpeg). No shell reads the value.
 */
export function parseGpuQueueCommand(value) {
  const hint = 'Pass --gpu-queue an absolute executable path, or a JSON array such as ["bash","/path/to/queue.sh"]; the queue command is run with a program appended and must run it once the GPU has room.';
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`--gpu-queue is empty. ${hint}`);
  let words;
  if (value.trim().startsWith('[')) {
    try {
      words = JSON.parse(value);
    } catch (error) {
      throw new TypeError(`--gpu-queue is not valid JSON (${error.message}). ${hint}`);
    }
  } else {
    words = [value];
  }
  if (!Array.isArray(words) || words.length === 0 || words.length > 16 || words.some(word => typeof word !== 'string' || word === '')) {
    throw new TypeError(`--gpu-queue must be a non-empty list of at most 16 non-empty strings. ${hint}`);
  }
  const [executable, ...argumentsList] = words;
  const bareName = !/[\\/]/.test(executable);
  if (!bareName && (!isAbsolute(executable) || !existsSync(executable))) {
    throw new TypeError(`--gpu-queue executable ${executable} must be an existing absolute path or a command name on PATH. ${hint}`);
  }
  return { executable, arguments: argumentsList };
}

export function parseGpuQueueWaitSeconds(value) {
  const seconds = value === undefined ? DEFAULT_GPU_QUEUE_WAIT_SECONDS : Number(value);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAXIMUM_GPU_QUEUE_WAIT_SECONDS) {
    throw new RangeError(`--gpu-queue-wait must be a whole number of seconds from 1 to ${MAXIMUM_GPU_QUEUE_WAIT_SECONDS}; the default is ${DEFAULT_GPU_QUEUE_WAIT_SECONDS}.`);
  }
  return seconds;
}

/**
 * Takes the card from the person's own queue around one unit of GPU work. `run(weight, work)` starts the queue command with the
 * holder program appended, waits for the holder to say it is granted (at most waitSeconds), runs `work`, then ends the holder so
 * the queue releases the card, whether the work finished, failed or was aborted. The weight reaches the command as
 * CRUCIBLE_GPU_WEIGHT, "light" for a look or a review and "heavy" for a render job or a bake.
 */
export function createGpuQueue({ command, waitSeconds = DEFAULT_GPU_QUEUE_WAIT_SECONDS, spawnProcess = spawn }) {
  const waitMs = parseGpuQueueWaitSeconds(waitSeconds) * 1000;

  function acquire(weight, signal) {
    return new Promise((resolve, reject) => {
      signal?.throwIfAborted();
      const holder = spawnProcess(command.executable, [...command.arguments, process.execPath, '-e', HOLDER_SCRIPT], {
        env: { ...process.env, CRUCIBLE_GPU_WEIGHT: weight },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let settled = false;
      let output = '';
      let errorOutput = '';
      const fail = message => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        endHolder(holder);
        reject(new Error(message));
      };
      const timer = setTimeout(() => fail(`The GPU queue command did not grant the card within ${waitMs / 1000} seconds. Check that it runs the program it is given once the GPU has room, or raise --gpu-queue-wait.`), waitMs);
      const onAbort = () => fail('The GPU queue wait was cancelled.');
      signal?.addEventListener('abort', onAbort, { once: true });
      holder.stdout.on('data', chunk => {
        output += chunk;
        if (!settled && output.includes(GRANTED_LINE)) {
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(holder);
        }
      });
      holder.stderr.on('data', chunk => { errorOutput = (errorOutput + chunk).slice(-400); });
      holder.on('error', error => fail(`The GPU queue command could not start (${error.message}). Pass --gpu-queue an executable that exists.`));
      holder.on('exit', code => {
        const detail = errorOutput.trim() ? ` It printed: ${errorOutput.trim()}` : '';
        fail(`The GPU queue command exited with code ${code} before it granted the card.${detail}`);
      });
    });
  }

  return {
    async run(weight, work, { signal } = {}) {
      if (!GPU_QUEUE_WEIGHTS.includes(weight)) throw new RangeError(`GPU queue weight must be light or heavy, not ${weight}.`);
      const holder = await acquire(weight, signal);
      try {
        return await work();
      } finally {
        endHolder(holder);
      }
    },
  };
}

// Closing stdin lets the holder exit and the queue free the card; the kill only covers a queue command that ignores that.
function endHolder(holder) {
  holder.stdin.on('error', () => {});
  holder.stdin.end();
  const killTimer = setTimeout(() => holder.kill(), RELEASE_GRACE_MS);
  killTimer.unref();
  holder.once('exit', () => clearTimeout(killTimer));
}
