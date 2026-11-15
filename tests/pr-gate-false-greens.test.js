// False greens in the pull request gates: an empty coverage file, a deleted change note and a size note for a bundle that does not exist.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planChecks } from '../scripts/preflight.mjs';
import { unknownNoteProblems } from '../scripts/size-growth.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

function runGit(folder, ...args) {
  const result = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: folder, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function changeNoteCheck(changedPaths, addedPaths) {
  return planChecks(changedPaths, { addedPaths }).find(check => check.name === 'change note');
}

test('an lcov file with no source files fails the coverage gate instead of reading as 100 percent', () => {
  const folder = mkdtempSync(join(tmpdir(), 'coverage-empty-'));
  try {
    const lcovPath = join(folder, 'empty.lcov');
    const baselinePath = join(folder, 'baseline.json');
    writeFileSync(lcovPath, '');
    writeFileSync(baselinePath, JSON.stringify({ lines: 90, branches: 80, functions: 90 }));
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'coverage-gate.mjs'), lcovPath, '--baseline', baselinePath], { encoding: 'utf8' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /no source files/i);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a change note that is edited or deleted, not added, does not satisfy the note check', () => {
  const changed = ['src/camera.js', 'changes/700.md'];
  assert.match(changeNoteCheck(changed, ['src/camera.js']).failure, /changes\/<issue>\.md/);
  assert.equal(changeNoteCheck(changed, ['changes/700.md']).failure, null);
});

test('check-change-note fails a branch that deletes a change note and changes src/', () => {
  const folder = mkdtempSync(join(tmpdir(), 'deleted-note-gate-'));
  try {
    runGit(folder, 'init', '-q');
    mkdirSync(join(folder, 'changes'));
    mkdirSync(join(folder, 'src'));
    writeFileSync(join(folder, 'package.json'), '{"version":"1.0.0"}\n');
    writeFileSync(join(folder, 'changes', '5.md'), '- Older note (#5)\n');
    writeFileSync(join(folder, 'src', 'a.js'), 'export const a = 1;\n');
    runGit(folder, 'add', '.');
    runGit(folder, 'commit', '-q', '-m', 'base');
    runGit(folder, 'rm', '-q', 'changes/5.md');
    writeFileSync(join(folder, 'src', 'a.js'), 'export const a = 2;\n');
    runGit(folder, 'add', '.');
    runGit(folder, 'commit', '-q', '-m', 'change');
    const result = spawnSync(process.execPath, [join(root, 'scripts', 'check-change-note.mjs'), '--base', 'HEAD~1'], { cwd: folder, encoding: 'utf8' });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /change note/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a size note line for a goal, scene or entry that does not exist is a problem', () => {
  const measured = { 'entry:core': { min: 300, gzip: 100 }, 'scene:lit-box': { min: 600, gzip: 200 } };
  const goals = { 'lit-box': 150 };
  const accepted = new Map([
    ['goal:lit-box', 'ok'], ['entry:core', 'ok'], ['archive', 'ok'], ['tool:scene_create', 'checked by the tool cost gate'],
    ['goal:lit-bxo', 'typo'], ['entry:cor', 'typo'], ['scene:gone', 'removed'],
  ]);
  const problems = unknownNoteProblems(accepted, measured, goals).join('\n');
  assert.equal(unknownNoteProblems(accepted, measured, goals).length, 3);
  assert.match(problems, /goal:lit-bxo/);
  assert.match(problems, /entry:cor\b/);
  assert.match(problems, /scene:gone/);
});
