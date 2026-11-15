import './support/load-agent-scene-modules.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mat4 } from 'gl-matrix';
import { createAgentScene, loadPhysicsEngine } from '../src/agent-scene.js';
import { createVehicleRig, driveAlongPath, crashImpulse, dentDepth, dentGeometry, detachedPartIds, findDriveImpact } from '../src/vehicle.js';

await loadPhysicsEngine();

const CAR_MASS = 1400;
const NOSE_OFFSET = 1.7;
const WALL_Z = 20;

/** A flat grid facing +z at z = 0, as the front panel of a car: `cells` squares a side, `size` metres wide. */
function frontPanel(cells = 40, size = 2) {
  const positions = [];
  const normals = [];
  const indices = [];
  for (let row = 0; row <= cells; row++) {
    for (let column = 0; column <= cells; column++) {
      positions.push((column / cells - 0.5) * size, (row / cells - 0.5) * size, 0);
      normals.push(0, 0, 1);
    }
  }
  const stride = cells + 1;
  for (let row = 0; row < cells; row++) {
    for (let column = 0; column < cells; column++) {
      const first = row * stride + column;
      indices.push(first, first + 1, first + stride, first + 1, first + stride + 1, first + stride);
    }
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices) };
}

function digest(geometry) {
  const hash = createHash('sha256');
  hash.update(Buffer.from(geometry.positions.buffer, geometry.positions.byteOffset, geometry.positions.byteLength));
  hash.update(Buffer.from(geometry.normals.buffer, geometry.normals.byteOffset, geometry.normals.byteLength));
  return hash.digest('hex');
}

function deepestDent(original, dented) {
  let deepest = 0;
  for (let index = 0; index < original.positions.length; index += 3) {
    deepest = Math.max(deepest, Math.hypot(
      dented.positions[index] - original.positions[index],
      dented.positions[index + 1] - original.positions[index + 1],
      dented.positions[index + 2] - original.positions[index + 2],
    ));
  }
  return deepest;
}

function boxVertices(center, size) {
  const positions = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    positions.push(center[0] + sx * size[0] / 2, center[1] + sy * size[1] / 2, center[2] + sz * size[2] / 2);
  }
  return { positions: new Float32Array(positions) };
}

function createCarRig() {
  const body = { name: 'Body', geometry: boxVertices([0, 0.8, 0], [1.6, 0.5, 3.4]), matrix: mat4.create() };
  const wheels = [[0.8, 1.2, 'FL'], [-0.8, 1.2, 'FR'], [0.8, -1.2, 'RL'], [-0.8, -1.2, 'RR']].map(([x, z, corner]) => {
    const positions = [];
    for (let step = 0; step < 24; step++) {
      const angle = step / 24 * Math.PI * 2;
      for (const side of [-1, 1]) positions.push(x + side * 0.1, 0.35 + Math.sin(angle) * 0.35, z + Math.cos(angle) * 0.35);
    }
    return { name: `Wheel_${corner}`, geometry: { positions: new Float32Array(positions) }, matrix: mat4.create() };
  });
  return createVehicleRig({ parts: [body, ...wheels], body: [body] });
}

/** What a car driven at `speed` into a wall at z = 20 does to a front panel: the deepest dent in metres. */
function crashAtSpeed(speed, panel = frontPanel()) {
  const drive = driveAlongPath(createCarRig(), [[0, 0, 0], [0, 0, WALL_Z + 5]], { speed });
  const impact = findDriveImpact(drive, { point: [0, 0, WALL_Z], normal: [0, 0, -1] }, { mass: CAR_MASS, frontOffset: NOSE_OFFSET });
  const dent = { stiffness: 40000, maxDepth: 0.6, radius: 0.5, impacts: [{ point: [0, 0, 0], direction: impact.direction, impulse: impact.impulse }] };
  return { impact, depth: deepestDent(panel, dentGeometry(panel, dent)) };
}

test('a car driven into a wall dents its front by an amount that grows with speed', () => {
  const slow = crashAtSpeed(3);
  const medium = crashAtSpeed(6);
  const fast = crashAtSpeed(12);
  assert.ok(Math.abs(slow.impact.speed - 3) < 1e-6 && Math.abs(fast.impact.speed - 12) < 1e-6);
  assert.ok(Math.abs(slow.impact.impulse - CAR_MASS * 3) < 1e-6);
  assert.ok(slow.depth > 0.05);
  assert.ok(slow.depth < medium.depth && medium.depth < fast.depth, `${slow.depth} ${medium.depth} ${fast.depth}`);
  assert.ok(Math.abs(medium.impact.point[2] - WALL_Z) < 1e-6);
  assert.ok(medium.impact.time > 2 && medium.impact.time < 4);
});

test('the same crash gives the same bytes on every run', () => {
  const panel = frontPanel();
  const dent = { impacts: [{ point: [0.2, 0.1, 0], direction: [0, 0, -1], impulse: 600 }, { point: [-0.3, 0, 0], direction: [0.2, 0, -1], impulse: 300 }] };
  assert.equal(digest(dentGeometry(panel, dent)), digest(dentGeometry(panel, dent)));
  assert.notEqual(digest(dentGeometry(panel, dent)), digest(panel));
  assert.equal(crashAtSpeed(8).depth, crashAtSpeed(8).depth);
});

test('a dent never passes maxDepth and touches at most 4096 vertices per hit, and the input stays as it was', () => {
  const panel = frontPanel(100, 2);
  const before = digest(panel);
  const dented = dentGeometry(panel, { maxDepth: 0.1, radius: 50, impacts: [{ point: [0, 0, 0], direction: [0, 0, -1], impulse: 1e9 }] });
  assert.equal(digest(panel), before);
  assert.ok(Math.abs(deepestDent(panel, dented) - 0.1) < 1e-6);
  let moved = 0;
  for (let index = 0; index < panel.positions.length; index += 3) if (dented.positions[index + 2] !== 0) moved++;
  assert.equal(moved, 4096);
  const repeated = dentGeometry(panel, { maxDepth: 0.1, radius: 50, impacts: Array.from({ length: 8 }, () => ({ point: [0, 0, 0], direction: [0, 0, -1], impulse: 1e9 })) });
  assert.ok(deepestDent(panel, repeated) <= 0.1 + 1e-6);
  assert.equal(dentDepth(10, { stiffness: 1000, maxDepth: 0.25 }), 0.01);
});

test('a dent tilts the normals around the hit and leaves the rest of the panel alone', () => {
  const panel = frontPanel();
  const dented = dentGeometry(panel, { radius: 0.4, impacts: [{ point: [0, 0, 0], direction: [0, 0, -1], impulse: 600 }] });
  const edge = panel.positions.length / 3 - 1;
  assert.deepEqual([...dented.normals.slice(edge * 3, edge * 3 + 3)], [0, 0, 1]);
  const tilted = [...dented.normals].some((component, index) => index % 3 !== 2 && Math.abs(component) > 0.01);
  assert.ok(tilted);
});

test('a bumper comes off above its threshold and stays on below it', () => {
  const impulse = crashImpulse({ mass: CAR_MASS, speed: 10 });
  const parts = [{ id: 'front-bumper', threshold: 9000 }, { id: 'mirror', threshold: 20000 }, { id: 'hood', threshold: 14000 }];
  assert.equal(impulse, 14000);
  assert.deepEqual(detachedPartIds(parts, impulse), ['front-bumper', 'hood']);
  assert.deepEqual(detachedPartIds(parts, 8999), []);
  assert.deepEqual(detachedPartIds(parts, 20000), ['front-bumper', 'mirror', 'hood']);
});

test('a bumper joined by a breakable joint breaks off in a physics crash only above the joint strength', () => {
  function crash(breakImpulse) {
    const scene = createAgentScene({
      format: 'crucible.scene', schemaVersion: 1,
      geometries: [{ id: 'slab', type: 'box', bevel: 0 }],
      materials: [{ id: 'paint', color: [0.6, 0.1, 0.1] }],
      nodes: [
        { id: 'floor', geometry: 'slab', material: 'paint', translation: [0, -0.25, 0], scale: [30, 0.5, 6] },
        { id: 'wall', geometry: 'slab', material: 'paint', translation: [0, 1, 9], scale: [4, 2, 0.5] },
        { id: 'car', geometry: 'slab', material: 'paint', translation: [0, 0.5, 0], scale: [1.6, 0.8, 3] },
        { id: 'bumper', geometry: 'slab', material: 'paint', translation: [0, 0.4, 1.7], scale: [1.6, 0.3, 0.3] },
      ],
      physics: {
        duration: 2,
        bodies: [
          { node: 'floor', type: 'fixed', shape: 'box' },
          { node: 'wall', type: 'fixed', shape: 'box' },
          { node: 'car', shape: 'box', mass: 1000, velocity: [0, 0, 10] },
          { node: 'bumper', shape: 'box', mass: 20, velocity: [0, 0, 10] },
        ],
        joints: [{ name: 'bumper-mount', type: 'fixed', bodyA: 'car', bodyB: 'bumper', anchorA: [0, -0.1, 1.7], anchorB: [0, 0, 0], breakImpulse }],
      },
    });
    scene.sampleMotion(2);
    return scene.inspect({}).physics.jointBreaks ?? [];
  }
  const hit = crash(1);
  assert.equal(hit.length, 1);
  assert.equal(hit[0].joint, 'bumper-mount');
  assert.deepEqual(crash(hit[0].impulse * 10), []);
});

function dentedRecipe(geometry) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'hood', type: 'sphere' }, geometry],
    materials: [{ id: 'paint', color: [0.6, 0.1, 0.1] }],
    nodes: [{ id: 'hood-node', geometry: geometry.id, material: 'paint' }],
  };
}

function recipeVertices(scene) {
  return scene.parts[0].geometry.positions;
}

test('a dented geometry in a recipe pushes the source in at the hits, deterministically', () => {
  const dented = { id: 'hood-dented', type: 'dented', source: 'hood', stiffness: 1000, maxDepth: 0.2, radius: 0.6, impacts: [{ point: [0, 0, 1], direction: [0, 0, -1], impulse: 100 }] };
  const first = createAgentScene(dentedRecipe(dented));
  const second = createAgentScene(dentedRecipe(dented));
  const intact = createAgentScene({ ...dentedRecipe(dented), nodes: [{ id: 'hood-node', geometry: 'hood', material: 'paint' }] });
  assert.deepEqual(recipeVertices(first), recipeVertices(second));
  assert.equal(recipeVertices(first).length, recipeVertices(intact).length);
  let deepest = 0;
  for (let index = 0; index < recipeVertices(first).length; index++) {
    deepest = Math.max(deepest, Math.abs(recipeVertices(first)[index] - recipeVertices(intact)[index]));
  }
  assert.ok(deepest > 0.05 && deepest <= 0.1 + 1e-6, `deepest ${deepest}`);
});

test('a dented geometry in a recipe names what to pass when the input is wrong', () => {
  const dented = { id: 'hood-dented', type: 'dented', source: 'hood', impacts: [{ point: [0, 0, 1], direction: [0, 0, -1], impulse: 100 }] };
  assert.throws(() => createAgentScene(dentedRecipe({ ...dented, source: 'missing' })), /source.*one of hood/s);
  assert.throws(() => createAgentScene(dentedRecipe({ ...dented, impacts: [] })), /1 to 8 impacts/);
  assert.throws(() => createAgentScene(dentedRecipe({ ...dented, impacts: Array.from({ length: 9 }, () => dented.impacts[0]) })), /1 to 8 impacts/);
  assert.throws(() => createAgentScene(dentedRecipe({ ...dented, impacts: [{ point: [0, 0, 1], direction: [0, 0, 0], impulse: 100 }] })), /impacts\[0\]\.direction.*not zero/s);
  assert.throws(() => createAgentScene(dentedRecipe({ ...dented, maxDepth: 5 })), /maxDepth.*from 0.000001 to 2/s);
  assert.throws(() => createAgentScene(dentedRecipe({ ...dented, depth: 1 })), /depth/);
  assert.throws(() => detachedPartIds([{ id: 'bumper' }], 10), /threshold/);
  assert.throws(() => findDriveImpact({ duration: 1, sample: () => ({}) }, { point: [0, 0, 1], normal: [0, 0, 0] }, { mass: 1 }), /wall\.normal/);
});
