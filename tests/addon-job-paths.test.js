// The Cook addon job runs only for pull requests that touch native code (#1796). A file that joins the addon tests' import
// graph must be listed in the workflow, or a change to it would skip the job that exercises it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { addonTestFiles, traceAddonFiles } from '../scripts/addon-job-paths.mjs';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const workflowLines = readFileSync(join(repositoryRoot, '.github/workflows/cook-addon.yml'), 'utf8').split('\n');

/** The quoted entries of `on.<trigger>.paths`, read without a YAML dependency. */
function triggerPaths(trigger) {
  const triggerIndex = workflowLines.findIndex((line) => line === `  ${trigger}:`);
  assert.notEqual(triggerIndex, -1, `cook-addon.yml has no ${trigger} trigger`);
  const entries = [];
  let insidePaths = false;
  for (const line of workflowLines.slice(triggerIndex + 1)) {
    if (/^ {0,2}\S/.test(line)) break;
    if (/^ {4}paths:/.test(line)) {
      insidePaths = true;
    } else if (insidePaths) {
      const entry = /^ {6}- '([^']+)'$/.exec(line);
      if (entry === null) break;
      entries.push(entry[1]);
    }
  }
  return entries;
}

function globToExpression(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped.replace(/\u0000/g, '.*')}$`);
}

function isCovered(file, globs) {
  return globs.some((glob) => globToExpression(glob).test(file));
}

test('the traced addon set includes the addon tests, their helper and the source they load', () => {
  const traced = traceAddonFiles();
  assert.ok(addonTestFiles().length > 20, 'expected the addon test files to be found with git grep');
  assert.ok(traced.includes('tests/support/cook.js'));
  assert.ok(traced.includes('tests/native-session.test.js'));
  assert.ok(traced.some((file) => file.startsWith('src/')));
});

test('every file the addon tests reach is covered by the pull_request paths of cook-addon.yml', () => {
  const globs = triggerPaths('pull_request');
  const missing = traceAddonFiles().filter((file) => !isCovered(file, globs));
  assert.deepEqual(
    missing,
    [],
    `Add these to on.pull_request.paths in .github/workflows/cook-addon.yml (run \`node scripts/addon-job-paths.mjs\` for the full list):\n${missing.join('\n')}`,
  );
});

test('the pull_request paths keep the build inputs and the workflow itself', () => {
  const globs = triggerPaths('pull_request');
  for (const required of ['package.json', 'package-lock.json', '.github/workflows/cook-addon.yml', 'scripts/check-first-native-job.mjs']) {
    assert.ok(isCovered(required, globs), `${required} must trigger the addon job`);
  }
  assert.ok(!isCovered('docs/goal.md', globs), 'documentation must not trigger the addon job');
});

test('the addon job also runs nightly on main, by schedule and by hand', () => {
  const workflow = workflowLines.join('\n');
  assert.match(workflow, /^ {2}schedule:\n {4}- cron: '[^']+'$/m);
  assert.match(workflow, /^ {2}workflow_dispatch:$/m);
  assert.match(workflow, /^ {2}push:\n {4}branches: \[main\]$/m);
});
