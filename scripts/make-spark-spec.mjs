// Writes the "sparks" block of scripts/cycles-volume-reference.py from the same seeded launches Glaze draws (#1758).
//
//   node scripts/make-spark-spec.mjs <spec.json> <sparks.json> <seconds> <out spec.json>
//
// <sparks.json> is one spark system as a recipe `particles.systems` entry (preset, position, count, ...). The output is the input spec with
// `sparks` added. `sparkMeshAt` is the same system as Glaze draws it, for the reference harness.

import { readFileSync, writeFileSync } from 'node:fs';
import { normalizeAgentParticles, sparkSystemSetup } from '../src/agent-particles.js';
import { buildSparkMesh, SPARK_FADE_FRACTION } from '../src/particle-sparks.js';
import { BLACKBODY_HUE_TABLE, BLACKBODY_RADIANCE_SCALE, BLACKBODY_TABLE_FIRST_KELVIN, BLACKBODY_TABLE_STEP_KELVIN } from '../src/volume-grid.js';

const GRAVITY = [0, -9.81, 0];

export function sparkSetupOf(systemInput) {
  const recipe = { nodes: [{ id: 'sparks', parent: null, geometry: 'speck', material: 'spark', translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }], materials: [{ id: 'spark', tag: 'unlit' }] };
  const normalized = normalizeAgentParticles({ systems: [{ type: 'sparks', node: 'sparks', ...systemInput }] }, recipe);
  const system = normalized.systems[0];
  return { system, ...sparkSystemSetup(system, { gravity: normalized.gravity ?? GRAVITY, wind: normalized.wind ?? [0, 0, 0], fields: [] }) };
}

/** The mesh Glaze draws at `seconds`: positions, normals, colors (radiance) and indices. */
export function sparkMeshAt(systemInput, seconds) {
  const { launches, forces, look } = sparkSetupOf(systemInput);
  return buildSparkMesh(launches, forces, seconds, look);
}

export function sparkBlock(systemInput, seconds) {
  const { system, launches, forces } = sparkSetupOf(systemInput);
  const particles = [];
  for (let index = 0; index < launches.count; index++) {
    particles.push({
      birth: launches.birth[index],
      life: launches.life[index],
      origin: Array.from(launches.origin.subarray(index * 3, index * 3 + 3)),
      velocity: Array.from(launches.velocity.subarray(index * 3, index * 3 + 3)),
      radius: launches.size[index],
      landing: Number.isFinite(launches.landing[index]) ? launches.landing[index] : null,
    });
  }
  return {
    time: seconds,
    gravity: forces.gravity,
    wind: forces.wind,
    drag: system.drag,
    ...(system.floor === undefined ? {} : { floor: system.floor }),
    shutter: system.shutter,
    temperature: system.temperature,
    intensity: system.intensity,
    fadeFraction: SPARK_FADE_FRACTION,
    radianceScale: BLACKBODY_RADIANCE_SCALE,
    blackbodyHue: { firstKelvin: BLACKBODY_TABLE_FIRST_KELVIN, stepKelvin: BLACKBODY_TABLE_STEP_KELVIN, values: Array.from(BLACKBODY_HUE_TABLE) },
    particles,
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/').split('/').pop())) {
  const [specPath, sparksPath, seconds, outputPath] = process.argv.slice(2);
  if (!outputPath) throw new Error('usage: node scripts/make-spark-spec.mjs <spec.json> <sparks.json> <seconds> <out spec.json>');
  const spec = JSON.parse(readFileSync(specPath, 'utf8'));
  const systemInput = JSON.parse(readFileSync(sparksPath, 'utf8'));
  writeFileSync(outputPath, JSON.stringify({ ...spec, sparks: sparkBlock(systemInput, Number(seconds)) }));
}
