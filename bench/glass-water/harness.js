import { CrucibleRenderer } from '/src/renderer.js';
import '/src/liquid-shader.js';
import { applyWaterReflection, attachWaterReflection } from '/src/water-reflection.js';
import { placeProbes, traceProbes } from '/src/reflection-probes.js';
import { pavilionParts, skyMap, CAMERA, GLASS_WALL } from './scene.js';

const query = new URLSearchParams(location.search);
const water = query.get('water') ?? 'plain';
const glass = query.get('glass') ?? 'transmission';
const mirror = query.get('mirror') === '1';
// probe=1 traces a reflection probe in front of the glass wall (a radius that reaches only the wall) and places it on the wall.
const probe = query.get('probe') === '1';

const environmentMap = skyMap();
const baseParts = pavilionParts({ water, glass });
const reflecting = mirror ? applyWaterReflection(baseParts) : { parts: baseParts, surface: null, report: null };
let parts = reflecting.parts;
let probeReport = null;
if (probe) {
  const lighting = { keyColor: [0, 0, 0] };
  const trace = traceProbes(parts, lighting, [{ position: [GLASS_WALL.probeX, 1.5, 1], radius: 1 }], { environmentMap });
  const placed = placeProbes(parts, trace);
  parts = placed.parts;
  probeReport = placed.report;
}
const renderer = new CrucibleRenderer(document.querySelector('canvas'), parts, {
  ground: false, hdr: true, samples: 4, pixelRatio: 1, memoryBudgetMiB: 512,
  environment: { map: environmentMap },
});
attachWaterReflection(renderer, reflecting.surface, { updateEvery: 1 });
for (let frame = 0; frame < 3; frame++) renderer.render({ exposure: 1, ...CAMERA });

// The glass wall's footprint on screen, shrunk a little so its edges stay out of the mean: [left, top, right, bottom] in pixels.
function wallRegion() {
  const matrix = renderer.viewProjection;
  const width = renderer.canvas.width;
  const height = renderer.canvas.height;
  const xs = [];
  const ys = [];
  for (const y of [GLASS_WALL.bottom, GLASS_WALL.top]) {
    for (const z of [GLASS_WALL.near, GLASS_WALL.far]) {
      const clip = [0, 1, 2, 3].map(row => matrix[row] * GLASS_WALL.x + matrix[4 + row] * y + matrix[8 + row] * z + matrix[12 + row]);
      xs.push((clip[0] / clip[3] * 0.5 + 0.5) * width);
      ys.push((1 - (clip[1] / clip[3] * 0.5 + 0.5)) * height);
    }
  }
  const [left, right] = [Math.min(...xs), Math.max(...xs)];
  const [top, bottom] = [Math.min(...ys), Math.max(...ys)];
  const insetX = (right - left) * 0.1;
  const insetY = (bottom - top) * 0.1;
  return [left + insetX, top + insetY, right - insetX, bottom - insetY].map(Math.round);
}

window.__done = { mirrorReport: reflecting.report, probeReport, wallRegion: wallRegion(), glError: renderer.context.getError() };
