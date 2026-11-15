import test from 'node:test';
import assert from 'node:assert/strict';
import { readImageDimensions, imageLimitProblem } from '../src/image-header.js';

const LIMITS = { maxSide: 1024, maxDecodedBytes: 64 * 1024 * 1024 };

function png(width, height) {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function jpeg(width, height) {
  const bytes = Buffer.alloc(24);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08]);
  bytes.writeUInt16BE(height, 7);
  bytes.writeUInt16BE(width, 9);
  return bytes;
}

function webpLossless(width, height) {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF', 0, 'latin1');
  bytes.writeUInt32LE(22, 4);
  bytes.write('WEBPVP8L', 8, 'latin1');
  bytes[20] = 0x2f;
  bytes.writeUInt32LE((width - 1) | ((height - 1) << 14), 21);
  return bytes;
}

test('PNG, JPEG and WebP sizes come from the header', () => {
  assert.deepEqual(readImageDimensions(png(640, 480)), { width: 640, height: 480 });
  assert.deepEqual(readImageDimensions(jpeg(300, 200)), { width: 300, height: 200 });
  assert.deepEqual(readImageDimensions(webpLossless(128, 64)), { width: 128, height: 64 });
  assert.equal(readImageDimensions(Buffer.from('not an image at all, just text')), null);
});

test('a frame over the side or the decoded byte limit is named from its header (#1313)', () => {
  assert.equal(imageLimitProblem(png(1024, 1024), 'frame', LIMITS), null);
  assert.match(imageLimitProblem(png(16000, 16000), 'frame', LIMITS), /frame is 16000x16000; frames are at most 1024 pixels on a side/);
  assert.match(imageLimitProblem(jpeg(2000, 10), 'frame', LIMITS), /2000x10/);
  assert.match(imageLimitProblem(png(1000, 1000), 'frame', { maxSide: 1024, maxDecodedBytes: 1024 * 1024 }), /decodes to more than 1 MiB/);
  assert.equal(imageLimitProblem(Buffer.from('plain'), 'frame', LIMITS), null);
});
