// Emitting local volumes light their surroundings and feed bloom (issue 1046). The pure tests check the flag, the light each volume makes and the
// bound on how many; the browser test draws a lit ground under an emitting sphere in the rasterizer (headless Chrome, SwiftShader, Vite dev
// server) and skips when Chrome cannot start.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { freePort } from './helpers/free-port.js';
import { launchChrome, skipOrThrow } from './helpers/dev-server-browser.js';
import { resolveLocalVolumes } from '../src/local-volumes.js';
import { MAX_POINT_LIGHTS } from '../src/light-limits.js';
import { withVolumeEmissionLights, emissionLightOf, volumeEmitsLight } from '../src/local-volume-lights.js';

const SIZE = 128;
const LOOKING_DOWN = { eye: [0, 8, 0], target: [0, 0, 0], up: [0, 0, -1], fov: 30 };
const FIREBALL = { shape: 'sphere', center: [0, 1.2, 0], radius: 0.8, density: 0, emission: [1, 0.45, 0.1], emissionStrength: 4, blur: 0 };

test('emissionLight defaults to true, takes a boolean and rejects the rest with the field name', () => {
  assert.equal(resolveLocalVolumes([FIREBALL])[0].emissionLight, true);
  assert.equal(resolveLocalVolumes([{ ...FIREBALL, emissionLight: false }])[0].emissionLight, false);
  assert.throws(() => resolveLocalVolumes([{ ...FIREBALL, emissionLight: 'no' }]), /emissionLight must be true or false/);
});

test('an emitting sphere makes a point light at its centre: emission colour, intensity emission times strength times volume', () => {
  const light = emissionLightOf(resolveLocalVolumes([FIREBALL])[0]);
  assert.deepEqual(light.position, [0, 1.2, 0]);
  assert.deepEqual(light.color, [1, 0.45, 0.1]);
  const sphereVolume = (4 / 3) * Math.PI * 0.8 ** 3;
  assert.ok(Math.abs(light.intensity - 4 * sphereVolume) < 1e-9, `intensity ${light.intensity}`);
  assert.ok(light.radius >= 0.05);
  const doubled = emissionLightOf(resolveLocalVolumes([{ ...FIREBALL, emissionStrength: 8 }])[0]);
  assert.ok(Math.abs(doubled.intensity - 2 * light.intensity) < 1e-9);
});

test('a volume lights the scene only when it emits, has strength and keeps its light on', () => {
  const [lit, noStrength, dark, off] = resolveLocalVolumes([FIREBALL, { ...FIREBALL, emissionStrength: 0 }, { ...FIREBALL, emission: [0, 0, 0] }, { ...FIREBALL, emissionLight: false }]);
  assert.deepEqual([lit, noStrength, dark, off].map(volumeEmitsLight), [true, false, false, false]);
});

test('a scene with no emitting volume gets its own environment object back, and the flag off adds no light', () => {
  const plain = { localVolumes: [{ ...FIREBALL, emission: [0, 0, 0] }], pointLights: [{ position: [0, 3, 0] }] };
  assert.equal(withVolumeEmissionLights(plain, [], 0), plain);
  const flagOff = { localVolumes: [{ ...FIREBALL, emissionLight: false }] };
  assert.equal(withVolumeEmissionLights(flagOff, [], 0), flagOff);
  const lit = withVolumeEmissionLights({ localVolumes: [FIREBALL], pointLights: [{ position: [0, 3, 0] }] }, [], 0);
  assert.equal(lit.pointLights.length, 2);
  assert.deepEqual(lit.pointLights[0].position, [0, 3, 0], 'the scene own lights keep their slots');
});

test('the lights follow the volume: a box volume lights from its own centre at each frame', () => {
  const at = center => withVolumeEmissionLights({ localVolumes: [{ shape: 'box', center, size: [1, 1, 1], emission: [1, 1, 1] }] }, [], 0).pointLights[0].position;
  assert.deepEqual(at([0, 1, 0]), [0, 1, 0]);
  assert.deepEqual(at([2, 1, -3]), [2, 1, -3]);
});

test('over the point light limit the scene lights stay and the brightest volumes win the rest', () => {
  const named = Array.from({ length: MAX_POINT_LIGHTS - 2 }, (_, index) => ({ position: [index, 5, 0] }));
  const volumes = [1, 9, 4].map((strength, index) => ({ ...FIREBALL, center: [index * 3, 1, 0], emissionStrength: strength }));
  const lit = withVolumeEmissionLights({ localVolumes: volumes, pointLights: named }, [], 0);
  assert.equal(lit.pointLights.length, MAX_POINT_LIGHTS);
  assert.deepEqual(lit.pointLights.slice(-2).map(light => light.position[0]), [3, 6], 'strength 9 then strength 4 win; strength 1 is dropped');
  const full = withVolumeEmissionLights({ localVolumes: volumes, pointLights: Array.from({ length: MAX_POINT_LIGHTS }, () => ({ position: [0, 5, 0] })) }, [], 0);
  assert.equal(full.pointLights.length, MAX_POINT_LIGHTS, 'a scene that already fills the limit gets no volume light');
});

async function startServer(port) {
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The dev server did not start.')), 30000);
    server.stdout.on('data', (data) => {
      if (/ready in/.test(data.toString())) {
        clearTimeout(timeout);
        resolve();
      }
    });
    server.on('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`The dev server exited ${code}.`));
    });
  });
  return server;
}

// Draws a grey lit ground (no key, fill or ambient light, so only the point lights reach it) and the volumes; returns the linear red, green
// and blue of every pixel, top row first.
async function drawRaster(page, volumes, effects = {}) {
  const task = async ({ size, camera, volumes: localVolumes, effects: frameEffects }) => {
    const { box } = await import('/src/geometry.js');
    const { CrucibleRenderer } = await import('/src/renderer.js');
    const { createFloatOutput, readFloatPixels } = await import('/src/float-output.js');
    await import('/src/fog-shader.js');
    document.body.innerHTML = '';
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    document.body.append(canvas);
    const ground = { name: 'ground', geometry: box(0, 1), matrix: new Float32Array([40, 0, 0, 0, 0, 0.2, 0, 0, 0, 0, 40, 0, 0, -0.1, 0, 1]), material: { color: [0.5, 0.5, 0.5], metallic: 0, roughness: 1, emission: 0 } };
    const renderer = new CrucibleRenderer(canvas, [ground], { hdr: true, depth: true, samples: 1, pixelRatio: 1, ground: false });
    const output = createFloatOutput(renderer.context, size, size);
    const environment = { keyIntensity: 0, fillIntensity: 0, ambientIntensity: 0, localVolumes };
    renderer.render({ ...camera, time: 0, effects: frameEffects, environment, outputFramebuffer: output.framebuffer });
    const pixels = Array.from(readFloatPixels(renderer.context, output.framebuffer, size, size));
    const glError = renderer.context.getError();
    output.dispose();
    renderer.dispose?.();
    return { pixels, glError };
  };
  const { pixels, glError } = await page.evaluate(task, { size: SIZE, camera: LOOKING_DOWN, volumes, effects });
  assert.equal(glError, 0);
  return pixels;
}

function regionMean(pixels, columns, rows) {
  let total = 0;
  let count = 0;
  for (let row = rows[0]; row < rows[1]; row++) {
    for (let column = columns[0]; column < columns[1]; column++) {
      total += pixels[(row * SIZE + column) * 4];
      count++;
    }
  }
  return total / count;
}

// The ground well clear of the sphere's silhouette: 1.25 to 1.7 m from the axis, while the sphere seen from 8 m covers up to about 0.95 m.
const FAR_GROUND = [[104, 120], [54, 74]];

test('the ground under an emitting sphere volume gets brighter with emissionStrength; with the flag off it draws as before', async (context) => {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    skipOrThrow(context, 'playwright is not installed');
    return;
  }
  const port = await freePort();
  const server = await startServer(port);
  let browser;
  try {
    try {
      browser = await launchChrome(chromium);
    } catch (error) {
      skipOrThrow(context, `Chrome did not start: ${error.message.split('\n')[0]}`);
      return;
    }
    const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
    await page.goto(`http://127.0.0.1:${port}/`);
    const dark = regionMean(await drawRaster(page, []), ...FAR_GROUND);
    assert.equal(dark, 0, 'with no light the ground is black');
    const flagOff = regionMean(await drawRaster(page, [{ ...FIREBALL, emissionStrength: 16, emissionLight: false }]), ...FAR_GROUND);
    assert.equal(flagOff, dark, 'a volume with its light off draws as before');
    const means = [];
    for (const emissionStrength of [1, 4, 16]) means.push(regionMean(await drawRaster(page, [{ ...FIREBALL, emissionStrength }]), ...FAR_GROUND));
    assert.ok(means[0] > 0.001, `strength 1 lights the ground: ${means[0]}`);
    assert.ok(means[1] > means[0] * 1.3 && means[2] > means[1] * 1.3, `the ground brightens with strength: ${means.join(', ')}`);

    // Bloom: the ring of ground just outside the silhouette is black unless the bloom took the glow of the volume (its light is off here, so the ground gets none).
    const ring = [[86, 98], [58, 70]];
    const glowing = { ...FIREBALL, emissionStrength: 40, emissionLight: false };
    const bloom = { bloom: { strength: 1, threshold: 1, radius: 2 } };
    const withoutBloom = regionMean(await drawRaster(page, [glowing]), ...ring);
    const withBloom = regionMean(await drawRaster(page, [glowing], bloom), ...ring);
    assert.ok(withBloom > withoutBloom * 1.05 + 0.01, `bloom lifts the ring around a glowing volume: ${withoutBloom} to ${withBloom}`);
    const noGlow = regionMean(await drawRaster(page, [{ ...glowing, emission: [0, 0, 0] }], bloom), ...ring);
    assert.ok(noGlow < withBloom / 2, `a volume that does not emit adds no bloom: ${noGlow}`);
  } finally {
    await browser?.close();
    server.kill();
  }
});
