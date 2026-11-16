// PNG encoding for native film frames (issue 1123). src/export-png.js is portable JavaScript that runs in the page too, so its CRC and
// Adler sums loop per byte: about 40 ms at 1080p. A film frame is encoded in Node, where zlib does both sums natively and the
// row copy is the only JavaScript left. The picture is the same: opaque RGB, filter 0, stored (uncompressed) blocks.
import { crc32, deflateSync } from 'node:zlib';
import { PNG_SIGNATURE, encodePng } from '../src/export-png.js';

function chunkWithNativeCrc(type, data) {
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  output.write(type, 4, 'latin1');
  output.set(data, 8);
  output.writeUInt32BE(crc32(output.subarray(4, 8 + data.length)), 8 + data.length);
  return output;
}

/**
 * @param {Uint8Array|Uint8ClampedArray} rgba Opaque 8-bit RGBA pixels, rows from the top (alpha is not read).
 * @returns {Uint8Array} An RGB PNG. Node without `zlib.crc32` (before 22.2) falls back to the portable encoder.
 */
export function encodeOpaquePng(rgba, width, height) {
  if (typeof crc32 !== 'function') return encodePng(rgba, width, height);
  const rowBytes = width * 3;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let row = 0; row < height; row++) {
    let target = row * (rowBytes + 1) + 1;
    let source = row * width * 4;
    for (let column = 0; column < width; column++) {
      raw[target++] = rgba[source];
      raw[target++] = rgba[source + 1];
      raw[target++] = rgba[source + 2];
      source += 4;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([Buffer.from(PNG_SIGNATURE), chunkWithNativeCrc('IHDR', header), chunkWithNativeCrc('IDAT', deflateSync(raw, { level: 0 })),
    chunkWithNativeCrc('IEND', Buffer.alloc(0))]);
}
