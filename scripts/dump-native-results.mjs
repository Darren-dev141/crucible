// Opt-in preload for the lavapipe miscompile sweep (#1760): `NODE_OPTIONS="--import ./scripts/dump-native-results.mjs"`
// with CRUCIBLE_DUMP_RESULTS=<directory>. It wraps every function of the Cook native addon (render-native.node) and appends
// a summary of each result (length, sum, mean, min, max, SHA-1 of the bytes) to <directory>/<pid>.ndjson. No test assertion
// changes, and nothing happens when CRUCIBLE_DUMP_RESULTS is unset. scripts/diff-native-dumps.mjs compares two such directories.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import Module from 'node:module';
import { basename, join } from 'node:path';

const dumpDirectory = process.env.CRUCIBLE_DUMP_RESULTS;
const MAX_DEPTH = 5;
const MAX_ARRAY_ITEMS = 64;
const MAX_STRING_LENGTH = 200;

function summarizeNumbers(typedArray) {
  let sum = 0;
  let minimum = Infinity;
  let maximum = -Infinity;
  let nonFinite = 0;
  for (let index = 0; index < typedArray.length; index += 1) {
    const value = Number(typedArray[index]);
    if (!Number.isFinite(value)) {
      nonFinite += 1;
      continue;
    }
    sum += value;
    if (value < minimum) minimum = value;
    if (value > maximum) maximum = value;
  }
  const finiteCount = typedArray.length - nonFinite;
  return {
    sum,
    mean: finiteCount > 0 ? sum / finiteCount : 0,
    min: finiteCount > 0 ? minimum : 0,
    max: finiteCount > 0 ? maximum : 0,
    nonFinite,
  };
}

function summarizeBytes(bytes, typeName, length) {
  return { type: typeName, length, sha1: createHash('sha1').update(bytes).digest('hex') };
}

export function summarizeValue(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') return value.slice(0, MAX_STRING_LENGTH);
  if (typeof value === 'function') return '[function]';
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const summary = summarizeBytes(bytes, value.constructor.name, value.length ?? value.byteLength);
    return value instanceof DataView ? summary : { ...summary, ...summarizeNumbers(value) };
  }
  if (value instanceof ArrayBuffer) return summarizeBytes(new Uint8Array(value), 'ArrayBuffer', value.byteLength);
  if (depth >= MAX_DEPTH) return '[depth]';
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ITEMS).map((item) => summarizeValue(item, depth + 1));
  const result = {};
  for (const key of Object.keys(value).sort()) result[key] = summarizeValue(value[key], depth + 1);
  return result;
}

let callCounter = 0;
const processName = basename(process.argv[1] ?? 'unknown');

function appendEntry(slot, callName, outcome) {
  const entry = { process: processName, index: slot, call: callName, ...outcome };
  appendFileSync(join(dumpDirectory, `${process.pid}.ndjson`), `${JSON.stringify(entry)}\n`);
}

function recordOutcome(callName, outcome) {
  const slot = callCounter;
  callCounter += 1;
  if (outcome && typeof outcome.then === 'function') {
    outcome.then(
      (resolved) => appendEntry(slot, callName, { result: summarizeValue(resolved) }),
      (error) => appendEntry(slot, callName, { error: String(error?.message ?? error).slice(0, MAX_STRING_LENGTH) })
    );
    return;
  }
  appendEntry(slot, callName, { result: summarizeValue(outcome) });
}

function wrapInstanceMethods(instance, className) {
  return new Proxy(instance, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function' || typeof property !== 'string') return value;
      return (...args) => {
        let outcome;
        try {
          outcome = value.apply(target, args);
        } catch (error) {
          recordOutcome(`${className}.${property}`, Promise.reject(error));
          throw error;
        }
        recordOutcome(`${className}.${property}`, outcome);
        return outcome;
      };
    },
  });
}

function wrapAddon(addonExports) {
  return new Proxy(addonExports, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function' || typeof property !== 'string') return value;
      return new Proxy(value, {
        apply(original, thisArgument, args) {
          let outcome;
          try {
            outcome = Reflect.apply(original, thisArgument, args);
          } catch (error) {
            recordOutcome(property, Promise.reject(error));
            throw error;
          }
          recordOutcome(property, outcome);
          return outcome;
        },
        construct(original, args) {
          return wrapInstanceMethods(Reflect.construct(original, args), property);
        },
      });
    },
  });
}

if (dumpDirectory) {
  mkdirSync(dumpDirectory, { recursive: true });
  const originalNodeLoader = Module._extensions['.node'];
  Module._extensions['.node'] = function loadAndWrap(module, filename) {
    originalNodeLoader(module, filename);
    if (basename(filename) === 'render-native.node') module.exports = wrapAddon(module.exports);
  };
}
