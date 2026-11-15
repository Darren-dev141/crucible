import './support/load-agent-scene-modules.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { box } from '../src/geometry.js';
import { meshFromGeometry } from '../src/mesh.js';
import { bevelEdges, MAX_BEVEL_SEGMENTS } from '../src/mesh-bevel.js';
import { subdivideMesh, MAX_SUBDIVISION_LEVELS } from '../src/mesh-subdivide.js';
import { loopCut, MAX_LOOP_CUTS } from '../src/mesh-loopcut.js';
import { bisectPlane } from '../src/mesh-bisect.js';
import { resampleCurve, filletCurve, MAX_RESAMPLE_COUNT } from '../src/curve-operations.js';
import { resampleSamples } from '../src/modeling-splines.js';
import { normalizeMeshEdits } from '../src/mesh-recipe.js';

const cube = () => meshFromGeometry(box(0, 1));
const ALL = { all: true };
const VERTICAL = { along: [0, 1, 0] };
const OPEN_CURVE = [[0, 0, 0], [1, 0, 0], [1, 1, 0]];

// Each case must name the function, the parameter, the value given and the allowed range, in that call's own words.
function refuses(call, ErrorType, ...fragments) {
  assert.throws(call, error => {
    assert.ok(error instanceof ErrorType, `expected ${ErrorType.name}, got ${error.constructor.name}: ${error.message}`);
    for (const fragment of fragments) assert.ok(error.message.includes(fragment), `"${error.message}" should include "${fragment}"`);
    return true;
  });
}

test('bevelEdges refuses a missing or NaN width, a NaN profile and a huge segment count', () => {
  refuses(() => bevelEdges(cube(), ALL, {}), TypeError, 'bevelEdges', 'width', 'missing', 'above 0');
  refuses(() => bevelEdges(cube(), ALL, { width: NaN }), RangeError, 'width', 'NaN', 'above 0');
  refuses(() => bevelEdges(cube(), ALL, { width: 0.1, profile: NaN }), RangeError, 'profile', 'NaN', 'from 0 to 1');
  refuses(() => bevelEdges(cube(), ALL, { width: 0.1, segments: 1e6 }), RangeError, 'segments', '1000000', `from 1 to ${MAX_BEVEL_SEGMENTS}`);
  refuses(() => bevelEdges(cube(), ALL, { width: 0.1, segments: 2.5 }), RangeError, 'segments', '2.5', 'whole number');
});

test('subdivideMesh refuses runaway levels and NaN sharpness', () => {
  refuses(() => subdivideMesh(cube(), { levels: 99 }), RangeError, 'subdivideMesh', 'levels', '99', `from 1 to ${MAX_SUBDIVISION_LEVELS}`);
  refuses(() => subdivideMesh(cube(), { crease: ALL, sharpness: NaN }), RangeError, 'sharpness', 'NaN', 'from 0 to 10');
});

test('loopCut refuses huge cut counts and a NaN factor', () => {
  refuses(() => loopCut(cube(), VERTICAL, { cuts: 1e6 }), RangeError, 'loopCut', 'cuts', '1000000', `from 1 to ${MAX_LOOP_CUTS}`);
  refuses(() => loopCut(cube(), VERTICAL, { factor: NaN }), RangeError, 'factor', 'NaN', 'above 0 and below 1');
});

test('bisectPlane names a missing point, a NaN normal and a NaN distance', () => {
  refuses(() => bisectPlane(cube(), { normal: [0, 0, 1] }), TypeError, 'bisectPlane', 'point', 'missing', 'three finite numbers');
  refuses(() => bisectPlane(cube(), { point: [0, 0, 0], normal: [NaN, 0, 1] }), TypeError, 'normal', 'NaN', 'three finite numbers');
  refuses(() => bisectPlane(cube(), { point: [0, 0, 0], normal: [0, 0, 0] }), RangeError, 'normal', 'nonzero');
  refuses(() => bisectPlane(cube(), { point: [0, 0, 0], normal: [0, 0, 1], distance: NaN }), RangeError, 'distance', 'NaN', 'from 0 to');
});

test('resampleCurve and resampleSamples refuse a count that cannot span the curve', () => {
  refuses(() => resampleCurve(OPEN_CURVE, 1), RangeError, 'resampleCurve', 'count', 'was 1', 'from 2 to');
  refuses(() => resampleCurve(OPEN_CURVE, 1e9), RangeError, 'count', `to ${MAX_RESAMPLE_COUNT}`);
  assert.equal(resampleCurve(OPEN_CURVE, 2).length, 2);
  const samples = { points: OPEN_CURVE, tangents: [[1, 0, 0], [1, 0, 0], [0, 1, 0]] };
  refuses(() => resampleSamples(samples, 1), RangeError, 'resampleSamples', 'count', 'was 1', 'from 2 to');
  assert.equal(resampleSamples(samples, 4).points.length, 4);
});

test('filletCurve refuses a zero or NaN radius and coincident points', () => {
  refuses(() => filletCurve(OPEN_CURVE, 0, 8), RangeError, 'filletCurve', 'radius', 'was 0', 'above 0');
  refuses(() => filletCurve(OPEN_CURVE, NaN, 8), RangeError, 'radius', 'NaN');
  refuses(() => filletCurve(OPEN_CURVE, 0.2, 0), RangeError, 'arcSegments', 'from 1 to');
  refuses(() => filletCurve([[0, 0, 0], [0, 0, 0], [1, 0, 0]], 0.2, 8), RangeError, 'points 0 and 1', 'same point');
  assert.ok(filletCurve(OPEN_CURVE, 0.2, 8).length > OPEN_CURVE.length);
});

test('the recipe layer reads the same segment and cut limits as the library', () => {
  const overSegments = { op: 'bevel', width: 0.1, segments: MAX_BEVEL_SEGMENTS + 1 };
  const overCuts = { op: 'loop_cut', edges: VERTICAL, cuts: MAX_LOOP_CUTS + 1 };
  assert.throws(() => normalizeMeshEdits([overSegments]), error => error.message.includes(`1 to ${MAX_BEVEL_SEGMENTS}`));
  assert.throws(() => normalizeMeshEdits([overCuts]), error => error.message.includes(`1 to ${MAX_LOOP_CUTS}`));
});
