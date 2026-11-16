import { finiteRange, vectorField } from './volumetric.js';

// The emission ramp of a local volume (#1046): the light a volume gives off at a point is a colour read from a short ramp by how much of the
// source (the density, or a grid's temperature or flame channel) is there, so one volume can grade from a white-hot core to an orange edge.
// This file holds only the checks. The ramp is baked to at most LOCAL_VOLUME_RAMP_STOPS colours (local-volume-ramp-bake.js), evenly spaced, that the
// rasterizer's uniforms and the CPU path tracer both read and blend linearly, so the two agree by construction. A volume with no `emissionRamp` is untouched.

export const LOCAL_VOLUME_RAMP_STOPS = 8;
export const LOCAL_VOLUME_RAMP_SOURCES = Object.freeze(['density', 'temperature', 'flame']);
export const LOCAL_VOLUME_RAMP_FIELDS = Object.freeze(['source', 'range', 'exposure', 'kelvin', 'stops']);
export const LOCAL_VOLUME_RAMP_MINIMUM_KELVIN = 300;
export const LOCAL_VOLUME_RAMP_MAXIMUM_KELVIN = 30000;
const MAXIMUM_STOP_CHANNEL = 100;

/** The packed code of a ramp source: 1 density, 2 temperature, 3 flame (0 is no ramp). */
export function rampSourceCode(source) {
  return LOCAL_VOLUME_RAMP_SOURCES.indexOf(source) + 1;
}

/**
 * Checks `emissionRamp` of one volume and returns it with every default filled in: `{ source, range, exposure, kelvin }` or `{ source, range, exposure, stops }`.
 * `kelvin` is `[cool, hot]`, the blackbody temperatures at the low and high end of the source; `stops` is 2 to 8 colours spaced evenly from the low to the
 * high end. `range` is `[low, high]`, the source values that map to the two ends (default `[0, 1]`). Resolved output resolves to itself again.
 */
export function resolveEmissionRamp(input, shape, label) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError(`${label} must be an object like { kelvin: [1000, 3000] } or { stops: [[1, 0.3, 0.05], [1, 1, 1]] }`);
  for (const field of Object.keys(input)) {
    if (!LOCAL_VOLUME_RAMP_FIELDS.includes(field)) throw new TypeError(`${label} has no field "${field}"; use ${LOCAL_VOLUME_RAMP_FIELDS.join(', ')}`);
  }
  if (shape === 'mesh') throw new TypeError(`${label} belongs to a box, a sphere or a grid; a mesh volume emits one colour (emission)`);
  const source = input.source ?? 'density';
  if (!LOCAL_VOLUME_RAMP_SOURCES.includes(source)) throw new RangeError(`${label}.source must be one of ${LOCAL_VOLUME_RAMP_SOURCES.join(', ')}`);
  if (source !== 'density' && shape !== 'grid') throw new RangeError(`${label}.source "${source}" is a channel of a grid volume; a ${shape} volume drives its ramp by its density`);
  const range = input.range === undefined ? [0, 1] : resolveSourceRange(input.range, `${label}.range`);
  if (!(range[0] < range[1])) throw new RangeError(`${label}.range must be [low, high] with low below high, got [${range[0]}, ${range[1]}]`);
  const resolved = { source, range, exposure: finiteRange(input.exposure ?? 1, 0, 1000, `${label}.exposure`) };
  if ((input.kelvin === undefined) === (input.stops === undefined)) throw new TypeError(`${label} takes exactly one of kelvin ([cool, hot] blackbody temperatures) or stops (a list of colours)`);
  if (input.kelvin !== undefined) return { ...resolved, kelvin: resolveKelvinRange(input.kelvin, `${label}.kelvin`) };
  return { ...resolved, stops: resolveStops(input.stops, `${label}.stops`) };
}

function resolveSourceRange(value, label) {
  if (!Array.isArray(value) || value.length !== 2) throw new TypeError(`${label} must be two numbers [low, high]`);
  return value.map((entry, index) => finiteRange(entry, -1e6, 1e6, `${label}[${index}]`));
}

function resolveKelvinRange(value, label) {
  if (!Array.isArray(value) || value.length !== 2) throw new TypeError(`${label} must be two temperatures [cool, hot] in kelvin, such as [1000, 3000]`);
  const kelvin = value.map((entry, index) => finiteRange(entry, LOCAL_VOLUME_RAMP_MINIMUM_KELVIN, LOCAL_VOLUME_RAMP_MAXIMUM_KELVIN, `${label}[${index}]`));
  if (!(kelvin[0] < kelvin[1])) throw new RangeError(`${label} must be [cool, hot] with cool below hot, got [${kelvin[0]}, ${kelvin[1]}]`);
  return kelvin;
}

function resolveStops(value, label) {
  if (!Array.isArray(value) || value.length < 2 || value.length > LOCAL_VOLUME_RAMP_STOPS) {
    throw new RangeError(`${label} must be a list of 2 to ${LOCAL_VOLUME_RAMP_STOPS} colours [red, green, blue], from the low end of the source to the high end`);
  }
  return value.map((stop, index) => vectorField(stop, 0, MAXIMUM_STOP_CHANNEL, `${label}[${index}]`));
}
