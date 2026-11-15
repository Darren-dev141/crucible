import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const checkScript = resolve('bin/crucible-addon-check.mjs');

function withFolder(run) {
  const folder = mkdtempSync(join(tmpdir(), 'crucible-addon-edge-'));
  try {
    return run(folder);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

test('a package.json that holds JSON null or an array fails the contract instead of passing', async () => {
  const { checkAddon } = await import('../bin/crucible-addon-check.mjs');
  for (const text of ['null', '[1]', '5']) {
    withFolder(folder => {
      writeFileSync(join(folder, 'package.json'), text);
      const { errors } = checkAddon(folder);
      assert.ok(errors.length > 0, `package.json ${text} must report an error`);
      assert.match(errors[0], /JSON object/);
    });
  }
});

test('the command line exits 1 for a null package.json', () => {
  withFolder(folder => {
    writeFileSync(join(folder, 'package.json'), 'null');
    const run = spawnSync(process.execPath, [checkScript, folder], { encoding: 'utf8', timeout: 20000 });
    assert.equal(run.status, 1);
  });
});

test('--version given twice is refused instead of the last one winning', async () => {
  const { parseArguments } = await import('../bin/crucible-addon-check.mjs');
  const result = parseArguments(['folder', '--version', '0.19.0', '--version=0.20.0']);
  assert.match(result.error, /--version.*once/);
});

test('an entry that names a folder is not a file the addon can load', async () => {
  const { checkAddon } = await import('../bin/crucible-addon-check.mjs');
  withFolder(folder => {
    mkdirSync(join(folder, 'dist'));
    writeFileSync(join(folder, 'package.json'), JSON.stringify({
      name: 'fixture-addon', license: 'MIT', keywords: ['crucible-addon'], exports: { '.': './dist' },
      peerDependencies: { '@codepawlhq/crucible': '>=0.19.0 <1.0.0' },
      crucible: { range: '>=0.19.0 <1.0.0', extensionPoints: ['registerController'], bundleBytes: 1000 },
    }));
    const { errors } = checkAddon(folder);
    assert.ok(errors.some(message => /folder, not a file/.test(message)), errors.join('\n'));
  });
});
