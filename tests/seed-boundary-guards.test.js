import test from 'node:test';
import assert from 'node:assert/strict';

const BAD_SEEDS = [NaN, Infinity, -Infinity, '7', null];

test('requireSeed returns finite numbers unchanged, fractions included', async () => {
  const { requireSeed } = await import('../src/seeded-random.js');
  assert.equal(requireSeed(0, 'x seed'), 0);
  assert.equal(requireSeed(1.5, 'x seed'), 1.5);
  assert.equal(requireSeed(-3, 'x seed'), -3);
});

test('requireSeed names the field for NaN, Infinity and non-numbers', async () => {
  const { requireSeed } = await import('../src/seeded-random.js');
  for (const bad of BAD_SEEDS) {
    assert.throws(() => requireSeed(bad, 'demo seed'), /demo seed must be a finite number/);
  }
});

test('createGrass refuses a NaN, Infinity or string seed instead of using the seed-0 layout', async () => {
  const { createGrass } = await import('../src/grass.js');
  const area = { minX: -2, maxX: 2, minZ: -2, maxZ: 2 };
  for (const bad of BAD_SEEDS) {
    assert.throws(() => createGrass({ area, density: 10, seed: bad }), /grass seed must be a finite number/);
  }
  assert.doesNotThrow(() => createGrass({ area, density: 10, seed: 1.5 }));
});

test('createNoiseHeight and createTerrain refuse a non-finite seed', async () => {
  const { createNoiseHeight, createTerrain } = await import('../src/terrain.js');
  for (const bad of BAD_SEEDS) {
    assert.throws(() => createNoiseHeight({}, bad), /terrain seed must be a finite number/);
    assert.throws(() => createTerrain({ seed: bad }), /terrain seed must be a finite number/);
  }
  assert.equal(typeof createNoiseHeight({}, 3), 'function');
});

test('createSlicer refuses NaN and Infinity budgets, which never or always yield', async () => {
  const { createSlicer } = await import('../src/cooperative.js');
  for (const bad of [NaN, Infinity, '8']) {
    assert.throws(() => createSlicer(bad), /Slice milliseconds must be finite/);
  }
  assert.equal(typeof createSlicer(-1), 'function');
  assert.equal(typeof createSlicer(), 'function');
});
