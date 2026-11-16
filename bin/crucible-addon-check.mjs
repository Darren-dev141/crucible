#!/usr/bin/env node
// Checks a folder against the Crucible third-party addon contract (docs/addons.md).
// Usage: npx crucible-addon-check <addon-folder> [--version <Crucible version>]
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ADDON_KEYWORD = 'crucible-addon';
export const CORE_PACKAGE = '@codepawlhq/crucible';
export const EXTENSION_POINTS = Object.freeze({
  registerController: 'registerController(kind, factory) from crucible/addons/player',
  registerCameraRig: 'registerCameraRig(kind, factory) from crucible/addons/player',
  userPass: 'a user GLSL pass given to renderer.userPasses.set (crucible/addons/user-pass)',
  streamingLoader: 'registerLoader(format, loader) on a streaming instance (crucible/addons/streaming)',
  runtimeSystem: 'runtime.addSystem(system) on a runtime (crucible/addons/runtime)',
});

// The running Crucible version may carry a prerelease tag or build metadata ("0.21.0-rc.1", "0.21.0+build5").
// Only its x.y.z is compared, as in src/pack-manifest.js.
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const COMPARATOR_PATTERN = /^(>=|<=|>|<|=|\^)?(\d+\.\d+\.\d+)$/;
const LARGEST_PART = 1e9;
const POINT_NAMES = Object.keys(EXTENSION_POINTS).join(', ');

function parseVersion(text) {
  const match = VERSION_PATTERN.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function caretUpperBound([major, minor, patch]) {
  if (major > 0) return [major + 1, 0, 0];
  if (minor > 0) return [0, minor + 1, 0];
  return [0, 0, patch + 1];
}

// Parses a range such as ">=0.19.0 <1.0.0" or "^0.19.0" into [operator, version] pairs, or null when it is not one.
export function parseRange(range) {
  if (typeof range !== 'string' || range.trim() === '') return null;
  const comparators = [];
  for (const part of range.trim().split(/\s+/)) {
    const match = COMPARATOR_PATTERN.exec(part);
    if (!match) return null;
    const version = parseVersion(match[2]);
    if (match[1] === '^') {
      comparators.push(['>=', version], ['<', caretUpperBound(version)]);
    } else {
      comparators.push([match[1] ?? '=', version]);
    }
  }
  return comparators;
}

// True when some version satisfies every comparator. Checks each bound and its patch neighbours, which is enough for the
// comparators this contract accepts.
export function rangeIsSatisfiable(range) {
  const comparators = parseRange(range);
  if (!comparators) return false;
  const candidates = [[0, 0, 0]];
  for (const [, [major, minor, patch]] of comparators) {
    candidates.push([major, minor, patch], [major, minor, patch + 1]);
    if (patch > 0) candidates.push([major, minor, patch - 1]);
    if (minor > 0) candidates.push([major, minor - 1, LARGEST_PART]);
    if (major > 0) candidates.push([major - 1, LARGEST_PART, LARGEST_PART]);
  }
  return candidates.some(candidate => rangeAllows(range, candidate.join('.')));
}

export function rangeAllows(range, version) {
  const comparators = parseRange(range);
  const parsed = parseVersion(version);
  if (!comparators || !parsed) return false;
  return comparators.every(([operator, bound]) => {
    const order = compareVersions(parsed, bound);
    return { '>=': order >= 0, '<=': order <= 0, '>': order > 0, '<': order < 0, '=': order === 0 }[operator];
  });
}

function readPackage(folder, errors) {
  const path = join(folder, 'package.json');
  if (!existsSync(path)) {
    errors.push(`No package.json in ${folder}. Run the check on the addon package folder.`);
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      errors.push('package.json must hold a JSON object with the addon name, keywords and "crucible" field. Replace its content.');
      return null;
    }
    return parsed;
  } catch (error) {
    errors.push(`package.json is not valid JSON (${error.message}). Fix the syntax.`);
    return null;
  }
}

function checkManifest(manifest, errors) {
  if (manifest === undefined || manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    errors.push('package.json has no "crucible" field. Add "crucible": { "range": ">=0.19.0 <1.0.0", "extensionPoints": ["registerController"], "bundleBytes": 2048 }.');
    return;
  }
  if (!parseRange(manifest.range)) {
    errors.push(`"crucible".range must be a version range such as ">=0.19.0 <1.0.0" or "^0.19.0", got ${JSON.stringify(manifest.range)}.`);
  }
  else if (!rangeIsSatisfiable(manifest.range)) {
    errors.push(`"crucible".range ${manifest.range} matches no version. Fix the bounds, for example ">=0.19.0 <1.0.0".`);
  }
  const points = manifest.extensionPoints;
  if (!Array.isArray(points) || points.length === 0) {
    errors.push(`"crucible".extensionPoints must list at least one of: ${POINT_NAMES}.`);
  } else {
    for (const point of points) {
      if (!Object.hasOwn(EXTENSION_POINTS, point)) {
        errors.push(`"crucible".extensionPoints names unknown point ${JSON.stringify(point)}. Use one of: ${POINT_NAMES}.`);
      }
    }
  }
  if (!Number.isInteger(manifest.bundleBytes) || manifest.bundleBytes <= 0) {
    errors.push(`"crucible".bundleBytes must be a positive whole number of bytes for the entry file, got ${JSON.stringify(manifest.bundleBytes)}.`);
  }
}

// The ES module entry of a package: a string `exports`, its "." entry, or the import/default condition of either; else `main`.
// The MCP loader (scripts/mcp-addons.mjs) uses this same function, so the check and the server agree on the file.
export function entryOf(pack) {
  const exportsField = pack.exports;
  const root = exportsField && typeof exportsField === 'object' && '.' in exportsField ? exportsField['.'] : exportsField;
  if (typeof root === 'string') return root;
  if (root && typeof root === 'object') {
    const conditional = root.import ?? root.default;
    if (typeof conditional === 'string') return conditional;
  }
  return typeof pack.main === 'string' ? pack.main : null;
}

function checkEntrySize(folder, pack, errors) {
  const manifest = pack['crucible'];
  const entry = entryOf(pack);
  if (entry === null) {
    errors.push('package.json names no entry file. Set "exports" (or its "." import condition) or "main" to the ES module that exports registerAddon.');
    return;
  }
  const path = resolve(folder, entry);
  if (!existsSync(path)) {
    errors.push(`The entry file ${entry} does not exist. Point "exports" (its "." entry) or "main" at a file that is published.`);
    return;
  }
  const entryStats = statSync(path);
  if (!entryStats.isFile()) {
    errors.push(`The entry ${entry} is a folder, not a file. Point "exports" (its "." entry) or "main" at the ES module file itself.`);
    return;
  }
  const actual = entryStats.size;
  if (Number.isInteger(manifest?.bundleBytes) && actual > manifest.bundleBytes) {
    errors.push(`${entry} is ${actual} bytes but "crucible".bundleBytes says ${manifest.bundleBytes}. Raise bundleBytes to at least ${actual}.`);
  }
}

function checkPeer(pack, errors, warnings, version) {
  const peerRange = pack.peerDependencies?.[CORE_PACKAGE];
  if (peerRange === undefined) {
    errors.push(`package.json "peerDependencies" must list ${CORE_PACKAGE} so the addon shares the host's copy. Add "${CORE_PACKAGE}": ">=0.19.0 <1.0.0".`);
  } else if (!parseRange(peerRange)) {
    errors.push(`peerDependencies.${CORE_PACKAGE} must be a version range such as ">=0.19.0 <1.0.0", got ${JSON.stringify(peerRange)}.`);
  } else if (!rangeIsSatisfiable(peerRange)) {
    errors.push(`peerDependencies.${CORE_PACKAGE} ${peerRange} matches no version. Fix the bounds, for example ">=0.19.0 <1.0.0".`);
  } else if (version && parseVersion(version) && !rangeAllows(peerRange, version)) {
    errors.push(`peerDependencies.${CORE_PACKAGE} ${peerRange} does not allow Crucible ${version}. Widen the peer range or test the addon against ${version}.`);
  }
  if (pack.dependencies?.[CORE_PACKAGE] !== undefined) {
    warnings.push(`${CORE_PACKAGE} is in dependencies. Move it to peerDependencies so hosts do not get two copies.`);
  }
}

// Returns { errors, warnings } for the addon package in `folder`. `version` is a Crucible version the declared range must allow.
export function checkAddon(folder, { version } = {}) {
  const errors = [];
  const warnings = [];
  const pack = readPackage(folder, errors);
  if (pack === null) return { errors, warnings };
  if (typeof pack.name !== 'string' || pack.name === '') errors.push('package.json needs a "name".');
  if (!Array.isArray(pack.keywords) || !pack.keywords.includes(ADDON_KEYWORD)) {
    errors.push(`package.json "keywords" must include "${ADDON_KEYWORD}" so the listing finds the addon. Add it.`);
  }
  checkPeer(pack, errors, warnings, version);
  if (typeof pack.license !== 'string' || pack.license === '') {
    errors.push('package.json "license" must be an SPDX identifier such as "MIT".');
  }
  checkManifest(pack['crucible'], errors);
  checkEntrySize(folder, pack, errors);
  const declaredRange = pack['crucible']?.range;
  if (version && parseRange(declaredRange) && !rangeAllows(declaredRange, version)) {
    errors.push(`"crucible".range ${declaredRange} does not allow Crucible ${version}. Widen the range or test the addon against ${version}.`);
  }
  return { errors, warnings };
}

const USAGE = 'Usage: npx crucible-addon-check <addon-folder> [--version <Crucible version>]';

// Returns { folder, version, help } or { error } for a bad command line. Accepts --version X and --version=X.
export function parseArguments(argumentsList) {
  if (argumentsList.includes('--help') || argumentsList.includes('-h')) return { help: true };
  let folder;
  let version;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--version' || argument.startsWith('--version=')) {
      const inline = argument.startsWith('--version=');
      const value = inline ? argument.slice('--version='.length) : argumentsList[index + 1];
      if (value === undefined || value === '' || value.startsWith('--')) {
        return { error: '--version needs a Crucible version such as 0.20.0. Pass --version 0.20.0 or --version=0.20.0.' };
      }
      if (!VERSION_PATTERN.test(value)) return { error: `--version must look like 0.20.0, got ${JSON.stringify(value)}.` };
      if (version !== undefined) return { error: '--version may be given only once. Pass one Crucible version.' };
      version = value;
      if (!inline) index += 1;
    } else if (argument.startsWith('-')) {
      return { error: `Unknown flag ${argument}. The flags are --version <Crucible version> and --help.` };
    } else if (folder === undefined) {
      folder = argument;
    } else {
      return { error: `Unexpected extra argument ${JSON.stringify(argument)}. Pass one addon package folder.` };
    }
  }
  return { folder, version };
}

export function main(argumentsList) {
  const parsed = parseArguments(argumentsList);
  if (parsed.help) {
    console.log(`${USAGE}

Checks the folder against the addon contract in docs/addons.md. --version tests the declared and peer ranges against that Crucible version. Exit 0 when ok, 1 when the contract fails, 2 for a bad command line.`);
    return 0;
  }
  if (parsed.error || !parsed.folder) {
    console.error(parsed.error ?? 'Pass the addon package folder.');
    console.error(USAGE);
    return 2;
  }
  const { errors, warnings } = checkAddon(resolve(parsed.folder), { version: parsed.version });
  for (const warning of warnings) console.warn(`warning: ${warning}`);
  for (const error of errors) console.error(`error: ${error}`);
  console.log(errors.length === 0 ? 'addon contract: ok' : `addon contract: ${errors.length} problem(s)`);
  return errors.length === 0 ? 0 : 1;
}

// npm links bin entries through a symlink or shim, so compare real paths to know this file is the program.
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = main(process.argv.slice(2));
