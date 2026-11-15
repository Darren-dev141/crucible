// A closed room's walls, ceiling and props get the sky they see traced into their vertices, not only the floor (#1334): the raster used to give every surface the
// whole sky, so a sealed room came out as bright as a room with a window while a path tracer renders it black.
import test from 'node:test';
import assert from 'node:assert/strict';
import { box } from '../src/geometry.js';
import { applyDefaultFloorSky } from '../src/floor-sky-visibility.js';

const HALF_WIDTH = 4;
const FRONT = -3;
const BACK = 3.5;
const HEIGHT = 3;
const WALL = 0.2;

function slab(name, center, size) {
  const matrix = new Float32Array([size[0], 0, 0, 0, 0, size[1], 0, 0, 0, 0, size[2], 0, center[0], center[1], center[2], 1]);
  return { name, geometry: box(0, 1), matrix, material: { color: [0.7, 0.7, 0.7], metallic: 0, roughness: 0.9 } };
}

// The probe room of bench/reference/interior-exposure.mjs; with `window` the front wall has an opening, without it the room is sealed.
function room({ window }) {
  const depth = BACK - FRONT;
  const middleZ = (FRONT + BACK) / 2;
  const frontZ = FRONT - WALL / 2;
  const parts = [
    slab('floor', [0, -WALL / 2, middleZ], [HALF_WIDTH * 2 + WALL * 2, WALL, depth + WALL * 2]),
    slab('ceiling', [0, HEIGHT + WALL / 2, middleZ], [HALF_WIDTH * 2 + WALL * 2, WALL, depth + WALL * 2]),
    slab('wall-left', [-HALF_WIDTH - WALL / 2, HEIGHT / 2, middleZ], [WALL, HEIGHT, depth + WALL * 2]),
    slab('wall-right', [HALF_WIDTH + WALL / 2, HEIGHT / 2, middleZ], [WALL, HEIGHT, depth + WALL * 2]),
    slab('wall-back', [0, HEIGHT / 2, BACK + WALL / 2], [HALF_WIDTH * 2, HEIGHT, WALL]),
  ];
  if (!window) {
    parts.push(slab('wall-front', [0, HEIGHT / 2, frontZ], [HALF_WIDTH * 2, HEIGHT, WALL]));
    return parts;
  }
  const opening = { halfWidth: 1.4, bottom: 0.9, top: 2.4 };
  const side = HALF_WIDTH - opening.halfWidth;
  parts.push(
    slab('front-left', [-(opening.halfWidth + side / 2), HEIGHT / 2, frontZ], [side, HEIGHT, WALL]),
    slab('front-right', [opening.halfWidth + side / 2, HEIGHT / 2, frontZ], [side, HEIGHT, WALL]),
    slab('front-sill', [0, opening.bottom / 2, frontZ], [opening.halfWidth * 2, opening.bottom, WALL]),
    slab('front-head', [0, (opening.top + HEIGHT) / 2, frontZ], [opening.halfWidth * 2, HEIGHT - opening.top, WALL]),
  );
  return parts;
}


// The mean sky visibility of the vertices whose normal points along `normalAxis` in the direction `normalSign`.
function faceMean(part, normalAxis, normalSign) {
  const { skyVisibility, normals } = part.geometry;
  let sum = 0;
  let count = 0;
  for (let vertex = 0; vertex < skyVisibility.length; vertex++) {
    if (Math.round(normals[vertex * 3 + normalAxis]) !== normalSign) continue;
    sum += skyVisibility[vertex];
    count += 1;
  }
  return sum / count;
}

const SUN = { keyIntensity: 1 };

test('a sealed room hides the sky from the inside faces of its floor, ceiling and walls', () => {
  const { parts, report } = applyDefaultFloorSky(room({ window: false }), SUN, { maximumTexels: 4000 });
  assert.equal(report.reason, null);
  const insideFaces = [['floor', 1, 1], ['ceiling', 1, -1], ['wall-left', 0, 1], ['wall-right', 0, -1], ['wall-back', 2, -1]];
  for (const [name, axis, sign] of insideFaces) {
    const part = parts.find(candidate => candidate.name === name);
    assert.ok(part.geometry.skyVisibility, `${name} carries a sky visibility`);
    const share = faceMean(part, axis, sign);
    assert.ok(share < 0.1, `the inside of ${name} keeps ${share.toFixed(3)} of the sky`);
  }
});

test('the outside faces of a sealed room still see the whole sky', () => {
  const { parts } = applyDefaultFloorSky(room({ window: false }), SUN, { maximumTexels: 4000 });
  const ceiling = parts.find(part => part.name === 'ceiling');
  assert.ok(faceMean(ceiling, 1, 1) > 0.9, 'the roof is open to the sky');
});

test('a window lets the sky reach the wall that faces it more than the sealed room does', () => {
  const sealed = applyDefaultFloorSky(room({ window: false }), SUN, { maximumTexels: 4000 }).parts.find(part => part.name === 'wall-back');
  const windowed = applyDefaultFloorSky(room({ window: true }), SUN, { maximumTexels: 4000 }).parts.find(part => part.name === 'wall-back');
  const windowShare = faceMean(windowed, 2, -1);
  const sealedShare = faceMean(sealed, 2, -1);
  assert.ok(windowShare > sealedShare + 0.01, `window ${windowShare.toFixed(3)} against sealed ${sealedShare.toFixed(3)}`);
});

test('a scene with the trace switched off keeps its parts as they are', () => {
  const sealed = room({ window: false });
  assert.equal(applyDefaultFloorSky(sealed, { ...SUN, floorSkyTrace: false }).parts, sealed);
});
