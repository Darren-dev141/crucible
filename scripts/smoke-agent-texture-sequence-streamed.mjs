// Through MCP on the CPU backend: a quad whose colour map is a sequence of 70 generated PNG frames, one more than a whole
// sequence holds, so its frames stream. Checks that scene_look shows the same PNG bytes as a whole 64 frame sequence of the
// same images for the frames both hold, that a seek back to an earlier frame works, that frames past 64 differ, and that a
// 70 frame video job shows the frame of each time.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir, constants, setPriority } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { deflateSync, crc32 } from 'node:zlib';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

setPriority(0, constants.priority.PRIORITY_BELOW_NORMAL);

const FRAME_COUNT = 70;
const WHOLE_FRAME_COUNT = 64;
const FRAMES_PER_SECOND = 10;
const SIZE = 128;

function frameColor(index) {
  return [(index * 37) % 256, (index * 91) % 256, (index * 53) % 256];
}

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

function solidPng(color, side = 16) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const rows = Buffer.alloc((side * 3 + 1) * side);
  for (let row = 0; row < side; row++) {
    for (let column = 0; column < side; column++) rows.set(color, row * (side * 3 + 1) + 1 + column * 3);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))]);
}

function centerPixelOfPng(input) {
  const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { input, windowsHide: true, maxBuffer: 16 * 1024 ** 2 });
  assert.equal(decoded.status, 0, decoded.stderr.toString());
  const offset = ((SIZE / 2) * SIZE + SIZE / 2) * 3;
  return [...decoded.stdout.subarray(offset, offset + 3)];
}

const directory = await mkdtemp(join(tmpdir(), 'crucible-streamed-sequence-smoke-'));
const assets = join(directory, 'assets');
const jobs = join(directory, 'jobs');
await mkdir(assets);
for (let index = 0; index < FRAME_COUNT; index++) {
  await writeFile(join(assets, `frame-${String(index).padStart(3, '0')}.png`), solidPng(frameColor(index)));
}
const transport = new StdioClientTransport({ command: process.execPath,
  args: [resolve('scripts/mcp-server.mjs'), '--backend', 'cpu', '--memory', '192', '--assets', assets, '--jobs', jobs], cwd: directory, stderr: 'pipe' });
let diagnostics = '';
transport.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-8192); });
const client = new Client({ name: 'crucible-streamed-sequence-proof', version: '1' });

async function call(name, argumentsValue = {}) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 120000 });
  assert.equal(result.isError, undefined, result.content?.find(item => item.type === 'text')?.text);
  return result;
}

async function look(sessionId, motionTime) {
  const result = await call('scene_look', { sessionId, width: SIZE, height: SIZE, motionTime });
  return Buffer.from(result.content.find(item => item.type === 'image').data, 'base64');
}

async function completed(jobId) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const record = (await call('scene_render_status', { jobId })).structuredContent;
    if (['completed', 'cancelled', 'failed'].includes(record.state)) {
      assert.equal(record.state, 'completed', JSON.stringify(record));
      return;
    }
    await delay(200);
  }
  throw new Error('Job did not complete within 180 seconds.');
}

function recipeWith(frames) {
  return {
    format: 'crucible.scene', schemaVersion: 1,
    geometries: [{ id: 'quad', type: 'grid', segments: 1 }],
    materials: [{ id: 'screen', roughness: 1, map: { sequence: { frames, fps: FRAMES_PER_SECOND } } }],
    nodes: [{ id: 'screen', geometry: 'quad', material: 'screen', scale: [6, 1, 6] }],
    camera: { eye: [0, 5, 0.5], target: [0, 0, 0], fov: 40 },
  };
}

function timeOfFrame(index) {
  return index / FRAMES_PER_SECOND + 0.01;
}

try {
  await client.connect(transport);
  const catalog = (await call('scene_asset_catalog')).structuredContent;
  const frames = catalog.assets.filter(asset => asset.kind === 'image').sort((left, right) => left.name.localeCompare(right.name)).map(asset => asset.assetId);
  assert.equal(frames.length, FRAME_COUNT);
  const whole = (await call('scene_create', { recipe: recipeWith(frames.slice(0, WHOLE_FRAME_COUNT)) })).structuredContent;
  const streamed = (await call('scene_create', { recipe: recipeWith(frames) })).structuredContent;

  for (const index of [0, 1, 2, 10, 33, 63]) {
    const wholeBytes = await look(whole.sessionId, timeOfFrame(index));
    const streamedBytes = await look(streamed.sessionId, timeOfFrame(index));
    assert.deepEqual(streamedBytes, wholeBytes, `frame ${index}: a streamed sequence gives the PNG bytes of a whole one`);
  }
  const lastWhole = await look(streamed.sessionId, timeOfFrame(63));
  const afterWhole = [];
  for (const index of [64, 65, 69]) afterWhole.push(await look(streamed.sessionId, timeOfFrame(index)));
  assert.equal(new Set([lastWhole, ...afterWhole].map(bytes => bytes.toString('base64'))).size, 4, 'frames past 64 differ from each other');
  const back = await look(streamed.sessionId, timeOfFrame(2));
  assert.deepEqual(back, await look(whole.sessionId, timeOfFrame(2)), 'a seek back to an earlier frame decodes it again');
  const inspected = (await call('scene_inspect', { sessionId: streamed.sessionId })).structuredContent;
  assert.equal(inspected.textureSequences[0].streamed, true);
  assert.ok(inspected.textureSequences[0].decodedFrames <= 2, 'two frames at most stay decoded');

  const video = (await call('scene_render_submit', { sessionId: streamed.sessionId, expectedRevision: streamed.revision ?? 0,
    settings: { kind: 'video', width: SIZE, height: SIZE, fps: FRAMES_PER_SECOND, duration: FRAME_COUNT / FRAMES_PER_SECOND, motion: { start: 0.01 } } })).structuredContent;
  await completed(video.jobId);
  const videoResult = (await call('scene_render_result', { jobId: video.jobId })).structuredContent;
  const decoded = spawnSync('ffmpeg', ['-v', 'error', '-i', videoResult.artifacts[0].path, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-threads', '1', 'pipe:1'],
    { windowsHide: true, maxBuffer: 64 * 1024 ** 2 });
  assert.equal(decoded.status, 0, decoded.stderr.toString());
  const frameBytes = SIZE * SIZE * 3;
  assert.equal(decoded.stdout.length, frameBytes * FRAME_COUNT);
  for (const index of [0, 5, 40, 63, 64, 69]) {
    const offset = index * frameBytes + ((SIZE / 2) * SIZE + SIZE / 2) * 3;
    const videoPixel = [...decoded.stdout.subarray(offset, offset + 3)];
    const lookPixel = centerPixelOfPng(await look(streamed.sessionId, timeOfFrame(index)));
    const largestGap = Math.max(...videoPixel.map((channel, channelIndex) => Math.abs(channel - lookPixel[channelIndex])));
    assert.ok(largestGap <= 12, `video frame ${index} shows the frame scene_look shows (gap ${largestGap})`);
  }
  console.log(JSON.stringify({ ok: true, frames: FRAME_COUNT, sameBytesAsWhole: [0, 1, 2, 10, 33, 63], videoFrames: FRAME_COUNT }));
} catch (error) {
  console.error(diagnostics);
  throw error;
} finally {
  await client.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
