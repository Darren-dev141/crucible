// Checks that a native film's memory stays flat per frame and that a closed session's memory is reused (#1211).
// Renders frames through the runner's own frame function (traceFrameNative, with OIDN when it is installed) over one
// session on the Cook room fixture, then opens, renders and closes sessions in a row. RSS is read after gc().
//   node --expose-gc bench/native-tracer/frame-memory.mjs [--frames 500] [--cycles 12] [--denoise oidn|none]
// Prints one FRAME_MEMORY line of JSON and exits 1 when the second half of the film grows more than
// FRAME_GROWTH_LIMIT_MB per frame, or the closed sessions grow more than CYCLE_GROWTH_LIMIT_MB per cycle.
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { traceFrameNative, yieldToEventLoop } from '../../scripts/agent-native-trace.mjs';

// Before the runner yielded after each frame a film grew 8.8 to 14 MB a frame; flat runs measure 0 to 0.004.
const FRAME_GROWTH_LIMIT_MB = 0.25;
const CYCLE_GROWTH_LIMIT_MB = 1;
const WIDTH = 480;
const HEIGHT = 360;
const SAMPLES = 32;

const argumentList = process.argv.slice(2);
const flag = (name, fallback) => (argumentList.includes(name) ? argumentList[argumentList.indexOf(name) + 1] : fallback);
const frameCount = Number(flag('--frames', 500));
const cycleCount = Number(flag('--cycles', 12));
const requestedDenoise = flag('--denoise', 'oidn');

if (typeof globalThis.gc !== 'function') throw new Error('Run with node --expose-gc, so RSS is read after a collection.');
if (!Number.isInteger(frameCount) || frameCount < 20) throw new Error(`--frames must be an integer of at least 20, got ${flag('--frames')}.`);

const repository = join(dirname(fileURLToPath(import.meta.url)), '../..');
const cookEntry = createRequire(import.meta.url).resolve('@codepawlhq/cook');
const cookDirectory = dirname(cookEntry);
const cook = await import(pathToFileURL(cookEntry).href);
const { decodePackFile } = await import(pathToFileURL(join(cookDirectory, 'pack-file.mjs')).href);
const denoiser = await import(pathToFileURL(join(repository, 'packages/denoise-oidn/index.mjs')).href);
const oidnInstalled = existsSync(join(repository, 'packages/denoise-oidn/vendor'));
const denoise = requestedDenoise === 'oidn' && !oidnInstalled ? 'none' : requestedDenoise;
const input = decodePackFile(readFileSync(join(cookDirectory, 'fixtures', 'room.cookpack')));

async function rssAfterCollect() {
  await yieldToEventLoop();
  globalThis.gc();
  return process.memoryUsage().rss / 1048576;
}

async function measureFilm() {
  const session = cook.createNativeSession(input, { width: WIDTH, height: HEIGHT, samples: SAMPLES });
  const sequence = { trace: () => ({ traced: session.render({}), route: {}, kernelParams: undefined }) };
  const exported = { schemaVersion: 2, counts: {}, tables: {}, triangles: 0, ignored: [] };
  let denoiserUsed = 'none';
  const frame = async seed => {
    const { report } = await traceFrameNative({ tracer: cook, denoiser, sequence, exported, width: WIDTH, height: HEIGHT,
      samples: SAMPLES, bounces: 4, seed, denoise, kernel: 'cycles' });
    denoiserUsed = report.denoiser;
  };
  const checkpoints = [];
  for (let index = 1; index <= frameCount; index++) {
    await frame(index);
    if (index === Math.floor(frameCount / 2) || index === frameCount) checkpoints.push(await rssAfterCollect());
  }
  session.close();
  const secondHalfFrames = frameCount - Math.floor(frameCount / 2);
  return { denoiser: denoiserUsed, halfwayMB: Math.round(checkpoints[0]), endMB: Math.round(checkpoints[1]),
    secondHalfGrowthPerFrameMB: Number(((checkpoints[1] - checkpoints[0]) / secondHalfFrames).toFixed(4)) };
}

async function measureSessionCycles() {
  const closed = [];
  for (let cycle = 0; cycle < cycleCount; cycle++) {
    const session = cook.createNativeSession(input, { width: WIDTH, height: HEIGHT, samples: SAMPLES });
    for (let index = 0; index < 30; index++) {
      session.render({});
      await yieldToEventLoop();
    }
    session.close();
    closed.push(await rssAfterCollect());
  }
  // The first close settles the allocator, so growth is counted from the second.
  const growthPerCycle = (closed.at(-1) - closed[1]) / (closed.length - 2);
  return { closedMB: closed.map(Math.round), growthPerCycleMB: Number(growthPerCycle.toFixed(3)) };
}

const film = await measureFilm();
const cycles = await measureSessionCycles();
const failures = [];
if (film.secondHalfGrowthPerFrameMB > FRAME_GROWTH_LIMIT_MB) {
  failures.push(`the film grew ${film.secondHalfGrowthPerFrameMB} MB a frame over its second half (limit ${FRAME_GROWTH_LIMIT_MB}): check that the frame loop still yields to the event loop after each native frame`);
}
if (cycles.growthPerCycleMB > CYCLE_GROWTH_LIMIT_MB) {
  failures.push(`closed sessions grew ${cycles.growthPerCycleMB} MB a cycle (limit ${CYCLE_GROWTH_LIMIT_MB}): session.close() is not giving its memory back`);
}
console.log(`FRAME_MEMORY ${JSON.stringify({ width: WIDTH, height: HEIGHT, samples: SAMPLES, frames: frameCount, film, cycles, failures })}`);
if (failures.length) process.exit(1);
