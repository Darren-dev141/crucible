// Runs every tests/*.test.js that mentions one of the given source files, directly or through one level of re-export.
// Usage: npm run test:affected -- src/foo.js scripts/bar.mjs
//        npm run test:affected            with no files, uses the files changed since origin/main (as preflight does)
import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, normalize, relative, resolve } from 'node:path';
import { changedPathsSince } from './preflight.mjs';
import { isMainModule, listTestFiles, repositoryRoot, runTestFiles } from './test-run.mjs';

const SOURCE_FOLDERS = ['src', 'scripts', 'packages', 'bin'];
const SOURCE_EXTENSION = /\.(m?js|cjs)$/;
const REEXPORT_PATTERN = /export\s+(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/g;

function toPosix(path) {
  return path.replace(/\\/g, '/');
}

function listSourceFiles(folder) {
  const found = [];
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (SOURCE_EXTENSION.test(entry.name)) found.push(path);
    }
  };
  for (const sourceFolder of SOURCE_FOLDERS) {
    try {
      visit(join(folder, sourceFolder));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return found;
}

// Files that re-export `targetPath` (repo-relative, posix): `export ... from './target.js'`.
export function findReexporters(targetPath, folder = repositoryRoot) {
  const target = normalize(resolve(folder, targetPath));
  const reexporters = [];
  for (const sourceFile of listSourceFiles(folder)) {
    const text = readFileSync(sourceFile, 'utf8');
    for (const match of text.matchAll(REEXPORT_PATTERN)) {
      if (!match[1].startsWith('.')) continue;
      if (normalize(resolve(dirname(sourceFile), match[1])) === target) {
        reexporters.push(toPosix(relative(folder, sourceFile)));
        break;
      }
    }
  }
  return reexporters;
}

function escapeForPattern(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentionPattern(filePath) {
  return new RegExp(`(^|[/'"\`\\s])${escapeForPattern(basename(filePath))}`);
}

// Test files (repo-relative, sorted) that mention any given file by name, or a module that re-exports it.
export function findAffectedTests(sourcePaths, folder = repositoryRoot) {
  const sources = sourcePaths.map(toPosix);
  const names = new Set(sources);
  for (const source of sources) {
    if (SOURCE_EXTENSION.test(source)) findReexporters(source, folder).forEach(path => names.add(path));
  }
  const patterns = [...names].map(mentionPattern);
  const testFiles = listTestFiles(folder);
  const affected = testFiles.filter(testFile => {
    if (names.has(testFile)) return true;
    const text = readFileSync(join(folder, testFile), 'utf8');
    return patterns.some(pattern => pattern.test(text));
  });
  return affected;
}

async function main(arguments_) {
  const requested = arguments_.filter(argument => !argument.startsWith('--'));
  const sourcePaths = requested.length > 0 ? requested : changedPathsSince('origin/main');
  const affected = findAffectedTests(sourcePaths);
  if (affected.length === 0) {
    console.log(`No test file mentions ${sourcePaths.length} changed file(s). Name the files to check: npm run test:affected -- <files...>`);
    return;
  }
  console.log(`Running ${affected.length} test file(s) that mention ${sourcePaths.length} file(s).`);
  process.exit(runTestFiles(affected).code);
}

if (isMainModule(import.meta.url)) await main(process.argv.slice(2));
