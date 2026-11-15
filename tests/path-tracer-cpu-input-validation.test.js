import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveRealtimeOptions } from '../src/path-tracer-realtime-options.js';
import { buildTraceScene } from '../src/path-tracer-scene.js';

function quadGeometry() {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

function buildWith(geometry) {
  return buildTraceScene([{ name: 'quad', geometry, material: { color: [1, 1, 1] } }], {});
}

test('a negative or fractional index is refused instead of wrapping to 4294967295 (#1467)', () => {
  for (const badIndices of [[0, 1, -1], [0, 1, 1.5], [0, 1, Number.NaN]]) {
    const geometry = quadGeometry();
    geometry.indices = badIndices;
    assert.throws(() => buildWith(geometry), /Part quad has an index that is not a whole number from 0 up/);
  }
});

test('a geometry without indices says what to pass (#1467)', () => {
  const geometry = quadGeometry();
  delete geometry.indices;
  assert.throws(() => buildWith(geometry), /Part quad needs geometry\.indices/);
});

test('NaN in uvs, lightUvs or colors is refused and names the array (#1461)', () => {
  const cases = [['uvs', 8, 'uvs'], ['lightUvs', 8, 'lightUvs'], ['colors', 12, 'colors']];
  for (const [field, length, name] of cases) {
    const geometry = quadGeometry();
    geometry[field] = new Float32Array(length).fill(Number.NaN);
    assert.throws(() => buildWith(geometry), new RegExp(`Part quad ${name} must be finite numbers`));
  }
});

test('finite uvs, lightUvs and colors still build (#1461)', () => {
  const geometry = quadGeometry();
  geometry.uvs = new Float32Array(8).fill(0.5);
  geometry.lightUvs = new Float32Array(8).fill(0.25);
  geometry.colors = new Float32Array(12).fill(0.75);
  assert.equal(buildWith(geometry).indices.length, 6);
});

test('real-time options refuse a bad history limit, cache cell size, divisor or filter count (#1462)', () => {
  const bad = [
    { historyLimit: Number.NaN }, { historyLimit: -1 }, { historyLimit: 0 },
    { cacheCellSize: Number.NaN }, { cacheCellSize: -0.5 }, { cacheCellSize: 0 },
    { resolutionDivisor: 0 }, { resolutionDivisor: -2 },
    { filterIterations: Number.NaN }, { filterIterations: 1.5 }, { filterIterations: -1 }, { filterIterations: 1e9 },
  ];
  for (const raw of bad) {
    const [name] = Object.keys(raw);
    assert.throws(() => resolveRealtimeOptions(raw), new RegExp(name), JSON.stringify(raw));
  }
});

test('real-time options keep their defaults and accept good values (#1462)', () => {
  const defaults = resolveRealtimeOptions({});
  assert.equal(defaults.historyLimit, undefined);
  assert.equal(defaults.filterIterations, undefined);
  const chosen = resolveRealtimeOptions({ historyLimit: 8, filterIterations: 0, cacheCellSize: 0.5, resolutionDivisor: 1 });
  assert.equal(chosen.historyLimit, 8);
  assert.equal(chosen.filterIterations, 0);
  assert.equal(chosen.cacheCellSize, 0.5);
  assert.equal(chosen.traceWidth, 960);
});
