import test from 'node:test';
import assert from 'node:assert/strict';
import './support/load-agent-scene-modules.mjs';
import { createAgentScene } from '../src/agent-scene.js';
import { normalizeMaterialRetro, retroDrawState } from '../src/material-retro.js';
import { createFragmentShader, createVertexShader, SHADER_FEATURES } from '../src/shaders.js';
import { AGENT_SCENE_CAPABILITIES } from '../src/agent-scene-capabilities.js';

const RIGID_FEATURES = SHADER_FEATURES.filter(feature => !['crowd', 'skin', 'morph'].includes(feature));

// Keeps the lines a preprocessor would keep when only the listed macros are defined (valueless #ifdef, #else, #endif).
function keptSource(source, defined) {
  const kept = [];
  const stack = [];
  for (const line of source.split('\n')) {
    const directive = line.trim().match(/^#(ifdef|ifndef|else|endif)\b\s*(\w+)?/);
    if (directive?.[1] === 'ifdef' || directive?.[1] === 'ifndef') {
      const isDefined = source.includes(`#define ${directive[2]}`) && defined.includes(directive[2]);
      stack.push(directive[1] === 'ifdef' ? isDefined : !isDefined);
    } else if (directive?.[1] === 'else') {
      stack[stack.length - 1] = !stack[stack.length - 1];
    } else if (directive?.[1] === 'endif') {
      stack.pop();
    } else if (stack.every(Boolean)) {
      kept.push(line);
    }
  }
  return kept.join('\n');
}

function recipeWithMaterial(material) {
  return {
    format: 'crucible.scene',
    schemaVersion: 1,
    geometries: [{ id: 'box', type: 'box', bevel: 0 }],
    materials: [{ id: 'finish', ...material }],
    nodes: [{ id: 'block', geometry: 'box', material: 'finish' }],
  };
}

test('retro accepts a snap grid and the affine switch and freezes the result', () => {
  const retro = normalizeMaterialRetro({ vertexSnap: [160, 120], affineUV: true });
  assert.deepEqual(retro, { vertexSnap: [160, 120], affineUV: true });
  assert.ok(Object.isFrozen(retro));
  assert.deepEqual(normalizeMaterialRetro({ affineUV: true }), { affineUV: true });
  assert.deepEqual(normalizeMaterialRetro({ vertexSnap: [16, 4096], affineUV: false }), { vertexSnap: [16, 4096] });
});

test('retro errors say what to pass', () => {
  assert.throws(() => normalizeMaterialRetro({}), /retro: got \{\}; expected at least one of vertexSnap/);
  assert.throws(() => normalizeMaterialRetro([]), /retro: got \[\]; expected an object/);
  assert.throws(() => normalizeMaterialRetro({ affineUV: false }), /expected at least one of vertexSnap/);
  assert.throws(() => normalizeMaterialRetro({ snap: 4 }), /retro\.snap: .*one of the fields vertexSnap, affineUV; remove snap/);
  assert.throws(() => normalizeMaterialRetro({ vertexSnap: 160 }), /retro\.vertexSnap: got 160; expected two whole numbers \[width, height\] from 16 to 4096/);
  assert.throws(() => normalizeMaterialRetro({ vertexSnap: [160] }), /retro\.vertexSnap/);
  assert.throws(() => normalizeMaterialRetro({ vertexSnap: [8, 120] }), /from 16 to 4096/);
  assert.throws(() => normalizeMaterialRetro({ vertexSnap: [160, 5000] }), /from 16 to 4096/);
  assert.throws(() => normalizeMaterialRetro({ vertexSnap: [160.5, 120] }), /retro\.vertexSnap/);
  assert.throws(() => normalizeMaterialRetro({ affineUV: 1 }), /retro\.affineUV: got 1; expected true or false/);
});

test('a recipe material and a set-material edit take retro, and a bad value is refused', () => {
  const scene = createAgentScene(recipeWithMaterial({ retro: { vertexSnap: [160, 120], affineUV: true } }));
  assert.deepEqual(scene.parts[0].material.retro, { vertexSnap: [160, 120], affineUV: true });
  assert.throws(() => createAgentScene(recipeWithMaterial({ retro: { vertexSnap: [3, 3] } })), /retro\.vertexSnap/);
  const plain = createAgentScene(recipeWithMaterial({}));
  assert.equal(plain.parts[0].material.retro, undefined);
  plain.apply([{ type: 'set-material', id: 'finish', retro: { affineUV: true } }], { expectedRevision: 0 });
  assert.deepEqual(plain.parts[0].material.retro, { affineUV: true });
  assert.throws(() => plain.apply([{ type: 'set-material', id: 'finish', retro: { vertexSnap: [0, 0] } }], { expectedRevision: 1 }), /retro\.vertexSnap/);
});

test('draw state is zero for a plain material and splits batches that look different', () => {
  assert.deepEqual(retroDrawState({}), [0, 0, 0]);
  assert.deepEqual(retroDrawState({ retro: normalizeMaterialRetro({ vertexSnap: [160, 120] }) }), [160, 120, 0]);
  assert.deepEqual(retroDrawState({ retro: normalizeMaterialRetro({ affineUV: true }) }), [0, 0, 1]);
});

test('without retro features the shaders compile to the plain source', () => {
  const vertex = createVertexShader(RIGID_FEATURES);
  const fragment = createFragmentShader(RIGID_FEATURES);
  for (const source of [keptSource(vertex, []), keptSource(fragment, [])]) {
    assert.doesNotMatch(source, /retro|affineUV|affineWeight/);
  }
  assert.match(keptSource(fragment, []), /in vec2 textureUV, lightmapUV;/);
  assert.doesNotMatch(vertex, /#define RETRO_/);
  assert.doesNotMatch(fragment, /#define RETRO_/);
});

test('retro features add the snap and the affine interpolation to the vertex and fragment shaders', () => {
  const snapped = createVertexShader([...RIGID_FEATURES, 'retroSnap']);
  assert.match(snapped, /#define RETRO_SNAP\n/);
  assert.doesNotMatch(snapped, /#define RETRO_AFFINE\n/);
  assert.match(keptSource(snapped, ['RETRO_SNAP']), /uniform vec2 retroSnap;[\s\S]*round\(gl_Position\.xy/);
  const affineFeatures = [...RIGID_FEATURES, 'retroAffine'];
  const vertex = keptSource(createVertexShader(affineFeatures), ['RETRO_AFFINE']);
  assert.match(vertex, /out vec3 affineUV;/);
  assert.match(vertex, /affineUV = vec3\(uv \* affineWeight, affineWeight\)/);
  const fragment = keptSource(createFragmentShader(affineFeatures), ['RETRO_AFFINE']);
  assert.match(fragment, /in vec3 affineUV;/);
  assert.match(fragment, /#define textureUV \(affineUV\.xy \/ affineUV\.z\)/);
  assert.ok(fragment.indexOf('in vec2 textureUV, lightmapUV;') < fragment.indexOf('#define textureUV'), 'the macro follows the declaration');
});

test('the capabilities name the retro field and its raster-only limit', () => {
  assert.match(AGENT_SCENE_CAPABILITIES.materialRetro, /vertexSnap[\s\S]*affineUV[\s\S]*path tracer ignores it/);
});
