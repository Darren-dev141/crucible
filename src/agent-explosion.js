import { invalidField } from './field-error.js';
import { finiteNumber, knownKeys, vectorOfThree } from './agent-recipe-checks.js';

// The add-explosion operation: one call writes a layered blast into ordinary recipe sections (effects, local volumes,
// particles, motion, physics), so scene_export_recipe shows plain parts an agent can tweak afterwards. The expansion is a
// pure function of the operation and the scene, so the same seed gives the same recipe byte for byte (#1050).

export const EXPLOSION_LIMITS = Object.freeze({
  size: [0.5, 100],
  start: [0, 3600],
  shake: [0, 1],
  maxIdLength: 64,
  fuels: Object.freeze(['dry', 'oily']),
  debrisSpeedLimit: 40,
});

const EXPLOSION_FIELDS = ['type', 'id', 'center', 'size', 'start', 'seed', 'fuel', 'debris', 'shake', 'ground'];
const DEBRIS_FIELDS = ['node'];
const POSITION_LIMIT = 10000;
const SMOKE_SECONDS = 8;
const SHAKE_SECONDS = 1;
const SHAKE_KEYS_PER_SECOND = 32;
const TICKS_PER_SECOND = 60;
const MAX_PHYSICS_SECONDS = 10;
const MAX_LOCAL_VOLUMES = 8;
const MAX_PARTICLE_SYSTEMS = 4;
const MAX_PARTICLES = 4000;
const MAX_AIR_SOURCES = 4;
const TINY = 0.001;

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function round(value) {
  return Number(value.toFixed(5));
}

/** Checks the operation and returns it with every default filled in. */
export function validatedExplosion(operation) {
  knownKeys(operation, EXPLOSION_FIELDS, 'operation');
  const { id } = operation;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id) || id.length > EXPLOSION_LIMITS.maxIdLength) {
    throw invalidField('id', id, `a string of 1 to ${EXPLOSION_LIMITS.maxIdLength} letters, digits, - or _, such as "blast"; every part of the blast gets an ID that starts with it`);
  }
  const center = vectorOfThree(operation.center, 'center', POSITION_LIMIT);
  const [minimumSize, maximumSize] = EXPLOSION_LIMITS.size;
  const size = finiteNumber(operation.size, 'size', minimumSize, maximumSize);
  const start = operation.start === undefined ? 0 : finiteNumber(operation.start, 'start', ...EXPLOSION_LIMITS.start);
  const seed = operation.seed === undefined ? 1 : finiteNumber(operation.seed, 'seed', 0, 4294967295);
  if (!Number.isInteger(seed)) throw invalidField('seed', seed, 'a whole number from 0 to 4294967295, such as 1');
  const fuel = operation.fuel ?? 'dry';
  if (!EXPLOSION_LIMITS.fuels.includes(fuel)) throw invalidField('fuel', fuel, `one of ${EXPLOSION_LIMITS.fuels.join(', ')}`);
  const ground = operation.ground === undefined ? center[1] : finiteNumber(operation.ground, 'ground', -POSITION_LIMIT, POSITION_LIMIT);
  let debris;
  if (operation.debris !== undefined) {
    knownKeys(operation.debris, DEBRIS_FIELDS, 'debris');
    if (typeof operation.debris.node !== 'string' || !operation.debris.node) {
      throw invalidField('debris.node', operation.debris.node, 'the ID of an existing mesh node to break apart, such as "crate"');
    }
    debris = { node: operation.debris.node };
  }
  const shake = operation.shake === undefined ? undefined : finiteNumber(operation.shake, 'shake', ...EXPLOSION_LIMITS.shake);
  return { id, center, size, start, seed, fuel, ground, debris, shake };
}

function claimIds(candidate, id) {
  const prefix = `${id}-`;
  const taken = [candidate.nodes, candidate.geometries, candidate.materials].flat().find(entry => entry.id.startsWith(prefix));
  if (taken) {
    throw invalidField('id', id, `an explosion ID no part uses yet; ${taken.id} already exists, so pick a new ID or remove the earlier blast's parts first`);
  }
}

function sourceVolume(geometry) {
  const { positions, indices } = geometry;
  let volume = 0;
  for (let corner = 0; corner < indices.length; corner += 3) {
    const [first, second, third] = [0, 1, 2].map(offset => indices[corner + offset] * 3);
    volume += (positions[first] * (positions[second + 1] * positions[third + 2] - positions[second + 2] * positions[third + 1])
      - positions[first + 1] * (positions[second] * positions[third + 2] - positions[second + 2] * positions[third])
      + positions[first + 2] * (positions[second] * positions[third + 1] - positions[second + 1] * positions[third])) / 6;
  }
  return Math.abs(volume);
}

/** Keys of one track with times that repeat dropped, so a blast at time 0 needs no special case. */
function uniqueKeys(keys) {
  const result = [];
  for (const key of keys) {
    if (result.length === 0 || key.time > result.at(-1).time + 1e-6) result.push({ time: round(key.time), value: key.value });
    else result[result.length - 1] = { time: result.at(-1).time, value: key.value };
  }
  return result;
}

function nodeTrack(id, property, keys, easing) {
  const keyframes = uniqueKeys(keys).map((key, index, all) => (easing && index < all.length - 1 ? { ...key, easing } : key));
  return { kind: 'node', id, property, interpolation: 'LINEAR', keyframes };
}

function addAirSteps(candidate, plan) {
  const { id, center, size, start } = plan;
  const effects = candidate.effects;
  const flashes = effects.flash === undefined ? [] : [effects.flash].flat();
  const rings = effects.distortion === undefined ? [] : [effects.distortion].flat();
  if (flashes.length >= MAX_AIR_SOURCES || rings.length >= MAX_AIR_SOURCES) {
    throw invalidField('id', id, `a scene with fewer than ${MAX_AIR_SOURCES} flash and distortion sources, since a blast adds one of each; clear effects.flash or effects.distortion first`);
  }
  flashes.push({
    centre: center, startTime: start, attack: 0, decay: round(0.12 + 0.04 * Math.sqrt(size)),
    intensity: 6, radius: round(size * 3), color: [1, 0.85, 0.6], ambient: 0.12,
  });
  rings.push({
    shape: 'ring', centre: center, startTime: start, speed: round(30 + 10 * Math.sqrt(size)),
    thickness: round(0.5 + 0.12 * size), strength: 0.9, falloff: 0.6, edge: 0.5, maxRadius: round(size * 8),
  });
  effects.flash = flashes.length === 1 ? flashes[0] : flashes;
  effects.distortion = rings;
}

function volumePlan(plan) {
  const { id, center, size, start, ground, oily } = plan;
  const fire = size * (oily ? 1.3 : 1);
  const rise = size * 0.5;
  const smokeDensity = oily ? 4 : 2.4;
  const smokeWidth = size * (oily ? 1.1 : 0.8);
  const smokeHeight = size * (oily ? 3 : 2.2);
  const smokeBase = Math.max(ground, center[1]);
  const volumes = [
    { name: 'fireball', shape: 'mesh', fit: 'bounds', density: 3, falloff: 0.9, noiseAmount: 0.7, noiseScale: round(1.2 / size * 4), absorption: [0.25, 0.6, 1], emission: [1, 0.42, 0.08], emissionStrength: 5 },
    { name: 'core', shape: 'mesh', fit: 'bounds', density: 2, falloff: 0.9, noiseAmount: 0.4, noiseScale: round(1.2 / size * 6), absorption: [0.3, 0.7, 1], emission: [1, 0.85, 0.5], emissionStrength: 12 },
    { name: 'smoke', shape: 'mesh', fit: 'bounds', density: smokeDensity, falloff: 0.85, noiseAmount: 0.8, noiseScale: round(1.5 / size * 3), absorption: [0.92, 0.92, 0.92], steps: 24 },
  ];
  const tracks = [
    nodeTrack(`${id}-fireball`, 'scale', [
      { time: 0, value: [TINY, TINY, TINY] }, { time: start, value: [TINY, TINY, TINY] },
      { time: start + 0.35, value: [fire, fire * 0.9, fire], easing: 'easeOutCubic' },
      { time: start + 1.2, value: [fire * 1.15, fire, fire * 1.15] },
      { time: start + 2.4, value: [fire * 0.08, fire * 0.08, fire * 0.08] },
    ], 'easeOutCubic'),
    nodeTrack(`${id}-fireball`, 'translation', [
      { time: 0, value: [...center] }, { time: start, value: [...center] },
      { time: start + 2.4, value: [center[0], center[1] + fire * 0.5 + rise, center[2]] },
    ]),
    nodeTrack(`${id}-core`, 'scale', [
      { time: 0, value: [TINY, TINY, TINY] }, { time: start, value: [TINY, TINY, TINY] },
      { time: start + 0.2, value: [fire * 0.55, fire * 0.5, fire * 0.55], easing: 'easeOutCubic' },
      { time: start + 0.9, value: [TINY, TINY, TINY] },
    ], 'easeOutCubic'),
    nodeTrack(`${id}-core`, 'translation', [{ time: 0, value: [...center] }]),
    nodeTrack(`${id}-smoke`, 'scale', [
      { time: 0, value: [TINY, TINY, TINY] }, { time: start + 0.15, value: [TINY, TINY, TINY] },
      { time: start + 4, value: [smokeWidth, smokeHeight, smokeWidth], easing: 'easeOutQuad' },
      { time: start + SMOKE_SECONDS, value: [smokeWidth * 1.5, smokeHeight * 1.2, smokeWidth * 1.5] },
    ], 'easeOutQuad'),
    nodeTrack(`${id}-smoke`, 'translation', [
      { time: 0, value: [center[0], smokeBase, center[2]] }, { time: start + 0.15, value: [center[0], smokeBase, center[2]] },
      { time: start + 4, value: [center[0], smokeBase + smokeHeight * 0.5, center[2]] },
      { time: start + SMOKE_SECONDS, value: [center[0], smokeBase + smokeHeight * 0.65, center[2]] },
    ], 'easeOutQuad'),
  ];
  return { volumes, tracks };
}

function addVolumes(candidate, plan) {
  const environment = candidate.environment;
  const existing = environment.localVolumes ?? [];
  const { volumes, tracks } = volumePlan(plan);
  if (existing.length + volumes.length > MAX_LOCAL_VOLUMES) {
    throw invalidField('id', plan.id, `a scene with room for ${volumes.length} more local volumes (${existing.length} of ${MAX_LOCAL_VOLUMES} in use); remove one with set-environment first`);
  }
  candidate.geometries.push({ id: `${plan.id}-cube`, type: 'box', bevel: 0 });
  for (const { name, ...volume } of volumes) {
    candidate.nodes.push({ id: `${plan.id}-${name}`, geometry: `${plan.id}-cube`, scale: [TINY, TINY, TINY], translation: [...plan.center], visible: false });
    existing.push({ ...volume, part: `${plan.id}-${name}` });
  }
  environment.localVolumes = existing;
  return tracks;
}

function addMaterial(candidate, id, fields) {
  candidate.materials.push({ id, ...fields });
}

function particleSystems(candidate, plan, random) {
  const { id, center, size, start, ground, oily } = plan;
  const reach = Math.sqrt(size);
  const piece = `${id}-speck`;
  candidate.geometries.push({ id: piece, type: 'box', bevel: 0 });
  addMaterial(candidate, `${id}-spark-glow`, { color: [1, 0.5, 0.1], emission: 8, emissiveColor: [1, 0.5, 0.1], roughness: 1 });
  addMaterial(candidate, `${id}-dust-grey`, { color: [0.45, 0.4, 0.34], roughness: 1 });
  addMaterial(candidate, `${id}-rubble-grey`, { color: [0.12, 0.11, 0.1], roughness: 0.9 });
  const specification = [
    { name: 'sparks', material: 'spark-glow', count: oily ? 420 : 300, lifetime: [0.6, 1.8], speed: [round(size * 1.5 + 3), round(size * 4 + 8)], size: round(0.025 * reach), spread: 80, drag: 0.5, scale: 'shrink', emitter: { shape: 'sphere', position: [...center], radius: round(size * 0.15) }, color: [[1, 0.9, 0.5], [0.8, 0.2, 0.05]] },
    { name: 'dust', material: 'dust-grey', count: 360, lifetime: [1.5, 3.2], speed: [round(size * 0.8), round(size * 2.2)], size: [round(0.08 * reach), round(0.22 * reach)], spread: 88, drag: 1.8, scale: 'grow', emitter: { shape: 'disc', position: [center[0], ground, center[2]], radius: round(size * 0.3) }, alpha: [0.8, 0] },
    { name: 'rubble', material: 'rubble-grey', count: 60, lifetime: [1.5, 3], speed: [round(size * 0.8 + 2), round(size * 2.4 + 5)], size: [0.04, round(0.1 + 0.03 * size)], spread: 70, drag: 0.1, floor: ground, bounce: 0.3, scale: 'constant', emitter: { shape: 'sphere', position: [...center], radius: round(size * 0.1) } },
  ];
  return specification.map(({ name, material, ...settings }, index) => {
    candidate.nodes.push({ id: `${id}-${name}`, geometry: piece, material: `${id}-${material}`, castShadow: false });
    return { node: `${id}-${name}`, seed: Math.floor(random() * 1e9) + index, delay: start, direction: [0, 1, 0], floor: ground, ...settings };
  });
}

function addParticles(candidate, plan, random) {
  const section = candidate.particles ?? { systems: [] };
  const systems = particleSystems(candidate, plan, random).map(system => JSON.parse(JSON.stringify(system)));
  const total = [...section.systems, ...systems].reduce((sum, system) => sum + (system.count ?? 100), 0);
  if (section.systems.length + systems.length > MAX_PARTICLE_SYSTEMS || total > MAX_PARTICLES) {
    throw invalidField('id', plan.id, `a scene with room for ${systems.length} more particle systems and ${total - MAX_PARTICLES} fewer particles (${section.systems.length} of ${MAX_PARTICLE_SYSTEMS} systems in use); clear particles with set-particles first`);
  }
  section.systems.push(...systems);
  candidate.particles = section;
}

function addScorch(candidate, plan) {
  const { id, center, size, start, ground } = plan;
  const radius = round(size * 0.55);
  candidate.geometries.push({ id: `${id}-disc`, type: 'cylinder', bevel: 0 });
  addMaterial(candidate, `${id}-char`, { color: [0.02, 0.02, 0.02], roughness: 1 });
  candidate.nodes.push({ id: `${id}-scorch`, geometry: `${id}-disc`, material: `${id}-char`, translation: [center[0], round(ground + 0.004), center[2]], scale: [radius, 0.004, radius], decal: true, castShadow: false });
  // The MCP schema has no node visible track, so the disc is a speck until the blast and jumps to full size at `start`.
  const speck = [TINY, TINY, TINY];
  return [{ kind: 'node', id: `${id}-scorch`, property: 'scale', interpolation: 'STEP', keyframes: uniqueKeys([{ time: 0, value: speck }, { time: start, value: [radius, 0.004, radius] }]) }];
}

function shakeTrack(candidate, plan, random) {
  const { center, size, start } = plan;
  const eye = candidate.camera?.eye ?? [4, 3, 5];
  const distance = Math.max(1, Math.hypot(eye[0] - center[0], eye[1] - center[1], eye[2] - center[2]));
  const amplitude = plan.shake * 0.015 * distance * Math.min(2, Math.max(0.3, size / 10));
  const keys = [{ time: 0, value: [...eye] }, { time: start, value: [...eye] }];
  const count = SHAKE_SECONDS * SHAKE_KEYS_PER_SECOND;
  for (let index = 1; index <= count; index++) {
    const seconds = index / SHAKE_KEYS_PER_SECOND;
    const decay = index === count ? 0 : Math.exp(-4.5 * seconds) * amplitude;
    keys.push({ time: start + seconds, value: eye.map(component => round(component + (random() * 2 - 1) * decay)) });
  }
  return { kind: 'camera', property: 'eye', interpolation: 'LINEAR', keyframes: uniqueKeys(keys) };
}

function throwDebris(candidate, plan, helpers, random) {
  const { id, center, start, size } = plan;
  const node = candidate.nodes.find(entry => entry.id === plan.debris.node);
  if (!node) {
    throw invalidField('debris.node', plan.debris.node, `the ID of an existing node, one of ${candidate.nodes.slice(0, 8).map(entry => entry.id).join(', ') || 'none yet'}`);
  }
  const physics = candidate.physics;
  if (!physics?.bodies?.some(body => body.type === 'fixed')) {
    throw invalidField('debris.node', plan.debris.node, 'used after a set-physics that holds a fixed floor body; physics carries the pieces, so set it first');
  }
  const cells = 12;
  const jointsBefore = new Set((physics.joints ?? []).map(joint => joint.name));
  const volume = sourceVolume(helpers.sourceGeometry(node.geometry));
  const scale = node.scale ?? [1, 1, 1];
  const pieceMass = volume * scale[0] * scale[1] * scale[2] / cells;
  helpers.fractureNode({ type: 'fracture-node', node: node.id, cells, strength: 1, seed: plan.seed });
  const prefix = `${node.id}-frag-`;
  physics.joints = (physics.joints ?? []).filter(joint => jointsBefore.has(joint.name) || !joint.name.startsWith(`${node.id}-glue-`));
  if (physics.joints.length === 0) delete physics.joints;
  const origin = node.translation ?? [0, 0, 0];
  const away = [origin[0] - center[0], 0, origin[2] - center[2]];
  const awayLength = Math.hypot(...away) || 1;
  const speed = Math.min(EXPLOSION_LIMITS.debrisSpeedLimit, 4 + size * 0.8);
  const tick = Math.round(start * TICKS_PER_SECOND);
  const bodies = physics.bodies.filter(body => body.node.startsWith(prefix));
  const events = physics.events ?? [];
  for (const body of bodies) {
    const direction = [away[0] / awayLength + (random() - 0.5) * 1.2, 0.6 + random() * 0.6, away[2] / awayLength + (random() - 0.5) * 1.2];
    const length = Math.hypot(...direction);
    const impulse = direction.map(component => round(component / length * speed * pieceMass * body.density * (0.7 + random() * 0.6)));
    const torqueImpulse = [0, 1, 2].map(() => round((random() - 0.5) * pieceMass * body.density * speed * 0.2));
    events.push({ tick, body: body.node, impulse, torqueImpulse });
  }
  physics.events = events;
  physics.duration = Math.min(MAX_PHYSICS_SECONDS, Math.max(physics.duration ?? 3, start + 3));
  return id;
}

/**
 * The add-explosion operation. Appends the parts of one blast to `candidate`, each ID prefixed by the explosion ID.
 * `helpers.fractureNode(operation)` fractures a node in `candidate`, and `helpers.sourceGeometry(geometryId)` returns its mesh.
 */
export function addExplosion(candidate, rawOperation, helpers) {
  const plan = { ...validatedExplosion(rawOperation) };
  claimIds(candidate, plan.id);
  plan.oily = plan.fuel === 'oily';
  const random = seededRandom(plan.seed);
  addAirSteps(candidate, plan);
  const tracks = addVolumes(candidate, plan);
  addParticles(candidate, plan, random);
  tracks.push(...addScorch(candidate, plan));
  if (plan.debris) throwDebris(candidate, plan, helpers, random);
  const motion = candidate.motion ?? { duration: 1, tracks: [] };
  const cameraTracked = motion.tracks.some(track => track.kind === 'camera' && track.property === 'eye');
  if (plan.shake !== undefined && plan.shake > 0 && cameraTracked) {
    throw invalidField('shake', plan.shake, 'left out or 0, since the camera already has an eye track; shake is its own eye track, so remove that track or shake 0');
  }
  const shaking = (plan.shake ?? 0.4) > 0 && !cameraTracked;
  if (shaking) tracks.push(shakeTrack(candidate, { ...plan, shake: plan.shake ?? 0.4 }, random));
  motion.tracks.push(...tracks);
  motion.duration = Math.max(motion.duration, plan.start + SMOKE_SECONDS);
  candidate.motion = motion;
}
