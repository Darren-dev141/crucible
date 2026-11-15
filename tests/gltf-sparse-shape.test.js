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
