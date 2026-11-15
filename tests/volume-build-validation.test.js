// Volume fog, fog detail, the volume fog motion track and local volumes fail when the scene or an edit is built, not at the first render (#1268).
import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';
import { resolveFogDetail } from '../src/fog-field.js';

function recipeWith(environment = {}, extra = {}) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box', bevel: 0 }],
    materials: [{ id: 'finish', color: [0.6, 0.6, 0.6], emission: 0 }],
    nodes: [{ id: 'block', geometry: 'box', material: 'finish' }],
    camera: { eye: [4, 3, 5], target: [0, 0, 0] },
    environment,
    ...extra,
  };
}

const BAD_DETAIL_FIELDS = [
  ['detailOctaves', 9, /Volume detail octaves must be between 1 and 3/],
  ['detailOctaves', 2.5, /Volume detail octaves must be an integer/],
  ['scatterOctaves', 2.5, /Volume scatter octaves must be an integer/],
  ['contrast', -1, /Volume contrast must be between 0 and 4/],
  ['warp', 5, /Volume warp must be between 0 and 4/],
  ['profileSoftness', 1, /Volume profile softness must be between 0 and 0.95/],
  ['keyScattering', 11, /Volume key scattering must be between 0 and 10/],
  ['multiScatter', 2, /Volume multi scatter must be between 0 and 1/],
  ['detailAmount', 2, /Volume detail amount must be between 0 and 1/],
  ['surfaceTransmittance', -0.5, /Volume surface transmittance must be between 0 and 1/],
];

for (const [field, value, message] of BAD_DETAIL_FIELDS) {
  test(`volumeFog ${field} ${value} throws when the scene is created and when set-environment edits it`, () => {
    assert.throws(() => createAgentScene(recipeWith({ volumeFog: { density: 0.05, [field]: value } })), message);
    const scene = createAgentScene(recipeWith({ volumeFog: { density: 0.05 } }));
    assert.throws(() => scene.apply([{ type: 'set-environment', environment: { volumeFog: { [field]: value } } }], { expectedRevision: 0 }), message);
  });
}

test('a valid detail fog still builds and resolves', () => {
  const volumeFog = { density: 0.05, detailOctaves: 3, scatterOctaves: 2, contrast: 4, warp: 4, profileSoftness: 0.95, keyScattering: 10, multiScatter: 1 };
  const scene = createAgentScene(recipeWith({ volumeFog }));
  assert.equal(resolveFogDetail(scene.exportRecipe().environment.volumeFog).detailOctaves, 3);
});

test('the volume fog density track range is 0 to 10, like environment.volumeFog.density', () => {
  const motion = value => ({ motion: { duration: 4, tracks: [{ kind: 'environment', property: 'volumeFogDensity', keyframes: [{ time: 0, value: 0.05 }, { time: 4, value }] }] } });
  const environment = { volumeFog: { density: 0.05 } };
  assert.throws(() => createAgentScene(recipeWith(environment, motion(500))), /volumeFogDensity/);
  const scene = createAgentScene(recipeWith(environment, motion(10)));
  scene.sampleMotion(4);
  assert.equal(scene.environment.volumeFog.density, 10);
});

test('a mesh volume that names a part the scene lacks throws at build and edit time with the render message', () => {
  const missing = { localVolumes: [{ shape: 'mesh', part: 'no-such-part' }] };
  assert.throws(() => createAgentScene(recipeWith(missing)), /environment\.localVolumes\[0\]\.part "no-such-part" names no part in the scene; parts: block/);
  const scene = createAgentScene(recipeWith({ localVolumes: [{ shape: 'mesh', part: 'block' }] }));
  assert.throws(() => scene.apply([{ type: 'set-environment', environment: missing }], { expectedRevision: 0 }), /names no part in the scene/);
});

test('two grid volumes throw at build and edit time with the render message', () => {
  const grid = center => ({ shape: 'grid', center, size: [1, 1, 1], grid: 'smoke.67vg' });
  const twoGrids = { localVolumes: [grid([0, 0, 0]), grid([2, 0, 0])] };
  assert.throws(() => createAgentScene(recipeWith(twoGrids)), /At most one volume in a scene takes shape "grid"/);
  const scene = createAgentScene(recipeWith({}));
  assert.throws(() => scene.apply([{ type: 'set-environment', environment: twoGrids }], { expectedRevision: 0 }), /At most one volume in a scene takes shape "grid"/);
});
