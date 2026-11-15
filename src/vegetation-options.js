// Checks for the options of the vegetation builders, so a bad value fails at the call with what to pass instead of
// as a crash, an endless loop or an out-of-memory error deep inside the scatter.

export const MAX_SCATTER_VARIANTS = 16;
export const MAX_SCATTER_GRID_CELLS = 16_000_000;
export const MAX_GRASS_BLADES = 2048;
export const MAX_FLOWERS = 256;
const MAX_CLUMP_SIZE = 100;

function describe(value) {
  return typeof value === 'number' ? String(value) : JSON.stringify(value) ?? String(value);
}

function checkedNumber(value, label, minimum, maximum, example) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be a finite number from ${minimum} to ${maximum}, such as ${example}; got ${describe(value)}.`);
  }
  return value;
}

function checkedWholeNumber(value, label, minimum, maximum, example) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be a whole number from ${minimum} to ${maximum}, such as ${example}; got ${describe(value)}.`);
  }
  return value;
}

/** The scatter options that can crash, hang or exhaust memory when wrong; throws a RangeError that says what to pass. */
export function checkScatterOptions({ area, density, spacing, variants, scale, seed, mix, knownSpecies }) {
  checkedNumber(density, 'Scatter density', Number.MIN_VALUE, 1e6, 0.012);
  if (spacing !== undefined) checkedNumber(spacing, 'Scatter spacing', Number.MIN_VALUE, 1e6, 3);
  checkedWholeNumber(variants, 'Scatter variants', 1, MAX_SCATTER_VARIANTS, 3);
  checkedNumber(seed, 'Scatter seed', -1e9, 1e9, 1);
  if (!Array.isArray(scale) || scale.length !== 2) throw new RangeError(`Scatter scale must be [minimum, maximum], such as [0.8, 1.25]; got ${describe(scale)}.`);
  checkedNumber(scale[0], 'Scatter scale minimum', 0.001, 1000, 0.8);
  checkedNumber(scale[1], 'Scatter scale maximum', scale[0], 1000, 1.25);
  if (!mix || typeof mix !== 'object' || Array.isArray(mix)) throw new RangeError('Scatter mix must map species to weights, such as { broadleaf: 3, bush: 1 }.');
  for (const [name, weight] of Object.entries(mix)) {
    if (!knownSpecies.includes(name)) throw new RangeError(`Scatter mix names unknown species "${name.slice(0, 24)}"; use ${knownSpecies.join(', ')}.`);
    checkedNumber(weight, `Scatter mix weight for ${name}`, 0, 1e6, 1);
  }
  if (!Object.values(mix).some(weight => weight > 0)) throw new RangeError('Scatter mix needs at least one positive weight, such as { broadleaf: 1 }.');
  const cellSize = (spacing ?? Math.sqrt(0.6 / density)) / Math.SQRT2;
  const cells = (Math.ceil((area.maxX - area.minX) / cellSize) + 1) * (Math.ceil((area.maxZ - area.minZ) / cellSize) + 1);
  if (cells > MAX_SCATTER_GRID_CELLS) {
    throw new RangeError(`Scatter would need ${cells} grid cells, over the limit of ${MAX_SCATTER_GRID_CELLS}; raise spacing (or lower density) or give a smaller area.`);
  }
}

/** Counts and sizes of a grass clump or flower patch; throws a RangeError that says what to pass. */
export function checkClumpOptions(kind, { count, countName, height, radius }) {
  const maximum = kind === 'grass' ? MAX_GRASS_BLADES : MAX_FLOWERS;
  checkedWholeNumber(count, `${kind} ${countName}`, 1, maximum, kind === 'grass' ? 16 : 5);
  checkedNumber(height, `${kind} height`, 0.001, MAX_CLUMP_SIZE, 0.4);
  if (radius !== undefined) checkedNumber(radius, `${kind} radius`, 0.001, MAX_CLUMP_SIZE, 0.13);
}
