import { invalidField } from './field-error.js';

// Retro look of a raster material (the PlayStation 1 look): `retro: { vertexSnap: [width, height], affineUV: true }`.
// vertexSnap rounds every vertex to a grid of width by height cells across the screen, so vertices jitter as the camera
// moves. affineUV interpolates texture coordinates without perspective correction, so textures swim across large
// triangles. Only the raster renderer reads it; the path tracer draws the material as usual.

export const RETRO_SNAP_LIMITS = Object.freeze({ minimum: 16, maximum: 4096 });
const RETRO_FIELDS = ['vertexSnap', 'affineUV'];

function normalizeVertexSnap(value) {
  const { minimum, maximum } = RETRO_SNAP_LIMITS;
  const valid = Array.isArray(value) && value.length === 2 && value.every(cells => Number.isInteger(cells) && cells >= minimum && cells <= maximum);
  if (!valid) {
    throw invalidField('retro.vertexSnap', value, `two whole numbers [width, height] from ${minimum} to ${maximum}, such as [160, 120]`, TypeError);
  }
  return Object.freeze([...value]);
}

/** Validates a material `retro` field and returns a frozen copy that holds only the options that were set. */
export function normalizeMaterialRetro(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidField('retro', value, 'an object, such as { vertexSnap: [160, 120], affineUV: true }', TypeError);
  }
  for (const key of Object.keys(value)) {
    if (!RETRO_FIELDS.includes(key)) {
      throw invalidField(`retro.${key}`, value[key], `one of the fields ${RETRO_FIELDS.join(', ')}; remove ${key}`, TypeError);
    }
  }
  const result = {};
  if (value.vertexSnap !== undefined) result.vertexSnap = normalizeVertexSnap(value.vertexSnap);
  if (value.affineUV !== undefined) {
    if (typeof value.affineUV !== 'boolean') throw invalidField('retro.affineUV', value.affineUV, 'true or false', TypeError);
    if (value.affineUV) result.affineUV = true;
  }
  if (result.vertexSnap === undefined && result.affineUV === undefined) {
    throw invalidField('retro', value, 'at least one of vertexSnap [160, 120] or affineUV true; remove retro for the plain look', TypeError);
  }
  return Object.freeze(result);
}

/** The values one draw call binds: snap cells (0 for none) and 1 when UVs are affine. Equal for materials that look alike. */
export function retroDrawState(material) {
  const retro = material.retro;
  return [retro?.vertexSnap?.[0] ?? 0, retro?.vertexSnap?.[1] ?? 0, retro?.affineUV === true ? 1 : 0];
}
