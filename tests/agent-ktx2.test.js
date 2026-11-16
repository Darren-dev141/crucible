import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mat4 } from 'gl-matrix';
import { box } from '../src/geometry.js';
import { exportGlb } from '../src/export.js';
import { createAgentAssetCatalog } from '../scripts/agent-asset-catalog.mjs';
import { padded, readGlb, writeGlb } from '../scripts/agent-glb-io.mjs';
import { KTX2_EXTENSION, KTX2_MISSING_ADVICE, encodeRgbaPng, transcodeKtx2Glb, usesKtx2 } from '../scripts/agent-ktx2.mjs';

const execFileAsync = promisify(execFile);
const FIXTURES = new URL('./fixtures/ktx2/', import.meta.url);
const WITHOUT_TRANSCODER_SCRIPT = new URL('./fixtures/ktx2/catalog-without-transcoder.mjs', import.meta.url);

// Both fixtures are 40x40 test images from the three.js examples (MIT): one ETC1S and one UASTC.
const KTX2_FIXTURES = [
  { name: '2d_etc1s.ktx2', firstPixel: [181, 148, 16, 255] },
  { name: '2d_uastc.ktx2', firstPixel: [186, 151, 0, 255] },
];

async function texturedBoxGlb(ktx2Name) {
  const ktx2 = await readFile(new URL(ktx2Name, FIXTURES));
  const plain = Buffer.from(exportGlb([{ name: 'Cube', geometry: box(0), matrix: mat4.create(), material: { color: [1, 1, 1], roughness: 0.5, metallic: 0 } }]));
  const { document, binary } = readGlb(plain);
  const start = padded(binary, 0).length;
  document.bufferViews.push({ buffer: 0, byteOffset: start, byteLength: ktx2.length });
  document.images = [{ bufferView: document.bufferViews.length - 1, mimeType: 'image/ktx2' }];
  document.textures = [{ extensions: { [KTX2_EXTENSION]: { source: 0 } } }];
  document.materials[0].pbrMetallicRoughness.baseColorTexture = { index: 0 };
  document.extensionsUsed = [KTX2_EXTENSION];
  document.extensionsRequired = [KTX2_EXTENSION];
  const body = padded(Buffer.concat([padded(binary, 0), ktx2]), 0);
  document.buffers[0].byteLength = body.length;
  return writeGlb(document, body);
}

function decodePng(png) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  assert.equal(png[24], 8);
  assert.equal(png[25], 6);
  let offset = 8;
  const compressed = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    if (type === 'IDAT') compressed.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const scanlines = inflateSync(Buffer.concat(compressed));
  const rowBytes = width * 4;
  const pixels = Buffer.alloc(rowBytes * height);
  for (let row = 0; row < height; row++) scanlines.copy(pixels, row * rowBytes, row * (rowBytes + 1) + 1, (row + 1) * (rowBytes + 1));
  return { width, height, pixels };
}

function imagePng(glb) {
  const { document, binary } = readGlb(glb);
  const view = document.bufferViews[document.images[0].bufferView];
  return { document, png: binary.subarray(view.byteOffset, view.byteOffset + view.byteLength) };
}

async function catalogFolder(context, files) {
  const directory = await mkdtemp(join(tmpdir(), 'crucible-ktx2-'));
  context.after(async () => {
    assert.equal(dirname(directory), tmpdir());
    await rm(directory, { recursive: true, force: true });
  });
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(directory, name), bytes);
  return directory;
}

for (const { name, firstPixel } of KTX2_FIXTURES) {
  test(`a GLB with a ${name} texture becomes a plain GLB with a PNG image and no extension`, async () => {
    const source = await texturedBoxGlb(name);
    assert.equal(usesKtx2(readGlb(source).document), true);
    const result = await transcodeKtx2Glb(source, { filename: 'lamp.glb' });
    assert.equal(result.images, 1);
    const { document, png } = imagePng(result.bytes);
    assert.equal(usesKtx2(document), false);
    assert.equal(document.extensionsUsed, undefined);
    assert.equal(document.extensionsRequired, undefined);
    assert.equal(document.images[0].mimeType, 'image/png');
    assert.equal(document.textures[0].source, 0);
    assert.equal(document.textures[0].extensions, undefined);
    const decoded = decodePng(png);
    assert.equal(decoded.width, 40);
    assert.equal(decoded.height, 40);
    assert.deepEqual([...decoded.pixels.subarray(0, 4)], firstPixel);
  });
}

test('the PNG writer round-trips RGBA pixels', () => {
  const pixels = Uint8Array.from({ length: 2 * 3 * 4 }, (unused, index) => index * 9);
  const decoded = decodePng(encodeRgbaPng(2, 3, pixels));
  assert.deepEqual([decoded.width, decoded.height], [2, 3]);
  assert.deepEqual([...decoded.pixels], [...pixels]);
});

test('the catalog lists a KTX2 GLB and hands the preview page a transcoded file', async context => {
  const directory = await catalogFolder(context, { 'lamp.glb': await texturedBoxGlb('2d_uastc.ktx2') });
  const catalog = await createAgentAssetCatalog(directory);
  const listed = catalog.list();
  assert.equal(listed.skipped, undefined);
  assert.equal(listed.assets.length, 1);
  assert.equal(listed.assets[0].images, 1);
  const read = await catalog.read(listed.assets[0].assetId);
  assert.equal(usesKtx2(readGlb(read).document), false);
  assert.equal(await catalog.size(listed.assets[0].assetId), read.length);
});

test('a damaged KTX2 image is skipped with the reason instead of failing the catalog', async context => {
  const damaged = await texturedBoxGlb('2d_uastc.ktx2');
  const { document, binary } = readGlb(damaged);
  const view = document.bufferViews[document.images[0].bufferView];
  const body = Buffer.from(binary);
  body.fill(0x7f, view.byteOffset + 12, view.byteOffset + 80);
  const directory = await catalogFolder(context, { 'damaged.glb': writeGlb(document, body) });
  const listed = (await createAgentAssetCatalog(directory)).list();
  assert.equal(listed.assets.length, 0);
  assert.match(listed.skipped[0].reason, /^damaged\.glb: .*KTX2/);
});

test('an image that is not KTX2 is refused with the texture named', async () => {
  const source = await texturedBoxGlb('2d_uastc.ktx2');
  const { document, binary } = readGlb(source);
  const body = Buffer.from(binary);
  body.fill(0, document.bufferViews[document.images[0].bufferView].byteOffset, document.bufferViews[document.images[0].bufferView].byteOffset + 4);
  await assert.rejects(transcodeKtx2Glb(writeGlb(document, body), { filename: 'lamp.glb' }), /lamp\.glb texture 0: image 0 is not a KTX2 file/);
});

test('without the transcoder the catalog skips the file and says to install three or re-export', async context => {
  const directory = await catalogFolder(context, { 'lamp.glb': await texturedBoxGlb('2d_uastc.ktx2') });
  const { stdout } = await execFileAsync(process.execPath, [WITHOUT_TRANSCODER_SCRIPT.pathname.replace(/^\/([A-Za-z]:)/, '$1'), directory]);
  const listed = JSON.parse(stdout);
  assert.equal(listed.assets.length, 0);
  assert.equal(listed.skipped.length, 1);
  assert.match(listed.skipped[0].reason, /^lamp\.glb: .*Basis transcoder is not installed/);
  assert.ok(listed.skipped[0].reason.includes(KTX2_MISSING_ADVICE));
  assert.match(KTX2_MISSING_ADVICE, /npm install three.*instead of KTX2/);
});
