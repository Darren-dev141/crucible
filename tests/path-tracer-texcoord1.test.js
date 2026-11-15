import assert from 'node:assert/strict';
import test from 'node:test';

import { renderPathTracedImage } from '../src/path-tracer.js';
import { buildTraceScene } from '../src/path-tracer-scene.js';
import { materialUvSet, packTriangles } from '../src/path-tracer-gpu-pack.js';

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

test('the GPU triangle table reads the second set for a material whose base colour names it', () => {
  const second = buildTraceScene([mixedPart(1)]);
  const first = buildTraceScene([mixedPart(0)]);
  assert.equal(materialUvSet(second.materials[0]), 1);
  assert.equal(materialUvSet(first.materials[0]), 0);
  assert.equal(packTriangles(second).data[3 * 4 + 3], 0.75);
  assert.equal(packTriangles(first).data[3 * 4 + 3], 0.25);
});
