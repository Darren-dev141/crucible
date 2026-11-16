// Motion blur of grid volumes (#1759): the gas velocity baked with a grid, the shutter that opens the blur, and the same smear in the rasterizer's and the CPU tracer's march.
import test from 'node:test';
import assert from 'node:assert/strict';
import { bakeGasSim } from '../src/gas-sim.js';
import {
  decodeVolumeGrid, encodeVolumeGrid, registerVolumeGrid, hasGridVelocity, gridUnitVelocity, gridMotionTimeFraction, VOLUME_GRID_VELOCITY_CHANNELS,
} from '../src/volume-grid.js';
import { resolveLocalVolumes, localVolumeGridMotionPoint, createLocalVolumeBuffers, packLocalVolumes } from '../src/local-volumes.js';
import { bindLocalVolumeParts } from '../src/local-volume-parts.js';
import { renderPathTracedImage } from '../src/path-tracer.js';

const SMALL_BAKE = { resolution: 16, frames: 3, fps: 24, substeps: 1, pressureIterations: 4 };

test('a gas bake writes the velocity channels only when asked, and every other channel is the same either way', () => {
  const plain = bakeGasSim(SMALL_BAKE);
  const withVelocity = bakeGasSim({ ...SMALL_BAKE, velocity: true });
  assert.deepEqual(Object.keys(plain.frames[0]), ['density', 'temperature', 'flame']);
  assert.deepEqual(Object.keys(withVelocity.frames[0]), ['density', 'temperature', 'flame', ...VOLUME_GRID_VELOCITY_CHANNELS]);
  plain.frames.forEach((frame, index) => {
    for (const name of ['density', 'temperature', 'flame']) assert.deepEqual(withVelocity.frames[index][name], frame[name], `${name} of frame ${index} does not depend on velocity`);
  });
  const speed = Math.max(...withVelocity.frames[1].velocityY.map(Math.abs));
  assert.ok(speed > 0.1 && speed < 100, `the burst moves the gas at metres per second, got ${speed}`);
  assert.throws(() => bakeGasSim({ ...SMALL_BAKE, velocity: 'yes' }), /velocity must be true or false/);
});

test('a grid file with velocity round-trips, an old file without it still loads, and a half set of channels is refused', () => {
  const voxels = 8;
  const flat = value => new Float32Array(voxels).fill(value);
  const bytes = encodeVolumeGrid({ resolution: [2, 2, 2], size: [2, 2, 2], channels: { density: flat(1), velocityX: flat(0.5), velocityY: flat(-2), velocityZ: flat(0) } });
  const grid = decodeVolumeGrid(bytes);
  assert.equal(hasGridVelocity(grid), true);
  const unit = gridUnitVelocity(grid, null);
  assert.deepEqual([unit.x[0], unit.y[0], unit.z[0]], [0.25, -1, 0], 'header size 2 turns 0.5 and -2 metres per second into box fractions per second');
  const old = decodeVolumeGrid(encodeVolumeGrid({ resolution: [2, 2, 2], channels: { density: flat(1), temperature: flat(0), flame: flat(0) } }));
  assert.equal(hasGridVelocity(old), false);
  assert.equal(gridUnitVelocity(old, [1, 1, 1]), null);
  assert.throws(() => encodeVolumeGrid({ resolution: [2, 2, 2], channels: { density: flat(1), velocityX: flat(1) } }), /all of velocityX, velocityY, velocityZ or none/);
});

function registerBlock({ name, velocityX = 0, resolution = [64, 1, 1], size = [1, 1, 1] }) {
  const voxels = resolution[0] * resolution[1] * resolution[2];
  const density = new Float32Array(voxels);
  for (let voxel = 0; voxel < voxels / 2; voxel++) density[voxel] = 1;
  registerVolumeGrid(name, encodeVolumeGrid({ resolution, size, channels: { density, velocityX: new Float32Array(voxels).fill(velocityX), velocityY: new Float32Array(voxels), velocityZ: new Float32Array(voxels) } }));
}

const VOLUME = { shape: 'grid', center: [0, 1.5, 0], steps: 128, density: 1.5 };

test('the shutter binds only a grid with velocity, and a volume with no shutter binds exactly as before', () => {
  registerBlock({ name: 'bind-moving', velocityX: 0.2 });
  registerVolumeGrid('bind-plain', encodeVolumeGrid({ resolution: [2, 2, 2], size: [1, 1, 1], channels: { density: new Float32Array(8) } }));
  const [moving] = resolveLocalVolumes([{ ...VOLUME, grid: 'bind-moving' }]);
  const [plain] = resolveLocalVolumes([{ ...VOLUME, grid: 'bind-plain' }]);
  assert.equal(bindLocalVolumeParts([moving], [], { shutter: 0.5 })[0].motionShutter, 0.5);
  assert.equal('motionShutter' in bindLocalVolumeParts([moving], [])[0], false, 'no shutter, no motion field');
  assert.equal('motionShutter' in bindLocalVolumeParts([moving], [], { shutter: 0 })[0], false);
  assert.equal('motionShutter' in bindLocalVolumeParts([plain], [], { shutter: 0.5 })[0], false, 'a grid without velocity has nothing to blur along');
  const buffers = createLocalVolumeBuffers();
  packLocalVolumes(bindLocalVolumeParts([moving], [], { shutter: 0.5 }), buffers);
  assert.equal(buffers.gridShutter, 0.5);
  packLocalVolumes(bindLocalVolumeParts([moving], []), buffers);
  assert.equal(buffers.gridShutter, 0, 'the next frame without a shutter packs none');
});

test('a point reads the grid back along the gas velocity by its place in the shutter, and a still grid or a point outside reads where it is', () => {
  registerBlock({ name: 'point-moving', velocityX: 0.2 });
  registerBlock({ name: 'point-still', velocityX: 0 });
  const [moving, still] = ['point-moving', 'point-still'].map(grid => bindLocalVolumeParts(resolveLocalVolumes([{ ...VOLUME, grid }]), [], { shutter: 0.5 })[0]);
  const out = new Float64Array(3);
  const back = Array.from(localVolumeGridMotionPoint(moving, -0.1, 1.5, 0, 0.5, out));
  assert.ok(Math.abs(back[0] - (-0.1 - 0.2 * 0.5 * 0.5)) < 1e-4, `0.2 m/s over half of a 0.5 s shutter reads the grid 0.05 m back along the velocity, got ${back[0]}`);
  assert.deepEqual(back.slice(1), [1.5, 0]);
  assert.deepEqual(Array.from(localVolumeGridMotionPoint(moving, -0.1, 1.5, 0, 0, out)), [-0.1, 1.5, 0], 'the frame\'s own time reads the frame');
  assert.deepEqual(Array.from(localVolumeGridMotionPoint(still, -0.1, 1.5, 0, 1, out)), [-0.1, 1.5, 0]);
  assert.deepEqual(Array.from(localVolumeGridMotionPoint(moving, 3, 1.5, 0, 1, out)), [3, 1.5, 0], 'no gas, no velocity outside the box');
});

test('the shutter times of a ray are spread over 0 to 1 and repeat for the same ray', () => {
  const fractions = Array.from({ length: 96 }, (_, step) => gridMotionTimeFraction(0.3, step));
  assert.ok(fractions.every(fraction => fraction >= 0 && fraction < 1));
  const mean = fractions.reduce((sum, fraction) => sum + fraction, 0) / fractions.length;
  assert.ok(Math.abs(mean - 0.5) < 0.02, `the steps cover the shutter evenly, mean ${mean}`);
  assert.deepEqual(fractions, Array.from({ length: 96 }, (_, step) => gridMotionTimeFraction(0.3, step)));
});

const IMAGE = { width: 16, height: 16, denoise: false, threads: 1, bounces: 1, samples: 8 };
const LOOKING_DOWN = { eye: [0, 3, 0], target: [0, 0, 0], up: [0, 0, -1], fov: 40 };

function ground() {
  const half = 20;
  const geometry = {
    positions: new Float32Array([-half, 0, half, half, 0, half, half, 0, -half, -half, 0, -half]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
  return [{ name: 'ground', geometry, material: { tag: 'surface', metallic: 0, roughness: 1, color: [0, 0, 0], ior: 1, emission: 1, emissiveColor: [1, 1, 1] } }];
}

// The ground glows white, so a pixel is the transmittance of the gas above it. Row 8 of a 16 pixel image, one value per column.
async function transmittanceRow(grid, volumeShutter) {
  const environment = { localVolumes: [{ ...VOLUME, grid }], ...(volumeShutter === undefined ? {} : { volumeShutter }) };
  const { linear } = await renderPathTracedImage({ parts: ground(), environment, camera: LOOKING_DOWN }, IMAGE);
  return Array.from({ length: 16 }, (_, column) => linear[(8 * 16 + column) * 3]);
}

test('the CPU path tracer leaves a still grid and a closed shutter as they were, and smears a moving edge forward along its velocity', async () => {
  registerBlock({ name: 'trace-moving', velocityX: 0.2 });
  registerBlock({ name: 'trace-still', velocityX: 0 });
  const sharp = await transmittanceRow('trace-moving');
  assert.deepEqual(await transmittanceRow('trace-moving', 0), sharp, 'a shutter of 0 is the render without one');
  assert.deepEqual(await transmittanceRow('trace-still', 1), await transmittanceRow('trace-still'), 'a grid that does not move is unchanged by the shutter');

  const blurred = await transmittanceRow('trace-moving', 1);
  const clearSide = Math.max(...sharp);
  const edge = sharp.findIndex(value => value > clearSide * 0.99);
  assert.ok(edge > 2 && edge < 14, `the sharp image has an edge between gas and clear air, found at column ${edge}`);
  const gasSide = sharp.indexOf(Math.min(...sharp));
  assert.ok(Math.abs(blurred[gasSide] - sharp[gasSide]) < 0.03, 'far from the edge the gas is as thick as it was');
  assert.ok(Math.abs(blurred[15 - gasSide] - sharp[15 - gasSide]) < 0.03, 'and the clear side stays clear');
  assert.ok(blurred[edge] < sharp[edge] - 0.05, `the clear air just ahead of the edge darkens as the gas moves into it: ${blurred[edge]} against ${sharp[edge]}`);
  const rear = sharp.findIndex(value => value < clearSide * 0.9);
  const middle = Math.floor((rear + edge) / 2);
  assert.ok(Math.abs(blurred[middle] - sharp[middle]) < 0.03, 'in the middle of the gas, behind the edge, the gas is there for the whole shutter');
});
