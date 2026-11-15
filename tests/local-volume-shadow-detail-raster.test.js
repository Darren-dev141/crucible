// Density-following self-shadow (#1047): shadowDetail makes a noisy smoke box shade by its own density along the sun, in the rasterizer.
// It skips when Chrome cannot start. Set SHADOW_DETAIL_ARTIFACTS to a folder to write the before and after stills there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { freePort } from './helpers/free-port.js';
import { launchChrome, skipOrThrow } from './helpers/dev-server-browser.js';
import { encodePng } from '../src/export-png.js';

const SIZE = 96;
const STILL_SIZE_DEFAULT = SIZE;
const STILL_SIZE = 512;
const DIFFERENCE_GAIN = 8;

async function startServer(port) {
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The dev server did not start.')), 30000);
    server.stdout.on('data', data => {
      if (/ready in/.test(data.toString())) {
        clearTimeout(timeout);
        resolve();
      }
    });
    server.on('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`The dev server exited ${code}.`));
    });
  });
  return server;
}

const SMOKE = { shape: 'box', center: [0, 1.5, 0], size: [2.2, 1.5, 2.2], density: 2.4, falloff: 0.3, absorption: [0.7, 0.8, 1], scatter: 0.8, noiseAmount: 0.9, noiseScale: 2, steps: 32 };
const SUN = { keyColor: [3, 3, 3], lightDirection: [1, 0.1, 0], keyIntensity: 1, fillIntensity: 0, skyTop: [0.15, 0.15, 0.15], skyBottom: [0.15, 0.15, 0.15] };
const LOOKING_DOWN = { eye: [0, 3, 0], target: [0, 0, 0], up: [0, 0, -1], fov: 40 };

async function rasterFrames(page, volumeLists, size = SIZE) {
  const task = async ({ size, lists, camera, light }) => {
    const { box } = await import('/src/geometry.js');
    const { CrucibleRenderer } = await import('/src/renderer.js');
    const { createFloatOutput, readFloatPixels } = await import('/src/float-output.js');
    await import('/src/fog-shader.js');
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    canvas.style.width = size + 'px';
    canvas.style.height = size + 'px';
    document.body.append(canvas);
    const material = { tag: 'unlit', color: [0.02, 0.02, 0.02], metallic: 0, roughness: 1, emission: 0 };
    const ground = { name: 'ground', geometry: box(0, 1), matrix: new Float32Array([40, 0, 0, 0, 0, 0.2, 0, 0, 0, 0, 40, 0, 0, -0.1, 0, 1]), material };
    const renderer = new CrucibleRenderer(canvas, [ground], { hdr: true, depth: true, samples: 1, pixelRatio: 1, ground: false });
    const output = createFloatOutput(renderer.context, size, size);
    const frames = lists.map(localVolumes => {
      renderer.render({ ...camera, time: 0, environment: { ...light, localVolumes }, outputFramebuffer: output.framebuffer });
      return Array.from(readFloatPixels(renderer.context, output.framebuffer, size, size));
    });
    const glError = renderer.context.getError();
    output.dispose();
    renderer.dispose?.();
    return { frames, glError };
  };
  return page.evaluate(task, { size, lists: volumeLists, camera: LOOKING_DOWN, light: SUN });
}

// Mean green of the left (away from the sun) and right (toward the sun) halves of the middle band, where the smoke box is.
function halfMeans(frame) {
  const sums = [0, 0];
  const counts = [0, 0];
  for (let row = SIZE / 4; row < (SIZE * 3) / 4; row++) {
    for (let column = SIZE / 4; column < (SIZE * 3) / 4; column++) {
      const side = column < SIZE / 2 ? 0 : 1;
      sums[side] += frame[(row * SIZE + column) * 4 + 1];
      counts[side]++;
    }
  }
  return { far: sums[0] / counts[0], near: sums[1] / counts[1] };
}

// Standard deviation of the green channel over the middle band after the left to right trend of the sun is removed: how much structure the shading has.
function detailOf(frame) {
  const rows = [];
  for (let row = SIZE / 4; row < (SIZE * 3) / 4; row++) {
    const values = [];
    for (let column = SIZE / 4; column < (SIZE * 3) / 4; column++) values.push(frame[(row * SIZE + column) * 4 + 1]);
    rows.push(values);
  }
  const columnCount = rows[0].length;
  let total = 0;
  let count = 0;
  for (let column = 0; column < columnCount; column++) {
    const mean = rows.reduce((sum, values) => sum + values[column], 0) / rows.length;
    for (const values of rows) {
      total += (values[column] - mean) ** 2;
      count++;
    }
  }
  return Math.sqrt(total / count);
}

function writeStill(path, frames, SIZE = STILL_SIZE_DEFAULT) {
  const pixels = new Uint8Array(SIZE * frames.length * SIZE * 4);
  frames.forEach((frame, index) => {
    for (let row = 0; row < SIZE; row++) {
      for (let column = 0; column < SIZE; column++) {
        const from = ((SIZE - 1 - row) * SIZE + column) * 4;
        const to = (row * SIZE * frames.length + index * SIZE + column) * 4;
        for (let channel = 0; channel < 3; channel++) pixels[to + channel] = Math.round(Math.max(0, Math.min(1, frame[from + channel])) * 255);
        pixels[to + 3] = 255;
      }
    }
  });
  writeFileSync(path, encodePng(pixels, SIZE * frames.length, SIZE));
}

// The two frames side by side and, as a third panel, their absolute difference times DIFFERENCE_GAIN.
function writeComparisonStill(path, before, after, size) {
  const difference = before.map((value, index) => (index % 4 === 3 ? 1 : Math.abs(after[index] - value) * DIFFERENCE_GAIN));
  writeStill(path, [before, after, difference], size);
}

test('shadowDetail makes the side of a noisy smoke box away from the sun darker than its sunlit side, and off draws as before', async context => {
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
      skipOrThrow(context, 'Chrome did not start: ' + error.message.split('\n')[0]);
      return;
    }
    const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
    await page.goto('http://127.0.0.1:' + port + '/');
    const { frames: [unnamed, off, on], glError } = await rasterFrames(page, [[SMOKE], [{ ...SMOKE, shadowDetail: false }], [{ ...SMOKE, shadowDetail: true }]]);
    assert.equal(glError, 0);
    assert.deepEqual(off, unnamed, 'shadowDetail false must draw exactly as a volume that does not name the field');
    const smooth = halfMeans(off);
    const detailed = halfMeans(on);
    const smoothRatio = smooth.far / smooth.near;
    const detailedRatio = detailed.far / detailed.near;
    assert.notDeepEqual(on, off);
    const folder = process.env.SHADOW_DETAIL_ARTIFACTS;
    if (folder) {
      mkdirSync(folder, { recursive: true });
      const { frames: [stillOff, stillOn] } = await rasterFrames(page, [[{ ...SMOKE, shadowDetail: false }], [{ ...SMOKE, shadowDetail: true }]], STILL_SIZE);
      writeComparisonStill(join(folder, 'shadow-detail-before-after.png'), stillOff, stillOn, STILL_SIZE);
      writeFileSync(join(folder, 'shadow-detail.json'), JSON.stringify({ volume: SMOKE, farOverNear: { off: smoothRatio, on: detailedRatio }, structure: { off: detailOf(off), on: detailOf(on) }, note: 'Left: shadowDetail false. Middle: true. Right: absolute difference times 8 (512 px panels, the pass assertions use 96 px). Smoke box seen from above, sun from +x (the right half), 96 px rasterizer.' }, null, 2) + '\n');
    }
    assert.ok(detailedRatio < 0.85, 'far side over near side is ' + detailedRatio + ' with shadowDetail and ' + smoothRatio + ' without');
    assert.ok(detailOf(on) > detailOf(off) * 1.05, 'shadowDetail should add shading structure: ' + detailOf(on) + ' against ' + detailOf(off));
  } finally {
    await browser?.close();
    server.kill();
  }
});
