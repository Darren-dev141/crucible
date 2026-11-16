// Reduces a JavaScript source file to the text that can change behaviour, for scripts/look-fingerprint.mjs: comments and
// whitespace are dropped. With `dropTemplateText`, the text inside template literals (the GLSL) is dropped too, because the
// fingerprint already hashes the shader text a template produces. The scanner is deliberately plain. When it misreads a rare
// construct it misreads base and head the same way, and a real edit near it still changes the text, so the result errs toward a hold.

const REGEX_PRECEDING_CHARACTERS = '(,=:[!&|?{};+-*%<>~^';

function skipQuoted(source, start, quote) {
  let index = start + 1;
  while (index < source.length && source[index] !== quote) index += source[index] === '\\' ? 2 : 1;
  return index + 1;
}

function skipRegex(source, start) {
  let index = start + 1;
  let inClass = false;
  while (index < source.length && source[index] !== '\n') {
    const character = source[index];
    if (character === '\\') index += 1;
    else if (character === '[') inClass = true;
    else if (character === ']') inClass = false;
    else if (character === '/' && !inClass) return index + 1;
    index += 1;
  }
  return start + 1;
}

// Returns the index after a template literal that starts at `start`, with the ${} expressions scanned as code.
function scanTemplate(source, start, dropTemplateText, output) {
  let index = start + 1;
  output.push('`');
  while (index < source.length && source[index] !== '`') {
    if (source[index] === '\\') {
      if (!dropTemplateText) output.push(source.slice(index, index + 2));
      index += 2;
    } else if (source[index] === '$' && source[index + 1] === '{') {
      output.push('${');
      index = scanCode(source, index + 2, dropTemplateText, output, true);
      output.push('}');
    } else {
      if (!dropTemplateText) output.push(source[index]);
      index += 1;
    }
  }
  output.push('`');
  return index + 1;
}

// Scans code until the end, or until the brace that closes a ${} expression.
function scanCode(source, start, dropTemplateText, output, insideExpression = false) {
  let index = start;
  let depth = 0;
  let lastSignificant = '';
  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];
    if (character === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
    } else if (character === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end < 0 ? source.length : end + 2;
    } else if (character === '\'' || character === '"') {
      const end = skipQuoted(source, index, character);
      output.push(source.slice(index, end));
      lastSignificant = character;
      index = end;
    } else if (character === '`') {
      index = scanTemplate(source, index, dropTemplateText, output);
      lastSignificant = '`';
    } else if (character === '/' && (lastSignificant === '' || REGEX_PRECEDING_CHARACTERS.includes(lastSignificant))) {
      const end = skipRegex(source, index);
      output.push(source.slice(index, end));
      lastSignificant = '/';
      index = end;
    } else if (/\s/.test(character)) {
      if (output.length > 0 && output[output.length - 1] !== ' ' && /[\w$]/.test(lastSignificant)) output.push(' ');
      index += 1;
    } else {
      if (insideExpression && character === '{') depth += 1;
      if (insideExpression && character === '}') {
        if (depth === 0) return index + 1;
        depth -= 1;
      }
      output.push(character);
      lastSignificant = character;
      index += 1;
    }
  }
  return index;
}

/** The behaviour-bearing text of a JavaScript file: no comments, collapsed whitespace, and optionally no template literal text. */
export function normalizedSourceText(source, { dropTemplateText = false } = {}) {
  const output = [];
  scanCode(source, 0, dropTemplateText, output);
  return output.join('');
}
