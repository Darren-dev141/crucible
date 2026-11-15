import assert from 'node:assert/strict';
import test from 'node:test';
import { createFragmentShader, createVertexShader, FRAGMENT_SHADOW_POSITION_FEATURE, SHADER_FEATURES } from '../src/shaders.js';

const RIGID_FEATURES = SHADER_FEATURES.filter(feature => !['crowd', 'skin', 'morph'].includes(feature));

// Resolves `#define`, `#ifdef`, `#ifndef`, `#else` and `#endif` on valueless macros, the only directives these tests need.
function resolveConditionals(source) {
  const defined = new Set();
  const kept = [];
  const stack = [];
  const isActive = () => stack.every(entry => entry.taken);
  for (const line of source.split('\n')) {
    const directive = line.trim().match(/^#(define|ifdef|ifndef|if|else|endif)\b\s*(\w+)?(.*)$/);
    if (!directive) {
      if (isActive()) kept.push(line);
    } else if (directive[1] === 'ifdef' || directive[1] === 'ifndef') {
      const isDefined = defined.has(directive[2]);
      stack.push({ taken: directive[1] === 'ifdef' ? isDefined : !isDefined });
    } else if (directive[1] === 'if') {
      // Only `defined(NAME)` joined by && occurs in these shaders.
      const expression = `${directive[2] ?? ''}${directive[3]}`.replace(/defined\((\w+)\)/g, (_, name) => String(defined.has(name)));
      stack.push({ taken: expression.split('&&').every(term => term.trim() === 'true') });
    } else if (directive[1] === 'else') {
      stack[stack.length - 1].taken = !stack[stack.length - 1].taken;
    } else if (directive[1] === 'endif') {
      stack.pop();
    } else if (isActive()) {
      defined.add(directive[2]);
      kept.push(line);
    }
  }
  return kept.join('\n');
}

test('the fragment shadow coordinate feature moves the sun shadow varying from the vertex shader into the fragment shader', () => {
  const features = [...RIGID_FEATURES, FRAGMENT_SHADOW_POSITION_FEATURE];
  const vertex = resolveConditionals(createVertexShader(features));
  const fragment = resolveConditionals(createFragmentShader(features));
  assert.doesNotMatch(vertex, /shadowPosition/, 'the vertex shader neither declares nor writes the varying');
  assert.match(fragment, /^vec4 shadowPosition;$/m);
  assert.doesNotMatch(fragment, /^in vec4 shadowPosition;$/m);
  assert.match(fragment, /shadowPosition = lightProjection \* vec4\(worldPosition, 1\.0\);/);
});

test('without the feature the varying stays, as in the default vertex shader the liquid pass reads', () => {
  const vertex = resolveConditionals(createVertexShader(RIGID_FEATURES));
  const fragment = resolveConditionals(createFragmentShader(RIGID_FEATURES));
  assert.match(vertex, /^out vec4 shadowPosition;$/m);
  assert.match(vertex, /shadowPosition = lightProjection \* world;/);
  assert.match(fragment, /^in vec4 shadowPosition;$/m);
  assert.doesNotMatch(fragment, /lightProjection/);
  assert.ok(!SHADER_FEATURES.includes(FRAGMENT_SHADOW_POSITION_FEATURE), 'a shader built from every feature keeps the varying');
});
