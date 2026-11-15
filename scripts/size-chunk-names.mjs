// esbuild names a chunk after a hash that depends on where the checkout sits on disk, so the base branch (built in a scratch folder)
// and the pull request got different eight-letter names for the same code. The names are text inside the importing chunks, and
// gzip packs different text into a different number of bytes, which showed as a few bytes of growth on a change that touched none
// of that code. The measurement renames every chunk by its own contents instead, so the same code gives the same bytes anywhere.
import { createHash } from 'node:crypto';
import { basename } from 'node:path';

const HASH_LENGTH = 8;
const HASHED_FILE_NAME = /^(.+)-([A-Z0-9]{8})(\.[a-z]+)$/;
const HASH_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function splitHashedName(fileName) {
  const match = HASHED_FILE_NAME.exec(fileName);
  return match ? { stem: match[1], hash: match[2], extension: match[3] } : null;
}

function hashFromText(text) {
  const digest = createHash('sha256').update(text).digest();
  let hash = '';
  for (let index = 0; index < HASH_LENGTH; index++) hash += HASH_ALPHABET[digest[index] % HASH_ALPHABET.length];
  return hash;
}

// Takes esbuild output files ({ path, contents }) and returns a Map from each output path to its contents with every chunk name
// replaced by a name made from the chunk's contents. Files without a hash in the name (the entry) keep their text apart from
// the references they hold.
export function renameChunksByContent(outputFiles) {
  const hashedFiles = outputFiles.filter(file => splitHashedName(basename(file.path)));
  let pattern = null;
  const renamed = new Map();
  const newNameByOldName = new Map();
  if (hashedFiles.length) {
    const fileNames = hashedFiles.map(file => basename(file.path));
    pattern = new RegExp(fileNames.map(escapeRegExp).join('|'), 'g');
    const blank = text => text.replace(pattern, name => {
      const { stem, extension } = splitHashedName(name);
      return `${stem}-${'_'.repeat(HASH_LENGTH)}${extension}`;
    });
    const used = new Set();
    for (const file of hashedFiles) {
      const oldName = basename(file.path);
      const { stem, extension } = splitHashedName(oldName);
      const text = blank(Buffer.from(file.contents).toString('latin1'));
      let newName;
      for (let attempt = 0; ; attempt++) {
        newName = `${stem}-${hashFromText(`${stem}\n${attempt}\n${text}`)}${extension}`;
        if (!used.has(newName)) break;
      }
      used.add(newName);
      newNameByOldName.set(oldName, newName);
    }
  }
  for (const file of outputFiles) {
    if (!pattern) {
      renamed.set(file.path, Buffer.from(file.contents));
      continue;
    }
    const text = Buffer.from(file.contents).toString('latin1').replace(pattern, name => newNameByOldName.get(name));
    renamed.set(file.path, Buffer.from(text, 'latin1'));
  }
  return renamed;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
