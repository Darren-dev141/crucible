import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTraceScene } from '../src/path-tracer-scene.js';
import { materialUvSetMask, packAtlas, packMaterials, packTriangles, UV_SET_SLOT } from '../src/path-tracer-gpu-pack.js';
import { buildFragmentSource } from '../src/path-tracer-gpu-shader.js';
import { uploadScene as uploadWebGlScene } from '../src/path-tracer-gpu.js';
import { MEGAKERNEL_SOURCE } from '../src/path-tracer-webgpu-kernel.js';
import { uploadScene as uploadWebGpuScene } from '../src/path-tracer-webgpu.js';

// These tests read the layout back out of the kernel source and out of what the tracers upload, so a tracer that uploads the
// wrong record or a kernel that reads the wrong texel or bit fails on values, not on a matching string.

const RED_GREEN = { data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]), width: 2, height: 1 };
const FLAT_NORMAL = { data: new Uint8Array([128, 128, 255, 255]), width: 1, height: 1 };
const FIRST_SET = [[0.05, 0.10], [0.15, 0.20], [0.25, 0.30], [0.35, 0.40]];
const SECOND_SET = [[0.55, 0.60], [0.65, 0.70], [0.75, 0.80], [0.85, 0.90]];
const CHANNEL_INDEX = { x: 0, y: 1, z: 2, w: 3 };
const NORMAL_AND_EMISSIVE_MASK = 2 + 8;

function twoSetScene() {
  const part = {
    name: 'floor',
    geometry: {
      positions: new Float32Array([-1, 0, 1, 1, 0, 1, 1, 0, -1, -1, 0, -1]),
      normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
      uvs: new Float32Array(FIRST_SET.flat()),
      lightUvs: new Float32Array(SECOND_SET.flat()),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    },
    material: {
      tag: 'surface', metallic: 0, roughness: 1, emission: 1, color: [1, 1, 1],
      map: { image: RED_GREEN, colorSpace: 'srgb', uvChannel: 0 },
      normalMap: { image: FLAT_NORMAL, colorSpace: 'linear', uvChannel: 1 },
      emissiveMap: { image: RED_GREEN, colorSpace: 'srgb', uvChannel: 1 },
    },
  };
  return buildTraceScene([part]);
}

const KERNELS = [
  ['WebGL fragment kernel', buildFragmentSource(), /const int TRIANGLE_TEXELS = (\d+);/],
  ['WebGPU megakernel', MEGAKERNEL_SOURCE, /const TRIANGLE_TEXELS: i32 = (\d+);/],
];
const TEXEL_REFERENCE = '(?:fetchData\\(uTriangles, base \\+ (\\d+)\\)|triangles\\[base \\+ (\\d+)\\])';

function secondSetReads(source) {
  const corners = [...source.matchAll(new RegExp(`secondSetCorners = ${TEXEL_REFERENCE};`, 'g'))].map(match => Number(match[1] ?? match[2]));
  const thirds = [...source.matchAll(new RegExp(`secondSetThird = vec2(?:<f32>)?\\(${TEXEL_REFERENCE}\\.(\\w), ${TEXEL_REFERENCE}\\.(\\w)\\);`, 'g'))]
    .map(match => ({ uTexel: Number(match[1] ?? match[2]), uChannel: match[3], vTexel: Number(match[4] ?? match[5]), vChannel: match[6] }));
  return { corners, thirds };
}

for (const [name, source, strideExpression] of KERNELS) {
  test(`${name}: the stride and texels it reads the second UV set from match the uploaded record`, () => {
    const scene = twoSetScene();
    const { data } = packTriangles(scene, { secondUvSet: true });
    const stride = Number(source.match(strideExpression)[1]);
    const { corners, thirds } = secondSetReads(source);
    assert.ok(corners.length >= 2 && thirds.length >= 2, 'both the hit pass and the alpha pass read the second set');
    for (let slot = 0; slot < scene.bvh.triangleOrder.length; slot++) {
      const triangle = scene.bvh.triangleOrder[slot];
      const vertices = [0, 1, 2].map(corner => scene.indices[triangle * 3 + corner]);
      const [first, second, third] = vertices.map(vertex => SECOND_SET[vertex].map(Math.fround));
      for (const cornerTexel of corners) {
        const base = (slot * stride + cornerTexel) * 4;
        assert.deepEqual(Array.from(data.subarray(base, base + 4)), [...first, ...second], `corner texel ${cornerTexel}, slot ${slot}`);
      }
      for (const read of thirds) {
        const readU = data[(slot * stride + read.uTexel) * 4 + CHANNEL_INDEX[read.uChannel]];
        const readV = data[(slot * stride + read.vTexel) * 4 + CHANNEL_INDEX[read.vChannel]];
        assert.deepEqual([readU, readV], third, `third corner, slot ${slot}`);
      }
    }
  });

  test(`${name}: each map tests the bit that the material record sets for it`, () => {
    const mapForKeyword = { mapRectangle: 'texture', normalOnSecondSet: 'normalTexture', surfaceRectangle: 'surfaceTexture', emissiveRectangle: 'emissiveTexture' };
    const bitPerMap = {};
    for (const line of source.split('\n')) {
      const bitMatch = line.match(/mapReadsSecondUvSet\(flagsTwo\.z, (\d+)\)/);
      if (!bitMatch) continue;
      const keyword = Object.keys(mapForKeyword).find(key => line.includes(key));
      if (keyword) bitPerMap[mapForKeyword[keyword]] = Number(bitMatch[1]);
    }
    assert.deepEqual(Object.keys(bitPerMap).sort(), ['emissiveTexture', 'normalTexture', 'surfaceTexture', 'texture']);
    for (const [field, bit] of Object.entries(bitPerMap)) {
      assert.equal(materialUvSetMask({ [field]: { uvSet: 1 } }), bit, `${field} reads bit ${bit} in the kernel`);
    }
  });

  test(`${name}: the main pass reads the mask from the slot the pack writes`, () => {
    const slotMatch = source.match(/flagsTwo = (?:fetchData\(uMaterials, material \+ (\d+)\)|materials\[material \+ (\d+)\]);/);
    assert.ok(slotMatch, 'the kernel loads flagsTwo');
    assert.equal(Number(slotMatch[1] ?? slotMatch[2]) * 4 + CHANNEL_INDEX.z, UV_SET_SLOT);
  });

  test(`${name}: the alpha pass reads the base colour bit from the slot the pack writes`, () => {
    const alphaPass = source.slice(source.indexOf('alphaAtNearestHit'));
    const slotMatch = alphaPass.match(/mapReadsSecondUvSet\((?:fetchData\(uMaterials, material \+ (\d+)\)|materials\[material \+ (\d+)\])\.(\w), 1\)/);
    assert.ok(slotMatch, 'the alpha pass tests the base colour bit');
    assert.equal(Number(slotMatch[1] ?? slotMatch[2]) * 4 + CHANNEL_INDEX[slotMatch[3]], UV_SET_SLOT);
  });

  test(`${name}: the bit test agrees with the mask the pack writes`, () => {
    const body = source.match(/mapReadsSecondUvSet\(mask: f32, bit: i32\) -> bool \{\s*return (.*);|bool mapReadsSecondUvSet\(float mask, int bit\) \{\s*return (.*);/);
    const expression = (body[1] ?? body[2])
      .replace(/(?:int|i32)\(mask\)/, 'Math.trunc(mask)')
      .replace(/\(Math\.trunc\(mask\) \/ bit\)/, 'Math.trunc(Math.trunc(mask) / bit)')
      .replace('==', '===');
    const reads = new Function('mask', 'bit', `return ${expression};`);
    for (let mask = 0; mask < 16; mask++) {
      for (const bit of [1, 2, 4, 8]) assert.equal(reads(mask, bit), (mask & bit) !== 0, `mask ${mask}, bit ${bit}`);
    }
  });
}

function recordingGl() {
  const unitTexture = new Map();
  const uniformUnit = new Map();
  let activeUnit = 0;
  let bound = null;
  const handlers = {
    createTexture: () => ({ data: null }),
    activeTexture: unit => { activeUnit = unit; },
    bindTexture: (target, texture) => { bound = texture; unitTexture.set(activeUnit, texture); },
    pixelStorei() {},
    texParameteri() {},
    texImage2D: (...args) => { bound.data = args.at(-1); },
    getUniformLocation: (program, name) => name,
    uniform1i: (location, unit) => uniformUnit.set(location, unit),
    getError: () => 0,
  };
  const gl = new Proxy({}, { get: (target, property) => (property in handlers ? handlers[property] : (property === 'TEXTURE0' ? 1000 : 1)) });
  return { gl, uploaded: name => unitTexture.get(1000 + uniformUnit.get(name)).data };
}

function assertTenTexelRecord(scene, triangles) {
  const expected = packTriangles(scene, { secondUvSet: true }).data;
  assert.deepEqual(Array.from(triangles), Array.from(expected));
  for (let slot = 0; slot < 2; slot++) {
    const firstCorner = scene.indices[scene.bvh.triangleOrder[slot] * 3];
    assert.equal(triangles[(slot * 10 + 9) * 4], Math.fround(SECOND_SET[firstCorner][0]), `slot ${slot}: texel 9 holds the second set at a ten-texel stride`);
  }
}

test('the WebGL tracer uploads the ten-texel record and the material mask', () => {
  const scene = twoSetScene();
  const { gl, uploaded } = recordingGl();
  uploadWebGlScene(gl, {}, scene);
  assertTenTexelRecord(scene, uploaded('uTriangles'));
  assert.equal(uploaded('uMaterials')[UV_SET_SLOT], NORMAL_AND_EMISSIVE_MASK);
});

test('the WebGPU tracer uploads the ten-texel record and the material mask', () => {
  globalThis.GPUBufferUsage = { STORAGE: 1, COPY_DST: 2 };
  const scene = twoSetScene();
  const written = new Map();
  const device = {
    createBuffer: descriptor => ({ label: descriptor.label }),
    queue: { writeBuffer: (buffer, offset, bytes) => written.set(buffer.label, new Float32Array(bytes.slice().buffer)) },
  };
  uploadWebGpuScene(device, scene);
  assertTenTexelRecord(scene, written.get('triangles'));
  const expectedMaterials = packMaterials(scene.materials, packAtlas(scene.materials), scene.shadowOnlyParts).data;
  assert.equal(written.get('materials')[UV_SET_SLOT], NORMAL_AND_EMISSIVE_MASK);
  assert.equal(expectedMaterials[UV_SET_SLOT], NORMAL_AND_EMISSIVE_MASK);
});
