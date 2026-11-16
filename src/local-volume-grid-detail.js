import { finiteRange } from './volumetric.js';
import { localVolumeFractalNoise } from './local-volume-noise.js';
import { LOCAL_VOLUME_MAXIMUM_NOISE_OCTAVES } from './local-volume-resolve.js';

// Detail noise for a grid volume (#1832): a simulated grid is too coarse for the ragged edge of real smoke, and a finer grid does not fit the 64 MiB a call may carry. So the
// noise is applied while the grid is sampled and the bake stays as it is. It erodes: the density loses `strength * noise` where the grid density is low, and nothing where it
// is at or above DETAIL_CORE_DENSITY, so the core of a cloud stays solid while its rim breaks up. The flame and the blackbody glow of the cell shrink with the density, so
// the lit edge breaks up with the smoke. The noise is the local-volume value noise (local-volume-noise.js; the post shader repeats it in GLSL, fog-shader.js).

export const GRID_DETAIL_MAXIMUM_SCALE = 64;
export const GRID_DETAIL_MINIMUM_SCALE = 0.25;
/** The grid density from which the erosion weight is 0 (the weight is 1 at 0 and eases down to 0 here). Shared with the shader. */
export const GRID_DETAIL_CORE_DENSITY = 0.6;
const DETAIL_FIELDS = Object.freeze(['strength', 'scale', 'octaves']);

/**
 * Checks a grid volume's detailNoise and returns it with defaults filled in: strength 0 to 1 (how much of the noise is taken off the density), scale in grid cells
 * (the size of the largest noise lump, 0.25 to 64) and octaves 1 to 5. Throws an error that names the field and the range.
 */
export function resolveGridDetailNoise(input, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`${label} must be an object such as { strength: 0.6, scale: 2, octaves: 3 }: strength 0-1 (how much density the noise removes at the edge), scale in grid cells (the size of the largest lump) and octaves 1-${LOCAL_VOLUME_MAXIMUM_NOISE_OCTAVES}`);
  }
  for (const field of Object.keys(input)) {
    if (!DETAIL_FIELDS.includes(field)) throw new TypeError(`${label} has no field "${field}"; use ${DETAIL_FIELDS.join(', ')}`);
  }
  const octaves = input.octaves ?? 1;
  if (!Number.isInteger(octaves) || octaves < 1 || octaves > LOCAL_VOLUME_MAXIMUM_NOISE_OCTAVES) {
    throw new RangeError(`${label}.octaves must be a whole number from 1 to ${LOCAL_VOLUME_MAXIMUM_NOISE_OCTAVES}`);
  }
  return {
    strength: finiteRange(input.strength ?? 0.5, 0, 1, `${label}.strength`),
    scale: finiteRange(input.scale ?? 2, GRID_DETAIL_MINIMUM_SCALE, GRID_DETAIL_MAXIMUM_SCALE, `${label}.scale`),
    octaves,
  };
}

/** The share of its density a cell keeps after the erosion: 1 outside the edge, below 1 where the noise cuts into a thin cell. `cellX/Y/Z` are the point in grid cells. */
export function gridDetailKeptShare(detail, cellX, cellY, cellZ, density) {
  if (!(density > 0)) return 1;
  const noise = localVolumeFractalNoise(cellX / detail.scale, cellY / detail.scale, cellZ / detail.scale, detail.octaves);
  const clamped = Math.min(density / GRID_DETAIL_CORE_DENSITY, 1);
  const edgeWeight = 1 - clamped * clamped * (3 - 2 * clamped);
  return Math.max(density - detail.strength * noise * edgeWeight, 0) / density;
}

/**
 * Erodes a sampled grid cell in place: `out` holds density, temperature, flame (and the blackbody radiance at out[3] to out[5] when `withBlackbody`), and the point
 * is (unitX, unitY, unitZ) in the grid box. Density, flame and blackbody take the kept share; the temperature stays, since it is a state and not an amount.
 */
export function erodeGridCell(detail, resolution, unitX, unitY, unitZ, out, withBlackbody) {
  const kept = gridDetailKeptShare(detail, unitX * resolution[0], unitY * resolution[1], unitZ * resolution[2], out[0]);
  if (kept === 1) return out;
  out[0] *= kept;
  out[2] *= kept;
  if (withBlackbody) {
    out[3] *= kept;
    out[4] *= kept;
    out[5] *= kept;
  }
  return out;
}

/**
 * The GLSL for a frame whose grid volume has detail noise: the erosion factor and the uniform `localGridDetail` (x strength, y scale in cells, z octaves). It needs
 * localVolumeFractalNoise and the grid texture, which the shader declares before it. gridDetailKeptShare repeats it.
 */
export const GRID_DETAIL_FUNCTIONS = `// Detail noise of the grid volume (#1832, local-volume-grid-detail.js gridDetailKeptShare repeats it): the share of its density a cell keeps.
uniform vec4 localGridDetail;
float localGridDetailKept(vec3 cells, float density) {
  if (density <= 0.0) return 1.0;
  float noise = localVolumeFractalNoise(cells / localGridDetail.y, int(localGridDetail.z + 0.5));
  float clamped = min(density / ${GRID_DETAIL_CORE_DENSITY.toFixed(3)}, 1.0);
  float edgeWeight = 1.0 - clamped * clamped * (3.0 - 2.0 * clamped);
  return max(density - localGridDetail.x * noise * edgeWeight, 0.0) / density;
}
`;
