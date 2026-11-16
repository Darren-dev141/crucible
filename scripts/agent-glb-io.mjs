// Reading and writing whole GLB files for the catalog steps that rewrite one (Draco #1698, KTX2 #1709).

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BINARY_CHUNK = 0x004e4942;

/** Splits a GLB into its JSON document and binary chunk. `subject` names the file kind in the error messages, such as "A Draco GLB". */
export function readGlb(bytes, subject = 'A GLB') {
  if (bytes.length < 20 || bytes.readUInt32LE(0) !== GLB_MAGIC || bytes.readUInt32LE(16) !== JSON_CHUNK) {
    throw new Error(`${subject} must be a complete glTF 2.0 binary file.`);
  }
  const jsonLength = bytes.readUInt32LE(12);
  const document = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
  const binaryStart = 20 + jsonLength;
  if (bytes.length < binaryStart + 8 || bytes.readUInt32LE(binaryStart + 4) !== BINARY_CHUNK) {
    throw new Error(`${subject} needs a binary chunk that holds its meshes and images.`);
  }
  const binaryLength = bytes.readUInt32LE(binaryStart);
  return { document, binary: bytes.subarray(binaryStart + 8, binaryStart + 8 + binaryLength) };
}

/** The buffer padded with `fill` to a multiple of four bytes. */
export function padded(buffer, fill) {
  const padding = (4 - (buffer.length % 4)) % 4;
  return padding ? Buffer.concat([buffer, Buffer.alloc(padding, fill)]) : buffer;
}

/** Writes a GLB from a JSON document and an already padded binary chunk. */
export function writeGlb(document, binary) {
  const json = padded(Buffer.from(JSON.stringify(document)), 0x20);
  const total = 12 + 8 + json.length + 8 + binary.length;
  const result = Buffer.alloc(total);
  result.writeUInt32LE(GLB_MAGIC, 0);
  result.writeUInt32LE(2, 4);
  result.writeUInt32LE(total, 8);
  result.writeUInt32LE(json.length, 12);
  result.writeUInt32LE(JSON_CHUNK, 16);
  json.copy(result, 20);
  const binaryOffset = 20 + json.length;
  result.writeUInt32LE(binary.length, binaryOffset);
  result.writeUInt32LE(BINARY_CHUNK, binaryOffset + 4);
  binary.copy(result, binaryOffset + 8);
  return result;
}
