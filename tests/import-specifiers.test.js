// The scanner behind scripts/addon-job-paths.mjs and scripts/fast-tests.mjs: real imports count, text and comments do not (#1830).
import assert from 'node:assert/strict';
import test from 'node:test';
import { importSpecifiers, importsFile } from '../scripts/import-specifiers.mjs';

test('every import form is found in order, including multi-line and re-exports', () => {
  const source = [
    "import first from './first.js';",
    'import {',
    '  second,',
    '} from "./second.js"',
    "import './third.js'",
    "export * from './fourth.js'",
    "export { fifth } from './fifth.js'",
    "const sixth = await import('./sixth.js'); const seventh = require('./seventh.js');",
  ].join('\n');
  assert.deepEqual(importSpecifiers(source), ['./first.js', './second.js', './third.js', './fourth.js', './fifth.js', './sixth.js', './seventh.js']);
});

test('comments, strings and template literals are ignored', () => {
  const source = [
    "// import hidden from './comment.js'",
    "/* import hidden from './block.js' */",
    "const text = \"import hidden from './string.js'\"; const other = 'from ./other.js';",
    "const template = `import hidden from './template.js'`;",
    "console.log('import hidden from \\'./escaped.js\\'');",
  ].join('\n');
  assert.deepEqual(importSpecifiers(source), []);
});

test('importsFile resolves the specifier against the importing file', () => {
  const target = 'tests/support/cook.js';
  assert.equal(importsFile("import { x } from './support/cook.js';", 'tests/a.test.js', target), true);
  assert.equal(importsFile("import { x } from '../support/cook.js';", 'tests/helpers/a.test.js', target), true);
  assert.equal(importsFile("import { x } from './cook.js';", 'tests/a.test.js', target), false);
  assert.equal(importsFile("import { x } from 'support/cook.js';", 'tests/a.test.js', target), false);
});
