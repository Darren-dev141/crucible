// The Cook addon job caches the built addon by a key that must change with the pin, the OS, the architecture and the Rust toolchain (#1800).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { BUILD_RECIPE, cookAddonCacheKey, cookPinFromLock, normalizeRustcVersion } from '../scripts/cook-addon-cache-key.mjs';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const PIN = '6e2cd0b0e56e30fe94739d9f495a8bef5d6959a9';
const OTHER_PIN = '1111111111111111111111111111111111111111';

function lockWith(resolved) {
  return JSON.stringify({ packages: { 'node_modules/@codepawlhq/cook': { resolved } } });
}

const baseInput = {
  lockText: lockWith(`git+https://github.com/codepawl/cook.git#${PIN}`),
  runnerOs: 'Linux',
  runnerArch: 'X64',
  rustcVersionLine: 'rustc 1.91.0 (f8297e351 2025-10-28)',
};

test('the pin is the commit SHA of the locked Cook', () => {
  assert.equal(cookPinFromLock(baseInput.lockText), PIN);
  assert.match(cookPinFromLock(readFileSync(join(repositoryRoot, 'package-lock.json'), 'utf8')), /^[0-9a-f]{40}$/);
});

test('a Cook that is not pinned to a commit SHA is refused with a fix', () => {
  assert.throws(() => cookPinFromLock(lockWith('https://registry.npmjs.org/cook/-/cook-1.0.0.tgz')), /pin Cook to a commit SHA/);
  assert.throws(() => cookPinFromLock('{"packages":{}}'), /pin Cook to a commit SHA/);
});

test('the rustc line becomes a key safe string and a wrong line is refused', () => {
  assert.equal(normalizeRustcVersion('rustc 1.91.0 (f8297e351 2025-10-28)\n'), 'rustc-1.91.0-f8297e351-2025-10-28');
  assert.throws(() => normalizeRustcVersion('cargo 1.91.0'), /rustc --version/);
});

test('every input that changes the binary changes the key', () => {
  const base = cookAddonCacheKey(baseInput).key;
  assert.ok(base.includes(BUILD_RECIPE) && base.includes(PIN) && base.includes('Linux') && base.includes('X64'));
  const variants = [
    { lockText: lockWith(`git+https://github.com/codepawl/cook.git#${OTHER_PIN}`) },
    { runnerOs: 'macOS' },
    { runnerArch: 'ARM64' },
    { rustcVersionLine: 'rustc 1.92.0 (aaaaaaaaa 2025-12-01)' },
  ];
  for (const variant of variants) {
    assert.notEqual(cookAddonCacheKey({ ...baseInput, ...variant }).key, base, JSON.stringify(Object.keys(variant)));
  }
  assert.equal(cookAddonCacheKey(baseInput).key, base, 'same inputs give the same key');
});
