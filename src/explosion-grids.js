import { bakeGasSim, GAS_SIM_TEMPERATURE_UNIT } from './gas-sim.js';
import { encodeVolumeGrid, registerVolumeGrid } from './volume-grid.js';

// The gas-sim grids behind add-explosion (#1050). One blast is baked once at a fixed size and resolution, and the volume's own box scales it, so
// a grid depends only on the fuel and the seed. Its file names say so (`explosion-dry-7_0000.67vg`): a recipe that names them can be rebuilt
// in a fresh scene, a render job or another process, because the MCP server bakes the same bytes again from the name (readVolumeGridFile).

export const EXPLOSION_GRID_RESOLUTION = 32;
export const EXPLOSION_GRID_FRAMES = 72;
export const EXPLOSION_GRID_FPS = 24;
/** Side of the baked box in metres: the volume's `size` is this times the blast's scale. */
export const EXPLOSION_GRID_BOX = 8;
/** The `size` in metres of an add-explosion that plays the bake at its own speed and scale. */
export const EXPLOSION_REFERENCE_SIZE = 2.5;
export const EXPLOSION_EMPTY_GRID = 'explosion-empty.67vg';
export { GAS_SIM_TEMPERATURE_UNIT };

const MAX_CACHED_BAKES = 4;
const BAKE_SECONDS_LIMIT = 90;
const NAME_PATTERN = /^explosion-(dry|oily)-(\d{1,10})_(\d{4})\.67vg$/;
// Oily fuel burns sootier: more smoke at the core and more smoke from every burned unit of fuel.
const FUEL_OPTIONS = Object.freeze({
  dry: Object.freeze({}),
  oily: Object.freeze({ burstSmoke: 1.6, smokeYield: 1.1 }),
});

const bakes = new Map();
let emptyBytes = null;

function gridSize() {
  return [EXPLOSION_GRID_BOX, EXPLOSION_GRID_BOX, EXPLOSION_GRID_BOX];
}

/** The names of the frames of one bake, in playing order. */
export function explosionGridNames(fuel, seed) {
  return Array.from({ length: EXPLOSION_GRID_FRAMES }, (_, index) => `explosion-${fuel}-${seed}_${String(index).padStart(4, '0')}.67vg`);
}

function bakeFrames(fuel, seed) {
  const key = `${fuel}-${seed}`;
  const cached = bakes.get(key);
  if (cached) return cached;
  const baked = bakeGasSim({
    resolution: EXPLOSION_GRID_RESOLUTION,
    cellSize: EXPLOSION_GRID_BOX / EXPLOSION_GRID_RESOLUTION,
    frames: EXPLOSION_GRID_FRAMES,
    fps: EXPLOSION_GRID_FPS,
    seed,
    maxSeconds: BAKE_SECONDS_LIMIT,
    ...FUEL_OPTIONS[fuel],
  });
  const frames = baked.frames.map(frame => encodeVolumeGrid({ resolution: baked.resolution, channels: frame, size: gridSize() }));
  bakes.set(key, frames);
  if (bakes.size > MAX_CACHED_BAKES) bakes.delete(bakes.keys().next().value);
  return frames;
}

function emptyFrame() {
  if (!emptyBytes) {
    const axis = EXPLOSION_GRID_RESOLUTION;
    const cells = axis * axis * axis;
    const channels = { density: new Float32Array(cells), temperature: new Float32Array(cells), flame: new Float32Array(cells) };
    emptyBytes = encodeVolumeGrid({ resolution: [axis, axis, axis], channels, size: gridSize() });
  }
  return emptyBytes;
}

/** The bytes of an explosion grid file by name, baked on first use, or null when the name is not one add-explosion writes. */
export function explosionGridBytes(name) {
  if (name === EXPLOSION_EMPTY_GRID) return emptyFrame();
  const match = typeof name === 'string' ? NAME_PATTERN.exec(name) : null;
  if (!match) return null;
  const seed = Number(match[2]);
  const index = Number(match[3]);
  if (seed > 4294967295 || index >= EXPLOSION_GRID_FRAMES) return null;
  return bakeFrames(match[1], seed)[index];
}

/**
 * Bakes the blast of `fuel` and `seed` and registers its frames and the empty frame, so a grid volume that lists them draws in this process.
 * Returns the frame names. Same fuel and seed give the same bytes.
 */
export function registerExplosionGrids(fuel, seed) {
  const names = explosionGridNames(fuel, seed);
  const frames = bakeFrames(fuel, seed);
  names.forEach((name, index) => registerVolumeGrid(name, frames[index]));
  registerVolumeGrid(EXPLOSION_EMPTY_GRID, emptyFrame());
  return names;
}
