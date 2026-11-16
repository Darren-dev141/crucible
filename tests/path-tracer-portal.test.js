// Light portals in the CPU path tracer (#1144): the sky is sampled through the window of a room, with the pdf Cook uses.
import assert from 'node:assert/strict';
import test from 'node:test';

import { box } from '../src/geometry.js';
import { createEnvironmentMap } from '../src/environment.js';
import { createCamera, describeIgnoredFeatures, renderBand } from '../src/path-tracer.js';
import { buildTraceScene } from '../src/path-tracer-scene.js';
import { portalPdf, samplePortalDirection } from '../src/path-tracer-portal.js';

function slab(centerX, centerY, centerZ, sizeX, sizeY, sizeZ) {
  const matrix = new Float32Array([sizeX, 0, 0, 0, 0, sizeY, 0, 0, 0, 0, sizeZ, 0, centerX, centerY, centerZ, 1]);
  return { name: 'wall', geometry: box(0, 1), matrix, material: { color: [0.35, 0.35, 0.35] } };
}

// The room of the native portal tests: 4 wide, 3 high and 4 deep, a window 2 wide and 1 high in its west wall, closed on top.
function roomParts() {
  return [
    slab(0, -0.1, 0, 4.8, 0.2, 4.8),
    slab(0, 0, -2.1, 4.8, 6, 0.2),
    slab(0, 0, 2.1, 4.8, 6, 0.2),
    slab(2.1, 0, 0, 0.2, 6, 4.8),
    slab(-2.1, 0.5, 0, 0.2, 1, 4),
    slab(-2.1, 2.5, 0, 0.2, 1, 4),
    slab(-2.1, 1.5, -1.5, 0.2, 1, 1),
    slab(-2.1, 1.5, 1.5, 0.2, 1, 1),
    slab(0, 3.1, 0, 4.8, 0.2, 4.8),
  ];
}

function skyMap() {
  const width = 32;
  const height = 16;
  const data = new Float32Array(width * height * 3);
  for (let row = 0; row < height; row++) {
    const radiance = row < height / 2 ? 4 : 0.5;
    for (let column = 0; column < width; column++) data.fill(radiance, (row * width + column) * 3, (row * width + column) * 3 + 3);
  }
  return createEnvironmentMap({ width, height, data, intensity: 1 });
}

const WINDOW_PORTAL = { position: [-2, 1.5, 0], direction: [1, 0, 0], up: [0, 1, 0], width: 2, height: 1, portal: true };
const WALL_CAMERA = { eye: [-1.4, 1.3, 1.2], target: [2, 1, -0.5], fov: 70 };
const SEEDS = [1, 2, 3, 4];

function sceneOf(withPortal) {
  return buildTraceScene(roomParts(), { map: skyMap(), areaLights: withPortal ? [WINDOW_PORTAL] : [] });
}

function render(scene, { samples, seed, width = 24, height = 16 }) {
  const view = createCamera(WALL_CAMERA, width, height);
  return renderBand(scene, view, { width, height, samples, bounces: 8, seed, threads: 1, noiseThreshold: 0, minSamples: samples }, 0, height, () => {}).color;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function meanSeedDifference(frames) {
  let total = 0;
  let count = 0;
  for (let first = 0; first < frames.length; first++) {
    for (let second = first + 1; second < frames.length; second++) {
      for (let index = 0; index < frames[first].length; index++) {
        total += Math.abs(frames[first][index] - frames[second][index]);
        count++;
      }
    }
  }
  return total / count;
}

const PORTAL = { position: [0, 0, 0], normal: [1, 0, 0], across: [0, 1, 0], along: [0, 0, 1], width: 2, height: 1 };

test('the portal pdf of a drawn direction is positive, and 1 over it averages to the solid angle of the opening', () => {
  const point = [2, 0.2, 0.1];
  const out = [0, 0, 0];
  let inverseSum = 0;
  const draws = 40000;
  let state = 12345;
  const unit = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  for (let draw = 0; draw < draws; draw++) {
    const pdf = samplePortalDirection([PORTAL], point[0], point[1], point[2], unit(), unit(), unit(), out);
    assert.ok(pdf > 0);
    inverseSum += 1 / pdf;
  }
  let hits = 0;
  const probes = 400000;
  for (let probe = 0; probe < probes; probe++) {
    const height = 2 * unit() - 1;
    const angle = 2 * Math.PI * unit();
    const radius = Math.sqrt(1 - height * height);
    if (portalPdf([PORTAL], point[0], point[1], point[2], radius * Math.cos(angle), height, radius * Math.sin(angle)) > 0) hits++;
  }
  const solidAngle = hits / probes * 4 * Math.PI;
  assert.ok(Math.abs(inverseSum / draws / solidAngle - 1) < 0.03, `${inverseSum / draws} against ${solidAngle}`);
});

test('a point behind the portal, outside the room, draws nothing and a ray away from it has no pdf', () => {
  const out = [0, 0, 0];
  assert.equal(samplePortalDirection([PORTAL], -3, 0, 0, 0.5, 0.5, 0.5, out), 0);
  assert.equal(portalPdf([PORTAL], 2, 0, 0, 1, 0, 0), 0);
  assert.equal(portalPdf([PORTAL], 2, 0, 0, -1, 0, 0) > 0, true);
});

test('with two portals the pdf sums over both, so a direction through both is counted twice', () => {
  const second = { ...PORTAL, position: [0.5, 0, 0] };
  const single = portalPdf([PORTAL], 2, 0, 0, -1, 0, 0);
  const both = portalPdf([PORTAL, second], 2, 0, 0, -1, 0, 0);
  assert.ok(both > 0 && single > 0);
  assert.ok(Math.abs(both - (single + portalPdf([second], 2, 0, 0, -1, 0, 0)) / 2) < 1e-9);
});

test('a portal keeps the mean of a room lit through a window and cuts the change between seeds', () => {
  const without = sceneOf(false);
  const withPortal = sceneOf(true);
  // The unportalled room is the noisy one, so its mean is over the seeds; one seed alone strays by about 2 percent.
  const meanWithout = mean(SEEDS.map(seed => mean(render(without, { samples: 512, seed }))));
  const meanWith = mean(SEEDS.map(seed => mean(render(withPortal, { samples: 512, seed }))));
  assert.ok(meanWithout > 0.02, `the room is lit: ${meanWithout}`);
  assert.ok(Math.abs(meanWith / meanWithout - 1) < 0.015, `mean ${meanWith} with a portal against ${meanWithout} without`);
  const differenceWithout = meanSeedDifference(SEEDS.map(seed => render(without, { samples: 16, seed })));
  const differenceWith = meanSeedDifference(SEEDS.map(seed => render(withPortal, { samples: 16, seed })));
  assert.ok(differenceWithout / differenceWith >= 2, `seed difference ${differenceWithout} without, ${differenceWith} with a portal`);
});

test('only the WebGL tracer is told that a portal draws nothing', () => {
  const environment = { areaLights: [WINDOW_PORTAL] };
  assert.doesNotMatch(describeIgnoredFeatures([], environment, 'cpu').join(' '), /portal/);
  assert.doesNotMatch(describeIgnoredFeatures([], environment, 'webgpu').join(' '), /portal/);
  assert.match(describeIgnoredFeatures([], environment, 'gpu').join(' '), /Light portals .* are ignored/);
});
