import { CrucibleRenderer } from '/src/renderer.js';
import '/src/liquid-shader.js';
import { applyWaterReflection, attachWaterReflection } from '/src/water-reflection.js';
import { pavilionParts, skyMap, CAMERA } from './scene.js';

const query = new URLSearchParams(location.search);
const water = query.get('water') ?? 'plain';
const glass = query.get('glass') ?? 'transmission';
const mirror = query.get('mirror') === '1';

const baseParts = pavilionParts({ water, glass });
const reflecting = mirror ? applyWaterReflection(baseParts) : { parts: baseParts, surface: null, report: null };
const renderer = new CrucibleRenderer(document.querySelector('canvas'), reflecting.parts, {
  ground: false, hdr: true, samples: 4, pixelRatio: 1, memoryBudgetMiB: 512,
  environment: { map: skyMap() },
});
attachWaterReflection(renderer, reflecting.surface, { updateEvery: 1 });
for (let frame = 0; frame < 3; frame++) renderer.render({ exposure: 1, ...CAMERA });
window.__done = { mirrorReport: reflecting.report, glError: renderer.context.getError() };
