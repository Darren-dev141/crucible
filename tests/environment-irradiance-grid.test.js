import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createEnvironmentMap,
  computeIrradianceCoefficients,
  computeIrradianceGrid,
  evaluateIrradiance,
  ENVIRONMENT_IRRADIANCE_HEIGHT,
  ENVIRONMENT_IRRADIANCE_WIDTH,
} from '../src/environment.js';
import { parseRadianceHdr } from '../src/hdri.js';
import { evaluateIrradianceGrid } from './fixtures/irradiance-grid-lookup.js';
import { environmentShadingGlsl } from '../src/environment-shading.js';

function loadSkyClouds() {
  const bytes = readFileSync(fileURLToPath(new URL('../assets/looks/sky-clouds.hdr', import.meta.url)));
  const parsed = parseRadianceHdr(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
  return createEnvironmentMap({ width: parsed.width, height: parsed.height, data: parsed.data });
}

// The cosine integral over every texel of the full map, divided by pi: the light a white surface facing `normal` sends back.
function bruteForceIrradiance(map, normal) {
  const { width, height, data, channels } = map;
  const sum = [0, 0, 0];
  const pixelSolidAngleScale = (2 * Math.PI / width) * (Math.PI / height);
  for (let row = 0; row < height; row++) {
    const polar = (row + 0.5) / height * Math.PI;
    const sinePolar = Math.sin(polar);
    for (let column = 0; column < width; column++) {
      const azimuth = ((column + 0.5) / width - 0.5) * 2 * Math.PI;
      const cosine = sinePolar * Math.sin(azimuth) * normal[0] + Math.cos(polar) * normal[1] - sinePolar * Math.cos(azimuth) * normal[2];
      if (cosine <= 0) continue;
      const weight = cosine * sinePolar * pixelSolidAngleScale / Math.PI;
      for (let channel = 0; channel < 3; channel++) sum[channel] += data[(row * width + column) * channels + channel] * weight;
    }
  }
  return sum;
}

function relativeError(value, exact) {
  return Math.abs(value / exact - 1);
}

test('irradiance grid of sky-clouds.hdr matches the cosine integral where the spherical harmonic fit rings (#1374)', () => {
  const map = loadSkyClouds();
  const grid = computeIrradianceGrid(map);
  const coefficients = computeIrradianceCoefficients(map);
  // The -X direction sits in the sun's shadow: the nine-term fit is 21% low in red here, the grid is exact.
  const normal = [-1, 0, 0];
  const exact = bruteForceIrradiance(map, normal);
  assert.deepEqual(exact.map(value => Number(value.toFixed(3))), [0.205, 0.237, 0.35]);
  const gridValue = evaluateIrradianceGrid(grid, normal);
  for (let channel = 0; channel < 3; channel++) {
    assert.ok(relativeError(gridValue[channel], exact[channel]) < 0.01, `grid channel ${channel} ${gridValue[channel]} against ${exact[channel]}`);
  }
  const harmonic = evaluateIrradiance(coefficients, normal);
  assert.ok(relativeError(harmonic[0], exact[0]) > 0.15, `the old fit should be off here, it gave ${harmonic[0]} against ${exact[0]}`);
});

test('irradiance grid stays within 4% of the cosine integral for normals all around the sky-clouds map', () => {
  const map = loadSkyClouds();
  const grid = computeIrradianceGrid(map);
  let worst = 0;
  for (const elevationDegrees of [-60, -30, 0, 30, 60]) {
    for (let step = 0; step < 8; step++) {
      const elevation = elevationDegrees * Math.PI / 180;
      const azimuth = step / 8 * 2 * Math.PI + 0.3;
      const normal = [Math.cos(elevation) * Math.sin(azimuth), Math.sin(elevation), -Math.cos(elevation) * Math.cos(azimuth)];
      const exact = bruteForceIrradiance(map, normal);
      const gridValue = evaluateIrradianceGrid(grid, normal);
      for (let channel = 0; channel < 3; channel++) worst = Math.max(worst, relativeError(gridValue[channel], exact[channel]));
    }
  }
  assert.ok(worst < 0.04, `worst grid error ${worst}`);
});

test('irradiance grid of a constant map is constant, and of a lit upper half follows the cosine law', () => {
  const constant = createEnvironmentMap({ width: 32, height: 16, data: new Float32Array(32 * 16 * 3).fill(0.75) });
  const constantGrid = computeIrradianceGrid(constant);
  assert.equal(constantGrid.length, ENVIRONMENT_IRRADIANCE_WIDTH * ENVIRONMENT_IRRADIANCE_HEIGHT * 3);
  for (const normal of [[0, 1, 0], [0, -1, 0], [1, 0, 0], [0.577, 0.577, 0.577]]) {
    for (const value of evaluateIrradianceGrid(constantGrid, normal)) assert.ok(Math.abs(value - 0.75) < 0.01, `constant ${value}`);
  }
  const halfData = new Float32Array(64 * 32 * 3);
  for (let row = 0; row < 16; row++) halfData.fill(1, row * 64 * 3, (row + 1) * 64 * 3);
  const half = computeIrradianceGrid(createEnvironmentMap({ width: 64, height: 32, data: halfData }));
  assert.ok(Math.abs(evaluateIrradianceGrid(half, [0, 1, 0])[0] - 1) < 0.05);
  assert.ok(evaluateIrradianceGrid(half, [0, -1, 0])[0] < 0.05);
  assert.ok(Math.abs(evaluateIrradianceGrid(half, [1, 0, 0])[0] - 0.5) < 0.03);
});

test('the shader reads the irradiance grid below the lookup square and wraps it with padding columns', () => {
  assert.match(environmentShadingGlsl, /environmentIrradianceGrid\(mapped\) \+ environmentBounce/);
  assert.match(environmentShadingGlsl, /coordinates\.x \* ENVIRONMENT_IRRADIANCE_SIZE\.x \+ 1\.0/);
  assert.match(environmentShadingGlsl, /vec2\(128\.0, 160\.0\)/);
});
