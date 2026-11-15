import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PUBLISHED_ADDONS, addonsToPublish } from '../scripts/publish-addons-ci.mjs';

const packages = {
  'packages/served/package.json': JSON.stringify({ name: '@scope/served', version: '1.0.0' }),
  'packages/new/package.json': JSON.stringify({ name: '@scope/new', version: '0.1.0' }),
};
const readText = async path => packages[path];

test('only an addon whose version the registry does not serve is published', async () => {
  const fetchImplementation = async url => ({ ok: url.includes('served'), status: url.includes('served') ? 200 : 404 });
  const pending = await addonsToPublish(['packages/served', 'packages/new'], { fetchImplementation, readText });
  assert.deepEqual(pending, [{ folder: 'packages/new', name: '@scope/new', version: '0.1.0' }]);
});

test('a registry error other than 404 stops the release instead of republishing', async () => {
  const fetchImplementation = async () => ({ ok: false, status: 503 });
  await assert.rejects(() => addonsToPublish(['packages/new'], { fetchImplementation, readText }), /@scope\/new@0\.1\.0 failed: HTTP 503/);
});

test('the OIDN denoiser is published and its package lists only the files a user needs', async () => {
  assert.ok(PUBLISHED_ADDONS.includes('packages/denoise-oidn'));
  const metadata = JSON.parse(await readFile('packages/denoise-oidn/package.json', 'utf8'));
  assert.equal(metadata.name, '@codepawlhq/crucible-denoise-oidn');
  assert.ok(!metadata.private, 'a private package cannot be published');
  assert.ok(!metadata.files.some(file => file.startsWith('vendor')), 'the downloaded binary must not ship in the archive');
});
