// Runs a deterministic sample (about 10 percent) of the test files, so a change can be checked in seconds.
// The seed defaults to the branch name, so different branches cover different files.
// Usage: npm run test:fast
//        npm run test:fast -- --seed any-text --percent 20
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isMainModule, listTestFiles, repositoryRoot, runTestFiles } from './test-run.mjs';

const DEFAULT_PERCENT = 10;

function rankOf(seed, testFile) {
  return createHash('sha256').update(`${seed}\n${testFile}`).digest('hex');
}

// Picks ceil(percent of the files), at least one, ordered by a hash of seed and name: the same seed always picks the same files.
export function sampleTestFiles(testFiles, seed, percent = DEFAULT_PERCENT) {
  if (!(percent > 0 && percent <= 100)) {
    throw new Error(`--percent must be above 0 and at most 100, got ${percent}. Pass for example --percent 10.`);
  }
  const count = Math.max(1, Math.ceil((testFiles.length * percent) / 100));
  return [...testFiles]
    .sort((first, second) => rankOf(seed, first).localeCompare(rankOf(seed, second)))
    .slice(0, count)
    .sort();
}

function currentBranchName() {
  const result = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : 'no-branch';
}

function valueAfter(arguments_, flag) {
  const index = arguments_.indexOf(flag);
  return index < 0 ? null : arguments_[index + 1];
}

function main(arguments_) {
  const seed = valueAfter(arguments_, '--seed') ?? currentBranchName();
  const percent = Number(valueAfter(arguments_, '--percent') ?? DEFAULT_PERCENT);
  const sample = sampleTestFiles(listTestFiles(), seed, percent);
  console.log(`Sampling ${sample.length} test file(s) with seed "${seed}". The full pass is still npm test.`);
  process.exit(runTestFiles(sample).code);
}

if (isMainModule(import.meta.url)) main(process.argv.slice(2));
