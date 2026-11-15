import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveRealtimeOptions } from '../src/path-tracer-realtime-options.js';

test('real-time options refuse an output size that is not a whole number of pixels', () => {
  for (const width of ['100', 960.5, NaN, 0, -4]) {
    assert.throws(() => resolveRealtimeOptions({ width }), /option width must be a whole number of pixels/, `width ${width}`);
  }
  for (const height of ['100', 540.5, Infinity, 0]) {
    assert.throws(() => resolveRealtimeOptions({ height }), /option height must be a whole number of pixels/, `height ${height}`);
  }
});

test('real-time options name width and resolutionDivisor when the traced size leaves the tracer range', () => {
  assert.throws(() => resolveRealtimeOptions({ width: 20 }), /option width 20 over resolutionDivisor.*Change width or resolutionDivisor/);
  assert.throws(() => resolveRealtimeOptions({ height: 30 }), /traces height 15 \(option height 30/);
  assert.equal(resolveRealtimeOptions({ width: 1920, height: 1080 }).traceWidth, 960);
});
