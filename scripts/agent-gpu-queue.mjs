import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const LAUNCH_ADVICE = 'Pass --gpu-queue an executable program, or a JSON array with its interpreter such as ["bash","/path/to/queue.sh"].';
export const GPU_QUEUE_WEIGHTS = Object.freeze(['light', 'heavy']);
export const DEFAULT_GPU_QUEUE_WAIT_SECONDS = 600;
export const MAXIMUM_GPU_QUEUE_WAIT_SECONDS = 3600;
const RELEASE_GRACE_MS = 2000;
const OUTPUT_TAIL_CHARACTERS = 200;
const GRANTED_LINE = 'crucible-gpu-granted';

// The program the queue command runs once it has room. It tells the server the card is granted, then holds it until the
// server closes its stdin. It is fixed here and takes nothing from a tool call.
const HOLDER_SCRIPT = `process.stdout.write(${JSON.stringify(`${GRANTED_LINE}\n`)});process.stdin.on('end',()=>process.exit(0));process.stdin.resume();`;

/**
 * Reads the --gpu-queue value the person who starts the server chose: either one executable, or a JSON array of strings whose
 * first item is the executable and the rest its arguments, such as ["bash", "/home/me/gpu-lock.sh"]. The executable is an
 * absolute path to an existing file, or a bare command name looked up on PATH (like --ffmpeg). No shell reads the value.
 */
export function parseGpuQueueCommand(value, platform = process.platform) {
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
  rejectScriptWithoutInterpreter(executable, platform);
  return { executable, arguments: argumentsList };
}

// Windows cannot start a script directly (spawn fails with EINVAL for .cmd and .bat, EFTYPE or ENOENT for .sh and .ps1), so say how to pass it now, not at the first call.
function rejectScriptWithoutInterpreter(executable, platform) {
  const extension = /\.([A-Za-z0-9]+)$/.exec(executable)?.[1]?.toLowerCase();
  const interpreters = { cmd: '["cmd.exe","/c","<path>"]', bat: '["cmd.exe","/c","<path>"]', ps1: '["powershell.exe","-File","<path>"]', sh: '["bash","<path>"]' };
  const windowsOnly = platform === 'win32' && extension !== undefined && Object.hasOwn(interpreters, extension);
  if (!windowsOnly) return;
  const isBareName = !/[\\/]/.test(executable);
  const path = isBareName ? `<absolute path to ${executable}>` : executable.replaceAll('\\', '/');
  const lookupNote = isBareName ? ' The interpreter does not look the script up on PATH, so give the absolute path of the script.' : '';
  throw new TypeError(`--gpu-queue ${executable} is a .${extension} script, which cannot be started directly on Windows. Pass it with its interpreter as a JSON array, for example ${interpreters[extension].replace('<path>', path)}.${lookupNote}`);
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
      let holder;
      try {
        holder = spawnProcess(command.executable, [...command.arguments, process.execPath, '-e', HOLDER_SCRIPT], {
          env: { ...process.env, CRUCIBLE_GPU_WEIGHT: weight },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch (error) {
        reject(new Error(`The GPU queue command could not start (${error.message}). ${LAUNCH_ADVICE}`));
        return;
      }
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
        if (settled) return;
        // Only a short tail is kept: the grant line is tiny, and a chatty queue wrapper must not grow the string.
        output = (output + chunk).slice(-OUTPUT_TAIL_CHARACTERS);
        if (output.includes(GRANTED_LINE)) {
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(holder);
        }
      });
      holder.stderr.on('data', chunk => { errorOutput = (errorOutput + chunk).slice(-400); });
      holder.on('error', error => fail(`The GPU queue command could not start (${error.message}). ${LAUNCH_ADVICE}`));
      holder.on('exit', code => {
        if (settled && !releasing.has(holder)) {
          console.error(`The GPU queue command exited with code ${code} while the server still holds the card, so the queue has freed it early. Check that the command passes its standard input through to the program it runs.`);
          return;
        }
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
const releasing = new WeakSet();
function endHolder(holder) {
  releasing.add(holder);
  holder.stdin.on('error', () => {});
  holder.stdin.end();
  const killTimer = setTimeout(() => holder.kill(), RELEASE_GRACE_MS);
  killTimer.unref();
  holder.once('exit', () => clearTimeout(killTimer));
}

/** Builds the queue from the parsed --gpu-queue and --gpu-queue-wait values, or returns undefined when --gpu-queue is not set. */
export function createGpuQueueFromFlags({ queue, wait }) {
  if (queue === undefined) {
    if (wait !== undefined) throw new Error('--gpu-queue-wait needs --gpu-queue. Pass both, or remove --gpu-queue-wait.');
    return undefined;
  }
  return createGpuQueue({ command: parseGpuQueueCommand(queue), waitSeconds: parseGpuQueueWaitSeconds(wait) });
}

const WEIGHT_RANK = Object.freeze({ light: 1, heavy: 2 });

/**
 * One server-side GPU slot on top of the person's queue, so the server never queues against itself. While the server holds the
 * card for one unit of work (a render job), a look or a review that wants the same or a lighter weight joins that hold instead of
 * asking the queue again; the card goes back to the queue when the last user leaves. `take(weight, signal)` waits for the card and
 * returns a `release` function; `run(weight, work, { signal })` wraps one unit of work. Taking the card must never happen while
 * holding the runtime's call queue, because the wait can be long.
 */
export function createSharedGpuCard(queue) {
  const slots = new Set();

  // A unit of work joins a slot that already holds the card at its weight or heavier, or one still waiting at exactly its weight.
  // It never joins a waiting heavier slot: that would hold a look behind a render job's wait instead of asking the queue itself.
  function findSlot(weight) {
    const rank = WEIGHT_RANK[weight];
    const all = [...slots];
    return all.find(slot => slot.granted && WEIGHT_RANK[slot.weight] >= rank) ?? all.find(slot => !slot.granted && slot.weight === weight);
  }

  function openSlot(weight) {
    const slot = { weight, users: 0, granted: false, controller: new AbortController(), finish: undefined };
    slot.ready = new Promise((resolveReady, rejectReady) => {
      queue.run(weight, () => {
        slot.granted = true;
        resolveReady();
        return new Promise(resolveFinish => { slot.finish = resolveFinish; });
      }, { signal: slot.controller.signal }).catch(rejectReady);
    });
    slot.ready.catch(() => {});
    slots.add(slot);
    return slot;
  }

  function leave(slot) {
    slot.users--;
    if (slot.users > 0) return;
    slots.delete(slot);
    if (slot.granted) slot.finish();
    else slot.controller.abort();
  }

  // A taker waits on its own slot and also joins a heavier slot that gets the card first, so a look is never held behind a render
  // job on a strictly first-come queue. The unused own request is aborted by leaving its slot. A failed heavier request never fails
  // the taker, which still has its own request.
  async function waitForFirstGrant(ownSlot, heavierWaiting, cancelled) {
    const neverSettles = new Promise(() => {});
    const candidates = [ownSlot, ...heavierWaiting].map(slot => slot.ready.then(() => slot, error => (slot === ownSlot ? Promise.reject(error) : neverSettles)));
    const firstGranted = await Promise.race([...candidates, cancelled]);
    if (firstGranted === ownSlot) return ownSlot;
    if (firstGranted.users > 0 && slots.has(firstGranted)) {
      firstGranted.users++;
      leave(ownSlot);
      return firstGranted;
    }
    await Promise.race([ownSlot.ready, cancelled]);
    return ownSlot;
  }

  return {
    async take(weight, signal) {
      if (!GPU_QUEUE_WEIGHTS.includes(weight)) throw new RangeError(`GPU queue weight must be light or heavy, not ${weight}.`);
      signal?.throwIfAborted();
      const ownSlot = findSlot(weight) ?? openSlot(weight);
      ownSlot.users++;
      const heavierWaiting = [...slots].filter(slot => !slot.granted && WEIGHT_RANK[slot.weight] > WEIGHT_RANK[weight]);
      let onAbort;
      const cancelled = new Promise((resolveCancelled, rejectCancelled) => {
        onAbort = () => rejectCancelled(new Error('The GPU queue wait was cancelled.'));
        signal?.addEventListener('abort', onAbort, { once: true });
      });
      cancelled.catch(() => {});
      let heldSlot;
      try {
        heldSlot = await waitForFirstGrant(ownSlot, heavierWaiting, cancelled);
      } catch (error) {
        leave(ownSlot);
        throw error;
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        leave(heldSlot);
      };
    },
    async run(weight, work, { signal } = {}) {
      const release = await this.take(weight, signal);
      try {
        return await work();
      } finally {
        release();
      }
    },
  };
}
