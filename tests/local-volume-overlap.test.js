// Overlapping box and sphere volumes in the CPU path tracer (issue 1722): volumes that share a stretch of the ray are marched together, so the
// glow and the dimming add per step. The rasterizer does the same (tests/local-volume-overlap-raster.test.js and tests/local-volume-compile-cost.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLocalVolumes } from '../src/local-volumes.js';
import { createLocalVolumeCrossing } from '../src/path-tracer-volume.js';

const BASE = { shape: 'box', falloff: 0, absorption: [1, 1, 1], emissionStrength: 1, steps: 32, size: [4, 4, 2] };
const NEAR = { ...BASE, center: [0, 0, 1], density: 1.2, emission: [1, 0.5, 0.25] };
const FAR = { ...BASE, center: [0, 0, 0], density: 0.8, emission: [0.2, 0.6, 1] };

// Looks down -z from z = 5, so the near box spans distances 3 to 5 along the ray and the far box 4 to 6.
function cross(volumes, jitter = 0.5, startingThroughput = [1, 1, 1]) {
  const crossing = createLocalVolumeCrossing(resolveLocalVolumes(volumes, 'volumes'));
  const throughput = Float64Array.from(startingThroughput);
  const emitted = new Float64Array(3);
  crossing(0, 0, 5, 0, 0, -1, 1e9, jitter, throughput, emitted);
  return { throughput: Array.from(throughput), emitted: Array.from(emitted) };
}

function slab(volume, length) {
  return { length, extinction: volume.absorption.map(channel => channel * volume.density), glow: volume.emission.map(channel => channel * volume.emissionStrength) };
}

function stretchLight(stretches) {
  const radiance = [0, 0, 0];
  const transmittance = [1, 1, 1];
  for (const { length, extinction, glow } of stretches) {
    for (let channel = 0; channel < 3; channel++) {
      const factor = Math.exp(-extinction[channel] * length);
      radiance[channel] += transmittance[channel] * glow[channel] * (1 - factor) / extinction[channel];
      transmittance[channel] *= factor;
    }
  }
  return { radiance, transmittance };
}

function assertClose(actual, expected, tolerance, what) {
  for (let channel = 0; channel < 3; channel++) assert.ok(Math.abs(actual[channel] - expected[channel]) <= tolerance, `${what}, channel ${channel}: got ${actual[channel]}, expected ${expected[channel]}`);
}

test('two boxes that overlap by half add their glow and dimming along the shared stretch', () => {
  const [near, far] = resolveLocalVolumes([NEAR, FAR], 'volumes');
  const both = { length: 1, extinction: slab(near, 1).extinction.map((channel, index) => channel + slab(far, 1).extinction[index]), glow: slab(near, 1).glow.map((channel, index) => channel + slab(far, 1).glow[index]) };
  const expected = stretchLight([slab(near, 1), both, slab(far, 1)]);
  const crossed = cross([NEAR, FAR]);
  assertClose(crossed.emitted, expected.radiance, 0.03, 'glow');
  assertClose(crossed.throughput, expected.transmittance, 0.01, 'transmittance');
  const oneAfterTheOther = stretchLight([slab(near, 2), slab(far, 2)]);
  assert.ok(Math.abs(crossed.emitted[2] - expected.radiance[2]) < Math.abs(crossed.emitted[2] - oneAfterTheOther.radiance[2]), 'closer to the volumes marched together than to one after the other');
});

test('the order the volumes are listed in does not change the picture', () => {
  const forward = cross([NEAR, FAR]);
  const backward = cross([FAR, NEAR]);
  assertClose(backward.emitted, forward.emitted, 0.02, 'glow');
  assertClose(backward.throughput, forward.throughput, 0.005, 'transmittance');
});

test('volumes with a gap between them, and a volume alone, march exactly as one after the other', () => {
  const separate = { ...FAR, center: [0, 0, -2] };
  const first = cross([NEAR]);
  const second = cross([separate], 0.5, first.throughput);
  const together = cross([NEAR, separate]);
  assertClose(together.emitted, first.emitted.map((channel, index) => channel + second.emitted[index]), 1e-12, 'glow');
  assertClose(together.throughput, second.throughput, 1e-12, 'transmittance');
  assertClose(first.emitted, stretchLight([slab(resolveLocalVolumes([NEAR], 'volumes')[0], 2)]).radiance, 0.06, 'one volume against the closed form');
});

test('a sphere that overlaps a box is marched together with it and dims the light behind both', () => {
  const sphere = { shape: 'sphere', center: [0, 0, 0.5], radius: 1.2, falloff: 0.5, density: 1, absorption: [1, 1, 1], emission: [0.5, 0.5, 0.5], emissionStrength: 1, steps: 32 };
  const crossed = cross([NEAR, sphere]);
  const alone = cross([NEAR]);
  assert.notDeepEqual(crossed.emitted, alone.emitted, 'the sphere changes the glow');
  assert.ok(crossed.throughput.every((channel, index) => channel < alone.throughput[index]), 'the sphere adds dimming');
});

test('three volumes that overlap all march and none is dropped', () => {
  const third = { ...FAR, center: [0, 0, 0.5], density: 0.5, emission: [0.4, 0.4, 0.4] };
  const crossed = cross([NEAR, FAR, third]);
  const pair = cross([NEAR, FAR]);
  assert.ok(crossed.emitted.every((channel, index) => channel > pair.emitted[index]));
  assert.ok(crossed.throughput.every((channel, index) => channel < pair.throughput[index]));
});
