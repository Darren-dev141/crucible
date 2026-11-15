// Fails when a tracked source file declares a variable or function with a one-letter or abbreviated name.
// Usage: npm run check:names
// The house rule: descriptive full names. Only loop indices i j k n, coordinates x y z u v, t, w h, colour channels r g b a and _
// may stay short, and tmp, cfg, res, obj, buf, idx, msg, el, cb, fn are never allowed.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const ALLOWED_SHORT_NAMES = new Set(['i', 'j', 'k', 'n', 'x', 'y', 'z', 'u', 'v', 't', 'w', 'h', 'r', 'g', 'b', 'a', '_']);
const ABBREVIATIONS = new Set(['tmp', 'cfg', 'res', 'obj', 'buf', 'idx', 'msg', 'el', 'cb', 'fn']);

const SCANNED_PATH = /^(src|scripts|bin|bench|tests)\/|^packages\/[^/]+\/src\//;
const SOURCE_FILE = /\.(js|mjs|ts)$/;
const SKIPPED_PATH = /\.min\.|(^|\/)(vendor|dist|generated|node_modules)\/|\.generated\./;

const DECLARATION = /\b(?:const|let|var|function\*?)\s+([A-Za-z_$][\w$]*)/g;

function isDisallowed(name) {
  if (ABBREVIATIONS.has(name)) return true;
  return /^[A-Za-z]$/.test(name) && !ALLOWED_SHORT_NAMES.has(name);
}

// Returns { line, name } for each disallowed declaration in a source text. Pure, so tests can call it without git.
export function findAbbreviatedNames(text) {
  const findings = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const trimmed = lines[index].trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    for (const match of lines[index].matchAll(DECLARATION)) {
      if (isDisallowed(match[1])) findings.push({ line: index + 1, name: match[1] });
    }
  }
  return findings;
}

export function isScannedPath(path) {
  const normalized = path.replaceAll('\\', '/');
  return SCANNED_PATH.test(normalized) && SOURCE_FILE.test(normalized) && !SKIPPED_PATH.test(normalized);
}

function trackedFiles() {
  const result = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr.trim()}`);
  return result.stdout.split('\n').filter(Boolean);
}

function main() {
  let problemCount = 0;
  for (const path of trackedFiles().filter(isScannedPath)) {
    for (const { line, name } of findAbbreviatedNames(readFileSync(resolve(root, path), 'utf8'))) {
      console.error(`${path}:${line}  \`${name}\` is a short name. Rename it to what it holds (for example thirdVertexOffset, not c).`);
      problemCount++;
    }
  }
  if (problemCount > 0) {
    console.error(`${problemCount} short name(s). Allowed short names: i j k n, x y z u v, t, w h, r g b a, _. Never tmp, cfg, res, obj, buf, idx, msg, el, cb, fn.`);
    process.exit(1);
  }
  console.log('check-names: clean');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
