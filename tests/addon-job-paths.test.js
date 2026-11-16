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

/** The workflow lines to paste under on.pull_request.paths for the traced files it does not cover, sorted. */
function missingPathLines(tracedFiles, globs) {
  return tracedFiles.filter((file) => !isCovered(file, globs)).sort().map((file) => `      - '${file}'`);
}

function assertWorkflowCovers(tracedFiles, globs) {
  const missingLines = missingPathLines(tracedFiles, globs);
  assert.deepEqual(
    missingLines,
    [],
    `Paste these lines under on.pull_request.paths in .github/workflows/cook-addon.yml:\n${missingLines.join('\n')}`,
  );
}

test('every file the addon tests reach is covered by the pull_request paths of cook-addon.yml', () => {
  assertWorkflowCovers(traceAddonFiles(), triggerPaths('pull_request'));
});

test('a traced file the workflow lacks fails with the exact lines to paste, in sorted order', () => {
  const globs = triggerPaths('pull_request');
  const traced = ['scripts/zzz-new.mjs', 'tests/support/cook.js', 'scripts/aaa-new.mjs'];
  assert.deepEqual(missingPathLines(traced, globs), ["      - 'scripts/aaa-new.mjs'", "      - 'scripts/zzz-new.mjs'"]);
  assert.throws(
    () => assertWorkflowCovers(traced, globs),
    (error) => error.message.includes("      - 'scripts/aaa-new.mjs'\n      - 'scripts/zzz-new.mjs'"),
  );
});

test('a file that the real tracer reaches but the workflow lacks is reported', () => {
  const globs = triggerPaths('pull_request').filter((glob) => glob !== 'tests/support/cook.js');
  assert.deepEqual(missingPathLines(traceAddonFiles(), globs), ["      - 'tests/support/cook.js'"]);
});

test('addon tests are found by their imports, not by a mention of the helper in text', () => {
  const sources = {
    'tests/imports.test.js': "import { x } from './support/cook.js';",
    'tests/side-effect.test.js': "import './support/cook.js';",
    'tests/reexport.test.js': "export { x } from './support/cook.js';",
    'tests/dynamic.test.js': "const helper = await import('./support/cook.js');",
    'tests/required.test.js': "const helper = require('./support/cook.js');",
    'tests/string.test.js': "const note = './support/cook.js'; const other = \"import './support/cook.js'\";",
    'tests/comment.test.js': "// import './support/cook.js'\n/* import './support/cook.js' */",
    'tests/other-helper.test.js': "import { x } from './support/scene.js';",
  };
  const found = addonTestFiles(Object.keys(sources), (file) => sources[file]);
  assert.deepEqual(found, ['tests/dynamic.test.js', 'tests/imports.test.js', 'tests/reexport.test.js', 'tests/required.test.js', 'tests/side-effect.test.js']);
});

test('the pull_request paths keep the build inputs and the workflow itself', () => {
  const globs = triggerPaths('pull_request');
  const requiredPaths = ['package.json', 'package-lock.json', '.github/workflows/cook-addon.yml', 'scripts/check-first-native-job.mjs', 'scripts/addon-job-paths.mjs', 'scripts/import-specifiers.mjs', 'tests/addon-job-paths.test.js'];
  for (const requiredPath of requiredPaths) {
    assert.ok(isCovered(requiredPath, globs), `${requiredPath} must trigger the addon job`);
  }
  assert.ok(!isCovered('docs/goal.md', globs), 'documentation must not trigger the addon job');
});

test('the addon job also runs nightly on main, by schedule and by hand', () => {
  const workflow = workflowLines.join('\n');
  assert.match(workflow, /^ {2}schedule:\n {4}- cron: '[^']+'$/m);
  assert.match(workflow, /^ {2}workflow_dispatch:$/m);
  assert.match(workflow, /^ {2}push:\n {4}branches: \[main\]$/m);
});
