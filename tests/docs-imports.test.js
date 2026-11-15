import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const packageExports = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).exports;
const libraryConfig = readFileSync(new URL('../config/vite.lib.config.js', import.meta.url), 'utf8');
const PACKAGE_NAMES = ['crucible', '@codepawlhq/crucible'];

function readText(relativePath) {
  return readFileSync(join(projectRoot, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

function markdownFiles(folder) {
  const found = [];
  for (const entry of readdirSync(join(projectRoot, folder), { withFileTypes: true })) {
    const path = `${folder}/${entry.name}`;
    if (entry.isDirectory()) found.push(...markdownFiles(path));
    else if (entry.name.endsWith('.md')) found.push(path);
  }
  return found;
}

const shippedFiles = [...markdownFiles('docs'), ...markdownFiles('skills')];

/** The import statements inside fenced js blocks: { file, specifier, names }. */
function importsOf(file) {
  const imports = [];
  for (const [, code] of readText(file).matchAll(/```(?:js|javascript|mjs)\n([\s\S]*?)```/g)) {
    for (const match of code.matchAll(/import\s+(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\}|\*\s+as\s+[\w$]+)?\s*from\s*'([^']+)'/g)) {
      const names = match[2] === undefined
        ? []
        : match[2].split(',').map(name => name.trim().split(/\s+as\s+/)[0]).filter(Boolean);
      imports.push({ file, specifier: match[3], names });
    }
  }
  return imports;
}

const allImports = shippedFiles.flatMap(importsOf);

function packageSubpath(specifier) {
  const name = PACKAGE_NAMES.find(candidate => specifier === candidate || specifier.startsWith(`${candidate}/`));
  return name === undefined ? null : `.${specifier.slice(name.length)}`;
}

/** The source file that the built entry of a package subpath comes from. */
function sourceOfSubpath(subpath) {
  const target = packageExports[subpath];
  if (typeof target !== 'string') return null;
  const entryName = target.match(/^\.\/build\/(.+)\.js$/)?.[1];
  if (subpath === '.') return 'src/index.js';
  const escaped = entryName.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const entry = libraryConfig.match(new RegExp(`(?:^|\\s)['"]?${escaped}['"]?:\\s*'([^']+)'`));
  return entry === null ? null : entry[1];
}

test('shipped docs and skills never import a repository path the npm package does not contain', () => {
  const offenders = allImports.filter(item => /^\.{1,2}\/(?:src|scripts)\//.test(item.specifier) || /^\.\/src\//.test(item.specifier));
  assert.deepEqual(offenders.map(item => `${item.file}: ${item.specifier}`), []);
});

test('every package import in docs and skills names a subpath that package.json exports', () => {
  const problems = [];
  for (const item of allImports) {
    const subpath = packageSubpath(item.specifier);
    if (subpath === null) continue;
    if (!Object.hasOwn(packageExports, subpath)) {
      problems.push(`${item.file}: ${item.specifier} is not in package.json exports`);
    } else if (sourceOfSubpath(subpath) === null) {
      problems.push(`${item.file}: ${item.specifier} has no entry in config/vite.lib.config.js`);
    }
  }
  assert.deepEqual(problems, []);
});

test('every named import from a package subpath is exported by that entry', async () => {
  const moduleCache = new Map();
  const problems = [];
  for (const item of allImports) {
    const subpath = packageSubpath(item.specifier);
    const source = subpath === null ? null : sourceOfSubpath(subpath);
    if (source === null || item.names.length === 0) continue;
    if (!moduleCache.has(source)) moduleCache.set(source, await import(pathToFileURL(join(projectRoot, source)).href));
    const exported = moduleCache.get(source);
    for (const name of item.names) {
      if (!(name in exported)) problems.push(`${item.file}: ${name} is not exported by ${item.specifier}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('the export-glb example builds its matrix without a mat4 helper and names the import of clipFromGltfAnimation', () => {
  const text = readText('docs/export-glb.md');
  assert.ok(!/\bmat4\b/.test(text), 'the core exports no mat4; pass a Float32Array');
  assert.match(text, /import \{ clipFromGltfAnimation \} from 'crucible\/addons\/skeleton-pose'/);
});

test('the navmesh example in the terrain guide finds a path as written', async () => {
  const section = readText('docs/terrain.md').split('## Navigation')[1];
  const code = section.match(/```js\n([\s\S]*?)```/)[1];
  const rewritten = code.replace(/from '(crucible\/addons\/[\w-]+)'/g, (_, specifier) => {
    const source = sourceOfSubpath(packageSubpath(specifier));
    return `from '${pathToFileURL(join(projectRoot, source)).href}'`;
  });
  const folder = mkdtempSync(join(tmpdir(), 'crucible-doc-'));
  try {
    const file = join(folder, 'example.mjs');
    writeFileSync(file, `${rewritten}\nexport { points, length };\n`);
    const result = await import(pathToFileURL(file).href);
    assert.ok(result.points.length > 1, `no path came back; ran from ${relative(projectRoot, file)}`);
    assert.ok(result.length > 0);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('the MCP limits table agrees with the scene cap stated in the same guide', () => {
  const text = readText('docs/mcp.md');
  assert.match(text, /keeps up to 4 scenes open, within 96 MiB/);
  assert.ok(!/Active render scenes \| 1 \|/.test(text));
  assert.match(text, /\| Open scenes \| 4, within 96 MiB/);
});

test('the agent workflow guide describes the capabilities index and tells the reader to pass a topic', () => {
  const text = readText('docs/learn/agent-workflows.md');
  assert.ok(!/about 24 KB/.test(text), 'scene_capabilities no longer returns 24 KB');
  assert.match(text, /topic: 'sceneLimits'/);
  assert.match(text, /topic: 'unsupported'/);
});
