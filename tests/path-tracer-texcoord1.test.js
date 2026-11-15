import assert from 'node:assert/strict';
import test from 'node:test';

import { renderPathTracedImage } from '../src/path-tracer.js';
import { buildTraceScene } from '../src/path-tracer-scene.js';
import { cookModule, cookTest } from './support/cook.js';
import { materialUvSetMask, NATIVE_TRIANGLE_TEXELS, packAtlas, packMaterials, packTriangles, UV_SET_SLOT } from '../src/path-tracer-gpu-pack.js';
import { buildFragmentSource, TRIANGLE_TEXELS } from '../src/path-tracer-gpu-shader.js';
import { MEGAKERNEL_SOURCE } from '../src/path-tracer-webgpu-kernel.js';

// A 2 by 1 image: red on the left half, green on the right half.
const RED_GREEN = { data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]), width: 2, height: 1 };
const FLAT_NORMAL = { data: new Uint8Array([128, 128, 255, 255]), width: 1, height: 1 };
const OVERHEAD_SUN = { keyColor: [3, 3, 3], lightDirection: [0, 1, 0] };
const LOOKING_DOWN = { eye: [0, 3, 0], target: [0, 0, 0], up: [0, 0, -1], fov: 40 };

// TEXCOORD_0 points at the red half of the image, TEXCOORD_1 at the green half.
function floorQuad() {
  const half = 20;
  return {
    positions: new Float32Array([-half, 0, half, half, 0, half, half, 0, -half, -half, 0, -half]),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0.25, 0.5, 0.25, 0.5, 0.25, 0.5, 0.25, 0.5]),
    lightUvs: new Float32Array([0.75, 0.5, 0.75, 0.5, 0.75, 0.5, 0.75, 0.5]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

function mixedPart(baseColourChannel) {
  return {
    name: 'floor',
    geometry: floorQuad(),
    material: {
      tag: 'surface', metallic: 0, roughness: 1, emission: 0, color: [1, 1, 1],
      map: { image: RED_GREEN, colorSpace: 'srgb', uvChannel: baseColourChannel },
      normalMap: { image: FLAT_NORMAL, colorSpace: 'linear', uvChannel: 0 },
    },
  };
}

async function centrePixel(part) {
  const image = await renderPathTracedImage(
    { parts: [part], environment: OVERHEAD_SUN, camera: LOOKING_DOWN },
    { width: 16, height: 16, samples: 4, bounces: 1, denoise: false, threads: 1 },
  );
  const centre = (8 * 16 + 8) * 3;
  return [image.linear[centre], image.linear[centre + 1], image.linear[centre + 2]];
}

test('a base colour on TEXCOORD_1 beside a TEXCOORD_0 normal map traces as the green half', async () => {
  const [red, green] = await centrePixel(mixedPart(1));
  assert.ok(green > 0.1, `green ${green}`);
  assert.ok(red < green * 0.05, `red ${red} against green ${green}`);
});

test('the same base colour on TEXCOORD_0 still traces as the red half', async () => {
  const [red, green] = await centrePixel(mixedPart(0));
  assert.ok(red > 0.1, `red ${red}`);
  assert.ok(green < red * 0.05, `green ${green} against red ${red}`);
});

test('the trace scene carries the second UV set and the UV set of each map', () => {
  const scene = buildTraceScene([mixedPart(1)]);
  assert.equal(scene.materials[0].texture.uvSet, 1);
  assert.equal(scene.materials[0].normalTexture.uvSet, 0);
  assert.equal(scene.uvs1[0], 0.75);
  assert.equal(scene.uvs[0], 0.25);
});

test('a scene with no second UV set carries none', () => {
  const part = mixedPart(0);
  delete part.geometry.lightUvs;
  assert.equal(buildTraceScene([part]).uvs1, null);
});

test('a lightUvs array of the wrong length is refused', () => {
  const part = mixedPart(1);
  part.geometry.lightUvs = new Float32Array(4);
  assert.throws(() => buildTraceScene([part]), /lightUvs/);
});

// Every corner carries its own UV in both sets, so a swapped corner or a swapped set shows in the packed floats.
const FIRST_SET = [[0.05, 0.10], [0.15, 0.20], [0.25, 0.30], [0.35, 0.40]];
const SECOND_SET = [[0.55, 0.60], [0.65, 0.70], [0.75, 0.80], [0.85, 0.90]];

function distinctUvPart() {
  const part = mixedPart(1);
  part.geometry.uvs = new Float32Array(FIRST_SET.flat());
  part.geometry.lightUvs = new Float32Array(SECOND_SET.flat());
  return part;
}

function packedTriangle(scene, data, slot, texelsPerTriangle) {
  const triangle = scene.bvh.triangleOrder[slot];
  const corners = [0, 1, 2].map(corner => scene.indices[triangle * 3 + corner]);
  return { corners, base: slot * texelsPerTriangle * 4 };
}

test('the GPU triangle table keeps each corner of both UV sets', () => {
  const scene = buildTraceScene([distinctUvPart()]);
  const { data } = packTriangles(scene, { secondUvSet: true });
  for (let slot = 0; slot < scene.bvh.triangleOrder.length; slot++) {
    const { corners, base } = packedTriangle(scene, data, slot, TRIANGLE_TEXELS);
    corners.forEach((vertex, corner) => {
      assert.equal(data[base + (3 + corner) * 4 + 3], Math.fround(FIRST_SET[vertex][0]), `first set u, corner ${corner}`);
      assert.equal(data[base + (6 + corner) * 4 + 3], Math.fround(FIRST_SET[vertex][1]), `first set v, corner ${corner}`);
    });
    const [first, second, third] = corners.map(vertex => SECOND_SET[vertex].map(Math.fround));
    assert.deepEqual(Array.from(data.subarray(base + 9 * 4, base + 9 * 4 + 4)), [...first, ...second]);
    assert.equal(data[base + 4 + 3], third[0]);
    assert.equal(data[base + 8 + 3], third[1]);
  }
});

test('the default triangle record keeps the nine texels the native tracer reads', () => {
  const scene = buildTraceScene([distinctUvPart()]);
  const table = packTriangles(scene);
  assert.equal(NATIVE_TRIANGLE_TEXELS, 9);
  assert.equal(table.data.length >= scene.bvh.triangleOrder.length * 36, true);
  const { corners, base } = packedTriangle(scene, table.data, 1, NATIVE_TRIANGLE_TEXELS);
  assert.equal(table.data[base + 3], 0, 'material index of the single material');
  assert.equal(table.data[base + 4 + 3], 0, 'no second set in the edge texel');
  assert.equal(table.data[base + 3 * 4 + 3], Math.fround(FIRST_SET[corners[0]][0]), 'first set stays where the native packer expects it');
});

function maskOf(...maps) {
  const part = mixedPart(0);
  part.material.emission = 1;
  for (const [field, channel] of maps) part.material[field] = { image: RED_GREEN, colorSpace: 'srgb', uvChannel: channel };
  return materialUvSetMask(buildTraceScene([part]).materials[0]);
}

test('the GPU material mask has one bit per map that reads TEXCOORD_1', () => {
  assert.equal(maskOf(), 0);
  assert.equal(maskOf(['map', 1]), 1);
  assert.equal(maskOf(['normalMap', 1]), 2);
  assert.equal(maskOf(['metallicRoughnessMap', 1]), 4);
  assert.equal(maskOf(['emissiveMap', 1]), 8);
  assert.equal(maskOf(['map', 1], ['emissiveMap', 1], ['metallicRoughnessMap', 1], ['normalMap', 1]), 15);
  assert.equal(maskOf(['map', 1], ['emissiveMap', 1], ['metallicRoughnessMap', 0]), 9);
});

test('the packed material record stores the mask in the slot the kernels read', () => {
  const part = mixedPart(0);
  part.material.normalMap.uvChannel = 1;
  part.material.emission = 1;
  part.material.emissiveMap = { image: RED_GREEN, colorSpace: 'srgb', uvChannel: 1 };
  const scene = buildTraceScene([part]);
  const table = packMaterials(scene.materials, packAtlas(scene.materials));
  assert.equal(table.data[UV_SET_SLOT], 10);
  assert.equal(UV_SET_SLOT, 5 * 4 + 2, 'material texel 5, third channel: flagsTwo.z in the kernels');
});

test('a scene without a second UV set packs zeros and an empty mask', () => {
  const part = mixedPart(0);
  delete part.geometry.lightUvs;
  const scene = buildTraceScene([part]);
  const { data } = packTriangles(scene, { secondUvSet: true });
  assert.deepEqual(Array.from(data.subarray(9 * 4, 9 * 4 + 4)), [0, 0, 0, 0]);
  assert.equal(packMaterials(scene.materials, packAtlas(scene.materials)).data[UV_SET_SLOT], 0);
});

test('both GPU kernels pick the UV set of each map from the material mask', () => {
  for (const source of [buildFragmentSource(), MEGAKERNEL_SOURCE]) {
    for (const bit of [1, 2, 4, 8]) assert.ok(source.includes(`mapReadsSecondUvSet(flagsTwo.z, ${bit})`), `bit ${bit}`);
    assert.match(source, /secondSetThird = vec2(<f32>)?\((fetchData\(uTriangles, base \+ 1\)|triangles\[base \+ 1\])\.w, (fetchData\(uTriangles, base \+ 2\)|triangles\[base \+ 2\])\.w\)/);
  }
});

test('the alpha pass of both kernels reads the second set for a base colour on TEXCOORD_1', () => {
  for (const source of [buildFragmentSource(), MEGAKERNEL_SOURCE]) {
    const alphaPass = source.slice(source.indexOf('alphaAtNearestHit'));
    assert.match(alphaPass, /mapReadsSecondUvSet\((fetchData\(uMaterials, material \+ 5\)|materials\[material \+ 5\])\.z, 1\)/);
    assert.match(alphaPass, /secondSetCorners\.zw/);
    assert.match(alphaPass, /(base \+ 2\)|base \+ 2\])\.w/);
  }
});

test('a map on TEXCOORD_1 without lightUvs is refused with a message that says what to set', () => {
  const part = mixedPart(1);
  delete part.geometry.lightUvs;
  assert.throws(() => buildTraceScene([part]), /Part floor has a map with uvChannel 1 but its geometry has no lightUvs.*uvChannel 0/);
});

test('a part without lightUvs is refused even when another part in the scene has them', () => {
  const bare = mixedPart(1);
  delete bare.geometry.lightUvs;
  assert.throws(() => buildTraceScene([mixedPart(1), bare]), /lightUvs/);
});

test('a layer map or emissive map on TEXCOORD_1 without lightUvs is refused', () => {
  const emissive = mixedPart(0);
  delete emissive.geometry.lightUvs;
  emissive.material.emission = 1;
  emissive.material.emissiveMap = { image: RED_GREEN, colorSpace: 'srgb', uvChannel: 1 };
  assert.throws(() => buildTraceScene([emissive]), /lightUvs/);
  const layered = mixedPart(0);
  delete layered.geometry.lightUvs;
  layered.material.layerMaps = { clearcoatTexture: { image: RED_GREEN, colorSpace: 'linear', uvChannel: 1 } };
  assert.throws(() => buildTraceScene([layered]), /lightUvs/);
});

// A normal map tilted along the tangent. The two UV sets run in opposite directions along x, so the tangent flips.
const TILTED_NORMAL = { data: new Uint8Array([255, 128, 255, 255]), width: 1, height: 1 };
const SLANTED_SUN = { keyColor: [3, 3, 3], lightDirection: [1, 1, 0] };

function tiltedPart({ normalChannel, uvsRunRight }) {
  const geometry = floorQuad();
  const forward = new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]);
  const backward = new Float32Array([1, 0, 0, 0, 0, 1, 1, 1]);
  geometry.uvs = uvsRunRight ? forward : backward;
  geometry.lightUvs = uvsRunRight ? backward : forward;
  return {
    name: 'tilted',
    geometry,
    material: {
      tag: 'surface', metallic: 0, roughness: 1, emission: 0, color: [1, 1, 1],
      normalMap: { image: TILTED_NORMAL, colorSpace: 'linear', uvChannel: normalChannel },
    },
  };
}

async function slantedBrightness(part) {
  const image = await renderPathTracedImage(
    { parts: [part], environment: SLANTED_SUN, camera: LOOKING_DOWN },
    { width: 16, height: 16, samples: 4, bounces: 1, denoise: false, threads: 1 },
  );
  const centre = (8 * 16 + 8) * 3;
  return image.linear[centre] + image.linear[centre + 1] + image.linear[centre + 2];
}

test('a normal map on TEXCOORD_1 follows the second UV set, not the first', async () => {
  const secondSetRunsLeft = await slantedBrightness(tiltedPart({ normalChannel: 1, uvsRunRight: true }));
  const sameFrameOnFirstSet = await slantedBrightness(tiltedPart({ normalChannel: 0, uvsRunRight: false }));
  const firstSetRunsRight = await slantedBrightness(tiltedPart({ normalChannel: 0, uvsRunRight: true }));
  assert.ok(Math.abs(secondSetRunsLeft - sameFrameOnFirstSet) < 0.05 * sameFrameOnFirstSet, `${secondSetRunsLeft} against ${sameFrameOnFirstSet}`);
  assert.ok(Math.abs(secondSetRunsLeft - firstSetRunsRight) > 0.2 * firstSetRunsRight, `${secondSetRunsLeft} against ${firstSetRunsRight}`);
});

test('an emissive map on TEXCOORD_1 emits the colour of the second set', async () => {
  const part = mixedPart(0);
  part.material.color = [0, 0, 0];
  part.material.emission = 2;
  part.material.emissiveColor = [1, 1, 1];
  part.material.emissiveMap = { image: RED_GREEN, colorSpace: 'srgb', uvChannel: 1 };
  const [red, green] = await centrePixel(part);
  assert.ok(green > 0.1, `green ${green}`);
  assert.ok(red < green * 0.05, `red ${red} against green ${green}`);
});

test('a map the tracer never reads does not demand lightUvs', () => {
  const idleEmissive = mixedPart(0);
  delete idleEmissive.geometry.lightUvs;
  idleEmissive.material.emissiveMap = { image: RED_GREEN, colorSpace: 'srgb', uvChannel: 1 };
  assert.doesNotThrow(() => buildTraceScene([idleEmissive]));
  const sheen = mixedPart(0);
  delete sheen.geometry.lightUvs;
  sheen.material.layerMaps = { sheenColorTexture: { image: RED_GREEN, colorSpace: 'srgb', uvChannel: 1 } };
  assert.doesNotThrow(() => buildTraceScene([sheen]));
});

test('the flattened scene hands the second UV set to the native packer as uv1s', () => {
  const scene = buildTraceScene([mixedPart(1)]);
  assert.equal(scene.uv1s, scene.uvs1);
  assert.equal(scene.uv1s[0], 0.75);
  const bare = mixedPart(0);
  delete bare.geometry.lightUvs;
  assert.equal(buildTraceScene([bare]).uv1s, undefined, 'no second set, no uv1s');
});

function sharedGeometryParts(withLightUvs) {
  const geometry = floorQuad();
  if (!withLightUvs) delete geometry.lightUvs;
  return ['left', 'right'].map(name => ({ ...mixedPart(1), name, geometry }));
}

test('an instanced scene hands lightUvs to the native packer as uv1s and keeps copies sharing one geometry', () => {
  const scene = buildTraceScene(sharedGeometryParts(true), undefined, { instancing: true });
  assert.ok(scene.instances, 'the scene is instanced');
  const [first, second] = scene.instances;
  assert.equal(first.geometry, second.geometry);
  assert.equal(first.geometry.uv1s[0], 0.75);
});

test('an instanced scene with two parts sharing geometry without lightUvs refuses a uvChannel 1 map', () => {
  assert.throws(
    () => buildTraceScene(sharedGeometryParts(false), undefined, { instancing: true }),
    /Part left has a map with uvChannel 1 but its geometry has no lightUvs.*uvChannel 0/,
  );
});

const NATIVE_CAMERA = { eye: [0, 3, 0], target: [0, 0, 0], up: [0, 0, -1], fov: 40 };
const NATIVE_OPTIONS = { width: 4, height: 4, samples: 1 };
const cook = await cookModule();

// The second UV pair of the quad sits at 0.75 in every corner, so each packed corner adds one float of 0.75.
function secondSetCornerCount(scene) {
  const { buffer, byteOffset, byteLength } = cook.buildNativeInputV2(scene, NATIVE_CAMERA, NATIVE_OPTIONS).triangles;
  const floats = new Float32Array(buffer.slice(byteOffset, byteOffset + byteLength));
  return floats.filter(value => value === 0.75).length;
}

cookTest('the native packer reads TEXCOORD_1 of a flattened scene', () => {
  assert.equal(secondSetCornerCount(buildTraceScene([mixedPart(1)])), 6);
});

cookTest('the native packer reads TEXCOORD_1 of an instanced scene', () => {
  assert.equal(secondSetCornerCount(buildTraceScene(sharedGeometryParts(true), undefined, { instancing: true })), 6);
});

const SECOND_UV_SET_SAMPLER_BIT = 1 << 21;
const TEXTURE_SAMPLER_WORD_INDEX = 3;

// Counts the packed texture descriptors whose sampler word asks the native kernel to read uv1s.
function mapsOnSecondUvSet(scene) {
  const { textureDescriptors, textureCount } = cook.buildNativeInputV2(scene, NATIVE_CAMERA, NATIVE_OPTIONS);
  const words = new Uint32Array(textureDescriptors.buffer.slice(textureDescriptors.byteOffset, textureDescriptors.byteOffset + textureDescriptors.byteLength));
  const wordsPerDescriptor = words.length / textureCount;
  let count = 0;
  for (let offset = TEXTURE_SAMPLER_WORD_INDEX; offset < words.length; offset += wordsPerDescriptor) {
    if (words[offset] & SECOND_UV_SET_SAMPLER_BIT) count += 1;
  }
  return count;
}

cookTest('only the TEXCOORD_1 map of a flattened scene selects the second UV set in the native input', () => {
  assert.equal(mapsOnSecondUvSet(buildTraceScene([mixedPart(1)])), 1);
  assert.equal(mapsOnSecondUvSet(buildTraceScene([mixedPart(0)])), 0);
});

cookTest('only the TEXCOORD_1 map of an instanced scene selects the second UV set in the native input', () => {
  assert.equal(mapsOnSecondUvSet(buildTraceScene(sharedGeometryParts(true), undefined, { instancing: true })), 1);
});

cookTest('a baked part in an instanced scene keeps its second UV set and the descriptor bit in the native input', () => {
  const sharedPair = sharedGeometryParts(true);
  const bakedGeometry = floorQuad();
  bakedGeometry.triangleMaterial = new Uint32Array([0, 0]);
  const bakedPart = { ...mixedPart(1), name: 'baked', geometry: bakedGeometry };
  const scene = buildTraceScene([...sharedPair, bakedPart], undefined, { instancing: true });
  const bakedInstance = scene.instances[2];
  assert.notEqual(bakedInstance.geometry, bakedGeometry, 'the part was baked into world space');
  assert.equal(bakedInstance.geometry.uv1s[0], 0.75);
  assert.equal(secondSetCornerCount(scene), 12, 'the shared quad is packed once and the baked quad once, six corner floats each');
  assert.equal(mapsOnSecondUvSet(scene), 1, 'one second-set descriptor for the base colour map the three parts share');
});
