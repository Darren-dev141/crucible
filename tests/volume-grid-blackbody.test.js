// Grid temperature emission (#1733): the blackbody hue against Mitchell Charity's table and the brightness against the Stefan-Boltzmann law as Blender's
// Principled Volume applies it (intern/cycles/kernel/svm/closure.h). Both are checked at kelvins between the table's own 200 K nodes too.

import test from 'node:test';
import assert from 'node:assert/strict';
import { blackbodyRadiance, BLACKBODY_RADIANCE_SCALE, BLACKBODY_HUE_TABLE, BLACKBODY_TABLE_COUNT } from '../src/volume-grid.js';

// Mitchell Charity, "What color is a blackbody?", bbr_color.txt (version 2001-Jun-22), http://www.vendian.org/mncharity/dir3/blackbody/:
// the CIE 1931 2 degree rows, columns R G B (linear sRGB, normalised so the largest is 1, out of gamut channels clipped to 0).
const CHARITY_TABLE = [
  [1000, 1.0, 0.0337, 0.0],
  [1200, 1.0, 0.0846, 0.0],
  [2000, 1.0, 0.2647, 0.0033],
  [2200, 1.0, 0.3126, 0.0219],
  [2600, 1.0, 0.4034, 0.0734],
  [3000, 1.0, 0.4870, 0.1411],
];
const HUE_TOLERANCE = 0.02;
const INTENSITY_TOLERANCE = 1e-4;
const LUMINANCE = [0.2126, 0.7152, 0.0722];
// sigma = 5.670373e-8 W/m^2/K^4, the 1e-6 of the scene's radiance unit and the 1/pi of a radiance, written out again here on purpose.
const expectedIntensity = kelvin => 5.670373e-8 * 1e-6 / Math.PI * kelvin ** 4;

test('the grid blackbody hue from 1000 K to 3000 K stays within 2 percent of full scale of the Charity table', () => {
  const radiance = new Float64Array(3);
  for (const [kelvin, ...reference] of CHARITY_TABLE) {
    blackbodyRadiance(kelvin, radiance);
    const largest = Math.max(...radiance);
    reference.forEach((expected, channel) => {
      assert.ok(Math.abs(radiance[channel] / largest - expected) <= HUE_TOLERANCE, `${kelvin} K channel ${channel}: ${(radiance[channel] / largest).toFixed(4)} against ${expected}`);
    });
  }
});

test('the grid blackbody has luminance sigma * T^4 / pi: the Stefan-Boltzmann brightness of Principled Volume, to 1e-4', () => {
  const radiance = new Float64Array(3);
  for (const kelvin of [900, 1000, 1500, 2300, 3000, 5000, 11000]) {
    blackbodyRadiance(kelvin, radiance);
    const luminance = radiance[0] * LUMINANCE[0] + radiance[1] * LUMINANCE[1] + radiance[2] * LUMINANCE[2];
    const expected = expectedIntensity(kelvin);
    assert.ok(Math.abs(luminance - expected) <= INTENSITY_TOLERANCE * expected, `${kelvin} K luminance ${luminance} against ${expected}`);
  }
  assert.equal(BLACKBODY_RADIANCE_SCALE, 5.670373e-8 * 1e-6 / Math.PI);
  assert.equal(BLACKBODY_HUE_TABLE.length, BLACKBODY_TABLE_COUNT * 3);
});

test('the grid blackbody is zero at or below 0 K and stays finite below 800 K and above 12000 K', () => {
  const radiance = new Float64Array(3);
  assert.deepEqual(Array.from(blackbodyRadiance(-5, radiance)), [0, 0, 0]);
  for (const kelvin of [300, 20000]) {
    blackbodyRadiance(kelvin, radiance);
    assert.ok(radiance.every(Number.isFinite) && radiance.every(value => value >= 0), `${kelvin} K ${Array.from(radiance)}`);
  }
});
