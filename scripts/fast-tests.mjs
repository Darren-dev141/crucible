// Runs the unit tests that are cheap, so `npm run preflight -- --skip-tests` (the pre-push hook) still catches the
// cheap failures that otherwise cost a CI round: docs import paths, JSON examples in docs, change-note format.
// Which files are cheap comes from config/test-timings.json, the per-file milliseconds measured on CI.
// Usage: node scripts/fast-tests.mjs [--threshold-ms 500] [--budget-ms 30000]
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isMainModule, listTestFiles, repositoryRoot, runTestFiles } from './test-run.mjs';

export const DEFAULT_THRESHOLD_MS = 500;
export const DEFAULT_BUDGET_MS = 30000;
export const TIMINGS_PATH = 'config/test-timings.json';

// Picks the files recorded under `thresholdMs`, fastest first, until their recorded times add up to `budgetMs`.
// Files missing from `existingFiles` (renamed or deleted since the timings were recorded) are dropped.
export function selectFastTests(timings, existingFiles, { thresholdMs = DEFAULT_THRESHOLD_MS, budgetMs = DEFAULT_BUDGET_MS } = {}) {
  const existing = new Set(existingFiles);
  const candidates = Object.entries(timings)
    .filter(([file, milliseconds]) => existing.has(file) && milliseconds < thresholdMs)
    .sort(([firstFile, firstMs], [secondFile, secondMs]) => firstMs - secondMs || firstFile.localeCompare(secondFile));
  const files = [];
  let recordedMilliseconds = 0;
  for (const [file, milliseconds] of candidates) {
    if (recordedMilliseconds + milliseconds > budgetMs) break;
    files.push(file);
    recordedMilliseconds += milliseconds;
  }
  return { files: files.sort(), recordedMilliseconds };
}

// The native Cook tests are recorded at 0 ms on CI, where they skip for lack of a GPU or the built addon, but they run for real here.
export function usesNativeAddon(sourceText) {
  return sourceText.includes('support/cook');
}

export function readTimings(folder = repositoryRoot) {
  const path = join(folder, TIMINGS_PATH);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function numberAfter(arguments_, flag, fallback) {
  const index = arguments_.indexOf(flag);
  if (index < 0) return fallback;
  const value = Number(arguments_[index + 1]);
  if (!(value > 0)) throw new Error(`${flag} needs a positive number of milliseconds, for example ${flag} ${fallback}.`);
  return value;
}

function main(arguments_) {
  const timings = readTimings();
  if (timings === null) {
    console.log(`Skipping the fast tests: ${TIMINGS_PATH} is missing. Restore it with git checkout origin/main -- ${TIMINGS_PATH}, or run npm test for the full pass.`);
    return;
  }
  const thresholdMs = numberAfter(arguments_, '--threshold-ms', DEFAULT_THRESHOLD_MS);
  const budgetMs = numberAfter(arguments_, '--budget-ms', DEFAULT_BUDGET_MS);
  const { files, recordedMilliseconds } = selectFastTests(timings, listTestFiles().filter(file => !usesNativeAddon(readFileSync(join(repositoryRoot, file), 'utf8'))), { thresholdMs, budgetMs });
  if (files.length === 0) {
    console.log(`No test file is recorded under ${thresholdMs} ms in ${TIMINGS_PATH}; nothing to run.`);
    return;
  }
  console.log(`Running ${files.length} fast test file(s), each recorded under ${thresholdMs} ms (${Math.round(recordedMilliseconds / 1000)} s of ${Math.round(budgetMs / 1000)} s budget).`);
  const startedAt = Date.now();
  const { code } = runTestFiles(files);
  console.log(`Fast tests took ${((Date.now() - startedAt) / 1000).toFixed(1)} s.`);
  process.exit(code);
}

if (isMainModule(import.meta.url)) main(process.argv.slice(2));
