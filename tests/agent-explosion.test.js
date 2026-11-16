import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentScene, loadPhysicsEngine } from '../src/agent-scene.js';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene-capabilities.js';
import { EXPLOSION_EMPTY_GRID, explosionGridBytes } from '../src/explosion-grids.js';
import { readVolumeGridFiles } from '../src/mcp-volume-grids.js';
import { agentSceneModulesNeeded, needsPhysics } from '../src/agent-scene-modules.js';

await loadPhysicsEngine();

function setRecipe() {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'slab', type: 'box', bevel: 0 }, { id: 'round', type: 'cylinder' }],
    materials: [{ id: 'stone', color: [0.4, 0.4, 0.4] }, { id: 'wood', color: [0.5, 0.3, 0.15] }],
    nodes: [
      { id: 'ground', geometry: 'round', material: 'stone', translation: [0, -0.1, 0], scale: [9, 0.2, 9] },
      { id: 'crate', geometry: 'slab', material: 'wood', translation: [2.6, 0.5, -1.2] },
    ],
    camera: { eye: [13, 10, 13], target: [0, 1.5, 0], fov: 32 },
    physics: { duration: 3, bodies: [{ node: 'ground', type: 'fixed', shape: 'box' }] },
  };
}

const blast = (extra = {}) => ({ type: 'add-explosion', id: 'blast', center: [0, 0, 0], size: 6, ...extra });

function applyBlast(operation, recipe = setRecipe()) {
  const scene = createAgentScene(recipe);
  const result = scene.apply([operation], { expectedRevision: scene.inspect({}).revision });
  return { scene, result, recipe: scene.exportRecipe() };
}

test('the operation is listed, loads its modules and asks for the physics engine only with debris', () => {
  assert.ok(AGENT_SCENE_CAPABILITIES.operations.includes('add-explosion'));
  assert.match(AGENT_SCENE_CAPABILITIES.explosion, /add-explosion/);
  const modules = agentSceneModulesNeeded([blast()]);
  for (const name of ['explosion', 'motion', 'particles', 'fogShader', 'postSteps']) assert.ok(modules.includes(name), name);
  assert.equal(needsPhysics([blast()]), false);
  assert.equal(needsPhysics([blast({ debris: { node: 'crate' } })]), true);
});

test('a blast writes plain sections, every part ID starting with the explosion ID', () => {
  const { recipe } = applyBlast(blast({ start: 0.5, fuel: 'oily' }));
  assert.equal([recipe.effects.flash].flat()[0].startTime, 0.5);
  assert.equal(recipe.effects.distortion[0].shape, 'ring');
  assert.equal(recipe.environment.localVolumes.length, 1);
  const volume = recipe.environment.localVolumes[0];
  assert.equal(volume.shape, 'grid');
  assert.equal(volume.castShadow, true);
  assert.equal(volume.lightsScene, true);
  assert.equal(volume.loop, false);
  assert.ok(volume.blackbodyIntensity > 0 && volume.temperatureScale === 1000);
  assert.equal(volume.frames.filter(name => name === 'explosion-empty.67vg').length, Math.ceil(0.5 * volume.fps));
  assert.equal(volume.frames.at(-1), 'explosion-oily-1_0071.67vg');
  assert.deepEqual(recipe.particles.systems.map(system => system.node), ['blast-sparks', 'blast-dust', 'blast-rubble']);
  assert.ok(recipe.particles.systems.every(system => system.delay === 0.5));
  const added = [...recipe.nodes, ...recipe.geometries, ...recipe.materials].map(entry => entry.id).filter(id => id.startsWith('blast-'));
  assert.ok(added.length >= 10);
  assert.ok(recipe.nodes.some(node => node.id === 'blast-scorch' && node.decal === true));
  const shake = recipe.motion.tracks.find(track => track.kind === 'camera');
  assert.deepEqual(shake.keyframes.at(-1).value, recipe.camera.eye);
  assert.ok(shake.keyframes.some(key => key.value[0] !== recipe.camera.eye[0]));
  assert.ok(recipe.motion.duration > 0.5 + 72 / volume.fps);
  assert.deepEqual(recipe.nodes.find(node => node.id === 'crate').translation, [2.6, 0.5, -1.2]);
});

test('the same seed gives a byte-identical recipe, another seed a different one', () => {
  const first = JSON.stringify(applyBlast(blast({ seed: 5, debris: { node: 'crate' } })).recipe);
  const second = JSON.stringify(applyBlast(blast({ seed: 5, debris: { node: 'crate' } })).recipe);
  const other = JSON.stringify(applyBlast(blast({ seed: 6, debris: { node: 'crate' } })).recipe);
  assert.equal(first, second);
  assert.notEqual(first, other);
});

test('the expanded recipe passes scene_create validation and the scene samples at any time', () => {
  const { recipe } = applyBlast(blast({ start: 1, debris: { node: 'crate' } }));
  const scene = createAgentScene(recipe);
  assert.equal(scene.inspect({}).particles.systems.length, 3);
});

test('debris fractures the node into loose pieces thrown by impulse events at the start tick', () => {
  const { recipe } = applyBlast(blast({ start: 0.5, debris: { node: 'crate' } }));
  assert.ok(!recipe.nodes.some(node => node.id === 'crate'));
  const pieces = recipe.nodes.filter(node => node.id.startsWith('crate-frag-'));
  assert.equal(pieces.length, 12);
  assert.equal(recipe.physics.joints, undefined);
  assert.equal(recipe.physics.events.length, 12);
  assert.ok(recipe.physics.events.every(event => event.tick === 30 && event.impulse.some(component => component !== 0)));
  assert.ok(recipe.physics.duration >= 3.5);
});

test('shake is skipped when the camera already has an eye track and refused when asked for', () => {
  const recipe = setRecipe();
  recipe.motion = { duration: 2, tracks: [{ kind: 'camera', property: 'eye', keyframes: [{ time: 0, value: [13, 10, 13] }, { time: 2, value: [12, 10, 13] }] }] };
  const { recipe: result } = applyBlast(blast(), recipe);
  assert.equal(result.motion.tracks.filter(track => track.kind === 'camera').length, 1);
  assert.throws(() => applyBlast(blast({ shake: 0.5 }), setRecipeWithEyeTrack()), /shake/);
});

function setRecipeWithEyeTrack() {
  const recipe = setRecipe();
  recipe.motion = { duration: 2, tracks: [{ kind: 'camera', property: 'eye', keyframes: [{ time: 0, value: [13, 10, 13] }, { time: 2, value: [12, 10, 13] }] }] };
  return recipe;
}

test('bad input names the field and a valid value', () => {
  const cases = [
    [blast({ id: 'a b' }), /id/],
    [blast({ id: 5 }), /id/],
    [blast({ center: [0, 0] }), /center/],
    [blast({ size: 0 }), /size.*0\.5 to 100/],
    [blast({ size: 101 }), /size/],
    [blast({ start: -1 }), /start/],
    [blast({ seed: 1.5 }), /seed/],
    [blast({ fuel: 'nuclear' }), /fuel.*dry, oily/],
    [blast({ shake: 2 }), /shake/],
    [blast({ extra: 1 }), /extra/],
    [blast({ debris: { node: 'missing' } }), /debris\.node.*existing node/],
    [blast({ debris: {} }), /debris\.node/],
  ];
  for (const [operation, pattern] of cases) assert.throws(() => applyBlast(operation), pattern, JSON.stringify(operation));
});

test('debris needs a physics floor, and a second blast needs a new ID and no other grid volume', () => {
  const recipe = setRecipe();
  delete recipe.physics;
  assert.throws(() => applyBlast(blast({ debris: { node: 'crate' } }), recipe), /fixed floor/);
  const scene = createAgentScene(setRecipe());
  scene.apply([blast()], { expectedRevision: scene.inspect({}).revision });
  assert.throws(() => scene.apply([blast()], { expectedRevision: scene.inspect({}).revision }), /blast-/);
  assert.throws(() => scene.apply([blast({ id: 'second' })], { expectedRevision: scene.inspect({}).revision }), /grid volume/);
});

test('the fireball is a gas-sim grid volume scaled to the blast size: box, density, emission and playback speed', () => {
  const small = applyBlast(blast({ size: 2.5 })).recipe.environment.localVolumes[0];
  const large = applyBlast(blast({ size: 10 })).recipe.environment.localVolumes[0];
  assert.deepEqual(small.size, [8, 8, 8]);
  assert.deepEqual(large.size, [32, 32, 32]);
  assert.equal(small.fps, 24);
  assert.equal(large.fps, 12);
  assert.equal(small.density / large.density, 4);
  assert.equal(small.emissionStrength / large.emissionStrength, 4);
  assert.deepEqual(small.center, [0, 4, 0]);
  const oily = applyBlast(blast({ size: 2.5, fuel: 'oily' })).recipe.environment.localVolumes[0];
  assert.equal(oily.density, 1.5 * small.density);
  assert.notDeepEqual(oily.frames, small.frames);
  const raised = applyBlast(blast({ size: 2.5, center: [1, 2, 3], ground: 0 })).recipe.environment.localVolumes[0];
  assert.deepEqual(raised.center, [1, 6, 3]);
});

test('the grids the recipe names are baked from the name, byte for byte, and tied to the seed and the fuel', () => {
  const { frames } = applyBlast(blast({ seed: 3 })).recipe.environment.localVolumes[0];
  assert.equal(frames.length, 72);
  assert.equal(frames[0], 'explosion-dry-3_0000.67vg');
  const first = explosionGridBytes(frames[10]);
  const again = explosionGridBytes(frames[10]);
  assert.ok(first.length > 1000);
  assert.deepEqual(first, again);
  assert.notDeepEqual(first, explosionGridBytes('explosion-dry-4_0010.67vg'));
  assert.notDeepEqual(first, explosionGridBytes('explosion-oily-3_0010.67vg'));
  assert.equal(explosionGridBytes('explosion-dry-3_0072.67vg'), null);
  assert.equal(explosionGridBytes('blast.67vg'), null);
  assert.ok(explosionGridBytes(EXPLOSION_EMPTY_GRID).length > 1000);
});

test('the wait before a blast is empty grid frames, bounded by the frame list', () => {
  const waited = applyBlast(blast({ size: 2.5, start: 2 })).recipe.environment.localVolumes[0];
  assert.equal(waited.frames.length, 72 + 48);
  assert.ok(waited.frames.slice(0, 48).every(name => name === EXPLOSION_EMPTY_GRID));
  assert.throws(() => applyBlast(blast({ size: 2.5, start: 30 })), /start.*at most 18\.3 s.*512/);
});

test('a scene with a grid volume already refuses the blast and says how to make room', () => {
  const recipe = setRecipe();
  recipe.environment = { localVolumes: [{ shape: 'grid', grid: 'explosion-empty.67vg', center: [0, 1, 0], size: [2, 2, 2] }] };
  assert.throws(() => applyBlast(blast(), recipe), /grid volume.*set-environment/);
});

test('the MCP server finds the grids an add-explosion operation will name, so the page gets them with the call', () => {
  const files = readVolumeGridFiles([blast({ seed: 9, fuel: 'oily', start: 1 })], '.');
  assert.equal(files.size, 73);
  assert.ok(files.has('explosion-oily-9_0000.67vg'));
  assert.ok(files.has(EXPLOSION_EMPTY_GRID));
  assert.equal(readVolumeGridFiles([blast({ fuel: 'nuclear' })], '.').size, 0);
  assert.equal(readVolumeGridFiles([blast({ seed: -1 })], '.').size, 0);
});
