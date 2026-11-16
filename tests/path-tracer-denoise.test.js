import assert from 'node:assert/strict';
import test from 'node:test';
import { denoiseRadiance } from '../src/path-tracer-denoise.js';

function buildBuffers(width, height, backgroundRows) {
  const pixelCount = width * height;
  const color = new Float32Array(pixelCount * 3);
  const albedo = new Float32Array(pixelCount * 3).fill(0.5);
  const normal = new Float32Array(pixelCount * 3);
  const depth = new Float32Array(pixelCount);
  const variance = new Float32Array(pixelCount).fill(0.01);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const isBackground = Math.floor(pixel / width) < backgroundRows;
    const value = 0.2 + 0.1 * ((pixel * 7) % 5);
    color.fill(value, pixel * 3, pixel * 3 + 3);
    if (isBackground) continue;
    normal[pixel * 3 + 1] = 1;
    depth[pixel] = 5;
  }
  return { width, height, color, albedo, normal, depth, variance };
}

test('wavelet filter keeps every pixel finite when background pixels have zero normal and depth', () => {
  const buffers = buildBuffers(16, 16, 6);
  const result = denoiseRadiance(buffers);
  assert.equal(result.length, buffers.color.length);
  for (let index = 0; index < result.length; index++) {
    assert.ok(Number.isFinite(result[index]), `output ${index} is ${result[index]}`);
  }
});

test('wavelet filter leaves a background pixel at its input colour', () => {
  const buffers = buildBuffers(16, 16, 6);
  const result = denoiseRadiance(buffers);
  for (let channel = 0; channel < 3; channel++) {
    assert.ok(Math.abs(result[channel] - buffers.color[channel]) < 1e-5);
  }
});

// Issue #1335: on a flat wall the filter left blotchy grain because each pixel's own noisy value decided how much light it took
// from its neighbours. A seeded flat plane with known light measures that: the error against the true light, and a shadow edge on
// the same plane that the filter must keep.
function seededNoise(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return (state / 4294967296 - 0.5) * 2;
  };
}

function flatPlane({ width, height, lightAt, noiseAmount }) {
  const pixelCount = width * height;
  const nextNoise = seededNoise(7);
  const truth = new Float32Array(pixelCount * 3);
  const color = new Float32Array(pixelCount * 3);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const light = lightAt(pixel % width);
    truth.fill(light, pixel * 3, pixel * 3 + 3);
    color.fill(Math.max(0, light + noiseAmount * nextNoise()), pixel * 3, pixel * 3 + 3);
  }
  const normal = new Float32Array(pixelCount * 3);
  for (let pixel = 0; pixel < pixelCount; pixel++) normal[pixel * 3 + 2] = 1;
  const albedo = new Float32Array(pixelCount * 3).fill(1);
  const depth = new Float32Array(pixelCount).fill(4);
  // A uniform noise of amplitude a has variance a squared over 3; the tracer reports the variance of the mean, so the sample count divides it.
  const variance = new Float32Array(pixelCount).fill((noiseAmount * noiseAmount) / 3 / 64);
  return { buffers: { width, height, color, albedo, normal, depth, variance }, truth };
}

function rootMeanSquareError(result, truth, columnRange = [0, Infinity], width = 32) {
  let sum = 0;
  let count = 0;
  for (let pixel = 0; pixel < truth.length / 3; pixel++) {
    const column = pixel % width;
    if (column < columnRange[0] || column >= columnRange[1]) continue;
    sum += (result[pixel * 3] - truth[pixel * 3]) ** 2;
    count++;
  }
  return Math.sqrt(sum / count);
}

test('wavelet filter takes a flat noisy wall to within 0.08 of its true light (the filter before #1335 left 0.16)', () => {
  const { buffers, truth } = flatPlane({ width: 32, height: 32, lightAt: () => 0.5, noiseAmount: 0.3 });
  const error = rootMeanSquareError(denoiseRadiance(buffers), truth);
  assert.ok(error < 0.08, `error ${error}`);
});

test('wavelet filter keeps a shadow edge on one surface sharp while it smooths both sides', () => {
  const { buffers, truth } = flatPlane({ width: 32, height: 32, lightAt: column => (column < 16 ? 0.2 : 0.8), noiseAmount: 0.1 });
  const result = denoiseRadiance(buffers);
  const row = 16;
  const justLeft = result[(row * 32 + 14) * 3];
  const justRight = result[(row * 32 + 17) * 3];
  assert.ok(justLeft < 0.3, `left of the edge ${justLeft}`);
  assert.ok(justRight > 0.7, `right of the edge ${justRight}`);
  assert.ok(rootMeanSquareError(result, truth, [0, 12]) < 0.03);
  assert.ok(rootMeanSquareError(result, truth, [20, 32]) < 0.03);
});
