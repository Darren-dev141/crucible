import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { trianglesIntersect } from '../src/triangle-math.js';
import { floatToHalf, halfToFloat } from '../src/volume-grid.js';
import { RenderTargetLedger } from '../src/render-target-ledger.js';

const unitTriangle = Float64Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]);

test('a zero area triangle in the plane of another but outside it does not intersect, in either argument order', () => {
  const point = Float64Array.from([5, 5, 0, 5, 5, 0, 5, 5, 0]);
  const segment = Float64Array.from([5, 5, 0, 6, 5, 0, 7, 5, 0]);
  for (const collapsed of [point, segment]) {
    assert.equal(trianglesIntersect(collapsed, unitTriangle), false);
    assert.equal(trianglesIntersect(unitTriangle, collapsed), false);
  }
});

test('a zero area triangle inside another still intersects, in either argument order', () => {
  const insidePoint = Float64Array.from([0.25, 0.25, 0, 0.25, 0.25, 0, 0.25, 0.25, 0]);
  const crossingSegment = Float64Array.from([-1, 0.25, 0, 0.25, 0.25, 0, 2, 0.25, 0]);
  for (const collapsed of [insidePoint, crossingSegment]) {
    assert.equal(trianglesIntersect(collapsed, unitTriangle), true);
    assert.equal(trianglesIntersect(unitTriangle, collapsed), true);
  }
});

test('floatToHalf rounds every subnormal and normal midpoint and its float32 neighbours to nearest even', () => {
  const floats = new Float32Array(1);
  const bits = new Uint32Array(floats.buffer);
  const wrong = [];
  for (let half = 0; half < 0x7bff; half += half < 0x400 ? 1 : 13) {
    const midpoint = (halfToFloat(half) + halfToFloat(half + 1)) / 2;
    floats[0] = midpoint;
    const midpointBits = bits[0];
    for (const delta of [-1, 0, 1]) {
      bits[0] = midpointBits + delta;
      const value = floats[0];
      const expected = value > midpoint ? half + 1 : value < midpoint ? half : half % 2 === 0 ? half : half + 1;
      if (floatToHalf(value) !== expected) wrong.push(`${half}${delta >= 0 ? '+' : ''}${delta}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test('the ledger accepts every format the renderer passes to renderTargets.record with finite positive bytes', () => {
  const sourceFolder = new URL('../src/', import.meta.url);
  const formats = new Set();
  for (const file of readdirSync(sourceFolder).filter(name => name.endsWith('.js'))) {
    const text = readFileSync(new URL(file, sourceFolder), 'utf8');
    for (const call of text.matchAll(/renderTargets\.record\([^;]*\);/g)) {
      for (const token of call[0].matchAll(/'([A-Z][A-Z0-9_]+)'/g)) formats.add(token[1]);
    }
    for (const definition of text.matchAll(/(?:COMPACT_FORMAT|depthFormat) = '([A-Z0-9_]+)'/g)) formats.add(definition[1]);
  }
  assert.ok(formats.has('RG32F') && formats.has('R11F_G11F_B10F') && formats.size >= 7, [...formats].join(','));
  const ledger = new RenderTargetLedger();
  const missing = [];
  for (const format of formats) {
    try {
      ledger.record(format, { width: 8, height: 8, format });
    } catch {
      missing.push(format);
    }
  }
  assert.deepEqual(missing, []);
  assert.ok(Number.isFinite(ledger.report().totalBytes) && ledger.report().totalBytes > 0);
});

test('the ledger rejects an unknown format or a size that is not a positive integer and keeps its totals finite', () => {
  const ledger = new RenderTargetLedger();
  ledger.record('frameColor', { width: 4, height: 4, format: 'RGBA8' });
  assert.throws(() => ledger.record('bad', { width: 4, height: 4, format: 'RGB10_A2' }), /known format, got 4x4 RGB10_A2/);
  assert.throws(() => ledger.record('bad', { width: -4, height: 4, format: 'R8' }), /positive width and height/);
  assert.throws(() => ledger.record('bad', { width: 4, format: 'R8' }), /got 4xundefined R8/);
  assert.equal(ledger.report().targets.length, 1);
  assert.equal(ledger.report().totalBytes, 64);
});
