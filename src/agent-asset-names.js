// Placing a catalog GLB by file name. The SHA-256 asset id changes on every re-export of a file, its name does not, so a
// recipe may write `asset: { name: "sheep_body.glb" }`. The MCP server resolves the name against the catalog when the call
// arrives; this module only rewrites the parsed recipe, so the scene core never sees a name.
import { invalidField } from './field-error.js';
import { visitPlacements } from './agent-scene-assets.js';

/** Whether a recipe or edit list has a placement that names its catalog file instead of its id. */
export function namesCatalogFiles(value) {
  let found = false;
  visitPlacements(value, placement => {
    if (placement.name !== undefined) found = true;
  });
  return found;
}

/**
 * Turns every placement that names its catalog file into the pinned form (`asset: { id }`), in place, so the scene, its
 * snapshots and its render jobs only ever hold the content hash. `resolveName` maps a file name to its asset id or throws.
 * Call it on a recipe or edit list the host has just parsed.
 */
export function resolveAssetPlacementNames(value, resolveName) {
  visitPlacements(value, placement => {
    if (placement.name === undefined) return;
    if (placement.id !== undefined) {
      throw invalidField('asset', 'both id and name', 'exactly one of id (the pinned SHA-256) or name (the catalog file name), such as { "name": "sheep_body.glb" }', TypeError);
    }
    placement.id = resolveName(placement.name);
    delete placement.name;
  });
}
