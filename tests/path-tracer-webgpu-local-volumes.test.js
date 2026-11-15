// Local volumes on the WebGPU path tracer (#1048): the volume table is packed in plain JS and tested here, the kernel gets the march only for a
// scene that has volumes, boxes and spheres are drawn on a real adapter and compared to the CPU tracer (headless Chrome, skips without an adapter),
// and the kinds the table cannot hold (mesh, grid) are refused with the backend that can draw them.
import assert from 'node:assert/strict';
import test from 'node:test';
import { box } from '../src/geometry.js';
import { resolveLocalVolumes } from '../src/local-volumes.js';
import { buildTraceScene, refuseLocalVolumes } from '../src/path-tracer-scene.js';
import { buildMegakernelSource, MEGAKERNEL_SOURCE } from '../src/path-tracer-webgpu-kernel.js';
import { assertWebGpuLocalVolumes, LOCAL_VOLUME_HEADER_TEXELS, LOCAL_VOLUME_TEXELS, packWebGpuLocalVolumes } from '../src/path-tracer-webgpu-local-volumes.js';
import { traceOnWebGpu } from '../src/path-tracer-webgpu.js';
import { withWebGpuPage } from './helpers/webgpu-page.js';

const SMOKE_BOX = { shape: 'box', center: [0, 1.5, 0], size: [3, 1.5, 3], density: 1.2, falloff: 0.3, absorption: [0.7, 0.8, 1], emission: [0.2, 0.1, 0], emissionStrength: 2, scatter: 0.8, noiseAmount: 0.5, noiseScale: 2, steps: 24 };
const PUFF = { shape: 'sphere', center: [1, 1, 0], radius: 0.6, density: 2, falloff: 0.5 };
const EMBER = { shape: 'sphere', center: [-1.2, 0.9, 0.5], radius: 0.5, density: 0.5, emission: [1, 0.4, 0.1], emissionStrength: 3, steps: 16 };

function floorPart() {
  const matrix = new Float32Array([8, 0, 0, 0, 0, 0.05, 0, 0, 0, 0, 8, 0, 0, 0, 0, 1]);
  return { name: 'floor', geometry: box(0, 1), matrix, material: { color: [0.5, 0.5, 0.5] } };
}

const rounded = values => [...values].map(value => Math.round(value * 1e4) / 1e4);

test('the table holds the count, the sky light and eight vectors per volume in the order the kernel reads them', () => {
  const [smoke, puff] = resolveLocalVolumes([SMOKE_BOX, PUFF], 'volumes');
  const environment = { width: 2, height: 1, channels: 3, data: new Float32Array(6).fill(0.25), intensity: 2 };
  const table = packWebGpuLocalVolumes([smoke, puff], environment);
  assert.equal(table.length, (LOCAL_VOLUME_HEADER_TEXELS + 2 * LOCAL_VOLUME_TEXELS) * 4);
  assert.equal(table[0], 2);
  assert.ok(Math.abs(table[4] - 0.5) < 1e-6, `sky red ${table[4]}`);
  const first = LOCAL_VOLUME_HEADER_TEXELS * 4;
  assert.deepEqual(rounded(table.subarray(first, first + 4)), [0, 1.5, 0, 0]);
  assert.deepEqual(rounded(table.subarray(first + 4, first + 8)), [1.5, 0.75, 1.5, 0.3]);
  assert.ok(Math.abs(table[first + 8] - 0.84) < 1e-6 && table[first + 11] === 0.5, 'absorption times density, then the noise amount');
  assert.ok(Math.abs(table[first + 12] - 0.4) < 1e-6 && table[first + 15] === 2, 'emission times strength, then the noise scale');
  assert.deepEqual(rounded(table.subarray(first + 16, first + 20)), [24, 0.8, 0, 0]);
  assert.deepEqual([...table.subarray(first + 20, first + 32)], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  const second = first + LOCAL_VOLUME_TEXELS * 4;
  assert.deepEqual(rounded(table.subarray(second, second + 4)), [1, 1, 0, 1]);
  assert.deepEqual(rounded(table.subarray(second + 4, second + 8)), [0.6, 0.6, 0.6, 0.5]);
  assert.ok(table[second + 18] === 0 && Math.abs(table[second + 19] - 0.6) < 1e-6, 'anisotropy and the radius');
});

test('a rotated box packs its axes rows, and more volumes than the limit are refused', () => {
  const turn = Math.PI / 2;
  const rotated = { ...resolveLocalVolumes([SMOKE_BOX], 'volumes')[0], axes: [Math.cos(turn), 0, Math.sin(turn), 0, 1, 0, -Math.sin(turn), 0, Math.cos(turn)] };
  const table = packWebGpuLocalVolumes([rotated], null);
  const rows = LOCAL_VOLUME_HEADER_TEXELS * 4 + 20;
  assert.ok(Math.abs(table[rows + 2] - 1) < 1e-6 && Math.abs(table[rows + 8] + 1) < 1e-6);
  assert.throws(() => packWebGpuLocalVolumes(new Array(9).fill(rotated), null), /at most 8 local volumes, got 9/);
});

test('the march is compiled into the megakernel only for a scene that has local volumes, and fog keeps its single phase function', () => {
  assert.doesNotMatch(MEGAKERNEL_SOURCE, /crossLocalVolumes|localVolumeProfile/);
  const localSource = buildMegakernelSource({ hasLocalVolumes: true });
  assert.match(localSource, /fn crossLocalVolumes\(/);
  assert.match(localSource, /crossLocalVolumes\(depth, position,/);
  assert.equal(localSource.match(/fn henyeyGreensteinPhase\(/g).length, 1);
  assert.doesNotMatch(localSource, /scatterInFog/);
  const both = buildMegakernelSource({ hasLocalVolumes: true, hasVolume: true });
  assert.equal(both.match(/fn henyeyGreensteinPhase\(/g).length, 1);
  assert.match(both, /fn scatterInFog\(/);
});

test('mesh and grid volumes are refused on the WebGPU tracer with the kind and the backend that draws them', async () => {
  assert.throws(() => assertWebGpuLocalVolumes({ localVolumes: [{ shape: 'box' }, { shape: 'mesh', part: { name: 'room' } }] }), /localVolumes\[1\] is a mesh volume, which only backend "cpu" traces/);
  assert.throws(() => assertWebGpuLocalVolumes({ localVolumes: [{ shape: 'grid', gridData: {} }] }), /localVolumes\[0\] is a grid volume, which only backend "cpu" traces/);
  assert.doesNotThrow(() => assertWebGpuLocalVolumes({ localVolumes: resolveLocalVolumes([SMOKE_BOX, PUFF], 'volumes') }));
  assert.doesNotThrow(() => assertWebGpuLocalVolumes({}));
  const scene = buildTraceScene([floorPart()], { localVolumes: [SMOKE_BOX] });
  scene.localVolumes = [{ ...scene.localVolumes[0], shape: 'grid', gridData: {} }];
  await assert.rejects(traceOnWebGpu(scene, {}, { width: 2, height: 2, samples: 1, bounces: 1 }, () => {}), /is a grid volume, which only backend "cpu" traces/);
});

test('the WebGL tracers still refuse every local volume, and the wavefront kernel refuses them before it asks for an adapter', async () => {
  const scene = buildTraceScene([floorPart()], { localVolumes: [SMOKE_BOX] });
  assert.throws(() => refuseLocalVolumes(scene, 'backend "gpu"'), /traced by the CPU path tracer only; backend "gpu" cannot draw them/);
  await assert.rejects(traceOnWebGpu(scene, {}, { kernel: 'wavefront' }, () => {}), /wavefront kernel does not trace volume fog, local volumes or subsurface/);
});

// Runs in the page: the same scene on the CPU and the WebGPU tracer, with the seconds each took.
async function renderBothBackends({ volumes, width, height, samples }) {
  const { box: makeBox } = await import('/src/geometry.js');
  const { renderPathTracedImage } = await import('/src/path-tracer.js');
  const matrix = new Float32Array([8, 0, 0, 0, 0, 0.05, 0, 0, 0, 0, 8, 0, 0, 0, 0, 1]);
  const parts = [{ name: 'floor', geometry: makeBox(0, 1), matrix, material: { color: [0.5, 0.5, 0.5] } }];
  const map = { width: 4, height: 2, channels: 3, data: new Float32Array(24).fill(0.15), intensity: 1, rotation: 0 };
  const environment = { localVolumes: volumes, keyColor: [3, 3, 3], lightDirection: [1, 0.6, 0.3], map };
  const camera = { eye: [0, 2.2, 5], target: [0, 1, 0], fov: 45 };
  const result = {};
  for (const backend of ['cpu', 'webgpu']) {
    const started = performance.now();
    const image = await renderPathTracedImage({ parts, environment, camera }, { width, height, samples, bounces: 3, seed: 7, backend, denoiser: 'none', threads: 1 });
    result[backend] = { linear: Array.from(image.linear), seconds: (performance.now() - started) / 1000 };
  }
  return result;
}

test('on a WebGPU adapter box and sphere volumes match the CPU tracer', { timeout: 300000 }, async context => {
  await withWebGpuPage(context, async page => {
    const { cpu, webgpu } = await page.evaluate(renderBothBackends, { volumes: [SMOKE_BOX, PUFF, EMBER], width: 64, height: 40, samples: 32 });
    let difference = 0;
    let reference = 0;
    let lit = 0;
    cpu.linear.forEach((value, index) => {
      difference += Math.abs(value - webgpu.linear[index]);
      reference += value;
      if (value > 0.05) lit++;
    });
    assert.ok(lit > 200, `the volumes show in the frame: ${lit} lit values`);
    assert.ok(difference / reference < 0.05, `mean relative difference ${(difference / reference).toFixed(4)}`);
  });
});
