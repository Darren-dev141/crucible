// Native video frames (#1861): a later frame of one job reads from the page only the byte ranges of the tables that changed, and the
// tables it returns are the ones a full export of the same frame gives.
import assert from 'node:assert/strict';
import test from 'node:test';
import { collectExportChunks, createExportReuse, discardHeldExport, fetchNativeExport } from '../scripts/agent-native-trace.mjs';
import {
  NATIVE_EXPORT_REUSE_BLOCK_BYTES, changedBlockRanges, describeTableReuse, exportNativeSceneTables, readExportChunk, splitExportForChunks,
} from '../scripts/native-bake-page.js';
import { createCamera } from '../src/path-tracer.js';
import * as pack from '../src/path-tracer-gpu-pack.js';
import { buildTraceScene, resolveTexture } from '../src/path-tracer-scene.js';
import { cookModule, cookTest } from './support/cook.js';

const { buildNativeInput } = (await cookModule('pack-input')) ?? {};
const { buildFlattenedJobNativeInput, buildJobNativeInput } = (await cookModule('job-input')) ?? {};

const BLOCK = NATIVE_EXPORT_REUSE_BLOCK_BYTES;
const WIDTH = 16;
const HEIGHT = 16;
const camera = createCamera({ eye: [0, 1, 8], target: [0, 0, 0], fov: 50 }, WIDTH, HEIGHT);
const packOptions = { width: WIDTH, height: HEIGHT, samples: 4, bounces: 2, seed: 1, fireflyClamp: 20, noiseThreshold: 0 };
const environment = { keyColor: [2, 2, 2], lightDirection: [0.3, 0.8, 0.5] };

// The page side of fetchNativeExport: it answers the export request with a manifest and serves ranges of the held tables.
function pageServing(exportsByFrame, log) {
  let held = null;
  let frame = 0;
  return {
    async evaluate(callback, request) {
      if (request?.chunked) {
        const exported = exportsByFrame[frame++];
        const reuse = request.reuseDigests ? await describeTableReuse(exported.tables, request.reuseDigests) : undefined;
        const split = splitExportForChunks(exported, reuse);
        held = split.tables;
        log.requests.push(request);
        return split.manifest;
      }
      if (request?.name !== undefined) {
        log.chunkReads.push({ name: request.name, offset: request.offset, byteCount: request.byteCount });
        return readExportChunk(held, request.name, request.offset, request.byteCount);
      }
      held = null;
      return undefined;
    },
  };
}

// A frame whose big table is three blocks and a bit long: `movingTail` fills its last bytes, the rest stays as it was.
function frameExport(movingTail, instances) {
  const triangles = new Uint8Array(3 * BLOCK + 10).map((_, index) => (index * 7) & 0xff);
  triangles.fill(movingTail, 3 * BLOCK);
  return { schemaVersion: 2, tables: { triangles, instances: Uint8Array.from(instances), kernelParams: Uint8Array.from([instances[0], 0]) },
    types: { triangles: 'Uint8Array', instances: 'Uint8Array', kernelParams: 'Uint8Array' }, counts: { triangleCount: 1 }, triangles: 1, wholeMaterials: true };
}

function readsOf(log, from) {
  return log.chunkReads.slice(from).map(({ name, offset, byteCount }) => `${name}@${offset}+${byteCount ?? 'all'}`).sort();
}

test('block digests name the ranges that differ from the held ones, merged and bounded', () => {
  assert.deepEqual(changedBlockRanges(['a', 'b', 'c', 'd'], ['a', 'x', 'y', 'd'], 3 * BLOCK + 5), [[BLOCK, 2 * BLOCK]]);
  assert.deepEqual(changedBlockRanges(['a', 'b'], ['a'], BLOCK + 5), [[BLOCK, 5]], 'a block past the held table differs, and the last one is short');
  assert.deepEqual(changedBlockRanges(['a', 'b'], ['a', 'b'], 2 * BLOCK), []);
});

test('the digests of a table cover each block, and only a changed block becomes a range to read', async () => {
  const first = frameExport(1, [4, 5]);
  const initial = await describeTableReuse(first.tables, {});
  assert.deepEqual(initial.changedRanges, {}, 'a reader that holds nothing is given no ranges');
  assert.equal(initial.digests.triangles.length, 4);
  assert.match(initial.digests.triangles[0], /^[0-9a-f]{64}$/);
  const held = { blockBytes: initial.blockBytes, tables: initial.digests };
  const later = await describeTableReuse(frameExport(2, [4, 5]).tables, held);
  assert.deepEqual(later.changedRanges, { triangles: [[3 * BLOCK, 10]], instances: [], kernelParams: [] });
  const otherBlockSize = await describeTableReuse(first.tables, { blockBytes: BLOCK / 2, tables: initial.digests });
  assert.deepEqual(otherBlockSize.changedRanges, {}, 'digests made with another block size are ignored');
});

test('the second and later frames of a job read only the ranges that changed', async () => {
  const frames = [frameExport(1, [10, 11]), frameExport(2, [10, 11]), frameExport(3, [20, 21])];
  const log = { requests: [], chunkReads: [] };
  const page = pageServing(frames, log);
  const reuse = createExportReuse();
  const received = [];
  for (let frame = 0; frame < frames.length; frame++) {
    const before = log.chunkReads.length;
    received.push({ exported: await fetchNativeExport(page, { sessionId: 's', options: {} }, { reuse }), reads: readsOf(log, before) });
  }
  assert.deepEqual(received[0].reads, ['instances@0+all', 'kernelParams@0+all', 'triangles@0+all'], 'the first frame reads everything');
  assert.deepEqual(received[1].reads, [`triangles@${3 * BLOCK}+10`], 'only the moving tail of the triangles is read');
  assert.deepEqual(received[2].reads, ['instances@0+2', 'kernelParams@0+2', `triangles@${3 * BLOCK}+10`]);
  assert.equal(received[1].exported.reusedBytes, 3 * BLOCK + 2 + 2);
  received.forEach(({ exported }, frame) => {
    for (const [name, bytes] of Object.entries(frames[frame].tables)) assert.equal(Buffer.compare(exported.tables[name], bytes), 0, `frame ${frame} table ${name}`);
  });
});

test('a job without a reuse object reads every table every frame', async () => {
  const frames = [frameExport(1, [3, 4]), frameExport(1, [3, 4])];
  const log = { requests: [], chunkReads: [] };
  const page = pageServing(frames, log);
  await fetchNativeExport(page, { sessionId: 's', options: {} });
  await fetchNativeExport(page, { sessionId: 's', options: {} });
  assert.equal(log.chunkReads.length, 6);
  assert.ok(log.requests.every(request => request.reuseDigests === undefined));
});

test('discarding the held export makes the next frame read every table again', async () => {
  const frames = [frameExport(1, [3, 4]), frameExport(1, [3, 4])];
  const log = { requests: [], chunkReads: [] };
  const page = pageServing(frames, log);
  const reuse = createExportReuse();
  await fetchNativeExport(page, { sessionId: 's', options: {} }, { reuse });
  discardHeldExport(reuse);
  await fetchNativeExport(page, { sessionId: 's', options: {} }, { reuse });
  assert.equal(log.chunkReads.length, 6);
});

test('ranges for a table the reader does not hold, or outside the table, fail with the way out', async () => {
  const manifest = { schemaVersion: 2, chunks: { tables: { triangles: 4 }, chunkBytes: 48, changedRanges: { triangles: [[0, 2]] }, blockBytes: BLOCK, digests: { triangles: ['a'] } } };
  await assert.rejects(collectExportChunks(manifest, async () => '', { reuse: createExportReuse() }), /holds no earlier copy of it/);
  const reuse = { tables: { triangles: new Uint8Array(4) }, digests: {} };
  const outside = { ...manifest, chunks: { ...manifest.chunks, changedRanges: { triangles: [[3, 5]] } } };
  await assert.rejects(collectExportChunks(outside, async () => '', { reuse }), /out of order or outside its 4 bytes/);
  const short = { ...manifest, chunks: { ...manifest.chunks, tables: { triangles: 8 } } };
  await assert.rejects(collectExportChunks(short, async () => Buffer.from([1, 2]).toString('base64'), { reuse }), /keeps bytes 2 to 8 of table "triangles", but the held copy has 4 bytes/);
});

cookTest('a scene whose particles move exports the same tables incrementally as in full', async () => {
  const slab = {
    positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
    normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: Uint32Array.from([0, 1, 2, 0, 2, 3]),
  };
  // The particle mesh of one frame: a different triangle each frame, the way a particle system rebuilds its vertices.
  const particleMesh = time => ({
    positions: Float32Array.from([0, time, 0, 0.1, time, 0, 0, time + 0.1, 0]),
    normals: Float32Array.from([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: Uint32Array.from([0, 1, 2]),
  });
  const partsAt = time => [
    { name: 'ground', geometry: slab, matrix: [4, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1, 0, 0, 0, -2, 1], material: { color: [0.5, 0.5, 0.5] } },
    { name: 'wall', geometry: slab, matrix: [4, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1, 0, 0, 0, -3, 1], material: { color: [0.2, 0.5, 0.5] } },
    { name: 'dust', geometry: particleMesh(time), matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], material: { color: [1, 0.6, 0.2] } },
  ];
  const exportFrame = time => exportNativeSceneTables({ parts: partsAt(time), environment, camera, options: packOptions, kernel: 'cycles', instancing: true, transport: 'chunks',
    modules: { buildTraceScene, resolveTexture, buildNativeInput, buildJobNativeInput, buildFlattenedJobNativeInput, pack } });
  const frames = [0, 0.25, 0.5].map(exportFrame);
  const log = { requests: [], chunkReads: [] };
  const reuse = createExportReuse();
  const page = pageServing(frames, log);
  const collected = [];
  for (let frame = 0; frame < frames.length; frame++) {
    const before = log.chunkReads.length;
    collected.push({ exported: await fetchNativeExport(page, { sessionId: 's', options: {} }, { reuse }), reads: log.chunkReads.slice(before) });
  }
  collected.forEach(({ exported }, frame) => {
    assert.deepEqual(Object.keys(exported.tables).sort(), Object.keys(frames[frame].tables).sort());
    for (const [name, bytes] of Object.entries(frames[frame].tables)) assert.equal(Buffer.compare(exported.tables[name], bytes), 0, `frame ${frame} table ${name}`);
  });
  assert.ok(collected[1].reads.every(({ byteCount }) => byteCount !== undefined), 'a later frame reads ranges, never a whole table');
  assert.ok(collected[2].exported.reusedBytes > 0);
});
