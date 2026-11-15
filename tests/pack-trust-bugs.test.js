import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findRemoteUrl } from '../src/pack-manifest.js';
import { addonFileFor } from '../scripts/mcp-addons.mjs';
import { buildPackIndex } from '../scripts/build-pack-index.mjs';

const EXAMPLE = new URL('../packs/example-starter', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

test('findRemoteUrl refuses the forms a browser reads as a remote address', () => {
  const remoteForms = [
    '/\\evil.example/texture.png',
    '\\\\evil.example/texture.png',
    '\\/evil.example/texture.png',
    'ht\ttp://evil.example/texture.png',
    'java\nscript:alert(1)',
    'h\r\nttps://evil.example/texture.png',
  ];
  for (const text of remoteForms) {
    assert.ok(findRemoteUrl({ texture: text }), `${JSON.stringify(text)} is a remote address and must be refused`);
  }
});

test('findRemoteUrl still accepts plain text that merely holds a backslash or a tab', () => {
  for (const text of ['wood\\oak', 'a\tb', 'models/crate.glb', 'C:\\notes', 'line one\nline two']) {
    assert.equal(findRemoteUrl({ note: text }), null, `${JSON.stringify(text)} is not a remote address`);
  }
});

test('addonFileFor serves a file whose folder name starts with two dots', (context) => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'addon-dots-')));
  context.after(() => rmSync(folder, { recursive: true, force: true }));
  mkdirSync(join(folder, '..lib'));
  writeFileSync(join(folder, '..lib/index.js'), 'export {};');
  assert.equal(addonFileFor([{ folder }], '/addons/0/..lib/index.js'), join(folder, '..lib', 'index.js'));
  assert.equal(addonFileFor([{ folder }], '/addons/0/../index.js'), null);
});

test('the pack index build refuses an output folder that holds the packs and keeps them', async (context) => {
  const root = mkdtempSync(join(tmpdir(), 'crucible-pack-out-'));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const packsDirectory = join(root, 'packs');
  cpSync(EXAMPLE, join(packsDirectory, 'example-starter'), { recursive: true });
  for (const outputDirectory of [packsDirectory, root, join(packsDirectory, 'example-starter')]) {
    await assert.rejects(buildPackIndex({ packsDirectory, outputDirectory }), /output|--out/i);
    assert.ok(existsSync(join(packsDirectory, 'example-starter/crucible-pack.json')), `packs survive --out ${outputDirectory}`);
  }
  assert.deepEqual(readdirSync(packsDirectory), ['example-starter']);
});
