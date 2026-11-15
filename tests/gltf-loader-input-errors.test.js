import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGltf } from '../src/gltf.js';

const triangleBytes = new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
const triangleBase64 = Buffer.from(triangleBytes).toString('base64');

function triangleJson(change = () => {}, uri = `data:application/octet-stream;base64,${triangleBase64}`) {
  const document = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    materials: [{}],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
    bufferViews: [{ buffer: 0, byteLength: 36 }],
    buffers: [{ byteLength: 36, uri }],
  };
  change(document);
  return JSON.stringify(document);
}

for (const [field, value, expected] of [
  ['matrix', [1, 2, 3], /nodes\[0\]\.matrix.*16 numbers/],
  ['translation', [1, 1], /nodes\[0\]\.translation.*3 numbers/],
  ['rotation', [0, 0, 1], /nodes\[0\]\.rotation.*4 numbers/],
  ['scale', ['a', 1, 1], /nodes\[0\]\.scale.*3 numbers/],
  ['rotation', [0, 0, 0, 0], /nodes\[0\]\.rotation.*zero quaternion/],
]) {
  test(`a node ${field} of ${JSON.stringify(value)} is refused with the field named`, async () => {
    await assert.rejects(parseGltf(triangleJson(document => { document.nodes[0][field] = value; })), expected);
  });
}

test('a data URI marked BASE64 in capitals loads', async () => {
  const uri = `data:application/octet-stream;BASE64,${triangleBase64}`;
  const result = await parseGltf(triangleJson(() => {}, uri));
  assert.equal(result.parts.length, 1);
});

for (const [label, payload] of [['URL-safe or stray characters', '-_-_'], ['a truncated payload', 'A']]) {
  test(`a data URI with ${label} says to use standard base64`, async () => {
    const uri = `data:application/octet-stream;base64,${payload}`;
    await assert.rejects(parseGltf(triangleJson(() => {}, uri)), /Invalid base64 in a glTF data URI.*standard base64/);
  });
}

for (const [mode, name] of [[5, 'TRIANGLE_STRIP (mode 5)'], [6, 'TRIANGLE_FAN (mode 6)'], [9, 'mode 9']]) {
  test(`a primitive of ${name} is refused by name with the fix`, async () => {
    const text = triangleJson(document => { document.meshes[0].primitives[0].mode = mode; });
    await assert.rejects(parseGltf(text), error => error.message.includes(name)
      && error.message.includes('meshes[0].primitives[0]') && error.message.includes('re-export'));
  });
}
