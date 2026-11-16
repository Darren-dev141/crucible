import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FINGERPRINT_VERSION, compareFingerprints, fingerprintTree } from '../scripts/look-fingerprint.mjs';
import { checkPullRequest, isFingerprintCovered, isLookIdentical } from '../scripts/pr-metadata-check.mjs';
import { readLookFingerprint, resolveLookIdentical } from '../scripts/pr-metadata-run.mjs';

const lookLabels = labels => labels.filter(label => label.startsWith('look:') || label.startsWith('hold:'));
const repositoryRoot = join(import.meta.dirname, '..');
const fingerprintScript = join(repositoryRoot, 'scripts', 'look-fingerprint.mjs');

// One process per tree: the module cache of this process would otherwise return the first copy of every file.
function fingerprintInChild(treeRoot) {
  return JSON.parse(execFileSync(process.execPath, [fingerprintScript, '--root', treeRoot], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
}

function pullRequest(overrides = {}) {
  return {
    body: '## What changed\n\nRefactor.\n\nCloses #1\n\n## Evidence\n\nOne line: nothing to show.\n\n## How I checked it\n\nTests.\n',
    title: 'Refactor (#1)',
    author: 'someone',
    authorAssociation: 'NONE',
    labels: ['goal:light', 'enhancement'],
    milestone: '0 Measure',
    draft: false,
    ...overrides,
  };
}

function files(...names) {
  return names.map(filename => ({ filename, additions: 1, deletions: 1 }));
}

// Replay of four merged pull requests. The file lists are their GitHub file lists (shortened to the look paths and a sample of
// the rest); lookIdentical is what `node scripts/look-fingerprint.mjs --base <merge>^1 --head <merge>` printed for each merge commit.
const replays = [
  {
    number: 1613,
    expectHold: true,
    lookIdentical: true,
    changed: [],
    files: files('changes/1589.md', 'packages/blender-addon/cook_blender/material_export.py', 'packages/blender-addon/cook_blender/scene_export.py', 'packages/blender-addon/tests/test_edge_cases.py'),
  },
  {
    number: 1594,
    expectHold: true,
    lookIdentical: true,
    changed: [],
    files: files('changes/1589.md', 'packages/blender-addon/cook_blender/material_export.py', 'packages/blender-addon/tests/test_edge_cases.py'),
  },
  {
    number: 1522,
    expectHold: true,
    lookIdentical: false,
    changed: ['file/material-graph.js'],
    files: files('changes/1522-descriptive-names.md', 'scripts/check-names.mjs', 'src/material-graph.js', 'src/mesh-volume-pass.js', 'src/vegetation-impostors.js', 'src/cloth.js', 'tests/modeling.test.js'),
  },
  {
    number: 1751,
    expectHold: true,
    lookIdentical: false,
    changed: ['composite/local-both', 'post/local-grid', 'post/local-shape', 'registered/feature-code'],
    files: files('changes/1733.md', 'src/agent-scene-capabilities.js', 'src/fog-shader.js', 'src/volume-grid.js', 'tests/volume-grid.test.js'),
  },
];

for (const replay of replays) {
  test(`replay of #${replay.number}: ${replay.expectHold ? 'keeps' : 'drops'} the look hold`, () => {
    const result = checkPullRequest({ pr: pullRequest({ lookIdentical: replay.lookIdentical }), files: replay.files });
    assert.equal(result.addLabels.includes('hold:look-approval'), replay.expectHold);
    assert.equal(result.addLabels.includes('look:identical'), !replay.expectHold);
    assert.equal(result.contributorFixes.some(item => item.id === 'look-without-image'), replay.expectHold);
    assert.equal(result.maintainerTodos.some(todo => todo.startsWith('Look change')), replay.expectHold);
  });
}

test('a fork pull request with lookIdentical true still gets the hold', () => {
  const result = checkPullRequest({ pr: pullRequest({ lookIdentical: true, fromFork: true }), files: files('src/lighting.js') });
  assert.ok(result.addLabels.includes('hold:look-approval'));
  assert.ok(!result.addLabels.includes('look:identical'));
});

test('an add-on script change and a look file the fingerprint cannot generate are held', () => {
  for (const name of ['packages/blender-addon/cook_blender/material_export.py', 'packages/cook-native/src/shader.rs', 'src/shaders/sky.glsl']) {
    const result = checkPullRequest({ pr: pullRequest({ lookIdentical: true }), files: files(name) });
    assert.ok(result.addLabels.includes('hold:look-approval'), name);
    assert.ok(!result.addLabels.includes('look:identical'), name);
  }
});

test('without a fingerprint a look change is held exactly as before', () => {
  const lookFiles = files('src/lighting.js');
  const result = checkPullRequest({ pr: pullRequest(), files: lookFiles });
  assert.ok(result.addLabels.includes('hold:look-approval'));
  assert.ok(!result.addLabels.includes('look:identical'));
  const failed = checkPullRequest({ pr: pullRequest({ lookIdentical: false }), files: lookFiles });
  assert.ok(failed.addLabels.includes('hold:look-approval'));
});

test('a hold that is already on the pull request stays, and look:identical is not added beside it', () => {
  const result = checkPullRequest({
    pr: pullRequest({ lookIdentical: true, labels: ['goal:light', 'enhancement', 'hold:look-approval'] }),
    files: files('src/lighting.js'),
  });
  assert.deepEqual(result.removeLabels, []);
  assert.deepEqual(lookLabels(result.addLabels), []);
});

test('a push that adds a difference swaps look:identical for the hold', () => {
  const result = checkPullRequest({
    pr: pullRequest({ lookIdentical: false, labels: ['goal:light', 'enhancement', 'look:identical'] }),
    files: files('src/fog-shader.js'),
  });
  assert.ok(result.addLabels.includes('hold:look-approval'));
  assert.deepEqual(result.removeLabels, ['look:identical']);
});

test('the hourly sweep keeps look:identical and adds no hold while no fingerprint is computed', () => {
  const result = checkPullRequest({
    pr: pullRequest({ labels: ['goal:light', 'enhancement', 'look:identical'] }),
    files: files('src/lighting.js', 'changes/1.md'),
  });
  assert.deepEqual(lookLabels(result.addLabels), []);
  assert.deepEqual(result.removeLabels, []);
});

test('only JavaScript under src counts as covered by the fingerprint', () => {
  assert.ok(isFingerprintCovered('src/post.js'));
  assert.ok(!isFingerprintCovered('packages/blender-addon/cook_blender/material_export.py'));
  assert.ok(!isFingerprintCovered('packages/cook-native/src/shader.rs'));
  assert.ok(!isFingerprintCovered('packages/some-addon/shaders.js'));
  assert.ok(!isFingerprintCovered('src/shaders/sky.glsl'));
  const uncovered = pullRequest({ lookIdentical: true });
  assert.equal(isLookIdentical(uncovered, files('src/lighting.js', 'packages/cook-native/src/shader.rs')), false);
  assert.equal(isLookIdentical(uncovered, files('docs/lighting.md')), false);
});

test('readLookFingerprint reads the job result and treats a missing file as no proof', () => {
  const directory = mkdtempSync(join(tmpdir(), 'look-result-'));
  try {
    const identical = join(directory, 'identical.json');
    writeFileSync(identical, JSON.stringify({ lookIdentical: true, changed: [] }));
    assert.equal(readLookFingerprint(identical).lookIdentical, true);
    assert.equal(readLookFingerprint(join(directory, 'missing.json')).lookIdentical, false);
    assert.equal(readLookFingerprint(''), undefined);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a result for another head commit, another version or no commit is not trusted', () => {
  const result = { version: FINGERPRINT_VERSION, headSha: 'abc123', lookIdentical: true, changed: [] };
  assert.equal(resolveLookIdentical(result, 'abc123'), true);
  assert.equal(resolveLookIdentical(result, 'def456'), false);
  assert.equal(resolveLookIdentical(result, undefined), false);
  assert.equal(resolveLookIdentical({ ...result, version: FINGERPRINT_VERSION - 1 }, 'abc123'), false);
  assert.equal(resolveLookIdentical({ ...result, headSha: undefined }, undefined), false);
  assert.equal(resolveLookIdentical(undefined, 'abc123'), undefined);
});

test('a look default edited in a file that is not a shader generator is held, and a comment or blank lines are not', () => {
  const directory = mkdtempSync(join(tmpdir(), 'look-default-'));
  try {
    cpSync(join(repositoryRoot, 'src'), join(directory, 'src'), { recursive: true });
    const original = fingerprintInChild(directory);
    const setupsPath = join(directory, 'src', 'lighting-setups.js');
    const setupsSource = readFileSync(setupsPath, 'utf8');
    const intensityDefault = 'createLightingSetupMap(name, { intensity = 1,';
    assert.ok(setupsSource.includes(intensityDefault));
    writeFileSync(setupsPath, setupsSource.replace(intensityDefault, 'createLightingSetupMap(name, { intensity = 2,'));
    const edited = compareFingerprints(original, fingerprintInChild(directory));
    assert.equal(edited.lookIdentical, false);
    assert.deepEqual(edited.changed, ['file/lighting-setups.js']);
    writeFileSync(setupsPath, `/* a comment */\n${setupsSource.replaceAll('\n', '\n\n')}`);
    assert.equal(compareFingerprints(original, fingerprintInChild(directory)).lookIdentical, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('compareFingerprints names every config or default that differs', () => {
  const base = { version: FINGERPRINT_VERSION, configs: { a: 'x', b: 'y' }, defaults: { 'constant/C': 'z' }, files: {} };
  assert.deepEqual(compareFingerprints(base, structuredClone(base)), { lookIdentical: true, changed: [] });
  const head = { version: FINGERPRINT_VERSION, files: {}, configs: { a: 'x', b: 'changed', c: 'new' }, defaults: { 'constant/C': 'other' } };
  assert.deepEqual(compareFingerprints(base, head), { lookIdentical: false, changed: ['b', 'c', 'constant/C'] });
  assert.equal(compareFingerprints(base, null).lookIdentical, false);
});

test('the fingerprint covers post, local volume kinds, materials, sky and the defaults', async () => {
  const fingerprint = await fingerprintTree(repositoryRoot);
  for (const name of ['post/none', 'post/local-grid', 'post/local-shape', 'post/local-both-motion', 'composite/local-grid', 'post/fog-sky', 'sky/fragment', 'material/fragment-all', 'material/vertex-all', 'shadow/depth-vertex', 'registered/feature-code']) {
    assert.match(fingerprint.configs[name] ?? '', /^[0-9a-f]{16}$/, name);
  }
  assert.ok(Object.keys(fingerprint.defaults).length > 20);
  assert.match(fingerprint.configs['import/errors'], /^[0-9a-f]{16}$/);
});

test('a comment keeps a copy of src identical and a shader edit does not', () => {
  const directory = mkdtempSync(join(tmpdir(), 'look-tree-'));
  try {
    cpSync(join(repositoryRoot, 'src'), join(directory, 'src'), { recursive: true });
    const original = fingerprintInChild(directory);
    const postPath = join(directory, 'src', 'post.js');
    const postSource = readFileSync(postPath, 'utf8');
    writeFileSync(postPath, `// a comment changes no pixel\n${postSource}`);
    assert.equal(compareFingerprints(original, fingerprintInChild(directory)).lookIdentical, true);
    assert.ok(postSource.includes('* 0.7 * daylight'));
    writeFileSync(postPath, postSource.replace('* 0.7 * daylight', '* 0.8 * daylight'));
    const edited = compareFingerprints(original, fingerprintInChild(directory));
    assert.equal(edited.lookIdentical, false);
    assert.ok(edited.changed.includes('sky/fragment'));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
