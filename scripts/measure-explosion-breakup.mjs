#!/usr/bin/env node
// Draws the add-explosion recipe in Glaze (the rasterizer) and scores its peak frame against a Cycles reference frame (#1736): how much the
// cloud breaks up (silhouette roughness), how fast it fades at its edge, how far its luminance distribution is from the reference's, and an RMSE
// of the two after both are centred and scaled to the same cloud size (scripts/explosion-breakup-metrics.mjs explains the reduction).
//
//   git show origin/evidence-pr-1720:look-comparison.png > out/look-comparison.png
//   bash ~/.agents/tools/gpu-lock.sh node scripts/measure-explosion-breakup.mjs --reference out/look-comparison.png --out artifacts/explosion-breakup/before
//
// The reference is the first panel (0, 0, 640, 360) of look-comparison.png, cropped to the fireball (--crop x,y,width,height inside the panel).
// --times lists the motion times to draw (the first one is scored against the reference, the others are only saved), --backend gpu|cpu.
// Sparks are left out of the recipe so only the gas is measured. Prints one JSON object and saves each frame as frame-<time>.png.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createAgentRuntime } from './agent-runtime.mjs';
import { createAgentMcpServer } from './mcp-server.mjs';
import { decodePng } from '../bench/agent-modeling/png-check.mjs';
import { compareFrames, describeFrame, luminanceImage } from './explosion-breakup-metrics.mjs';

const REFERENCE_PANEL = { x: 0, y: 0, width: 640, height: 360 };
const DEFAULT_CROP = '170,120,280,200';
const FRAME_SIZE = { width: 1024, height: 576 };

// The scene the evidence stills use: a floor disc and a camera that looks at the blast from above and to the side.
const SCENE = {
  format: 'crucible.scene', schemaVersion: 1,
  geometries: [{ id: 'disc', type: 'cylinder' }],
  materials: [{ id: 'floor', color: [0.12, 0.11, 0.1], roughness: 1 }],
  nodes: [{ id: 'floor', geometry: 'disc', material: 'floor', scale: [9, 0.1, 9], translation: [0, -0.05, 0] }],
  camera: { eye: [0, 3.2, 9], target: [0, 1.6, 0], fov: 40 },
};

function parseArguments(argv) {
  const options = { backend: 'gpu', times: [0.45], crop: DEFAULT_CROP, size: 4, seed: 1, out: 'artifacts/explosion-breakup/run' };
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]?.replace(/^--/, '');
    if (!['reference', 'backend', 'times', 'crop', 'size', 'seed', 'out'].includes(name) || argv[index + 1] === undefined) {
      throw new Error(`Unknown or incomplete option ${argv[index]}; use --reference <png> --out <folder> [--times 0.45,1.2] [--crop x,y,w,h] [--backend gpu|cpu] [--size 4] [--seed 1].`);
    }
    options[name] = argv[index + 1];
  }
  options.times = String(options.times).split(',').map(Number);
  options.size = Number(options.size);
  options.seed = Number(options.seed);
  if (!options.reference) throw new Error('Pass --reference <png>: the look-comparison.png of the evidence-pr-1720 branch.');
  return options;
}

async function connect(backend) {
  const runtime = createAgentRuntime({ backend, memory: 192 });
  const server = createAgentMcpServer(runtime);
  const client = new Client({ name: 'measure-explosion-breakup', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); await runtime.close?.(); } };
}

async function call(client, name, argumentsValue) {
  const result = await client.callTool({ name, arguments: argumentsValue }, { timeout: 180000 });
  if (result.isError) throw new Error(result.content?.find(item => item.type === 'text')?.text ?? `${name} failed`);
  return result;
}

async function drawFrames(options) {
  const { client, close } = await connect(options.backend);
  try {
    const created = (await call(client, 'scene_create', { recipe: SCENE })).structuredContent;
    const operation = { type: 'add-explosion', id: 'blast', center: [0, 0, 0], size: options.size, seed: options.seed, sparks: 'none', motionBlur: false };
    await call(client, 'scene_apply', { sessionId: created.sessionId, expectedRevision: created.revision, operations: [operation] });
    const frames = [];
    for (const motionTime of options.times) {
      const look = await call(client, 'scene_look', { sessionId: created.sessionId, motionTime, ...FRAME_SIZE });
      const image = look.content.find(item => item.type === 'image');
      frames.push({ motionTime, png: Buffer.from(image.data, 'base64') });
    }
    return frames;
  } finally {
    await close();
  }
}

function referenceCrop(png, cropText) {
  const [x, y, width, height] = cropText.split(',').map(Number);
  return luminanceImage(png, { x: REFERENCE_PANEL.x + x, y: REFERENCE_PANEL.y + y, width, height });
}

const options = parseArguments(process.argv.slice(2));
await mkdir(options.out, { recursive: true });
const reference = describeFrame(referenceCrop(decodePng(await readFile(options.reference)), options.crop));
const frames = await drawFrames(options);
const report = { backend: options.backend, size: options.size, seed: options.seed, crop: options.crop, times: [] };
for (const [position, frame] of frames.entries()) {
  await writeFile(join(options.out, `frame-${frame.motionTime}.png`), frame.png);
  const described = describeFrame(luminanceImage(decodePng(frame.png)));
  const entry = { motionTime: frame.motionTime, cloudRadiusPixels: Math.round(described.geometry.radius), roughness: described.roughness, edgeFalloff: described.edgeFalloff };
  if (position === 0) entry.againstReference = compareFrames(reference, described);
  report.times.push(entry);
}
report.reference = { cloudRadiusPixels: Math.round(reference.geometry.radius), roughness: reference.roughness, edgeFalloff: reference.edgeFalloff };
await writeFile(join(options.out, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(0);
