// Renders the volume reference scene of #1048 on cpu (Node) and webgpu (Chrome), writes the raw frames and the frame times to the folder in argv[2]. Run through gpu-lock, then score with flip.py: uv run --no-project --with flip-evaluator --with numpy --with pillow python bench/webgpu-tracer/local-volumes/flip.py <folder>.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { freePort } from '../../../tests/helpers/free-port.js';
import { render } from './scene.js';

const outputFolder = `${process.argv[2] ?? 'artifacts/webgpu-local-volumes'}/`;
mkdirSync(outputFolder, { recursive: true });
const save = (name, linear) => writeFileSync(`${outputFolder}${name}.f32`, Buffer.from(new Float32Array(linear).buffer));
const port = await freePort();
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { stdio: ['ignore', 'pipe', 'pipe'] });
await new Promise(resolve => server.stdout.on('data', data => /ready in/.test(data.toString()) && resolve()));
const browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--use-angle=d3d11', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage();
await page.goto(`http://127.0.0.1:${port}/`);
const onGpu = (width, height, samples) => page.evaluate(async ({ width, height, samples }) => {
  const scene = await import('/bench/webgpu-tracer/local-volumes/scene.js');
  return scene.render('webgpu', width, height, samples);
}, { width, height, samples });
const timing = {};
const cpuStill = await render('cpu', 480, 300, 32);
const gpuStill = await onGpu(480, 300, 32);
save('cpu', cpuStill.linear);
save('webgpu', gpuStill.linear);
timing.still480x300At32 = { cpuSeconds: cpuStill.seconds, webgpuSeconds: gpuStill.seconds };
const cpuBig = await render('cpu', 1920, 1080, 4);
await onGpu(1920, 1080, 1);
const gpuBig = await onGpu(1920, 1080, 4);
timing.frame1080pAt4 = { cpuSeconds: cpuBig.seconds, webgpuSeconds: gpuBig.seconds };
writeFileSync(`${outputFolder}timing.json`, JSON.stringify(timing, null, 2));
console.log(JSON.stringify(timing));
await browser.close();
server.kill();
