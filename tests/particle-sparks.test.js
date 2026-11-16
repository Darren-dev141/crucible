import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { createParticleLaunches } from '../src/particles.js';
import { SPARK_DEFAULTS, SPARK_FADE_FRACTION, SPARK_LIMITS, buildSparkMesh, sparkKelvin, sparkRadiance, sparkStreakAt } from '../src/particle-sparks.js';
import { BLACKBODY_RADIANCE_SCALE, blackbodyRadiance } from '../src/volume-grid.js';

const LUMINANCE = [0.2126, 0.7152, 0.0722];
const luminanceOf = color => color[0] * LUMINANCE[0] + color[1] * LUMINANCE[1] + color[2] * LUMINANCE[2];

function sparkRecipe(system, extra = {}) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'speck', type: 'box' }],
    materials: [{ id: 'spark', tag: 'unlit', color: [1, 1, 1], emission: 0 }, { id: 'plain', color: [1, 0.5, 0.1], emission: 4 }],
    nodes: [{ id: 'sparks', geometry: 'speck', material: 'spark' }],
    particles: { systems: [{ type: 'sparks', node: 'sparks', ...system }] },
    ...extra,
  };
}

function launchesFor(overrides = {}, forces = {}) {
  return createParticleLaunches({
    count: 4, seed: 5, emitter: { shape: 'point', position: [0, 0, 0] }, lifetime: [1, 1], speed: [10, 10], direction: [1, 0, 0], spreadRadians: 0,
    size: [0.01, 0.01], forces: { gravity: [0, 0, 0], wind: [0, 0, 0], drag: 0, ...forces }, ...overrides,
  });
}

test('a spark cools along the blackbody curve: its colour goes from yellow orange to dark red and its brightness follows sigma T^4', () => {
  const out = [0, 0, 0];
  const temperature = [2500, 800];
  const born = sparkRadiance(0, temperature, 1, [0, 0, 0]);
  const middle = sparkRadiance(0.5, temperature, 1, [0, 0, 0]);
  const old = sparkRadiance(0.85, temperature, 1, [0, 0, 0]);
  // Luminance 1 hue times sigma T^4 / pi: the brightness is the physical one at each temperature.
  assert.ok(Math.abs(luminanceOf(born) - BLACKBODY_RADIANCE_SCALE * 2500 ** 4) < 1e-9);
  assert.ok(Math.abs(luminanceOf(middle) - BLACKBODY_RADIANCE_SCALE * 1650 ** 4) < 1e-9);
  // At 0.85 of the life the spark is at 1055 K, just before its fade starts.
  assert.ok(Math.abs(luminanceOf(old) - BLACKBODY_RADIANCE_SCALE * 1055 ** 4) < 1e-9);
  // The same radiance as the grid fireball at that temperature.
  blackbodyRadiance(2500, out);
  assert.deepEqual(born.map(Number), Array.from(out));
  // Hue: yellow-white at birth, orange in the middle, red at the end; blue never leads.
  // The physical colour of 2500 K is a yellow orange (green about 0.38 of red), 1650 K a deep orange (0.18) and 1055 K a dark red (0.04).
  assert.ok(born[1] / born[0] > 0.3 && born[2] / born[0] > 0.05, 'yellow orange at 2500 K');
  assert.ok(middle[1] / middle[0] < born[1] / born[0] && middle[1] / middle[0] > old[1] / old[0], 'green falls against red while it cools');
  assert.ok(old[1] / old[0] < 0.1 && old[2] === 0, 'dark red near 1000 K, with no blue');
  for (const color of [born, middle, old]) assert.ok(color[0] >= color[1] && color[1] >= color[2]);
  assert.ok(luminanceOf(born) > luminanceOf(middle) * 5 && luminanceOf(middle) > luminanceOf(old) * 5, 'it fades by a large factor each stage');
});

test('the temperature is linear over life and the radiance tapers to zero over the last 15 percent', () => {
  assert.equal(sparkKelvin(0, [2500, 800]), 2500);
  assert.equal(sparkKelvin(0.5, [2500, 800]), 1650);
  assert.equal(sparkKelvin(1, [2500, 800]), 800);
  assert.equal(sparkKelvin(2, [2500, 800]), 800, 'clamped past the end of life');
  const atTaper = sparkRadiance(1 - SPARK_FADE_FRACTION, [2500, 800], 1, [0, 0, 0]);
  const halfway = sparkRadiance(1 - SPARK_FADE_FRACTION / 2, [2500, 800], 1, [0, 0, 0]);
  const full = sparkKelvin(1 - SPARK_FADE_FRACTION / 2, [2500, 800]);
  assert.ok(Math.abs(luminanceOf(halfway) - 0.5 * BLACKBODY_RADIANCE_SCALE * full ** 4) < 1e-9);
  assert.ok(luminanceOf(atTaper) > luminanceOf(halfway));
  assert.deepEqual(sparkRadiance(1, [2500, 800], 1, [1, 1, 1]), [0, 0, 0]);
  assert.ok(Math.abs(luminanceOf(sparkRadiance(0, [2500, 800], 3, [0, 0, 0])) / luminanceOf(sparkRadiance(0, [2500, 800], 1, [0, 0, 0])) - 3) < 1e-9, 'intensity is a plain multiplier');
});

test('the streak is as long as the spark travels while the shutter is open', () => {
  const launches = launchesFor();
  const streak = { head: [0, 0, 0], tail: [0, 0, 0], radius: 0, fraction: 0 };
  sparkStreakAt(launches, 0, { gravity: [0, 0, 0], wind: [0, 0, 0], drag: 0, fields: [] }, 0.5, 1 / 48, streak);
  const length = Math.hypot(...streak.head.map((value, axis) => value - streak.tail[axis]));
  assert.ok(Math.abs(length - 10 / 48) < 1e-9, `10 m/s over 1/48 s is 0.2083 m, got ${length}`);
  sparkStreakAt(launches, 0, { gravity: [0, 0, 0], wind: [0, 0, 0], drag: 0, fields: [] }, 0.5, 1 / 12, streak);
  assert.ok(Math.abs(Math.hypot(...streak.head.map((value, axis) => value - streak.tail[axis])) - 10 / 12) < 1e-9, 'a longer shutter gives a longer streak');
  sparkStreakAt(launches, 0, { gravity: [0, 0, 0], wind: [0, 0, 0], drag: 0, fields: [] }, 0.5, 0, streak);
  assert.equal(Math.hypot(...streak.head.map((value, axis) => value - streak.tail[axis])), 0, 'no shutter, no stretch');
});

test('the streak follows gravity and drag: its direction is the path between the two times, and it never starts before birth', () => {
  const forces = { gravity: [0, -9.81, 0], wind: [0, 0, 0], drag: 1.2, fields: [] };
  const launches = launchesFor({}, forces);
  const streak = { head: [0, 0, 0], tail: [0, 0, 0], radius: 0, fraction: 0 };
  sparkStreakAt(launches, 1, forces, 0.8, 0.1, streak);
  const along = streak.head.map((value, axis) => value - streak.tail[axis]);
  // Drag slows the spark, so it travels less than the launch speed times the shutter, and gravity bends the streak downward.
  assert.ok(Math.hypot(...along) < 10 * 0.1);
  assert.ok(along[1] < 0 && along[0] > 0);
  const earlyStreak = { head: [0, 0, 0], tail: [0, 0, 0], radius: 0, fraction: 0 };
  sparkStreakAt(launches, 1, forces, 0.02, 0.1, earlyStreak);
  assert.ok(Math.abs(Math.hypot(...earlyStreak.head.map((value, axis) => value - earlyStreak.tail[axis])) - 10 * 0.02) < 0.01, 'a spark 0.02 s old streaks 0.02 s of travel, from its launch point');
  assert.deepEqual(earlyStreak.tail, [0, 0, 0]);
});

test('the mesh stretches each octahedron to the streak and carries the cooling colour; a spark outside its life collapses and is black', () => {
  const forces = { gravity: [0, 0, 0], wind: [0, 0, 0], drag: 0, fields: [] };
  const launches = launchesFor({ rate: 4, count: 4 });
  const look = { shutter: 0.1, temperature: [2500, 800], intensity: 1 };
  const mesh = buildSparkMesh(launches, forces, 1.2, look);
  // Spark 0 is born at 0 (age 1.2, past its life of 1): hidden. Spark 1 is born at 0.25 (age 0.95): the last 5 percent of its life.
  assert.deepEqual(Array.from(mesh.colors.slice(0, 18)), new Array(18).fill(0));
  const alongSpan = vertexIndex => mesh.positions[(6 + vertexIndex) * 3];
  // Corner 2 and 3 are the tips along x: half length is the radius plus half of the travel (10 m/s times 0.1 s).
  assert.ok(Math.abs(alongSpan(2) - alongSpan(3) - (2 * 0.01 + 1)) < 1e-4);
  const colour = Array.from(mesh.colors.slice(18, 21));
  const expected = sparkRadiance(0.95, look.temperature, 1, [0, 0, 0]);
  assert.ok(colour.every((value, channel) => Math.abs(value - expected[channel]) < 1e-5));
  assert.equal(mesh.indices.length, 4 * 24);
});

test('the same seed gives the same sparks, another seed gives others, and more sparks keep the earlier ones', () => {
  const sampleAt = (system, time) => {
    const scene = createAgentScene(sparkRecipe(system));
    scene.sampleMotion(time);
    return scene.parts[0].geometry;
  };
  const first = sampleAt({ preset: 'explosion', seed: 9, count: 60 }, 0.4);
  assert.deepEqual(Array.from(sampleAt({ preset: 'explosion', seed: 9, count: 60 }, 0.4).positions), Array.from(first.positions));
  assert.notDeepEqual(Array.from(sampleAt({ preset: 'explosion', seed: 10, count: 60 }, 0.4).positions), Array.from(first.positions));
  const larger = sampleAt({ preset: 'explosion', seed: 9, count: 120 }, 0.4);
  assert.deepEqual(Array.from(larger.positions.slice(0, first.positions.length)), Array.from(first.positions));
  assert.deepEqual(Array.from(larger.colors.slice(0, first.colors.length)), Array.from(first.colors));
});

test('a seek back repeats the same bytes', () => {
  const scene = createAgentScene(sparkRecipe({ preset: 'explosion', seed: 2, count: 50, floor: 0, bounce: 0.3, position: [0, 0.5, 0] }));
  scene.sampleMotion(0.6);
  const before = Array.from(scene.parts[0].geometry.positions);
  scene.sampleMotion(1.4);
  scene.sampleMotion(0.6);
  assert.deepEqual(Array.from(scene.parts[0].geometry.positions), before);
});

test('the explosion preset throws sparks in all directions from the blast point and reports its numbers', () => {
  const scene = createAgentScene(sparkRecipe({ preset: 'explosion', position: [1, 2, 3] }));
  scene.sampleMotion(0.1);
  const report = scene.inspect().particles.systems[0];
  assert.equal(report.type, 'sparks');
  assert.equal(report.particles, 800);
  assert.equal(report.verticesPerParticle, 6);
  assert.deepEqual(report.temperature, SPARK_DEFAULTS.temperature);
  const positions = scene.parts[0].geometry.positions;
  const heights = [];
  for (let spark = 0; spark < 800; spark++) heights.push(positions[spark * 18 + 1]);
  assert.ok(heights.some(height => height > 2.5) && heights.some(height => height < 1.5), 'sparks fly up and down from the blast at y 2');
});

test('spark input is bounded and the errors say what to pass', () => {
  const message = (system, extra) => {
    try {
      createAgentScene(sparkRecipe(system, extra));
    } catch (error) {
      return error.message;
    }
    return '';
  };
  assert.match(message({ count: SPARK_LIMITS.maxCount + 1 }), /whole number from 1 to 4096/);
  assert.match(message({ count: 0 }), /whole number from 1 to 4096/);
  assert.match(message({ speed: SPARK_LIMITS.maxSpeed + 1 }), /speed/);
  assert.match(message({ lifetime: 9 }), /lifetime/);
  assert.match(message({ temperature: [800, 2500] }), /start at or above the end, such as \[2500, 800\]/);
  assert.match(message({ temperature: [9000, 800] }), /temperature/);
  assert.match(message({ temperature: 2500 }), /\[start, end\] kelvin/);
  assert.match(message({ preset: 'volcano' }), /one of explosion/);
  assert.match(message({ intensity: -1 }), /intensity/);
  assert.match(message({ shutter: 2 }), /shutter/);
  assert.match(message({ size: 5 }), /size/);
  assert.match(message({ position: [0, 0, 0], emitter: { position: [1, 1, 1] } }), /blast point once/);
  assert.match(message({ drift: 1 }), /drift/);
  assert.match(message({}, { nodes: [{ id: 'sparks', geometry: 'speck', material: 'plain' }] }), /unlit/);
  assert.match(message({}, { particles: { systems: [{ type: 'sparks', node: 'sparks', count: 3000 }, { type: 'sparks', node: 'second', count: 3000 }] }, nodes: [{ id: 'sparks', geometry: 'speck', material: 'spark' }, { id: 'second', geometry: 'speck', material: 'spark' }] }), /at most 4096/);
});
