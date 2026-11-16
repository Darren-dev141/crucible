import { finiteRange, vectorField } from './volumetric.js';

// The emission ramp of a local volume (#1046): the light a volume gives off at a point is a colour read from a short ramp by how much of the
// source (the density, or a grid's temperature or flame channel) is there, so one volume can grade from a white-hot core to an orange edge.
// The ramp is baked to at most LOCAL_VOLUME_RAMP_STOPS colours, evenly spaced, that the rasterizer's uniforms and the CPU path tracer both read
// and blend linearly, so the two agree by construction. A volume with no `emissionRamp` is untouched by this file.

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

// Wyman, Sloan and Shirley (2013), "Simple Analytic Approximations to the CIE XYZ Color Matching Functions": two-sided Gaussian lobes.
function gaussianLobe(wavelength, center, widthBelow, widthAbove) {
  const width = wavelength < center ? widthBelow : widthAbove;
  const offset = (wavelength - center) / width;
  return Math.exp(-0.5 * offset * offset);
}

const PLANCK_SECOND_RADIATION_CONSTANT = 1.4387769e-2;
const FIRST_WAVELENGTH_NANOMETERS = 360;
const LAST_WAVELENGTH_NANOMETERS = 830;
const WAVELENGTH_STEP_NANOMETERS = 5;

/**
 * Writes the linear sRGB colour of a blackbody at `kelvin` into `out`, scaled so the largest channel is 1 (the hue only; the brightness is
 * blackbodyRampColor's). Planck's law is integrated against the CIE 1931 colour matching functions and a negative channel is clipped to 0,
 * as in Mitchell Charity's blackbody colour table that the test compares against.
 */
export function blackbodyChromaticity(kelvin, out) {
  let tristimulusX = 0;
  let tristimulusY = 0;
  let tristimulusZ = 0;
  for (let wavelength = FIRST_WAVELENGTH_NANOMETERS; wavelength <= LAST_WAVELENGTH_NANOMETERS; wavelength += WAVELENGTH_STEP_NANOMETERS) {
    const meters = wavelength * 1e-9;
    const radiance = 1 / (meters ** 5 * (Math.exp(PLANCK_SECOND_RADIATION_CONSTANT / (meters * kelvin)) - 1));
    tristimulusX += radiance * (1.056 * gaussianLobe(wavelength, 599.8, 37.9, 31.0) + 0.362 * gaussianLobe(wavelength, 442.0, 16.0, 26.7) - 0.065 * gaussianLobe(wavelength, 501.1, 20.4, 26.2));
    tristimulusY += radiance * (0.821 * gaussianLobe(wavelength, 568.8, 46.9, 40.5) + 0.286 * gaussianLobe(wavelength, 530.9, 16.3, 31.1));
    tristimulusZ += radiance * (1.217 * gaussianLobe(wavelength, 437.0, 11.8, 36.0) + 0.681 * gaussianLobe(wavelength, 459.0, 26.0, 13.8));
  }
  const red = Math.max(0, 3.2406 * tristimulusX - 1.5372 * tristimulusY - 0.4986 * tristimulusZ);
  const green = Math.max(0, -0.9689 * tristimulusX + 1.8758 * tristimulusY + 0.0415 * tristimulusZ);
  const blue = Math.max(0, 0.0557 * tristimulusX - 0.2040 * tristimulusY + 1.0570 * tristimulusZ);
  const largest = Math.max(red, green, blue);
  out[0] = red / largest;
  out[1] = green / largest;
  out[2] = blue / largest;
  return out;
}

/** The ramp colour of a blackbody at `kelvin` under the hottest end `maximumKelvin` of the ramp: the hue of blackbodyChromaticity times (kelvin / maximumKelvin)^4, the Stefan-Boltzmann fall of its light. */
export function blackbodyRampColor(kelvin, maximumKelvin, out) {
  blackbodyChromaticity(kelvin, out);
  const brightness = (kelvin / maximumKelvin) ** 4;
  out[0] *= brightness;
  out[1] *= brightness;
  out[2] *= brightness;
  return out;
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

/**
 * Bakes a resolved ramp to colours: `{ count, colors }` where colors holds `count * 3` linear RGB values, exposure applied, evenly spaced from
 * the low end of the source to the high end. A blackbody ramp is sampled at LOCAL_VOLUME_RAMP_STOPS temperatures.
 */
export function bakeEmissionRamp(ramp) {
  if (ramp.stops) return { count: ramp.stops.length, colors: Float64Array.from(ramp.stops.flat(), channel => channel * ramp.exposure) };
  const [cool, hot] = ramp.kelvin;
  const colors = new Float64Array(LOCAL_VOLUME_RAMP_STOPS * 3);
  const sample = new Float64Array(3);
  for (let stop = 0; stop < LOCAL_VOLUME_RAMP_STOPS; stop++) {
    blackbodyRampColor(cool + (hot - cool) * stop / (LOCAL_VOLUME_RAMP_STOPS - 1), hot, sample);
    for (let channel = 0; channel < 3; channel++) colors[stop * 3 + channel] = sample[channel] * ramp.exposure;
  }
  return { count: LOCAL_VOLUME_RAMP_STOPS, colors };
}

/** How far along a ramp a source value is, 0 to 1: `(value - low) / (high - low)` clamped. */
export function emissionRampPosition(ramp, value) {
  return Math.min(1, Math.max(0, (value - ramp.range[0]) / (ramp.range[1] - ramp.range[0])));
}

/** Writes the colour of a baked ramp at a position 0 to 1 into `out`, blending the two nearest stops linearly. */
export function sampleBakedRamp(baked, position, out) {
  const scaled = position * (baked.count - 1);
  const lower = Math.min(Math.floor(scaled), baked.count - 1);
  const upper = Math.min(lower + 1, baked.count - 1);
  const blend = scaled - lower;
  for (let channel = 0; channel < 3; channel++) {
    out[channel] = baked.colors[lower * 3 + channel] * (1 - blend) + baked.colors[upper * 3 + channel] * blend;
  }
  return out;
}
