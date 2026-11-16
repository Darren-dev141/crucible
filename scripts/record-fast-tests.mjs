// Measures every test file once and writes config/fast-tests.json: the files that finish in under 0.6 s of wall time
// (node start-up included), as { "tests/x.test.js": milliseconds }. scripts/fast-tests.mjs runs them in the pre-push check.
// The 0.6 s line leaves room under the 1 s the pre-push check promises, so a loaded machine or a CI runner keeps them fast.
// Run it again when many test files were added: npm run record:fast-tests
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMainModule, listTestFiles, repositoryRoot } from './test-run.mjs';
import { FAST_TESTS_PATH, usesNativeAddon } from './fast-tests.mjs';

export const RECORD_LIMIT_MS = 600;
const PARALLEL_MEASUREMENTS = 3;

function measureOneFile(testFile) {
  return new Promise(resolve => {
    const startedAt = performance.now();
    const child = spawn(process.execPath, ['--test', '--test-timeout=20000', testFile], { cwd: repositoryRoot, stdio: 'ignore' });
    child.on('close', code => resolve({ testFile, passed: code === 0, milliseconds: Math.round(performance.now() - startedAt) }));
  });
}

async function measureAll(testFiles) {
  const queue = [...testFiles];
  const results = [];
  async function worker() {
    while (queue.length > 0) results.push(await measureOneFile(queue.shift()));
  }
  await Promise.all(Array.from({ length: PARALLEL_MEASUREMENTS }, worker));
  return results;
}

// Keeps the passing files under the limit. A failing file is never listed, so the check cannot start on a red test.
export function pickFastResults(results, limitMs = RECORD_LIMIT_MS) {
  const picked = results
    .filter(result => result.passed && result.milliseconds < limitMs)
    .sort((first, second) => first.testFile.localeCompare(second.testFile));
  return Object.fromEntries(picked.map(result => [result.testFile, result.milliseconds]));
}

async function main() {
  const testFiles = listTestFiles().filter(file => !usesNativeAddon(readFileSync(join(repositoryRoot, file), 'utf8')));
  console.log(`Measuring ${testFiles.length} test files, ${PARALLEL_MEASUREMENTS} at a time.`);
  const fastTests = pickFastResults(await measureAll(testFiles));
  writeFileSync(join(repositoryRoot, FAST_TESTS_PATH), `${JSON.stringify(fastTests, null, 2)}\n`);
  console.log(`Wrote ${Object.keys(fastTests).length} files under ${RECORD_LIMIT_MS} ms to ${FAST_TESTS_PATH}.`);
}

if (isMainModule(import.meta.url)) await main();
