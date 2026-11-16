#!/usr/bin/env node
// Traces which files can change what the Cook addon job tests, so the workflow runs only for those (#1796).
// It starts at every test whose import statements load tests/support/cook.js (not a mention in text, #1830), follows relative static imports and `import('./literal')` calls,
// and prints the files it reaches as workflow path lines. tests/addon-job-paths.test.js fails when the workflow misses one.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importsFile } from './import-specifiers.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const COOK_SUPPORT_FILE = 'tests/support/cook.js';

// `from '...'`, bare `import '...'`, `import('...')` and `require('...')` with a relative literal path.
const IMPORT_PATTERN = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"])(\.{1,2}\/[^'"\n]+)\1/g;

// Tests also start scripts and read sources by a literal repository path, for example join(root, 'scripts/native-png.mjs').
const PATH_LITERAL_PATTERN = /['"`](?:\.\.?\/)*((?:scripts|src|bench|packages)\/[\w./-]+\.(?:m?js|cjs))['"`]/g;

function gitLines(args) {
  return execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.length > 0);
}

/** Test files whose real import statements load the Cook helper; a mention in a string or comment does not count. */
export function addonTestFiles(
  testFiles = gitLines(['ls-files', 'tests']).filter((file) => /\.(m?js|cjs)$/.test(file)),
  readSource = (file) => readFileSync(join(repositoryRoot, file), 'utf8'),
) {
  return testFiles
    .filter((file) => file !== COOK_SUPPORT_FILE)
    .filter((file) => importsFile(readSource(file), file, COOK_SUPPORT_FILE))
    .sort();
}

function resolveImport(importerPath, specifier) {
  const target = join(dirname(importerPath), specifier).split('\\').join('/');
  const candidates = [target, `${target}.js`, `${target}.mjs`, `${target}/index.js`];
  return candidates.find((candidate) => /\.(m?js|cjs)$/.test(candidate) && existsSync(join(repositoryRoot, candidate))) ?? null;
}

/** Every repository file the addon tests reach through relative imports, including the tests themselves. Sorted. */
export function traceAddonFiles(entryFiles = [...addonTestFiles(), COOK_SUPPORT_FILE]) {
  const reached = new Set();
  const queue = [...entryFiles];
  while (queue.length > 0) {
    const current = queue.pop();
    if (reached.has(current)) continue;
    reached.add(current);
    const source = readFileSync(join(repositoryRoot, current), 'utf8');
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const resolved = resolveImport(current, match[2]);
      if (resolved !== null) queue.push(resolved);
    }
    for (const match of source.matchAll(PATH_LITERAL_PATTERN)) {
      if (existsSync(join(repositoryRoot, match[1]))) queue.push(match[1]);
    }
  }
  return [...reached].sort();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const traced = traceAddonFiles();
  const tracedSource = traced.filter((file) => file.startsWith('src/'));
  const allSource = gitLines(['ls-files', 'src']);
  for (const file of traced) console.log(`      - '${file}'`);
  console.error(`traced ${traced.length} files, ${tracedSource.length} of ${allSource.length} src files`);
}
