import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  formatReport,
  parseArguments,
  parseRemoteUrl,
  pushEvidence,
  rawUrl,
} from '../scripts/push-evidence.mjs';

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

describe('push-evidence', () => {
  let sandbox;
  let bareRepository;
  let clone;

  before(() => {
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'push-evidence-test-')));
    bareRepository = join(sandbox, 'remote.git');
    clone = join(sandbox, 'clone');
    git(['init', '--bare', '--quiet', bareRepository], sandbox);
    git(['clone', '--quiet', bareRepository, clone], sandbox);
    git(['config', 'user.email', 'test@example.com'], clone);
    git(['config', 'user.name', 'Test'], clone);
    writeFileSync(join(clone, 'readme.txt'), 'hello');
    git(['add', '.'], clone);
    git(['commit', '--quiet', '-m', 'first'], clone);
    mkdirSync(join(clone, 'artifacts'));
    writeFileSync(join(clone, 'artifacts', 'before.png'), 'before picture');
    writeFileSync(join(clone, 'artifacts', 'after.png'), 'after picture');
  });

  after(() => rmSync(sandbox, { recursive: true, force: true }));

  test('creates the branch, then a second push keeps the first file, without touching the clone', () => {
    const headBefore = git(['rev-parse', 'HEAD'], clone);
    const statusBefore = git(['status', '--porcelain', '--untracked-files=all'], clone);
    const stagedBefore = git(['ls-files', '--stage'], clone);

    pushEvidence({ prNumber: 7, files: ['artifacts/before.png'], cwd: clone });
    assert.equal(git(['ls-tree', '-r', '--name-only', 'evidence-pr-7'], bareRepository), 'pr-7/before.png');
    assert.equal(git(['rev-list', '--count', 'evidence-pr-7'], bareRepository), '1');

    pushEvidence({ prNumber: 7, files: ['artifacts/after.png'], cwd: clone });
    assert.equal(
      git(['ls-tree', '-r', '--name-only', 'evidence-pr-7'], bareRepository),
      'pr-7/after.png\npr-7/before.png',
    );
    assert.equal(git(['rev-list', '--count', 'evidence-pr-7'], bareRepository), '2');
    assert.equal(git(['show', 'evidence-pr-7:pr-7/before.png'], bareRepository), 'before picture');

    assert.equal(git(['rev-parse', 'HEAD'], clone), headBefore);
    assert.equal(git(['status', '--porcelain', '--untracked-files=all'], clone), statusBefore);
    assert.equal(git(['ls-files', '--stage'], clone), stagedBefore);
  });

  test('dry run pushes nothing', () => {
    const report = pushEvidence({ prNumber: 8, files: ['artifacts/after.png'], dryRun: true, cwd: clone });
    assert.equal(report.dryRun, true);
    const branches = git(['branch', '--list', 'evidence-pr-8'], bareRepository);
    assert.equal(branches, '');
  });

  test('refuses bad input with a message that says what to pass', () => {
    assert.throws(() => parseArguments(['abc', 'a.png']), /positive integer/);
    assert.throws(() => parseArguments(['0', 'a.png']), /positive integer/);
    assert.throws(() => pushEvidence({ prNumber: 9, files: [], cwd: clone }), /at least one picture/);
    assert.throws(() => pushEvidence({ prNumber: 9, files: ['missing.png'], cwd: clone }), /File not found/);
    writeFileSync(join(clone, 'artifacts', 'notes.txt'), 'text');
    assert.throws(() => pushEvidence({ prNumber: 9, files: ['artifacts/notes.txt'], cwd: clone }), /Pass one of: .png/);
    writeFileSync(join(clone, 'artifacts', 'huge.mp4'), Buffer.alloc(20 * 1024 * 1024 + 1));
    assert.throws(() => pushEvidence({ prNumber: 9, files: ['artifacts/huge.mp4'], cwd: clone }), /over the 20 MB limit/);
  });

  test('refuses a file outside the repository and the temp folder', () => {
    const outside = process.platform === 'win32' ? 'C:\\Windows\\System32\\drivers\\etc\\hosts.png' : '/etc/hosts.png';
    assert.throws(() => pushEvidence({ prNumber: 9, files: [outside], cwd: clone }), /not found|outside the repository/);
  });

  test('builds raw URLs and Markdown from a GitHub remote', () => {
    const repository = parseRemoteUrl('https://github.com/codepawl/crucible.git');
    assert.deepEqual(repository, { owner: 'codepawl', repository: 'crucible' });
    assert.deepEqual(parseRemoteUrl('git@github.com:codepawl/crucible.git'), repository);
    const url = rawUrl(repository, 12, 'a.png');
    assert.equal(url, 'https://raw.githubusercontent.com/codepawl/crucible/evidence-pr-12/pr-12/a.png');
    const report = formatReport({ branch: 'evidence-pr-12', links: [{ name: 'a.png', url }], dryRun: false });
    assert.match(report, /!\[a\.png\]\(https:\/\/raw\.githubusercontent\.com\/codepawl\/crucible\/evidence-pr-12\/pr-12\/a\.png\)/);
  });
});
