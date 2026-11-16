// Finds the module specifiers a JavaScript file really imports, ignoring comments and text inside strings (#1830).
// `import x from 'a'`, `import 'a'`, `export { x } from 'a'`, `import('a')` and `require('a')` count when they are code.
// It is a small scanner, not a parser: it masks comments and string bodies, then matches statements that start a line
// or follow `;` or `}`. Template literals are masked whole, so an import written inside one is ignored.
import { posix } from 'node:path';

const STATEMENT_PATTERN = /(?:^|[;}])[ \t]*(?:import|export)\b[^;'"`]*?(?:\bfrom\s*|\bimport\s*)(["'])(\d+)\1/gm;
const SIDE_EFFECT_PATTERN = /(?:^|[;}])[ \t]*import\s*(["'])(\d+)\1/gm;
const CALL_PATTERN = /(?:\bimport|\brequire)\s*\(\s*(["'])(\d+)\1\s*\)/g;

/** Replaces comments with spaces and each string with its quote around an index into `literals`. */
function maskSource(source) {
  const literals = [];
  let masked = '';
  let position = 0;
  while (position < source.length) {
    const character = source[position];
    const next = source[position + 1];
    if (character === '/' && next === '/') {
      while (position < source.length && source[position] !== '\n') position += 1;
    } else if (character === '/' && next === '*') {
      const end = source.indexOf('*/', position + 2);
      const stop = end === -1 ? source.length : end + 2;
      masked += source.slice(position, stop).replace(/[^\n]/g, ' ');
      position = stop;
    } else if (character === '"' || character === "'" || character === '`') {
      let end = position + 1;
      while (end < source.length && source[end] !== character) end += source[end] === '\\' ? 2 : 1;
      if (character === '`') {
        masked += '``';
      } else {
        masked += `${character}${literals.length}${character}`;
        literals.push(source.slice(position + 1, end));
      }
      position = end + 1;
    } else {
      masked += character;
      position += 1;
    }
  }
  return { masked, literals };
}

/** Every specifier the source imports, in order of appearance. */
export function importSpecifiers(source) {
  const { masked, literals } = maskSource(source);
  const found = new Map();
  for (const pattern of [STATEMENT_PATTERN, SIDE_EFFECT_PATTERN, CALL_PATTERN]) {
    for (const match of masked.matchAll(pattern)) {
      const literalStart = match.index + match[0].lastIndexOf(match[1] + match[2]);
      found.set(literalStart, literals[Number(match[2])]);
    }
  }
  return [...found.entries()].sort(([first], [second]) => first - second).map(([, specifier]) => specifier);
}

/** True when the source imports `targetPath` (a repository path) by a relative specifier, from a file at `importerPath`. */
export function importsFile(source, importerPath, targetPath) {
  const targetWithoutExtension = targetPath.replace(/\.(m?js|cjs)$/, '');
  return importSpecifiers(source)
    .filter((specifier) => specifier.startsWith('./') || specifier.startsWith('../'))
    .some((specifier) => {
      const resolved = posix.join(posix.dirname(importerPath), specifier);
      return resolved === targetPath || resolved === targetWithoutExtension;
    });
}
