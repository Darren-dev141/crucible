import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeVolumeGrid, encodeVolumeGrid } from '../src/volume-grid.js';

function gridBytesWithHeader(headerText) {
  const headerBytes = Math.ceil(headerText.length / 4) * 4;
  const bytes = new Uint8Array(12 + headerBytes);
  bytes.set([0x36, 0x37, 0x56, 0x47], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 1, true);
  view.setUint32(8, headerBytes, true);
  bytes.set(new TextEncoder().encode(headerText.padEnd(headerBytes, ' ')), 12);
  return bytes;
}

test('encodeVolumeGrid refuses a channel name a grid file cannot hold', () => {
  const density = new Float32Array(1);
  assert.throws(() => encodeVolumeGrid({ resolution: [1, 1, 1], channels: { density, smoke: density } }), /smoke/);
});

test('encodeVolumeGrid refuses a size decodeVolumeGrid would reject', () => {
  const density = new Float32Array(1);
  assert.throws(() => encodeVolumeGrid({ resolution: [1, 1, 1], channels: { density }, size: [1, -2, 3] }), /size/);
  assert.throws(() => encodeVolumeGrid({ resolution: [1, 1, 1], channels: { density }, size: [1, NaN, 3] }), /size/);
});

test('decodeVolumeGrid names the header when it is JSON but not an object', () => {
  for (const text of ['null', '7', '"x"']) {
    assert.throws(() => decodeVolumeGrid(gridBytesWithHeader(text), 'g'), /g header must be a JSON object/);
  }
});

test('answerKernelRequest refuses a name that is not a kernel, including Object.prototype names', async () => {
  const { answerKernelRequest } = await import('../src/kernel-registry.js');
  for (const name of ['nope', 'toString', 'constructor', '__proto__', 'hasOwnProperty']) {
    const { response } = answerKernelRequest({ name, args: [] });
    assert.match(response.error?.message ?? '', /unknown kernel/, name);
  }
});
