import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPack } from '../scripts/agent-packs.mjs';
import { validatePackScene } from '../scripts/pack-scene-validator.mjs';
import packageMetadata from '../package.json' with { type: 'json' };

const EXAMPLE = new URL('../packs/example-starter', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

function pngWithDeclaredSize(width, height) {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'latin1');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header[24] = 8;
  return header;
}

function installPack(context, change) {
  const parent = mkdtempSync(join(tmpdir(), 'crucible-pack-limits-'));
  context.after(() => rmSync(parent, { recursive: true, force: true }));
  const folder = join(parent, 'limited');
  cpSync(EXAMPLE, folder, { recursive: true });
  const manifestPath = join(folder, 'crucible-pack.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  change(manifest, folder);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return folder;
}

function load(folder) {
  return loadPack(folder, { packageVersion: packageMetadata.version, label: 'limited', validateScene: validatePackScene });
}

test('a recipe preview larger than a sequence frame still loads (#1313)', async context => {
  const folder = installPack(context, (manifest, root) => {
    writeFileSync(join(root, manifest.contents.recipes[0].preview), pngWithDeclaredSize(1920, 1080));
  });
  const pack = await load(folder);
  assert.equal(pack.items.recipes[0].preview, 'previews/crates.png');
});

test('a content image over the frame limit refuses the pack (#1313)', async context => {
  const folder = installPack(context, (manifest, root) => {
    mkdirSync(join(root, 'models'));
    writeFileSync(join(root, 'models/wide.png'), pngWithDeclaredSize(1920, 1080));
    manifest.contents.images = [{ id: 'wide', file: 'models/wide.png' }];
  });
  await assert.rejects(() => load(folder), /pack "limited" models\/wide\.png: got "contents\.images\[0\]\.file/);
});
