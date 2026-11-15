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
  assert.match(imageLimitProblem(Buffer.from('plain'), 'frame', LIMITS), /frame has no readable size.*1024 pixel.*64 MiB/);
});

function jpegFromSegments(segments) {
  return Buffer.concat([Buffer.from([0xff, 0xd8]), ...segments, Buffer.from([0xff, 0xda, 0x00, 0x02])]);
}

function segment(marker, payload) {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

function frameSegment(marker, width, height) {
  const payload = Buffer.alloc(15);
  payload[0] = 8;
  payload.writeUInt16BE(height, 1);
  payload.writeUInt16BE(width, 3);
  return segment(marker, payload);
}

test('a JPEG size is found past standalone markers and metadata segments (#1319)', () => {
  const restart = Buffer.from([0xff, 0xd0, 0xff, 0xd7, 0xff, 0x01, 0xff, 0xff, 0xff, 0xd8]);
  assert.deepEqual(readImageDimensions(jpegFromSegments([restart, frameSegment(0xc0, 16000, 16000)])), { width: 16000, height: 16000 });
  assert.match(imageLimitProblem(jpegFromSegments([restart, frameSegment(0xc0, 16000, 16000)]), 'frame', LIMITS), /16000x16000/);
  const exif = segment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), Buffer.alloc(40)]));
  const icc = segment(0xe2, Buffer.concat([Buffer.from('ICC_PROFILE\0', 'latin1'), Buffer.alloc(100)]));
  assert.deepEqual(readImageDimensions(jpegFromSegments([exif, icc, frameSegment(0xc0, 640, 480)])), { width: 640, height: 480 });
  assert.deepEqual(readImageDimensions(jpegFromSegments([exif, frameSegment(0xc2, 800, 600), icc])), { width: 800, height: 600 });
  assert.equal(imageLimitProblem(jpegFromSegments([exif, icc, frameSegment(0xc0, 640, 480)]), 'frame', LIMITS), null);
});
