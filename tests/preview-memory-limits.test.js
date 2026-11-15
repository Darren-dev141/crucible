import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { previewHarness } from './support/preview-harness.mjs';
import { MAXIMUM_MEMORY_MIB } from '../src/agent-scene-capabilities.js';

function recipe() {
  return { format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'cube', type: 'box', bevel: 0 }],
    materials: [{ id: 'paint', color: [0.4, 0.5, 0.6] }],
    nodes: [{ id: 'cube', geometry: 'cube', material: 'paint' }] };
}

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

test('a 16000x16000 sequence frame is refused from its header and never reaches createImageBitmap (#1313)', async () => {
  let decodeCalls = 0;
  const harness = previewHarness({ createImageBitmap: async () => { decodeCalls++; return { width: 1, height: 1, close() {} }; } });
  const sequenceData = { [`${'a'.repeat(64)}`]: pngWithDeclaredSize(16000, 16000).toString('base64') };
  await assert.rejects(
    () => harness.preview.createWithAssets({ recipe: recipe(), sessionId: 'oversized-frame', backend: 'cpu', memoryBudgetMiB: 192, assetData: {}, sequenceData }),
    /Sequence frame aaaaaaaaaaaa is 16000x16000.*at most 1024 pixels/s,
  );
  assert.equal(decodeCalls, 0);
});

test('the preview hands the runtime memory ceiling to its renderer (#1313)', () => {
  const harness = previewHarness();
  harness.preview.create({ recipe: recipe(), sessionId: 'ceiling', backend: 'cpu', memoryBudgetMiB: 192 });
  assert.equal(harness.rendererOptions.length > 0, true);
  for (const options of harness.rendererOptions) assert.equal(options.maximumMemoryBudgetMiB, MAXIMUM_MEMORY_MIB);
});
