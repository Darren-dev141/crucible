import assert from 'node:assert/strict';
import test from 'node:test';
import { attributeFloats, attributeFloatsInSlices, createAccessorReader } from '../src/gltf-accessors.js';

const FLOAT_TYPE = 5126;
const UNSIGNED_INT_TYPE = 5125;

function readerFor(accessor, bytes) {
  const document = {
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bytes.length }],
    accessors: [{ bufferView: 0, componentType: FLOAT_TYPE, type: 'VEC3', ...accessor }],
  };
  return createAccessorReader(document, () => bytes);
}

function sequentialBytes() {
  return new Uint8Array(64).map((_, index) => index);
}

test('an accessor with a negative byteOffset fails by name instead of reading from the end of the view', () => {
  const reader = readerFor({ byteOffset: -12, count: 1 }, sequentialBytes());
  assert.throws(() => reader.readAccessor(0), /byteOffset -12.*non-negative integer/);
});

test('an accessor with a fractional byteOffset fails by name', () => {
  const reader = readerFor({ byteOffset: 1.5, count: 1 }, sequentialBytes());
  assert.throws(() => reader.readAccessor(0), /byteOffset 1\.5/);
});

test('sparse indices with a negative byteOffset fail by name', () => {
  const bytes = sequentialBytes();
  const document = {
    bufferViews: [{ buffer: 0, byteLength: bytes.length }],
    accessors: [{
      bufferView: 0, componentType: FLOAT_TYPE, type: 'SCALAR', count: 4,
      sparse: { count: 1, indices: { bufferView: 0, byteOffset: -4, componentType: UNSIGNED_INT_TYPE }, values: { bufferView: 0, byteOffset: 0 } },
    }],
  };
  const reader = createAccessorReader(document, () => bytes);
  assert.throws(() => reader.readAccessor(0), /byteOffset -4/);
});

test('a normalized flag on a float accessor leaves the values unchanged', async () => {
  const bytes = new Uint8Array(new Float32Array([1, 2, 3]).buffer);
  const attribute = readerFor({ normalized: true, count: 1 }, bytes).readAccessor(0);
  assert.deepEqual([...attributeFloats(attribute)], [1, 2, 3]);
  assert.deepEqual([...await attributeFloatsInSlices(attribute, async () => {})], [1, 2, 3]);
});

test('a normalized flag on a 32-bit integer accessor leaves the values unchanged', () => {
  const bytes = new Uint8Array(new Uint32Array([7, 8, 9]).buffer);
  const attribute = readerFor({ normalized: true, componentType: UNSIGNED_INT_TYPE, count: 1 }, bytes).readAccessor(0);
  assert.deepEqual([...attributeFloats(attribute)], [7, 8, 9]);
});
