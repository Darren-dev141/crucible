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

// Values sit just past each limit, so a missing guard returns quickly instead of hanging.
// Each message names the function, the parameter, the value given and the allowed range.
function refuses(call, ...fragments) {
  assert.throws(call, error => {
    assert.ok(error instanceof RangeError, `expected RangeError, got ${error.constructor.name}: ${error.message}`);
    for (const fragment of fragments) assert.ok(error.message.includes(fragment), `"${error.message}" should include "${fragment}"`);
    return true;
  });
}

test('bevelEdges refuses a missing or NaN width and too many segments', () => {
  refuses(() => bevelEdges(cube(), ALL, {}), 'bevelEdges', 'width', 'undefined', 'from 0 to');
  refuses(() => bevelEdges(cube(), ALL, { width: NaN }), 'width', 'NaN');
  refuses(() => bevelEdges(cube(), ALL, { width: 0.1, segments: MAX_BEVEL_SEGMENTS + 1 }), 'segments', String(MAX_BEVEL_SEGMENTS + 1), `from 1 to ${MAX_BEVEL_SEGMENTS}`);
  refuses(() => bevelEdges(cube(), ALL, { width: 0.1, segments: 2.5 }), 'segments', '2.5', 'whole number');
});

test('subdivideMesh refuses too many levels', () => {
  refuses(() => subdivideMesh(cube(), { levels: MAX_SUBDIVISION_LEVELS + 1 }), 'subdivideMesh', 'levels', `from 1 to ${MAX_SUBDIVISION_LEVELS}`);
});

test('loopCut refuses too many cuts', () => {
  refuses(() => loopCut(cube(), VERTICAL, { cuts: MAX_LOOP_CUTS + 1 }), 'loopCut', 'cuts', `from 1 to ${MAX_LOOP_CUTS}`);
});

test('bisectPlane names a missing point and a NaN normal', () => {
  refuses(() => bisectPlane(cube(), { normal: [0, 0, 1] }), 'bisectPlane', 'point and normal', 'was ,0,0,1');
  refuses(() => bisectPlane(cube(), { point: [0, 0, 0], normal: [NaN, 0, 1] }), 'point and normal', 'NaN');
});

test('resampleCurve and resampleSamples refuse a count that cannot span the curve', () => {
  refuses(() => resampleCurve(OPEN_CURVE, 1), 'resampleCurve', 'count', 'was 1', 'from 2 to');
  refuses(() => resampleCurve(OPEN_CURVE, MAX_RESAMPLE_COUNT + 1), 'count', `to ${MAX_RESAMPLE_COUNT}`);
  assert.equal(resampleCurve(OPEN_CURVE, 2).length, 2);
  const samples = { points: OPEN_CURVE, tangents: [[1, 0, 0], [1, 0, 0], [0, 1, 0]] };
  refuses(() => resampleSamples(samples, 1), 'resampleSamples', 'count', 'was 1', 'from 2 to');
  assert.equal(resampleSamples(samples, 4).points.length, 4);
});

test('filletCurve refuses a zero or NaN radius', () => {
  refuses(() => filletCurve(OPEN_CURVE, 0, 8), 'filletCurve', 'radius', 'was 0');
  refuses(() => filletCurve(OPEN_CURVE, NaN, 8), 'radius', 'NaN');
  assert.ok(filletCurve(OPEN_CURVE, 0.2, 8).length > OPEN_CURVE.length);
});

test('the recipe layer reads the same segment and cut limits as the library', () => {
  const overSegments = { op: 'bevel', width: 0.1, segments: MAX_BEVEL_SEGMENTS + 1 };
  const overCuts = { op: 'loop_cut', edges: VERTICAL, cuts: MAX_LOOP_CUTS + 1 };
  assert.throws(() => normalizeMeshEdits([overSegments]), error => error.message.includes(`1 to ${MAX_BEVEL_SEGMENTS}`));
  assert.throws(() => normalizeMeshEdits([overCuts]), error => error.message.includes(`1 to ${MAX_LOOP_CUTS}`));
});
