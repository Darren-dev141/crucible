import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccessorReader } from '../src/gltf-accessors.js';

const FLOAT_TYPE = 5126;
const UNSIGNED_SHORT_TYPE = 5123;
const ACCESSOR_COUNT = 4;

const valueBytes = new Uint8Array(new Float32Array([1, 2, 3, 4]).buffer);
const indexBytes = new Uint8Array(new Uint16Array([0, 1, 2, 3]).buffer);
const combinedBytes = new Uint8Array([...valueBytes, ...indexBytes]);

function readSparse(sparse) {
  const document = {
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: valueBytes.length },
      { buffer: 0, byteOffset: valueBytes.length, byteLength: indexBytes.length },
    ],
    accessors: [{ bufferView: 0, componentType: FLOAT_TYPE, type: 'SCALAR', count: ACCESSOR_COUNT, sparse }],
  };
  return createAccessorReader(document, () => combinedBytes).readAccessor(0);
}

const indices = { bufferView: 1, componentType: UNSIGNED_SHORT_TYPE };
const values = { bufferView: 0 };

test('a sparse accessor with a whole count in range still substitutes', () => {
  assert.deepEqual([...readSparse({ count: 2, indices, values }).array], [1, 2, 3, 4]);
});

test('a fractional sparse count fails by name, not with a typed array length error', () => {
  assert.throws(() => readSparse({ count: 1.5, indices, values }), /Invalid glTF sparse.*whole count/);
});

test('a negative, zero, missing or text sparse count fails by name instead of substituting nothing', () => {
  for (const count of [-1, 0, undefined, '2']) {
    assert.throws(() => readSparse({ count, indices, values }), /Invalid glTF sparse/, `count ${count}`);
  }
});

test('a sparse count above the accessor count fails by name', () => {
  assert.throws(() => readSparse({ count: ACCESSOR_COUNT + 1, indices, values }), /Invalid glTF sparse.*from 1 to 4/);
});

test('a sparse accessor without indices or values fails by name, not with a property of undefined', () => {
  assert.throws(() => readSparse({ count: 1, values }), /Invalid glTF sparse.*indices, values/);
  assert.throws(() => readSparse({ count: 1, indices }), /Invalid glTF sparse.*indices, values/);
});

// The glTF spec asks for strictly increasing sparse indices, but files in the wild break it. three.js writes the
// values in file order, so a repeated index keeps its last value; the reader must do the same.
test('repeated or decreasing sparse indices apply in file order, so the last write wins as in three.js', () => {
  const baseBytes = new Uint8Array(new Float32Array([1, 2, 3, 4]).buffer);
  const sparseValueBytes = new Uint8Array(new Float32Array([10, 20, 30]).buffer);
  const sparseIndexBytes = new Uint8Array(new Uint16Array([2, 0, 2]).buffer);
  const bytes = new Uint8Array([...baseBytes, ...sparseValueBytes, ...sparseIndexBytes]);
  const document = {
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: baseBytes.length },
      { buffer: 0, byteOffset: baseBytes.length, byteLength: sparseValueBytes.length },
      { buffer: 0, byteOffset: baseBytes.length + sparseValueBytes.length, byteLength: sparseIndexBytes.length },
    ],
    accessors: [{ bufferView: 0, componentType: FLOAT_TYPE, type: 'SCALAR', count: ACCESSOR_COUNT,
      sparse: { count: 3, indices: { bufferView: 2, componentType: UNSIGNED_SHORT_TYPE }, values: { bufferView: 1 } } }],
  };
  assert.deepEqual([...createAccessorReader(document, () => bytes).readAccessor(0).array], [20, 2, 30, 4]);
});
