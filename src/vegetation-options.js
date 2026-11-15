// Option checks that stop a hang, an out-of-memory death or an opaque TypeError inside the vegetation builders.

function need(value, label, minimum, maximum, whole) {
  if (!(value >= minimum && value <= maximum) || (whole && !Number.isInteger(value))) {
    throw new RangeError(`${label} must be ${whole ? 'a whole number ' : ''}from ${minimum} to ${maximum}; got ${value}.`);
  }
}

export function checkScatterOptions({ area, density, spacing, variants, scale, mix }) {
  need(density, 'Scatter density', Number.MIN_VALUE, 1e6);
  need(spacing ?? 1, 'Scatter spacing', Number.MIN_VALUE, 1e6);
  need(variants, 'Scatter variants', 1, 16, true);
  need(scale[0], 'Scatter scale minimum', 0.001, 1000);
  need(scale[1], 'Scatter scale maximum', scale[0], 1000);
  if (!Object.values(mix).some(weight => weight > 0)) throw new RangeError('Scatter mix needs a positive weight.');
  for (const [species, weight] of Object.entries(mix)) {
    if (weight > 0 && !Number.isFinite(weight)) throw new RangeError(`Scatter mix weight for ${species} must be finite; got ${weight}.`);
  }
  const cellSize = (spacing ?? Math.sqrt(0.6 / density)) / Math.SQRT2;
  const cells = (Math.ceil((area.maxX - area.minX) / cellSize) + 1) * (Math.ceil((area.maxZ - area.minZ) / cellSize) + 1);
  need(cells, 'Scatter grid cells', 0, 16e6);
}

export function checkClumpOptions(label, count, maximumCount, height) {
  need(count, `${label} count`, 1, maximumCount, true);
  need(height, `${label} height`, 0.001, 100);
}
