import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeJobSettings } from '../scripts/agent-render-jobs.mjs';
import { assertAudioCoversVideo, audioInputArguments, formatSeekSeconds } from '../scripts/job-audio.mjs';
import { videoFrameCount } from '../src/film-timeline.js';

function timelineRecipe(shotSeconds) {
  return { format: 'crucible.scene', timeline: { shots: shotSeconds.map((duration, index) => ({ name: `shot${index}`, duration })) } };
}

function timelineFrameCount(shotSeconds, fps) {
  const settings = normalizeJobSettings({ kind: 'video', width: 64, height: 64, fps, timeline: {} }, [], timelineRecipe(shotSeconds));
  return settings.frameCount;
}

test('the frame count is the exact ceil, with float-noise sums included', () => {
  // 0.8 s at 24 fps is 19.2 frames, so 20 is right: the issue text expecting 19 was a miscount.
  assert.equal(timelineFrameCount([0.5, 0.3], 24), 20);
  assert.equal(timelineFrameCount([0.5, 0.6], 24), 27);
  assert.equal(timelineFrameCount([0.5, 1.3], 24), 44);
  assert.equal(timelineFrameCount([0.1, 0.2], 10), 3);
  assert.equal(timelineFrameCount([0.2, 0.4], 25), 15);
  assert.equal(timelineFrameCount([0.7, 0.1], 10), 8);
});

test('no two-shot timeline gains a duplicate frame from float noise', () => {
  const mismatches = [];
  for (const fps of [24, 30]) {
    for (let firstHundredths = 20; firstHundredths <= 300; firstHundredths += 1) {
      for (let secondHundredths = 20; secondHundredths <= 300; secondHundredths += 1) {
        const expected = Math.ceil(fps * (firstHundredths + secondHundredths) / 100);
        const actual = videoFrameCount(fps, firstHundredths / 100 + secondHundredths / 100);
        if (actual !== expected) mismatches.push({ fps, firstHundredths, secondHundredths, actual, expected });
      }
    }
  }
  assert.deepEqual(mismatches, []);
  assert.equal(videoFrameCount(24, 0.8), 20);
  assert.equal(videoFrameCount(24, 0.81), 20);
});

test('an offset below one microsecond reaches ffmpeg as a plain decimal', () => {
  assert.equal(formatSeekSeconds(1e-7), '0.000000');
  assert.equal(formatSeekSeconds(1.5), '1.500000');
  const seekValue = audioInputArguments('t.wav', 1e-7)[3];
  assert.doesNotMatch(seekValue, /e/i);
  const settings = normalizeJobSettings({ kind: 'video', width: 64, height: 64, audio: { file: 'a.wav', offset: 1e-7 } }, [], null);
  assert.equal(settings.audio.offset, 1e-7);
});

test('audio shorter than the video after its offset is refused up front', () => {
  assert.throws(() => assertAudioCoversVideo(3, 0, 5), /Audio has 3\.00 s after its offset but the video lasts 5\.00 s/);
  assert.throws(() => assertAudioCoversVideo(5, 2, 5), RangeError);
  assert.equal(assertAudioCoversVideo(5, 0, 5), 5);
  assert.equal(assertAudioCoversVideo(4.97, 0, 5), 4.97);
});

test('render-media measures the audio before it starts the encoder', async () => {
  const source = await readFile(new URL('../scripts/render-media.mjs', import.meta.url), 'utf8');
  const measureAt = source.indexOf('assertAudioCoversVideo(');
  const encoderAt = source.indexOf('createFrameEncoder({ executable');
  assert.ok(measureAt > 0 && encoderAt > 0 && measureAt < encoderAt, 'the audio check must run before the encoder starts');
});
