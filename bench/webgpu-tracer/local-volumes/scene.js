// The volume reference scene of #1048, shared by the Node and the page side of measure.mjs.
import { box } from '../../../src/geometry.js';

export const volumes = [
  { shape: 'box', center: [0, 1.5, 0], size: [3, 1.5, 3], density: 1.2, falloff: 0.3, absorption: [0.7, 0.8, 1], emission: [0.2, 0.1, 0], emissionStrength: 2, scatter: 0.8, noiseAmount: 0.5, noiseScale: 2, steps: 24 },
  { shape: 'sphere', center: [1, 1, 0], radius: 0.6, density: 2, falloff: 0.5 },
  { shape: 'sphere', center: [-1.2, 0.9, 0.5], radius: 0.5, density: 0.5, emission: [1, 0.4, 0.1], emissionStrength: 3, steps: 16 },
];

export function referenceScene() {
  const matrix = new Float32Array([8, 0, 0, 0, 0, 0.05, 0, 0, 0, 0, 8, 0, 0, 0, 0, 1]);
  const parts = [{ name: 'floor', geometry: box(0, 1), matrix, material: { color: [0.5, 0.5, 0.5] } }];
  const map = { width: 4, height: 2, channels: 3, data: new Float32Array(24).fill(0.15), intensity: 1, rotation: 0 };
  const environment = { localVolumes: volumes, keyColor: [3, 3, 3], lightDirection: [1, 0.6, 0.3], map };
  const camera = { eye: [0, 2.2, 5], target: [0, 1, 0], fov: 45 };
  return { parts, environment, camera };
}

export async function render(backend, width, height, samples) {
  const { renderPathTracedImage } = await import('../../../src/path-tracer.js');
  const started = performance.now();
  const image = await renderPathTracedImage(referenceScene(), { width, height, samples, bounces: 3, seed: 7, backend, denoiser: 'none' });
  return { linear: Array.from(image.linear), seconds: (performance.now() - started) / 1000, report: image.report?.ignored ?? null };
}
