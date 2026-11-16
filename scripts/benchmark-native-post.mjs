// Times the step from a traced film to an encoded PNG at 1080p, in the JavaScript path (toneMapToRgba8 then encodePng) and in the
// Cook post path (session.render({ post }).display then encodePng), and prints the largest per-channel difference between the two
// pictures (issue 1123). Needs the native addon and a GPU: run it through gpu-lock on a machine where nothing else uses the card.
//
//   node scripts/benchmark-native-post.mjs artifacts/1123/post-bench.json [width height samples runs]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { buildNativeInputV2, createNativeSession } from '@codepawlhq/cook';
import { mapLookToCookPost } from './native-post-look.mjs';
import { encodePng } from '../src/export-png.js';
import { encodeOpaquePng } from './native-png.mjs';
import { createCamera, toneMapToRgba8 } from '../src/path-tracer.js';

const [outputPath = 'artifacts/1123/post-bench.json', widthText = '1920', heightText = '1080', samplesText = '8', runsText = '7'] = process.argv.slice(2);
const WIDTH = Number(widthText);
const HEIGHT = Number(heightText);
const SAMPLES = Number(samplesText);
const RUNS = Number(runsText);

function quad(corners) {
  return {
    positions: new Float32Array(corners.flat()),
    normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
    colors: new Float32Array(12).fill(1),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

const ground = quad([[-6, 0, 6], [6, 0, 6], [6, 0, -6], [-6, 0, -6]]);
const panelLight = {
  positions: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
  uvs: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
  colors: new Float32Array(12).fill(1),
  indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
};
const scene = {
  materials: [{ color: [0.55, 0.5, 0.42], roughness: 0.7 }, { color: [1, 0.95, 0.9], emission: 12, roughness: 1 }],
  instances: [
    { geometry: ground, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], materialIndex: 0 },
    { geometry: panelLight, matrix: [2, 0, 0, 0, 0, 0, -2, 0, 0, 2, 0, 0, 1, 4, -1, 1], materialOverride: 1 },
  ],
};
const camera = createCamera({ eye: [0, 1.8, 6.5], target: [0, 0.2, 0], fov: 50 }, WIDTH, HEIGHT);
const imageOptions = { width: WIDTH, height: HEIGHT, samples: SAMPLES, bounces: 4, seed: 7 };
const session = createNativeSession(buildNativeInputV2(scene, camera, imageOptions), imageOptions);
const { post } = mapLookToCookPost({ viewTransform: 'aces', exposure: 1 });

function median(values) {
  return [...values].sort((first, second) => first - second)[Math.floor(values.length / 2)];
}

function largestChannelDifference(first, second) {
  let largest = 0;
  for (let index = 0; index < first.length; index++) {
    if (index % 4 !== 3) largest = Math.max(largest, Math.abs(first[index] - second[index]));
  }
  return largest;
}

function rgbOnly(rgba) {
  const linear = new Float32Array(WIDTH * HEIGHT * 3);
  for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel++) {
    linear.set(rgba.subarray(pixel * 4, pixel * 4 + 3), pixel * 3);
  }
  return linear;
}

// A first frame compiles the kernel and warms the card, so no timed run pays for either.
session.render({ samples: 1 });
const javascriptSeconds = [];
const postSeconds = [];
const traceSeconds = [];
let largestDifference = 0;
for (let run = 0; run < RUNS; run++) {
  const traced = session.render({ samples: SAMPLES, post });
  traceSeconds.push(traced.tracedSeconds);
  const javascriptStarted = performance.now();
  const javascriptBytes = toneMapToRgba8(rgbOnly(traced.rgba), WIDTH, HEIGHT);
  encodePng(javascriptBytes, WIDTH, HEIGHT);
  javascriptSeconds.push((performance.now() - javascriptStarted) / 1000);
  const postStarted = performance.now();
  encodeOpaquePng(traced.display, WIDTH, HEIGHT);
  // The post stage ran inside render, so its own time (postSeconds) joins the encode to give traced film to encoded file.
  postSeconds.push(traced.postSeconds + (performance.now() - postStarted) / 1000);
  largestDifference = Math.max(largestDifference, largestChannelDifference(javascriptBytes, traced.display));
}
const result = {
  width: WIDTH,
  height: HEIGHT,
  samples: SAMPLES,
  runs: RUNS,
  medianTraceSeconds: median(traceSeconds),
  medianJavascriptFilmToPngSeconds: median(javascriptSeconds),
  medianCookPostFilmToPngSeconds: median(postSeconds),
  javascriptFilmToPngSeconds: javascriptSeconds,
  cookPostFilmToPngSeconds: postSeconds,
  largestChannelDifference: largestDifference,
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(result));
session.close();
