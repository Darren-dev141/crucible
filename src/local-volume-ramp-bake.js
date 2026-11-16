import { LOCAL_VOLUME_RAMP_STOPS } from './local-volume-ramp.js';

// The colours of an emission ramp (#1046): the blackbody curve, the bake to evenly spaced stops and the lookup the rasterizer's uniforms and the CPU path
// tracer share. Kept apart from the checks in local-volume-ramp.js so a scene that only builds volumes does not carry the colour science.

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
