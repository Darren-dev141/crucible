import assert from 'node:assert/strict';
import test from 'node:test';

import { buildFragmentSource } from '../src/path-tracer-gpu-shader.js';
import { MEGAKERNEL_SOURCE } from '../src/path-tracer-webgpu-kernel.js';

// Which UV set each map samples is read out of the kernel expressions themselves: the condition, what it yields when the bit is
// set and what it yields when it is clear. A kernel that swaps the branches, tests the wrong bit, samples the wrong set, pairs a
// corner with the wrong weight or disables the alpha-pass branch fails here. The bit numbers match materialUvSetMask, which
// tests/path-tracer-gpu-uv-set.test.js pins.

const KERNELS = [
  ['WebGL fragment kernel', buildFragmentSource()],
  ['WebGPU megakernel', MEGAKERNEL_SOURCE],
];

const SECOND_SET_INTERPOLATION = 'firstWeight * secondSetCorners.xy + secondWeight * secondSetCorners.zw + thirdWeight * secondSetThird';

function splitTopLevel(text, separator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '(') depth++;
    if (character === ')') depth--;
    if (character === separator && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

function callArguments(source, callPrefix) {
  const start = source.indexOf(callPrefix);
  assert.notEqual(start, -1, `the kernel contains ${callPrefix}`);
  const argumentsStart = start + callPrefix.length;
  let depth = 1;
  let index = argumentsStart;
  while (depth > 0) {
    if (source[index] === '(') depth++;
    if (source[index] === ')') depth--;
    index++;
  }
  return splitTopLevel(source.slice(argumentsStart, index - 1), ',');
}

function parseChoice(expression) {
  const selectMatch = expression.match(/^select\((.*)\)$/s);
  if (selectMatch) {
    const [whenClear, whenSet, condition] = splitTopLevel(selectMatch[1], ',');
    return { condition, whenSet, whenClear };
  }
  const [condition, branches] = splitTopLevel(expression, '?');
  const [whenSet, whenClear] = splitTopLevel(branches, ':');
  return { condition, whenSet, whenClear };
}

const simplify = text => text.replace(/vec2<f32>/g, 'vec2').replace(/\s+/g, ' ').trim();

function assignedExpression(source, variable) {
  const match = source.match(new RegExp(`(?:vec2 |let |var |bool )?${variable} = (.*);`));
  assert.ok(match, `the kernel assigns ${variable}`);
  return match[1];
}

for (const [name, source] of KERNELS) {
  const bitTest = bit => `mapReadsSecondUvSet(flagsTwo.z, ${bit})`;
  const alphaStart = source.indexOf('alphaAtNearestHit');
  const hitPass = source.slice(source.indexOf('fillHit('), alphaStart);
  const alphaPass = source.slice(alphaStart);
  const sampledSets = [
    ['base colour', 'sampleAtlas(mapRectangle, flagsOne.y,', 1],
    ['emissive', 'sampleAtlas(emissiveRectangle, flagsTwo.x,', 8],
    ['surface', 'sampleAtlas(surfaceRectangle, flagsOne.w,', 4],
  ];

  for (const [mapName, call, bit] of sampledSets) {
    test(`${name}: the ${mapName} map samples the second set exactly when bit ${bit} is set`, () => {
      const choice = parseChoice(callArguments(hitPass, call)[0]);
      assert.equal(simplify(choice.condition), bitTest(bit));
      assert.equal(simplify(choice.whenSet), 'secondUv');
      assert.equal(simplify(choice.whenClear), 'uv');
    });
  }

  test(`${name}: the normal map takes its frame and its uv from the second set exactly when bit 2 is set`, () => {
    assert.equal(simplify(assignedExpression(hitPass, 'normalOnSecondSet')), bitTest(2));
    const normalMapArguments = callArguments(hitPass, 'applyNormalMap(');
    assert.equal(normalMapArguments[5], 'uvOne');
    assert.equal(normalMapArguments[6], 'uvTwo');
    const uvChoice = parseChoice(normalMapArguments[7]);
    assert.equal(uvChoice.condition, 'normalOnSecondSet');
    assert.equal(simplify(uvChoice.whenSet), 'secondUv');
    assert.equal(simplify(uvChoice.whenClear), 'uv');
    const uvOneChoice = parseChoice(assignedExpression(hitPass, 'uvOne'));
    assert.equal(uvOneChoice.condition, 'normalOnSecondSet');
    assert.equal(simplify(uvOneChoice.whenSet), 'secondSetCorners.zw - secondSetCorners.xy');
    assert.equal(simplify(uvOneChoice.whenClear), 'vec2(normalTwoData.w - normalOneData.w, colorTwoData.w - colorOneData.w)');
    const uvTwoChoice = parseChoice(assignedExpression(hitPass, 'uvTwo'));
    assert.equal(uvTwoChoice.condition, 'normalOnSecondSet');
    assert.equal(simplify(uvTwoChoice.whenSet), 'secondSetThird - secondSetCorners.xy');
    assert.equal(simplify(uvTwoChoice.whenClear), 'vec2(normalThreeData.w - normalOneData.w, colorThreeData.w - colorOneData.w)');
  });

  test(`${name}: both passes interpolate the second set with the weight that belongs to each corner`, () => {
    assert.equal(simplify(assignedExpression(hitPass, 'secondUv')), SECOND_SET_INTERPOLATION);
    const alphaInterpolations = [...alphaPass.matchAll(/\buv = (firstWeight \* secondSetCorners[^;]*);/g)].map(match => simplify(match[1]));
    assert.deepEqual(alphaInterpolations, [SECOND_SET_INTERPOLATION]);
    assert.match(hitPass, /firstWeight = 1\.0 - secondWeight - thirdWeight/);
    assert.match(hitPass, /secondWeight = nearestU/);
    assert.match(hitPass, /thirdWeight = nearestV/);
  });

  test(`${name}: the alpha pass switches to the second set on exactly the base colour bit test`, () => {
    const guardLines = alphaPass.split('\n').filter(line => line.includes('mapReadsSecondUvSet('));
    assert.equal(guardLines.length, 1);
    const guard = guardLines[0].trim();
    assert.match(guard, /^if \(mapReadsSecondUvSet\((?:fetchData\(uMaterials, material \+ 5\)|materials\[material \+ 5\])\.z, 1\)\) \{$/);
    const guardIndex = alphaPass.indexOf(guardLines[0]);
    const closingBrace = alphaPass.indexOf('}', guardIndex);
    assert.match(alphaPass.slice(guardIndex, closingBrace), /uv = firstWeight \* secondSetCorners\.xy/);
    assert.match(alphaPass.slice(closingBrace), /sampleAtlas\(mapRectangle, [^;]*, uv\)\.a;/);
  });
}
