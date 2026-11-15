import assert from 'node:assert/strict';
import test from 'node:test';
import { applyViewTransform, parseCube, sampleLook } from '../src/view-transform.js';

function identityCubeRows(size) {
  const rows = [];
  for (let blue = 0; blue < size; blue++) {
    for (let green = 0; green < size; green++) {
      for (let red = 0; red < size; red++) rows.push(`${red / (size - 1)} ${green / (size - 1)} ${blue / (size - 1)}`);
    }
  }
  return rows.join('\n');
}

const twoPointCube = (header = '') => `LUT_3D_SIZE 2\n${header}\n${identityCubeRows(2)}\n`;

test('a .cube DOMAIN line needs three finite numbers and a maximum above the minimum', () => {
  assert.throws(() => parseCube(twoPointCube('DOMAIN_MIN 0')), /DOMAIN_MIN/);
  assert.throws(() => parseCube(twoPointCube('DOMAIN_MAX 1 1 x')), /DOMAIN_MAX/);
  assert.throws(() => parseCube(twoPointCube('DOMAIN_MAX 0 0 0')), /DOMAIN_MAX/);
  const valid = parseCube(twoPointCube('DOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1'));
  assert.ok(valid.data.every(Number.isFinite));
});

test('a .cube look refuses rows that are not three numbers and sizes that are not decimal integers', () => {
  const fourColumns = `LUT_3D_SIZE 2\n${identityCubeRows(2).replace(/$/gm, ' 9')}\n`;
  assert.throws(() => parseCube(fourColumns), /three/);
  assert.throws(() => parseCube(`LUT_3D_SIZE 0x2\n${identityCubeRows(2)}\n`), /LUT_3D_SIZE/);
  assert.throws(() => parseCube(`LUT_3D_SIZE 2 3\n${identityCubeRows(2)}\n`), /LUT_3D_SIZE/);
});

test('a non-finite channel gives a finite display colour instead of poisoning the other channels', () => {
  for (const name of ['aces', 'agx', 'neutral']) {
    for (const bad of [NaN, Infinity, -Infinity]) {
      const colour = applyViewTransform(name, [bad, 0.5, 0.25]);
      assert.ok(colour.every(Number.isFinite), `${name} with ${bad} gave ${colour}`);
    }
  }
  const look = parseCube(twoPointCube());
  assert.ok(sampleLook(look, [NaN, 0.5, 0.5]).every(Number.isFinite));
});
