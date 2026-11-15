import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { renameChunksByContent } from '../scripts/size-chunk-names.mjs';

function outputFile(name, text) {
  return { path: join('out', name), contents: Buffer.from(text) };
}

function textsOf(renamed) {
  return [...renamed.values()].map(contents => contents.toString()).sort();
}

test('the same chunks under different hashes get the same names and the same text', () => {
  const first = renameChunksByContent([
    outputFile('stdin.js', 'import("./agent-bake-AAAAAAAA.js");import"./chunk-BBBBBBBB.js";'),
    outputFile('agent-bake-AAAAAAAA.js', 'import"./chunk-BBBBBBBB.js";bake();'),
    outputFile('chunk-BBBBBBBB.js', 'shared();'),
  ]);
  const second = renameChunksByContent([
    outputFile('stdin.js', 'import("./agent-bake-ZZZZZZZZ.js");import"./chunk-YYYYYYYY.js";'),
    outputFile('agent-bake-ZZZZZZZZ.js', 'import"./chunk-YYYYYYYY.js";bake();'),
    outputFile('chunk-YYYYYYYY.js', 'shared();'),
  ]);
  assert.deepEqual(textsOf(first), textsOf(second));
  assert.doesNotMatch(textsOf(first).join(), /AAAAAAAA|BBBBBBBB/);
});

test('chunks with different code keep different names', () => {
  const renamed = renameChunksByContent([
    outputFile('stdin.js', 'import"./chunk-AAAAAAAA.js";import"./chunk-BBBBBBBB.js";'),
    outputFile('chunk-AAAAAAAA.js', 'one();'),
    outputFile('chunk-BBBBBBBB.js', 'two();'),
  ]);
  const references = [...renamed.get(join('out', 'stdin.js')).toString().matchAll(/chunk-[A-Z0-9]{8}.js/g)].map(match => match[0]);
  assert.equal(references.length, 2);
  assert.notEqual(references[0], references[1]);
});

test('output without hashed names is returned unchanged', () => {
  const renamed = renameChunksByContent([outputFile('stdin.js', 'run();')]);
  assert.equal([...renamed.values()][0].toString(), 'run();');
});

test('the size of a bundle does not depend on the folder it is built in', async () => {
  const sources = { 'main.js': 'import("./lazy.js");import "./shared.js";', 'lazy.js': 'import "./shared.js";export const lazy = 1;', 'shared.js': 'console.log("shared");' };
  const texts = [];
  for (let copy = 0; copy < 2; copy++) {
    const folder = mkdtempSync(join(tmpdir(), `size-chunk-names-${copy}-`));
    try {
      mkdirSync(join(folder, 'deeper'.repeat(copy + 1)), { recursive: true });
      for (const [name, text] of Object.entries(sources)) writeFileSync(join(folder, name), text);
      const result = await build({ entryPoints: [join(folder, 'main.js')], bundle: true, splitting: true, format: 'esm', write: false, minify: true, outdir: join(folder, 'out'), logLevel: 'silent' });
      texts.push(textsOf(renameChunksByContent(result.outputFiles)));
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  }
  assert.deepEqual(texts[0], texts[1]);
});
