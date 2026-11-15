import assert from 'node:assert/strict';
import test from 'node:test';
import { agentAssetDecodeOptions } from '../src/agent-asset-limits.js';
import { parseGltf } from '../src/gltf.js';

const REMOTE_BUFFER_URI = 'https://assets.example.invalid/triangle.bin';

function documentWithBufferUri(uri) {
  return JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    buffers: [{ byteLength: 36, uri }],
  });
}

async function withFetchStub(run) {
  const requested = [];
  const original = globalThis.fetch;
  globalThis.fetch = async url => {
    requested.push(String(url));
    throw new Error('stubbed network');
  };
  try {
    await run(requested);
  } finally {
    globalThis.fetch = original;
  }
}

test('the catalog decode options refuse an embedded absolute uri without any network request', async () => {
  await withFetchStub(async requested => {
    await assert.rejects(
      parseGltf(documentWithBufferUri(REMOTE_BUFFER_URI), agentAssetDecodeOptions()),
      error => error.message.includes(REMOTE_BUFFER_URI) && /GLB/.test(error.message) && /data URI/.test(error.message),
    );
    assert.deepEqual(requested, []);
  });
});

test('a library caller keeps the explicit remote fetch', async () => {
  await withFetchStub(async requested => {
    await assert.rejects(parseGltf(documentWithBufferUri(REMOTE_BUFFER_URI)), /stubbed network/);
    assert.deepEqual(requested, [REMOTE_BUFFER_URI]);
  });
});

test('an embedded data uri still loads under the catalog decode options', async () => {
  const bytes = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer).toString('base64');
  const asset = await parseGltf(documentWithBufferUri(`data:application/octet-stream;base64,${bytes}`), agentAssetDecodeOptions());
  assert.equal(asset.parts.length, 1);
});
