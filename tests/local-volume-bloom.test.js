// Bloom sees the glow of emitting local volumes (issue 1046). The pure tests check which packed volumes count as emitting; the browser test
// draws a black ground under a glowing sphere in the rasterizer (headless Chrome, SwiftShader, Vite dev server) and skips when Chrome cannot start.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { freePort } from './helpers/free-port.js';
import { launchChrome, skipOrThrow } from './helpers/dev-server-browser.js';
import { resolveLocalVolumes, createLocalVolumeBuffers, packLocalVolumes, packedVolumesEmit } from '../src/local-volumes.js';

const SIZE = 128;
const LOOKING_DOWN = { eye: [0, 8, 0], target: [0, 0, 0], up: [0, 0, -1], fov: 30 };
const FIREBALL = { shape: 'sphere', center: [0, 1.2, 0], radius: 0.8, density: 0, emission: [1, 0.45, 0.1], emissionStrength: 40, blur: 0 };

function packed(volumes) {
  return packLocalVolumes(resolveLocalVolumes(volumes), createLocalVolumeBuffers());
}

test('packed volumes emit only with a glow colour and strength above zero', () => {
  assert.equal(packedVolumesEmit(packed([])), false);
  assert.equal(packedVolumesEmit(packed([FIREBALL])), true);
  assert.equal(packedVolumesEmit(packed([{ ...FIREBALL, emission: [0, 0, 0] }])), false);
  assert.equal(packedVolumesEmit(packed([{ ...FIREBALL, emissionStrength: 0 }])), false);
  assert.equal(packedVolumesEmit(packed([{ ...FIREBALL, emission: [0, 0, 0] }, FIREBALL])), true, 'one emitting volume among dark ones is enough');
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
    const bloomTargetCount = renderer.bloomTargets.length;
    let sourcePeak = 0;
    if (bloomTargetCount === 3) {
      const gl = renderer.context;
      gl.bindFramebuffer(gl.FRAMEBUFFER, renderer.bloomTargets[2].framebuffer);
      const source = new Float32Array(renderer.bloomWidth * renderer.bloomHeight * 4);
      gl.readPixels(0, 0, renderer.bloomWidth, renderer.bloomHeight, gl.RGBA, gl.FLOAT, source);
      for (let index = 0; index < source.length; index += 4) sourcePeak = Math.max(sourcePeak, source[index]);
    }
    output.dispose();
    renderer.dispose?.();
    return { pixels, glError, bloomTargetCount, sourcePeak };
  };
  const drawn = await page.evaluate(task, { size: SIZE, camera: LOOKING_DOWN, volumes, effects });
  assert.equal(drawn.glError, 0);
  lastBloomTargetCount = drawn.bloomTargetCount;
  lastSourcePeak = drawn.sourcePeak;
  return drawn.pixels;
}

let lastBloomTargetCount = 0;
let lastSourcePeak = 0;

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


// The ring of ground just outside the sphere's silhouette (the sphere seen from 8 m covers up to about 0.95 m). The ground has no light,
// so the ring is black unless bloom took the glow of the volume.
const RING = [[86, 98], [58, 70]];

test('bloom lifts the ground around a glowing volume, and the third bloom target exists only with a glow and bloom both on', async (context) => {
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
    const bloom = { bloom: { strength: 1, threshold: 1, radius: 2 } };
    const withoutBloom = regionMean(await drawRaster(page, [FIREBALL]), ...RING);
    assert.equal(lastBloomTargetCount, 0, 'bloom off allocates no bloom target');
    const withBloom = regionMean(await drawRaster(page, [FIREBALL], bloom), ...RING);
    assert.equal(lastBloomTargetCount, 3, 'a glow with bloom on adds the volume source target');
    assert.ok(withBloom > withoutBloom * 1.05 + 0.01, `bloom lifts the ring around a glowing volume: ${withoutBloom} to ${withBloom}`);
    assert.ok(lastSourcePeak > 10, `the bloom source keeps the volume's linear value above the threshold of 1: peak ${lastSourcePeak}`);
    const noGlow = regionMean(await drawRaster(page, [{ ...FIREBALL, emission: [0, 0, 0] }], bloom), ...RING);
    assert.equal(lastBloomTargetCount, 2, 'a volume that does not emit leaves the two bloom targets');
    assert.ok(noGlow < withBloom / 2, `a volume that does not emit adds no bloom: ${noGlow}`);
  } finally {
    await browser?.close();
    server.kill();
  }
});
