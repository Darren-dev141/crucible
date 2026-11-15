import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findAbbreviatedNames, isScannedPath } from '../scripts/check-names.mjs';

// Built from parts so this file itself holds no short declarations for the name check to flag.
const declare = (keyword, name) => `${keyword} ${name} = 1;`;

test('one-letter and abbreviated declarations are flagged with their line', () => {
  const lines = [declare('const', 'total'), declare('const', 'c'), declare('let', 'tmp'), `${'function'} fn() {}`, declare('var', 'obj')];
  assert.deepEqual(findAbbreviatedNames(lines.join('\n')), [
    { line: 2, name: 'c' },
    { line: 3, name: 'tmp' },
    { line: 4, name: 'fn' },
    { line: 5, name: 'obj' },
  ]);
});

test('loop indices, coordinates, colour channels and underscore stay allowed', () => {
  const allowedNames = ['i', 'j', 'x', 't', 'r', '_', '$'];
  const text = allowedNames.map(name => declare('const', name)).join('\n');
  assert.deepEqual(findAbbreviatedNames(text), []);
});

test('comments and longer names that contain an abbreviation are not flagged', () => {
  const lines = [`// ${declare('const', 'c')}`, ` * ${declare('let', 'tmp')}`, declare('const', 'message'), declare('const', 'index')];
  assert.deepEqual(findAbbreviatedNames(lines.join('\n')), []);
});

test('only tracked source folders are scanned, minus generated and vendor files', () => {
  assert.equal(isScannedPath('src/cloth.js'), true);
  assert.equal(isScannedPath('packages/blender-addon/src/a.js'), true);
  assert.equal(isScannedPath(String.raw`scripts\drive.mjs`), true);
  assert.equal(isScannedPath('src/vendor/lib.js'), false);
  assert.equal(isScannedPath('src/bundle.min.js'), false);
  assert.equal(isScannedPath('docs/example.js'), false);
  assert.equal(isScannedPath('src/readme.md'), false);
});
