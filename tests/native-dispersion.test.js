import assert from 'node:assert/strict';
import { createCamera } from '../src/path-tracer.js';
import * as pack from '../src/path-tracer-gpu-pack.js';
import { buildTraceScene, resolveTexture } from '../src/path-tracer-scene.js';
import { cookModule, cookTest } from './support/cook.js';

const { STRUCT_STRIDES_V2 } = (await cookModule()) ?? {};
const { buildFlattenedJobNativeInput, carriedMaterialFields } = (await cookModule('job-input')) ?? {};

const SIZE = 16;
const MATERIAL_STRIDE = STRUCT_STRIDES_V2?.material;
const DIAMOND_DISPERSION = 0.36;
const camera = createCamera({ eye: [0, 0, 5], target: [0, 0, 0], up: [0, 1, 0], fov: 30 }, SIZE, SIZE);
const packOptions = { width: SIZE, height: SIZE, samples: 8, bounces: 4, seed: 7, fireflyClamp: 0, noiseThreshold: 0 };

function glassSheet(material) {
  return {
    name: 'glass',
    geometry: {
      positions: Float32Array.from([-3, -3, 0, 3, -3, 0, 3, 3, 0, -3, 3, 0]),
      normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
    },
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    material: { color: [1, 1, 1], roughness: 0, metallic: 0, transmission: 1, thickness: 0.5, ior: 1.5, ...material },
  };
}

function jobInputOf(material) {
  const scene = buildTraceScene([glassSheet(material)], { keyColor: [3, 3, 3], lightDirection: [0, 0, -1] });
  return buildFlattenedJobNativeInput(scene, camera, packOptions, pack, resolveTexture);
}

function bytesOf(view) {
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}

cookTest('the dispersion of a material reaches the Cook material table, and 0 or none sends the old table', () => {
  const plain = jobInputOf({});
  const zero = jobInputOf({ dispersion: 0 });
  assert.equal(Buffer.compare(bytesOf(zero.materials), bytesOf(plain.materials)), 0, 'dispersion 0 is bit for bit the old table');
  assert.equal(plain.materials.byteLength, plain.materialCount * MATERIAL_STRIDE, 'no extension record without dispersion');

  const dispersive = jobInputOf({ dispersion: DIAMOND_DISPERSION });
  assert.equal(dispersive.materials.byteLength, 2 * plain.materials.byteLength, 'one extension record per material');
  const record = Uint8Array.from(bytesOf(dispersive.materials).subarray(dispersive.materialCount * MATERIAL_STRIDE, (dispersive.materialCount + 1) * MATERIAL_STRIDE));
  const dispersionWord = new Float32Array(record.buffer)[4];
  assert.ok(Math.abs(dispersionWord - DIAMOND_DISPERSION) < 1e-6, `the record carries ${dispersionWord}`);
});

cookTest('the carried material fields hold dispersion only when it is above 0, and an out of range value throws', () => {
  assert.equal('dispersion' in carriedMaterialFields({ transmission: 1 }, { transmission: 1 }, resolveTexture), false);
  assert.equal(carriedMaterialFields({ transmission: 1, dispersion: 1 }, { transmission: 1 }, resolveTexture).dispersion, 1);
  assert.throws(() => carriedMaterialFields({ transmission: 1, dispersion: 11 }, { transmission: 1 }, resolveTexture), /dispersion must be a number from 0 to/);
});
