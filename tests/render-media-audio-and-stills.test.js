import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { audioTrimArguments, createFrameEncoder } from '../scripts/frame-encoder.mjs';
import { audioInputArguments, measureStreamSeconds } from '../scripts/job-audio.mjs';
import { assertOutputHasAudio, parseRenderOptions, stillPath } from '../scripts/render-media.mjs';

const ffmpegAvailable = spawnSync('ffmpeg', ['-version']).status === 0;
const SYNC_TOLERANCE_SECONDS = 0.05;

function runFfmpeg(argumentsValue) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...argumentsValue]);
  assert.equal(result.status, 0, String(result.stderr));
}

async function makeInputs(directory, fps, frameCount) {
  const sound = join(directory, 'sound.wav');
  const annexB = join(directory, 'clip.h264');
  runFfmpeg(['-f', 'lavfi', '-i', 'sine=d=3:r=48000', sound]);
  runFfmpeg(['-f', 'lavfi', '-i', `testsrc=s=64x64:r=${fps}`, '-frames:v', String(frameCount), '-c:v', 'libx264', '-bf', '0', '-f', 'h264', annexB]);
  return { sound, clip: await readFile(annexB) };
}

async function encodeWithAudio(directory, { fps, frameCount, audioCodec }) {
  const { sound, clip } = await makeInputs(directory, fps, frameCount);
  const output = join(directory, `${audioCodec}-${fps}.mp4`);
  const encoder = createFrameEncoder({ output, fps, format: 'h264', audioCodec, frameCount,
    audioArguments: audioInputArguments(sound, 0) });
  encoder.writeChunk(clip);
  await encoder.finish();
  await encoder.close();
  return output;
}

test('the audio trim pads with silence and cuts at the picture length', () => {
  assert.deepEqual(audioTrimArguments('pcm', 1), ['-af', 'apad', '-c:a', 'pcm_s16le', '-t', '1.000000']);
  assert.deepEqual(audioTrimArguments('aac', 24 / 12).slice(-2), ['-t', '2.000000']);
});

test('an encoder with audio refuses to start without a frame count', () => {
  assert.throws(() => createFrameEncoder({ output: 'x.mp4', fps: 24, format: 'h264', audioArguments: ['-i', 'a.wav'] }), /frameCount/);
});

for (const [audioCodec, fps, frameCount] of [['aac', 24, 24], ['pcm', 24, 24], ['pcm', 12, 24], ['pcm', 24, 12]]) {
  test(`${audioCodec} audio on the page-encoded H.264 copy path keeps the picture length (${frameCount} frames at ${fps} fps)`, { skip: !ffmpegAvailable }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'crucible-1284-'));
    try {
      const output = await encodeWithAudio(directory, { fps, frameCount, audioCodec });
      const audioSeconds = await measureStreamSeconds('ffmpeg', output, 'audio');
      const videoSeconds = await measureStreamSeconds('ffmpeg', output, 'video');
      assert.ok(Math.abs(audioSeconds - frameCount / fps) <= 0.011, `audio ${audioSeconds}`);
      assert.ok(Math.abs(audioSeconds - videoSeconds) <= SYNC_TOLERANCE_SECONDS, `audio ${audioSeconds} video ${videoSeconds}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('a rendered video without an audio stream fails the render', { skip: !ffmpegAvailable }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crucible-1284-'));
  try {
    const silent = join(directory, 'silent.mp4');
    runFfmpeg(['-f', 'lavfi', '-i', 'testsrc=s=64x64:r=24', '-frames:v', '24', '-pix_fmt', 'yuv420p', silent]);
    await assert.rejects(assertOutputHasAudio('ffmpeg', silent), /no audio stream/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('stills are distinct files frame-0 to frame-7 beside --output, however short the duration', () => {
  const names = Array.from({ length: 8 }, (_, index) => stillPath(join('out', 's.png'), index, 'png'));
  assert.equal(new Set(names).size, 8);
  assert.match(names[0], /frame-0\.png$/);
  assert.match(names[7], /frame-7\.png$/);
  assert.match(stillPath(join('out', 's.jpg'), 3, 'jpeg'), /frame-3\.jpg$/);
});

test('a derived video dimension is rounded to even and a passed odd one is still refused', () => {
  const derived = parseRenderOptions(['--kind', 'video', '--width', '1000']);
  assert.deepEqual([derived.width, derived.height], [1000, 562]);
  const portrait = parseRenderOptions(['--kind', 'video', '--width', '1000', '--aspect', 'portrait']);
  assert.deepEqual([portrait.width, portrait.height], [1000, 1778]);
  assert.throws(() => parseRenderOptions(['--kind', 'video', '--width', '1001', '--height', '564']), /even/);
  assert.equal(parseRenderOptions(['--kind', 'image', '--width', '1000']).height, 563);
});
