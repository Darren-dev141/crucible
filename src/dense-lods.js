import { generateGeometryLods, checkRatios, DEFAULT_LOD_RATIOS } from './mesh-lod.js';
import { MAXIMUM_SIMPLIFY_TRIANGLES } from './geometry-simplify.js';
import { DENSE_TRIANGLES_PER_PIXEL, partTakesLods } from './renderer.js';

// Parts for a scene with more than one triangle per pixel (a scan, a sculpt), given `lods` so that each draws with the
// fewest triangles whose error stays under `lodPixelError` pixels (#1163). On such a scene every pixel is shaded about
// once per triangle that touches it, so a level with a quarter of the triangles shades far fewer quads.

const DEFAULT_MINIMUM_TRIANGLES = 20000;

/** Triangles over pixels for these parts on a canvas of `pixels` pixels (the canvas size times the pixel ratio squared). */
export function trianglesPerPixel(parts, pixels) {
  if (!(pixels > 0)) throw new RangeError('pixels must be the canvas width times its height times the pixel ratio squared, a positive number.');
  let triangles = 0;
  for (const part of parts) triangles += part.geometry.indices.length / 3;
  return triangles / pixels;
}

/**
 * Returns `parts` with `lods` on every part that has at least `minimumTriangles` triangles and may take levels, when
 * the scene is denser than `minimumTrianglesPerPixel`; otherwise returns `parts` itself. Parts that share a geometry
 * share its levels and so one batch; a part that already has `lods` keeps them. The levels keep uvs and colours.
 */
export function addLodsToDenseParts(parts, { pixels, minimumTrianglesPerPixel = DENSE_TRIANGLES_PER_PIXEL, minimumTriangles = DEFAULT_MINIMUM_TRIANGLES, ratios = DEFAULT_LOD_RATIOS } = {}) {
  if (!Array.isArray(parts)) throw new TypeError('parts must be the array of parts that goes to CrucibleRenderer.');
  // Checked here so bad ratios fail on a sparse scene too, not only on the frame a scene turns dense.
  checkRatios(ratios);
  if (trianglesPerPixel(parts, pixels) <= minimumTrianglesPerPixel) return parts;
  const levelsByGeometry = new Map();
  return parts.map(part => {
    const triangles = part.geometry.indices.length / 3;
    if (part.lods || triangles < minimumTriangles || triangles > MAXIMUM_SIMPLIFY_TRIANGLES || !partTakesLods(part)) return part;
    if (!levelsByGeometry.has(part.geometry)) levelsByGeometry.set(part.geometry, generateGeometryLods(part.geometry, { ratios }));
    return { ...part, lods: levelsByGeometry.get(part.geometry) };
  });
}
