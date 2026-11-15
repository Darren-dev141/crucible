import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { box } from '../src/geometry.js';
import { bakeAgentParts, normalizeAgentBake } from '../src/agent-bake.js';
import { lightmapBytes } from './support/agent-bake-rooms.mjs';
import { IRRADIANCE_GRID_LIMITS } from '../src/irradiance-grid.js';

// #1218: environment.keyAffects (sun light linking) must reach the recipe bake, and the irradiance grid range must fit the node cap.

const cube = box(0, 1);

function placed(name, translation, scale) {
  const matrix = new Float32Array([scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, translation[0], translation[1], translation[2], 1]);
  return { name, geometry: cube, matrix, material: { tag: 'surface', color: [0.8, 0.8, 0.8], metallic: 0, roughness: 0.8, emission: 0 } };
}

function bakeFor(keyAffects, bakeSettings) {
  const parts = [placed('floor', [0, -0.05, 0], [4, 0.1, 4]), placed('wall', [0, 1.5, -2.05], [4.2, 3.2, 0.1])];
  const environment = {
    keyColor: [3, 3, 3], lightDirection: [0.2, 1, 0.3], skyTop: [0.2, 0.3, 0.6], skyBottom: [0.4, 0.4, 0.4],
    pointLights: [], spotLights: [], areaLights: [], keyAffects,
  };
  const settings = normalizeAgentBake({ preset: 'draft', probes: false, ...bakeSettings });
  return { parts, result: bakeAgentParts(parts, new Map(parts.map(part => [part.name, part.matrix])), environment, settings) };
}

function bakedLightFor(keyAffects) {
  const { result } = bakeFor(keyAffects, {});
  const lightSum = name => {
    const part = result.parts.find(candidate => candidate.name === name);
    const lightmap = part.material.emissiveMap ? lightmapBytes(part) : [];
    return Array.from(lightmap).reduce((sum, value) => sum + value, 0);
  };
  return { floor: lightSum('floor'), wall: lightSum('wall') };
}

test('the sun link changes what each part bakes (#1218)', () => {
  const unlinked = bakedLightFor(undefined);
  assert.ok(unlinked.floor > 0 && unlinked.wall > 0, 'the unlinked sun lights both parts');
  // Only the sun's bounce is baked: a part the sun skips sends none, so its neighbour gets nothing.
  const floorOnly = bakedLightFor(['floor']);
  assert.equal(floorOnly.floor, 0);
  assert.ok(floorOnly.wall > 0);
  const wallOnly = bakedLightFor(['wall']);
  assert.ok(wallOnly.floor > 0);
  assert.equal(wallOnly.wall, 0);
  assert.deepEqual(bakedLightFor([]), { floor: 0, wall: 0 });
});

test('the sun link reaches the irradiance grid bake (#1218)', () => {
  const gridSum = keyAffects => {
    const { result } = bakeFor(keyAffects, { irradianceGrid: 8 });
    return Array.from(result.parts[0].material.irradianceGrid.data).reduce((sum, value) => sum + Math.abs(value), 0);
  };
  assert.ok(gridSum(undefined) > 0, 'the unlinked sun lights the grid');
  assert.ok(gridSum([]) < gridSum(undefined), 'a sun linked to no part adds no sun light to the grid');
});

test('the recipe refuses an irradiance grid node count whose cube passes the node cap (#1218)', () => {
  const [, maximum] = IRRADIANCE_GRID_LIMITS.resolution;
  assert.ok(maximum ** 3 <= IRRADIANCE_GRID_LIMITS.maxNodes);
  assert.ok((maximum + 1) ** 3 > IRRADIANCE_GRID_LIMITS.maxNodes);
  assert.equal(normalizeAgentBake({ irradianceGrid: maximum }).irradianceGrid, maximum);
  assert.throws(() => normalizeAgentBake({ irradianceGrid: maximum + 1 }), /bake\.irradianceGrid.*8 to 40/);
});
