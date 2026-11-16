import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRadianceHdr } from '../src/hdri.js';

function hdrFile(width, height, pixelBytes, extraHeader = '') {
  const header = `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n${extraHeader}\n-Y ${height} +X ${width}\n`;
  return Uint8Array.from([...new TextEncoder().encode(header), ...pixelBytes]);
}

test('an old-format 1,1,1 pixel repeats the previous pixel by its exponent byte', () => {
  const parsed = parseRadianceHdr(hdrFile(4, 1, [128, 64, 0, 129, 1, 1, 1, 3]));
  assert.deepEqual(Array.from(parsed.data), [1, 0.5, 0, 1, 0.5, 0, 1, 0.5, 0, 1, 0.5, 0]);
});

test('consecutive old-format repeats shift the count up by 8 bits each', () => {
  const width = 300;
  const parsed = parseRadianceHdr(hdrFile(width, 1, [128, 128, 128, 129, 1, 1, 1, 43, 1, 1, 1, 1]));
  assert.equal(parsed.data.length, width * 3);
  assert.equal(parsed.data[0], 1);
  assert.equal(parsed.data[(width - 1) * 3], 1);
});

test('an old-format repeat with no previous pixel or past the row end is refused', () => {
  assert.throws(() => parseRadianceHdr(hdrFile(4, 1, [1, 1, 1, 2, 128, 128, 128, 129, 128, 128, 128, 129])), /repeat run is invalid/);
  assert.throws(() => parseRadianceHdr(hdrFile(2, 1, [128, 128, 128, 129, 1, 1, 1, 5])), /repeat run is invalid/);
});

test('the EXPOSURE header line leaves pixel values alone, as three.js and Blender do', () => {
  const parsed = parseRadianceHdr(hdrFile(1, 1, [128, 64, 0, 129], 'EXPOSURE=2.0\n'));
  assert.deepEqual(Array.from(parsed.data), [1, 0.5, 0]);
});
