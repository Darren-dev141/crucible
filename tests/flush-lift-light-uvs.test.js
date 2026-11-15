import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFlushParts } from '../src/coplanar-overlap.js';
import { renderPathTracedImage } from '../src/path-tracer.js';
import { liftRankedTriangles } from '../src/flush-lift.js';

// #1504: the demo room's window-top got NaN in lightUvs. The lightmap unwrap was fine; the path tracer's lift of ranked
// triangles (flush-lift.js) grew the positions with copied vertices but left lightUvs at its old length, and the box
// projection that follows read past its end.
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const CAMERA = { eye: [0, 0, 4], target: [0, 0, 0], up: [0, 1, 0], fov: 30 };
const OPTIONS = { width: 17, height: 17, samples: 1, bounces: 1, denoise: false, threads: 1 };

function bakedQuadPart(name, color, material = {}) {
  const geometry = {
    positions: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    lightUvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    skyVisibility: new Float32Array([0.1, 0.2, 0.3, 0.4]),
    surfaceMasks: new Float32Array([1, 2, 3, 4]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
  return { name, geometry, matrix: new Float32Array(IDENTITY), material: { tag: 'surface', metallic: 0, roughness: 1, color, ...material } };
}

test('a lift copies lightUvs, skyVisibility and surfaceMasks with the vertices it adds', () => {
  const lower = bakedQuadPart('lower', [0.9, 0.1, 0.1]);
  const upper = bakedQuadPart('upper', [0.1, 0.9, 0.1]);
  resolveFlushParts([lower, upper]);
  const lifted = liftRankedTriangles(upper, upper.geometry);
  const vertexCount = lifted.positions.length / 3;
  assert.equal(vertexCount, 4 + 6);
  assert.equal(lifted.lightUvs.length, vertexCount * 2);
  assert.equal(lifted.skyVisibility.length, vertexCount);
  assert.equal(lifted.surfaceMasks.length, vertexCount);
  assert.ok(lifted.lightUvs.every(Number.isFinite), 'every lightUvs value is finite');
  assert.deepEqual(Array.from(lifted.lightUvs.slice(8, 14)), [0, 0, 1, 0, 1, 1], 'a copied corner keeps the lightUvs of the vertex it came from');
});

test('a ranked, box-projected part with baked lightUvs reaches the path tracer with finite lightUvs', async () => {
  const lower = bakedQuadPart('lower', [0.9, 0.1, 0.1]);
  const upper = bakedQuadPart('upper', [0.1, 0.9, 0.1], { boxMapScale: 1 });
  resolveFlushParts([lower, upper]);
  await renderPathTracedImage({ parts: [lower, upper], environment: { keyColor: [1, 1, 1], lightDirection: [0, 0, 1] }, camera: CAMERA }, OPTIONS);
});

test('the path tracer refuses lightUvs that are not finite', async () => {
  const part = bakedQuadPart('window-top', [0.5, 0.5, 0.5]);
  part.geometry.lightUvs[3] = Number.NaN;
  await assert.rejects(
    renderPathTracedImage({ parts: [part], environment: { keyColor: [1, 1, 1], lightDirection: [0, 0, 1] }, camera: CAMERA }, OPTIONS),
    /Part window-top lightUvs must be finite numbers/,
  );
});
