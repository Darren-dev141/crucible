// Grid local volumes in the native path tracer (Cook): the map from a Crucible grid volume to Cook's gridVolumes, the frame at the render
// time, the errors for what Cook cannot draw, the export into the FORMAT-v2 tables and a render that skips without the addon or an adapter.
import assert from 'node:assert/strict';
import test from 'node:test';
import { traceFrameNative } from '../scripts/agent-native-trace.mjs';
import { exportNativeSceneTables } from '../scripts/native-bake-page.js';
import { createCamera, describeIgnoredFeatures } from '../src/path-tracer.js';
import * as pack from '../src/path-tracer-gpu-pack.js';
import { cookGridVolume, nativeGridVolumes } from '../src/path-tracer-native-volumes.js';
import { buildTraceScene, resolveTexture } from '../src/path-tracer-scene.js';
import { encodeVolumeGrid, registerVolumeGrid } from '../src/volume-grid.js';
import { cookInstalled, cookModule, cookTest } from './support/cook.js';

const cook = await cookModule();
const packInput = await cookModule('pack-input');
const jobInput = await cookModule('job-input');
const gridVolumeInput = await cookModule('grid-volume-input');
const { buildNativeInputV2, findNativeAddon } = cook ?? {};
const { buildNativeInput } = packInput ?? {};
const { buildFlattenedJobNativeInput, buildJobNativeInput } = jobInput ?? {};

const WIDTH = 32;
const HEIGHT = 24;
const camera = createCamera({ eye: [0, 0, 6], target: [0, 0, 0], fov: 50 }, WIDTH, HEIGHT);
const packOptions = { width: WIDTH, height: HEIGHT, samples: 8, bounces: 3, seed: 3, fireflyClamp: 20, noiseThreshold: 0 };
const baseEnvironment = { keyColor: [2, 2, 2], lightDirection: [0.3, 0.8, 0.5] };

const RESOLUTION = [4, 4, 4];
const VOXELS = 64;
registerVolumeGrid('native-grid-a', encodeVolumeGrid({ resolution: RESOLUTION, size: [2, 2, 2],
  channels: { density: new Float32Array(VOXELS).fill(1), temperature: new Float32Array(VOXELS).fill(1.5), flame: new Float32Array(VOXELS).fill(0.5) } }));
registerVolumeGrid('native-grid-b', encodeVolumeGrid({ resolution: RESOLUTION, size: [2, 2, 2], channels: { density: new Float32Array(VOXELS).fill(2) } }));
registerVolumeGrid('native-grid-c', encodeVolumeGrid({ resolution: RESOLUTION, size: [2, 2, 2],
  channels: { density: new Float32Array(VOXELS).fill(2), temperature: new Float32Array(VOXELS).fill(1.5), flame: new Float32Array(VOXELS).fill(0.5) } }));

const gridVolume = {
  shape: 'grid', grid: 'native-grid-a', center: [0.5, 1, -0.25], size: [3, 2, 1],
  density: 3, absorption: [1, 0.5, 0.25], scatter: 0.4, anisotropy: 0.3, emission: [1, 0.5, 0.2], emissionStrength: 6,
  temperatureScale: 1000, blackbodyIntensity: 0.25,
};

const wall = {
  name: 'wall',
  geometry: {
    positions: Float32Array.from([-4, -4, -2, 4, -4, -2, 4, 4, -2, -4, 4, -2]),
    normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
  },
  matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  material: { color: [0.6, 0.6, 0.6], roughness: 0.9 },
};

function traceSceneWith(localVolumes, extra = {}) {
  return buildTraceScene([wall], { ...baseEnvironment, localVolumes, ...extra });
}

test('a grid volume maps to the Cook grid volume with its box, terms and channels', () => {
  const [mapped] = nativeGridVolumes(traceSceneWith([gridVolume]).localVolumes);
  assert.deepEqual(mapped.resolution, RESOLUTION);
  assert.deepEqual(Object.keys(mapped.channels), ['density', 'temperature', 'flame']);
  assert.deepEqual(mapped.center, [0.5, 1, -0.25]);
  assert.deepEqual(mapped.size, [3, 2, 1]);
  assert.equal(mapped.density, 3);
  assert.deepEqual(mapped.absorption, [1, 0.5, 0.25]);
  assert.deepEqual(mapped.scatter, [0.4, 0.4, 0.4]);
  assert.equal(mapped.anisotropy, 0.3);
  assert.deepEqual(mapped.emission, [1, 0.5, 0.2]);
  assert.equal(mapped.emissionStrength, 6);
  assert.equal(mapped.temperatureScale, 1000);
  assert.equal(mapped.blackbodyIntensity, 0.25 * 6, 'Blackbody Intensity is scaled by the emission strength, as in the Cycles reference');
});

test('a grid with density only maps to the density channel, and the box falls back to the grid size', () => {
  const { size, ...withoutSize } = gridVolume;
  const [mapped] = nativeGridVolumes(traceSceneWith([{ ...withoutSize, grid: 'native-grid-b' }]).localVolumes);
  assert.deepEqual(Object.keys(mapped.channels), ['density']);
  assert.deepEqual(mapped.size, [2, 2, 2]);
});

test('a grid sequence maps the frame at the volume time', () => {
  const sequence = { ...gridVolume, grid: undefined, frames: ['native-grid-a', 'native-grid-c'], fps: 2 };
  const first = nativeGridVolumes(traceSceneWith([sequence], { volumeTime: 0.1 }).localVolumes)[0];
  const second = nativeGridVolumes(traceSceneWith([sequence], { volumeTime: 0.6 }).localVolumes)[0];
  const halfOne = 0x3c00;
  const halfTwo = 0x4000;
  assert.equal(first.channels.density[0], halfOne, 'frame 0 at 0.1 s with 2 fps');
  assert.equal(second.channels.density[0], halfTwo, 'frame 1 at 0.6 s');
});

test('no local volumes map to no grid volumes', () => {
  assert.equal(nativeGridVolumes(null), null);
  assert.equal(nativeGridVolumes([]), null);
});

test('a volume that is not a grid is refused with what to use instead', () => {
  const box = traceSceneWith([{ shape: 'box', center: [0, 0, 0], size: [1, 1, 1] }]).localVolumes;
  assert.throws(() => nativeGridVolumes(box), /environment\.localVolumes\[0\] is a box volume; the native path tracer draws grid volumes only\. Use backend "cpu"/);
  const sphere = traceSceneWith([gridVolume, { shape: 'sphere', center: [0, 0, 0], radius: 1 }]).localVolumes;
  assert.throws(() => nativeGridVolumes(sphere), /localVolumes\[1\] is a sphere volume/);
});

test('an emission ramp on a grid is refused, since Cook has no ramp', () => {
  const [volume] = traceSceneWith([gridVolume]).localVolumes;
  assert.throws(() => nativeGridVolumes([{ ...volume, emissionRamp: { source: 'flame' } }]), /emissionRamp is not drawn by the native path tracer/);
  assert.ok(cookGridVolume(volume));
});

test('a motion shutter on a grid is named as ignored by the native kernel only', () => {
  const environment = { ...baseEnvironment, localVolumes: [gridVolume], volumeShutter: 0.02 };
  assert.ok(describeIgnoredFeatures([wall], environment, 'cpu', { kernelMaterials: true }).some(note => /volumeShutter is ignored for a grid volume/.test(note)));
  assert.ok(!describeIgnoredFeatures([wall], environment, 'cpu', { kernelMaterials: false }).some(note => /volumeShutter/.test(note)));
  assert.ok(!describeIgnoredFeatures([wall], { ...environment, volumeShutter: 0 }, 'cpu', { kernelMaterials: true }).some(note => /volumeShutter/.test(note)));
});

function exportScene(environment, parts = [wall], extra = {}) {
  return exportNativeSceneTables({ parts, environment, camera, options: packOptions, kernel: 'cycles', instancing: false,
    modules: { buildTraceScene, resolveTexture, buildNativeInput, buildJobNativeInput, buildFlattenedJobNativeInput, pack, gridVolumeInput }, ...extra });
}

function tableBytes(exported, name) {
  return Buffer.from(exported.tables[name], 'base64');
}

cookTest('a scene without volumes exports the tables Cook packs for it, as before', () => {
  const exported = exportScene(baseEnvironment);
  const direct = buildFlattenedJobNativeInput(buildTraceScene([wall], baseEnvironment), camera, packOptions, pack, resolveTexture);
  for (const [name, table] of Object.entries(direct)) {
    if (!ArrayBuffer.isView(table)) continue;
    assert.equal(exported.tables[name], Buffer.from(table.buffer, table.byteOffset, table.byteLength).toString('base64'), name);
  }
  assert.deepEqual(exported.tables, exportScene({ ...baseEnvironment, localVolumes: [] }).tables, 'an empty volume list is the same scene');
});

cookTest('a grid scene exports the plain scene tables plus the grid in the texel pool and the kernel parameters', () => {
  const plain = exportScene(baseEnvironment);
  const withGrid = exportScene({ ...baseEnvironment, localVolumes: [gridVolume] });
  const plainTexels = tableBytes(plain, 'textureTexels');
  const gridTexels = tableBytes(withGrid, 'textureTexels');
  assert.ok(gridTexels.length > plainTexels.length);
  assert.equal(Buffer.compare(gridTexels.subarray(0, plainTexels.length), plainTexels), 0, 'the grid comes after the textures');
  const parameters = tableBytes(withGrid, 'kernelParams');
  const view = new DataView(parameters.buffer, parameters.byteOffset, parameters.byteLength);
  assert.equal(view.getUint32(324, true), 1, 'one grid volume');
  assert.equal(view.getUint32(328, true), plainTexels.length / 4, 'the descriptor table starts after the textures');
  assert.ok(view.getUint32(32, true) & 8192, 'HAS_GRID_VOLUME is set');
  const plainParameters = tableBytes(plain, 'kernelParams');
  assert.equal(new DataView(plainParameters.buffer, plainParameters.byteOffset, plainParameters.byteLength).getUint32(324, true), 0);
});

cookTest('an instanced export carries the grid exactly as Cook packs scene.gridVolumes', () => {
  const shared = wall.geometry;
  const parts = [{ ...wall, name: 'wall-a' }, { ...wall, name: 'wall-b', matrix: wall.matrix.map((value, index) => (index === 12 ? 0.5 : value)) }];
  const environment = { ...baseEnvironment, localVolumes: [gridVolume] };
  const exported = exportScene(environment, parts, { instancing: true });
  const scene = buildTraceScene(parts, environment, { instancing: true });
  assert.ok(scene.instances, `geometry ${shared ? 'is' : 'is not'} shared`);
  const { localVolumes, ...withoutVolumes } = scene;
  const direct = buildJobNativeInput({ ...withoutVolumes, gridVolumes: nativeGridVolumes(localVolumes) }, camera, packOptions, pack, resolveTexture);
  for (const name of ['textureTexels', 'kernelParams']) {
    assert.equal(exported.tables[name], Buffer.from(direct[name].buffer, direct[name].byteOffset, direct[name].byteLength).toString('base64'), name);
  }
  assert.ok(buildNativeInputV2);
});

cookTest('an export with a box volume is refused instead of dropping the volume', () => {
  assert.throws(() => exportScene({ ...baseEnvironment, localVolumes: [{ shape: 'box', center: [0, 0, 0], size: [1, 1, 1] }] }), /draws grid volumes only/);
});

const addonSkip = !cookInstalled || !findNativeAddon() ? 'the native addon is not built' : false;

async function traceFrame(environment, t) {
  const exported = JSON.parse(JSON.stringify({ ...exportScene(environment), ignored: [] }));
  let traced;
  const recordingTracer = { ...cook, traceNative(tables, options) {
    traced = cook.traceNative(tables, options);
    return traced;
  } };
  try {
    await traceFrameNative({ tracer: recordingTracer, exported, width: WIDTH, height: HEIGHT, samples: 16, denoise: 'none', kernel: 'cycles' });
  } catch (error) {
    if (/adapter|Vulkan|ray quer/i.test(error.message)) return t.skip(error.message);
    throw error;
  }
  return traced.rgba;
}

function meanLuminance(rgba) {
  let sum = 0;
  for (let index = 0; index < rgba.length; index += 4) sum += rgba[index] + rgba[index + 1] + rgba[index + 2];
  return sum / (rgba.length / 4);
}

cookTest('a glowing grid volume brightens the frame and a dense dark one darkens it', { skip: addonSkip }, async t => {
  const plain = await traceFrame(baseEnvironment, t);
  if (!plain) return;
  const glowing = await traceFrame({ ...baseEnvironment, localVolumes: [gridVolume] }, t);
  assert.ok(meanLuminance(glowing) > meanLuminance(plain) * 1.02, 'the flame and the blackbody emit into the frame');
  const dark = await traceFrame({ ...baseEnvironment, localVolumes: [{ ...gridVolume, emission: [0, 0, 0], blackbodyIntensity: 0, scatter: 0, density: 40, center: [0, 0, 0], size: [8, 8, 2] }] }, t);
  assert.ok(meanLuminance(dark) < meanLuminance(plain) * 0.5, 'a dense absorbing grid hides the wall');
});
