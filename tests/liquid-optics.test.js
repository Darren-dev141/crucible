import test from 'node:test';
import assert from 'node:assert/strict';
import { LIQUID_OPTICS, resolveLiquidOptics } from '../src/liquid-optics.js';

test('a field left undefined keeps its default', () => {
  const optics = resolveLiquidOptics({ ior: undefined, thickness: 2 });
  assert.equal(optics.ior, LIQUID_OPTICS.ior[0]);
  assert.equal(optics.thickness, 2);
});

test('a field that is not a liquid optic throws and lists the valid names', () => {
  assert.throws(() => resolveLiquidOptics({ iorr: 1.5 }), /Unknown liquid field iorr.*ior/s);
});

test('values outside their range still throw', () => {
  assert.throws(() => resolveLiquidOptics({ ior: 0.9 }), /liquid\.ior must be between 1 and 3/);
  assert.throws(() => resolveLiquidOptics({ scattering: Number.NaN }), /liquid\.scattering/);
});
