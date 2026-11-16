import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPathTracedImage } from '../src/path-tracer.js';
import { renderReport, NOISY_RELATIVE_NOISE } from '../scripts/agent-render-estimate.mjs';
import { conciseJobResult } from '../scripts/mcp-response-format.mjs';

const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const CAMERA = { eye: [0, 0, 4], target: [0, 0, 0], up: [0, 1, 0], fov: 30 };

function quad(half, z, color, material = {}) {
  const geometry = {
    positions: new Float32Array([-half, -half, z, half, -half, z, half, half, z, -half, half, z]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
  return { name: `quad-${z}`, geometry, matrix: new Float32Array(IDENTITY_MATRIX), material: { tag: 'surface', metallic: 0, roughness: 1, color, ...material } };
}

// A grey floor lit by a small bright emitter: a few samples per pixel leave visible grain.
async function traceLitScene(samples) {
  const parts = [quad(2, 0, [0.8, 0.8, 0.8]), quad(0.3, 1, [0, 0, 0], { emissive: [8, 8, 8] })];
  const environment = { keyColor: [1, 1, 1], lightDirection: [0.3, 0.3, 1] };
  const options = { width: 48, height: 48, samples, bounces: 3, denoise: false, threads: 1, seed: 7 };
  return (await renderPathTracedImage({ parts, environment, camera: CAMERA }, options)).report;
}

const PATH_SETTINGS = { frameCount: 1, renderer: { type: 'pathTracer', samples: 4 } };

test('a noisy path trace reports a larger noise figure than a clean one, and says what to do', async () => {
  const noisy = await traceLitScene(4);
  const clean = await traceLitScene(64);
  assert.ok(noisy.estimatedNoise > clean.estimatedNoise * 2, `${noisy.estimatedNoise} against ${clean.estimatedNoise}`);
  const noisyReport = renderReport({ settings: PATH_SETTINGS, metrics: { elapsedSeconds: 1, pathTracer: noisy } });
  const cleanReport = renderReport({ settings: PATH_SETTINGS, metrics: { elapsedSeconds: 1, pathTracer: clean } });
  assert.ok(noisyReport.noise.relative > NOISY_RELATIVE_NOISE);
  assert.match(noisyReport.noise.verdict, /^noisy: raise renderer\.samples or set renderer\.denoise/);
  assert.ok(cleanReport.noise.relative < NOISY_RELATIVE_NOISE);
  assert.match(cleanReport.noise.verdict, /^clean enough/);
});

test('a denoised noisy frame is told to raise samples only', async () => {
  const noisy = await traceLitScene(4);
  const report = renderReport({ settings: PATH_SETTINGS, metrics: { elapsedSeconds: 1, pathTracer: { ...noisy, denoised: true } } });
  assert.equal(report.noise.verdict, 'noisy: raise renderer.samples.');
});

test('one sample per pixel has no noise estimate, and the report says so instead of writing 0', async () => {
  const single = await traceLitScene(1);
  assert.equal(single.estimatedNoise, undefined);
  const report = renderReport({ settings: PATH_SETTINGS, metrics: { elapsedSeconds: 1, pathTracer: single } });
  assert.equal(report.noise.relative, null);
  assert.match(report.noise.verdict, /^not measured/);
});

test('raster jobs carry no noise figure, in the full or the concise report', () => {
  const report = renderReport({ settings: { frameCount: 1 }, metrics: { elapsedSeconds: 1 } });
  assert.equal('noise' in report, false);
  const concise = conciseJobResult({ jobId: 'job', artifacts: [], metrics: { report } });
  assert.equal('noise' in concise.metrics.report, false);
});

test('the concise report keeps the noise verdict of a path trace', async () => {
  const report = renderReport({ settings: PATH_SETTINGS, metrics: { elapsedSeconds: 1, pathTracer: await traceLitScene(4) } });
  const concise = conciseJobResult({ jobId: 'job', artifacts: [], metrics: { report } });
  assert.deepEqual(concise.metrics.report.noise, report.noise);
});
