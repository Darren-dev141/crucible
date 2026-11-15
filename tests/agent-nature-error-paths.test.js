import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene } from '../src/agent-scene.js';

function vegetationRecipe(scatter, extraNodes = []) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'ground', type: 'terrain', size: 40, resolution: 16, seed: 3, amplitude: 1 }, { id: 'pad', type: 'box' }],
    materials: [{ id: 'grass', tag: 'grass', color: [0.2, 0.4, 0.1] }, { id: 'stone', color: [0.5, 0.5, 0.5] }],
    nodes: [{ id: 'hills', geometry: 'ground', material: 'grass' }, ...extraNodes, { id: 'forest', vegetation: { mix: { bush: 1 }, scatter } }],
    camera: { eye: [0, 6, 40], target: [0, 4, 0] },
  };
}

function forestParts(scene) {
  return scene.parts.filter(part => part.name.startsWith('forest/'));
}

test('a scatter area that misses the ground names vegetation.scatter.area and the span that works', () => {
  const miss = { ground: 'hills', area: { min: [100, 100], max: [110, 110] } };
  assert.throws(() => createAgentScene(vegetationRecipe(miss)), /vegetation\.scatter\.area: got .*overlaps the ground.*-19\.5 to 19\.5/);
  const overlapping = { ground: 'hills', area: { min: [-100, -100], max: [-30, 100] } };
  assert.throws(() => createAgentScene(vegetationRecipe(overlapping)), /vegetation\.scatter\.area/);
});

test('an exclusion that follows a node inside a moved group clears the ground under the node, not under its local offset', () => {
  const nodes = [
    { id: 'camp', translation: [10, 0, 0] },
    { id: 'pond', parent: 'camp', geometry: 'pad', material: 'stone' },
  ];
  const clearRadius = 6;
  const withExclusion = createAgentScene(vegetationRecipe({ ground: 'hills', density: 0.05, exclude: [{ node: 'pond', radius: clearRadius }] }, nodes));
  const withoutExclusion = createAgentScene(vegetationRecipe({ ground: 'hills', density: 0.05 }, nodes));
  const nearPond = scene => forestParts(scene).filter(part => Math.hypot(part.matrix[12] - 10, part.matrix[14]) <= clearRadius);
  assert.ok(nearPond(withoutExclusion).length > 0, 'the control scene grows plants where the pond stands');
  assert.equal(nearPond(withExclusion).length, 0);
});

test('an exclusion that names a missing node reports its own index in the list', () => {
  const exclude = [{ center: [0, 0], radius: 2 }, { node: 'nothing', radius: 2 }];
  assert.throws(() => createAgentScene(vegetationRecipe({ ground: 'hills', exclude })), /vegetation\.scatter\.exclude\[1\]\.node/);
});

function particleRecipe(emitter) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'speck', type: 'box' }, { id: 'wall', type: 'box' }],
    materials: [{ id: 'paint' }],
    nodes: [
      { id: 'dust', geometry: 'speck', material: 'paint' },
      { id: 'sparks', geometry: 'speck', material: 'paint' },
      { id: 'wall', geometry: 'wall', material: 'paint', translation: [0, 0, 5] },
    ],
    particles: { systems: [{ node: 'dust', count: 10 }, { node: 'sparks', count: 10, emitter }] },
  };
}

test('a particle emitter vertex group that the mesh lacks names the system that asked for it', () => {
  const missingGroup = { shape: 'mesh', mesh: 'wall', group: 'rim' };
  assert.throws(() => createAgentScene(particleRecipe(missingGroup)), /particles\.systems\[1\]\.emitter\.group: got "rim"/);
});

test('a cloth pin group that the mesh lacks names the sheet that asked for it', () => {
  const recipe = {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'sheet', type: 'mesh', base: { type: 'grid', segments: 4 } }],
    materials: [{ id: 'fabric', doubleSided: true }],
    nodes: [
      { id: 'flag', geometry: 'sheet', material: 'fabric' },
      { id: 'banner', geometry: 'sheet', material: 'fabric', translation: [2, 0, 0] },
    ],
    cloth: { duration: 1, sheets: [{ node: 'flag', pin: ['top'] }, { node: 'banner', pinGroup: 'hem' }] },
  };
  assert.throws(() => createAgentScene(recipe), /cloth\.sheets\[1\]\.pinGroup: got "hem"/);
});

test('a vegetation exclusion that mixes the box form with the circle form names both forms and its index', () => {
  const mixed = { ground: 'hills', exclude: [{ center: [0, 0], radius: 2 }, { min: [-3, -3], max: [3, 3], radius: 4 }] };
  assert.throws(() => createAgentScene(vegetationRecipe(mixed)), /vegetation\.scatter\.exclude\[1\]: got .*expected either the box form.*"min".*"max".*or the circle form.*"center".*"radius"/s);
  const withNode = { ground: 'hills', exclude: [{ min: [-3, -3], max: [3, 3], node: 'hills' }] };
  assert.throws(() => createAgentScene(vegetationRecipe(withNode)), /vegetation\.scatter\.exclude\[0\]/);
  const boxOnly = { ground: 'hills', exclude: [{ min: [-3, -3], max: [3, 3] }] };
  assert.doesNotThrow(() => createAgentScene(vegetationRecipe(boxOnly)));
});

test('hair swayRate without sway is refused and names sway', () => {
  const hairRecipe = system => ({
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'ball', type: 'sphere' }, { id: 'strand', type: 'box' }],
    materials: [{ id: 'paint' }],
    nodes: [{ id: 'head', geometry: 'ball', material: 'paint' }, { id: 'fur', geometry: 'strand', material: 'paint' }],
    particles: { systems: [{ type: 'hair', node: 'fur', surface: 'head', seed: 5, count: 10, ...system }] },
  });
  assert.throws(() => createAgentScene(hairRecipe({ swayRate: 2 })), /particles\.systems\[0\]\.swayRate: got 2; expected .*sway/);
  assert.doesNotThrow(() => createAgentScene(hairRecipe({ sway: 0.05, swayRate: 2 })));
});

test('a box particle emitter with a radius is refused and points to halfExtents', () => {
  assert.throws(() => createAgentScene(particleRecipe({ shape: 'box', radius: 2 })), /particles\.systems\[1\]\.emitter\.radius: got 2; expected .*halfExtents/);
  assert.doesNotThrow(() => createAgentScene(particleRecipe({ shape: 'sphere', radius: 2 })));
});
