import test from 'node:test';
import assert from 'node:assert/strict';
import { VIEW_SIZE, cloudMask, compareFrames, describeFrame, silhouetteRoughness } from '../scripts/explosion-breakup-metrics.mjs';

// The measures behind scripts/measure-explosion-breakup.mjs (#1736), on synthetic clouds whose answer is known.

const SIZE = 160;

function cloudImage(radiusAt, softness = 2) {
  const luminance = new Float64Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x - SIZE / 2;
      const dy = y - SIZE / 2;
      const edge = radiusAt(Math.atan2(dy, dx));
      const fade = Math.min(1, Math.max(0, (edge - Math.hypot(dx, dy)) / softness + 0.5));
      luminance[y * SIZE + x] = 0.05 + 0.9 * fade;
    }
  }
  return { width: SIZE, height: SIZE, luminance };
}

test('a disc has the roughness of a disc and a ragged outline has more', () => {
  const disc = describeFrame(cloudImage(() => 40));
  const ragged = describeFrame(cloudImage(angle => 40 + 5 * Math.sin(angle * 11) + 3 * Math.sin(angle * 23 + 1)));
  assert.ok(disc.roughness > 4.3 && disc.roughness < 4.8, `disc roughness ${disc.roughness}`);
  assert.ok(ragged.roughness > disc.roughness * 1.2, `ragged ${ragged.roughness} against disc ${disc.roughness}`);
});

test('a soft edge has a wider falloff than a hard one, and scaling the picture changes neither number much', () => {
  const hard = describeFrame(cloudImage(() => 40, 1));
  const soft = describeFrame(cloudImage(() => 40, 12));
  assert.ok(soft.edgeFalloff > hard.edgeFalloff * 3, `soft ${soft.edgeFalloff} hard ${hard.edgeFalloff}`);
  const smaller = describeFrame(cloudImage(() => 25, 1));
  assert.ok(Math.abs(smaller.roughness - hard.roughness) / hard.roughness < 0.2);
});

test('a frame compared with itself has no difference, a different one has', () => {
  const frame = describeFrame(cloudImage(() => 40));
  const same = compareFrames(frame, frame);
  assert.equal(same.rmse, 0);
  assert.equal(same.histogramDistance, 0);
  assert.equal(same.roughness.ratio, 1);
  assert.ok(compareFrames(frame, describeFrame(cloudImage(() => 40, 12))).rmse > 0.01);
});

test('the mask keeps the largest piece, fills its holes and the view is a fixed size', () => {
  const image = cloudImage(() => 40);
  image.luminance[(SIZE / 2) * SIZE + SIZE / 2] = 0.05;
  image.luminance[5 * SIZE + 5] = 1;
  const mask = cloudMask(image);
  assert.equal(mask[(SIZE / 2) * SIZE + SIZE / 2], 1);
  assert.equal(mask[5 * SIZE + 5], 0);
  assert.equal(describeFrame(image).view.luminance.length, VIEW_SIZE * VIEW_SIZE);
  assert.ok(silhouetteRoughness(new Uint8Array(4).fill(1), 2, 2) === 8 / 2);
});
