import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { curve } from '../src/modeling.js';
import { sampleSpline } from '../src/modeling-splines.js';

const wire = { radius: 0.01, radialSegments: 4 };

function assertFiniteCurve(points, options) {
  const mesh = curve(points, { ...wire, ...options });
  assert.ok(mesh.positions.length > 0);
  assert.ok(mesh.positions.every(Number.isFinite), 'every position is finite');
  assert.ok(mesh.normals.every(Number.isFinite), 'every normal is finite');
}

test('a poly curve through a repeated point takes the chord direction instead of crashing', () => {
  assertFiniteCurve([[0, 0, 0], [1, 0, 0], [1, 0, 0], [1, 1, 0]], { kind: 'poly' });
  assertFiniteCurve([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 0, 0]], { kind: 'poly', closed: true });
  assertFiniteCurve([[0, 0, 0], [1, 0, 0], [1, 0, 0]], { kind: 'poly' });
  const samples = sampleSpline({ type: 'poly', closed: false, points: [[0, 0, 0], [1, 0, 0], [1, 0, 0], [1, 1, 0]] }, 4);
  assert.deepEqual(samples.tangents[0], [1, 0, 0]);
  assert.deepEqual(samples.tangents[1], [0, 1, 0], 'a repeated point leaves toward the next distinct point');
  assert.deepEqual(samples.tangents[2], [0, 1, 0]);
  const trailing = sampleSpline({ type: 'poly', closed: false, points: [[0, 0, 0], [1, 0, 0], [1, 0, 0]] }, 4);
  assert.deepEqual(trailing.tangents[2], [1, 0, 0], 'trailing repeated points keep the direction they arrived with');
});

test('a NURBS curve with a duplicated end control point builds', () => {
  assertFiniteCurve([[0, 0, 0], [0, 0, 0], [1, 0, 0], [1, 1, 0]], { kind: 'nurbs' });
});

test('a curve whose points all coincide says it has no length', () => {
  assert.throws(() => curve([[0, 0, 0], [0, 0, 0]], { ...wire, kind: 'poly' }), /The curve has no length\. Move its points apart/);
});
