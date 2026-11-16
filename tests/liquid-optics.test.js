import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAgentLook } from '../src/agent-look.js';
import { LIQUID_OPTICS, resolveLiquidOptics } from '../src/liquid-optics.js';

test('a field left undefined keeps its default', () => {
  const optics = resolveLiquidOptics({ ior: undefined, thickness: 2 });
  assert.equal(optics.ior, LIQUID_OPTICS.ior[0]);
  assert.equal(optics.thickness, 2);
});

test('the render path ignores a stray key instead of crashing the frame', () => {
  const optics = resolveLiquidOptics({ ...{ iorr: 1.5, ior: 1.4 }, ...{ stray: 'x' } });
  assert.equal(optics.ior, 1.4);
  assert.equal('iorr' in optics, false);
});

test('the recipe boundary rejects an unknown liquid field and lists the valid names', () => {
  assert.throws(() => normalizeAgentLook({ environment: { liquid: { iorr: 1.5 } } }), /Unknown liquid field: iorr. Use thickness, ior/);
});

test('values outside their range still throw', () => {
  assert.throws(() => resolveLiquidOptics({ ior: 0.9 }), /liquid\.ior must be between 1 and 3/);
  assert.throws(() => resolveLiquidOptics({ scattering: Number.NaN }), /liquid\.scattering/);
});
