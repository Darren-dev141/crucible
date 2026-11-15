// A recipe that leaves `shadow` out gets a view fitted to a scene wider than the default 7 m one (#1359): outside the default view the sun reached
// everything, so a sealed room 8 m wide came out as bright as a room with a window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '../src/geometry.js';
import { fitAgentShadow, normalizeAgentLook, resolveAgentShadow } from '../src/agent-look.js';
import { effectiveShadowCascades } from '../src/cascaded-shadows.js';

function slab(center, size) {
  const matrix = new Float32Array([size[0], 0, 0, 0, 0, size[1], 0, 0, 0, 0, size[2], 0, center[0], center[1], center[2], 1]);
  return { name: 'slab', geometry: box(0, 1), matrix, material: { color: [0.7, 0.7, 0.7], metallic: 0, roughness: 0.9 } };
}

const DEFAULT_SHADOW = normalizeAgentLook({}).shadow;

test('a scene wider than the default view gets a view that covers it, centred on it', () => {
  const parts = [slab([0, 0, 0], [8, 3, 8]), slab([0, 1.5, 4], [8, 3, 0.2])];
  const fitted = fitAgentShadow(DEFAULT_SHADOW, parts);
  assert.ok(fitted.extent > DEFAULT_SHADOW.extent, `extent ${fitted.extent}`);
  assert.ok(fitted.extent < 10, `extent ${fitted.extent} stays close to the scene`);
  assert.ok(Math.abs(fitted.target[2] - 0.05) < 0.5 && Math.abs(fitted.target[1] - 0.75) < 0.5, `centred on the scene: ${fitted.target}`);
  assert.ok(fitted.near < fitted.far);
  assert.doesNotThrow(() => resolveAgentShadow(fitted, [0.3, 0.55, -0.8]));
});

test('a scene inside the default view, a recipe that set a shadow and a scene wider than the largest view keep their shadow', () => {
  assert.equal(fitAgentShadow(DEFAULT_SHADOW, [slab([0, 0, 0], [3, 1, 3])]), DEFAULT_SHADOW);
  const authored = { ...DEFAULT_SHADOW, extent: 6 };
  assert.equal(fitAgentShadow(authored, [slab([0, 0, 0], [40, 3, 40])]), authored);
  assert.equal(fitAgentShadow(DEFAULT_SHADOW, [slab([0, 0, 0], [300, 1, 300])]), DEFAULT_SHADOW);
});

test('a scene whose bounds are unknown keeps the default shadow', () => {
  const moving = { ...slab([0, 0, 0], [40, 3, 40]), skin: {} };
  assert.equal(fitAgentShadow(DEFAULT_SHADOW, [moving]), DEFAULT_SHADOW);
});

test('a fitted view wider than 40 m turns the automatic cascades on, a narrower one keeps the single map', () => {
  const wide = fitAgentShadow(DEFAULT_SHADOW, [slab([0, 0, 0], [60, 1, 60])]);
  assert.equal(effectiveShadowCascades({}, wide), 3);
  const narrow = fitAgentShadow(DEFAULT_SHADOW, [slab([0, 0, 0], [20, 1, 20])]);
  assert.equal(effectiveShadowCascades({}, narrow), 0);
});

test('a small subject on a large ground plane keeps the default view, so its shadow texels stay as fine (#1366)', () => {
  const subject = slab([0, 0.5, 0], [1, 1, 1]);
  const ground = slab([0, -0.05, 0], [50, 0.1, 50]);
  assert.equal(fitAgentShadow(DEFAULT_SHADOW, [subject, ground]), DEFAULT_SHADOW);
  const naive = fitAgentShadow(DEFAULT_SHADOW, [slab([0, 0, 0], [50, 1, 50])]);
  assert.ok(naive.extent > 30, `a plane alone, with nothing else to fit, still gets its view: ${naive.extent}`);
});

test('a ground plane does not shrink the fit of the scene on it: the subject sets the view, the plane is left out', () => {
  const ground = slab([0, -0.05, 0], [50, 0.1, 50]);
  const hall = [slab([0, 3, 0], [14, 6, 0.3]), slab([0, 3, 9], [14, 6, 0.3])];
  const fitted = fitAgentShadow(DEFAULT_SHADOW, [...hall, ground]);
  const withoutGround = fitAgentShadow(DEFAULT_SHADOW, hall);
  assert.deepEqual(fitted, withoutGround);
  assert.ok(fitted.extent > DEFAULT_SHADOW.extent && fitted.extent < 14, `extent ${fitted.extent}`);
});

test('a recipe that writes the default shadow out is read as having left it out, and one that changes any field keeps it', () => {
  const wide = [slab([0, 0, 0], [20, 3, 20])];
  const written = normalizeAgentLook({ shadow: { ...DEFAULT_SHADOW } }).shadow;
  assert.ok(fitAgentShadow(written, wide).extent > DEFAULT_SHADOW.extent);
  const tightened = normalizeAgentLook({ shadow: { extent: 3.5, distance: 10 } }).shadow;
  assert.equal(fitAgentShadow(tightened, wide), tightened);
});
