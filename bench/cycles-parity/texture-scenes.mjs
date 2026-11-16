// Textured scenes for the sampler checks of #896, exported in the same JSON as `export-scene.mjs`, so `trace-native.mjs`,
// `render-cycles.py` and `run-m1-parity.py` take them like any parity scene.
//   node bench/cycles-parity/texture-scenes.mjs <outputDirectory>
//
// tex-repeat   a repeating sRGB colour map and an alpha-masked map, wrap mode and filter at Cycles' defaults, so Cycles can
//              render it as the reference.
// tex-wraps    clamp, mirror and nearest maps, a blended alpha map and a normal map. The Cycles bridge reads the colour map
//              only, so this one is for byte comparisons between two builds of Cook, not for scoring.
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { serializeSceneDescription } from './scene-bridge.mjs';

const TEXTURE_SIZE = 16;
const LIGHT_LEVEL = 0.05;

function quadGeometry(uvRepeat) {
  return {
    positions: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 0, uvRepeat, 0, uvRepeat, uvRepeat, 0, uvRepeat]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

function placedMatrix(translation, scale) {
  return new Float32Array([scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, translation[0], translation[1], translation[2], 1]);
}

function part(name, geometry, translation, scale, material) {
  return { name, geometry, matrix: placedMatrix(translation, scale), material: { tag: 'surface', metallic: 0, roughness: 0.6, emission: 0, ...material } };
}

// A gradient with a checker, so that wrap, filter and colour space each leave a visible mark.
function gradientChecker(withAlphaGradient) {
  const data = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
  for (let y = 0; y < TEXTURE_SIZE; y++) {
    for (let x = 0; x < TEXTURE_SIZE; x++) {
      const offset = (y * TEXTURE_SIZE + x) * 4;
      const checker = ((x >> 2) + (y >> 2)) & 1;
      data[offset] = checker ? 230 : 40 + x * 8;
      data[offset + 1] = checker ? 200 : 40 + y * 8;
      data[offset + 2] = checker ? 60 : 200 - x * 6;
      data[offset + 3] = withAlphaGradient ? Math.round(255 * (x + 0.5) / TEXTURE_SIZE) : 255;
    }
  }
  return { width: TEXTURE_SIZE, height: TEXTURE_SIZE, data };
}

function bumpyNormalMap() {
  const data = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
  for (let y = 0; y < TEXTURE_SIZE; y++) {
    for (let x = 0; x < TEXTURE_SIZE; x++) {
      const offset = (y * TEXTURE_SIZE + x) * 4;
      const tilt = Math.sin(x * 0.8) * Math.cos(y * 0.8) * 0.5;
      data[offset] = Math.round((tilt * 0.5 + 0.5) * 255);
      data[offset + 1] = Math.round((-tilt * 0.5 + 0.5) * 255);
      data[offset + 2] = 255;
      data[offset + 3] = 255;
    }
  }
  return { width: TEXTURE_SIZE, height: TEXTURE_SIZE, data };
}

function environment() {
  const pointLights = [
    { position: [0, 2.5, 4], color: [1, 0.95, 0.85], intensity: 30, radius: 0.1, castShadow: true },
    { position: [-3, 0.5, 3], color: [0.6, 0.7, 1], intensity: 10, radius: 0.1, castShadow: true },
  ];
  return {
    world: true, fillIntensity: 0, ambientIntensity: 1, fogDensity: 0, lightDirection: [-3, 6, 4], keyColor: [0, 0, 0],
    pointLights, spotLights: [], areaLights: [],
  };
}

function sceneWithParts(parts) {
  return {
    parts,
    blenderWorld: { type: 'constant', value: LIGHT_LEVEL },
    environment: environment(),
    camera: { eye: [0, 0, 8], target: [0, 0, 0], up: [0, 1, 0], fov: 40, near: 0.1, far: 50 },
  };
}

function backdrop() {
  return part('backdrop', quadGeometry(1), [0, 0, -1.5], [7, 4, 1], { color: [0.55, 0.12, 0.1], roughness: 0.9 });
}

function textureRepeatScene(maskColorSpace = 'srgb') {
  const colourMap = { image: gradientChecker(false), colorSpace: 'srgb' };
  const maskMap = { image: gradientChecker(true), colorSpace: maskColorSpace };
  return sceneWithParts([
    backdrop(),
    part('colour', quadGeometry(3), [-2.2, 0, 0], [1.9, 1.9, 1], { color: [1, 1, 1], map: colourMap }),
    part('mask', quadGeometry(3), [2.2, 0, 0], [1.9, 1.9, 1], { color: [0.9, 0.95, 0.9], alphaMode: 'mask', alphaCutoff: 0.5, map: maskMap }),
  ]);
}

// Where does the brightness gap of tex-repeat against Cycles come from? The same room with the textured quads dropped, with
// each one alone, and with both as flat untextured quads of their average colour.
function textureSplitScene(include) {
  const colourMap = { image: gradientChecker(false), colorSpace: 'srgb' };
  const maskMap = { image: gradientChecker(true), colorSpace: 'srgb' };
  const parts = [backdrop()];
  if (include === 'colour' || include === 'both') {
    parts.push(part('colour', quadGeometry(3), [-2.2, 0, 0], [1.9, 1.9, 1], { color: [1, 1, 1], map: colourMap }));
  }
  if (include === 'mask' || include === 'both') {
    parts.push(part('mask', quadGeometry(3), [2.2, 0, 0], [1.9, 1.9, 1], { color: [0.9, 0.95, 0.9], alphaMode: 'mask', alphaCutoff: 0.5, map: maskMap }));
  }
  if (include === 'flat') {
    parts.push(part('flat-left', quadGeometry(1), [-2.2, 0, 0], [1.9, 1.9, 1], { color: [0.35, 0.3, 0.2] }));
    parts.push(part('flat-right', quadGeometry(1), [2.2, 0, 0], [1.9, 1.9, 1], { color: [0.35, 0.3, 0.2] }));
  }
  return sceneWithParts(parts);
}

// An emissive quad seen head on with no light in the room, so a pixel is the texture itself and the mean of the picture is
// known in closed form from the texels. Cook and Cycles differ here only in how they read a
// texture. One frame covers 10 degrees of a 3 x 3 repeat of the quad.
function emissiveProbeScene(colorSpace) {
  const emissiveMap = { image: gradientChecker(false), colorSpace };
  return {
    parts: [part('emitter', quadGeometry(3), [0, 0, 0], [1, 1, 1], { color: [0, 0, 0], emission: 1, emissiveColor: [1, 1, 1], emissiveMap })],
    blenderWorld: { type: 'constant', value: 0 },
    environment: { ...environment(), pointLights: [] },
    camera: { eye: [0, 0, 8], target: [0, 0, 0], up: [0, 1, 0], fov: 10, near: 0.1, far: 50 },
  };
}

// A high-contrast two-tone sRGB checker, one texel per square.
function contrastChecker() {
  const size = 4;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4;
      const bright = (x + y) & 1;
      data[offset] = bright ? 235 : 25;
      data[offset + 1] = bright ? 180 : 40;
      data[offset + 2] = bright ? 60 : 120;
      data[offset + 3] = 255;
    }
  }
  return { width: size, height: size, data };
}

// A textured emitter that lights a diffuse floor. The floor only sees the emitter through light sampling and through bounce rays
// that happen to hit it, so a mean colour used as the radiance of a light sample (instead of the map read at the sampled
// point) shows as a floor brighter under light sampling alone than under bounce rays alone (#1030).
function emissiveFloorScene(colorSpace) {
  const emissiveMap = { image: contrastChecker(), colorSpace };
  const floorMatrix = new Float32Array([1.5, 0, 0, 0, 0, 0, -1.4, 0, 0, 1, 0, 0, 0, -1, 1.6, 1]);
  const floor = {
    name: 'floor',
    geometry: quadGeometry(1),
    matrix: floorMatrix,
    material: { tag: 'surface', metallic: 0, roughness: 0.9, emission: 0, color: [0.6, 0.6, 0.6] },
  };
  return {
    parts: [part('emitter', quadGeometry(4), [0, 0.2, 0], [1, 1, 1], { color: [0, 0, 0], emission: 4, emissiveColor: [1, 1, 1], emissiveMap }), floor],
    blenderWorld: { type: 'constant', value: 0 },
    environment: { ...environment(), pointLights: [] },
    camera: { eye: [0, 2.2, 5], target: [0, -0.6, 1], up: [0, 1, 0], fov: 45, near: 0.1, far: 50 },
  };
}

// The mask quad of tex-repeat without the backdrop that receives its shadow, and with an opaque map under the same mask material.
// Cook over Cycles on these two says whether a gap on the mask quad sits on the quad, in its shadow or in the cutout itself.
function maskDiagnosticScene(variant) {
  const mapImage = variant === 'opaque' ? gradientChecker(false) : gradientChecker(true);
  const maskMap = { image: mapImage, colorSpace: 'srgb' };
  const maskQuad = part('mask', quadGeometry(3), [2.2, 0, 0], [1.9, 1.9, 1], { color: [0.9, 0.95, 0.9], alphaMode: 'mask', alphaCutoff: 0.5, map: maskMap });
  return sceneWithParts(variant === 'alone' ? [maskQuad] : [backdrop(), maskQuad]);
}

function textureWrapsScene() {
  const wrapped = (extra) => ({ image: gradientChecker(false), colorSpace: 'srgb', uvScale: [2.5, 2.5], uvOffset: [0.15, -0.1], ...extra });
  const alpha = (extra) => ({ image: gradientChecker(true), colorSpace: 'srgb', uvScale: [2.5, 2.5], ...extra });
  const columnSpacing = 1.55;
  const place = (index, row) => [(index - 2) * columnSpacing, row, 0];
  const size = [0.68, 0.68, 1];
  const top = 1.5;
  const bottom = -0.2;
  return sceneWithParts([
    backdrop(),
    part('clamp', quadGeometry(1), place(0, top), size, { color: [1, 1, 1], map: wrapped({ wrapU: 1, wrapV: 1 }) }),
    part('mirror', quadGeometry(1), place(1, top), size, { color: [1, 1, 1], map: wrapped({ wrapU: 2, wrapV: 2 }) }),
    part('repeat-nearest', quadGeometry(1), place(2, top), size, { color: [1, 1, 1], map: wrapped({ nearest: true }) }),
    part('mirror-nearest', quadGeometry(1), place(3, top), size, { color: [1, 1, 1], map: wrapped({ wrapU: 2, wrapV: 2, nearest: true }) }),
    part('linear-colour', quadGeometry(1), place(4, top), size, { color: [1, 1, 1], map: wrapped({ colorSpace: 'linear' }) }),
    part('mask-mirror', quadGeometry(1), place(0, bottom), size, { color: [0.9, 1, 0.9], alphaMode: 'mask', alphaCutoff: 0.5, map: alpha({ wrapU: 2, wrapV: 2 }) }),
    part('mask-clamp', quadGeometry(1), place(1, bottom), size, { color: [0.9, 1, 0.9], alphaMode: 'mask', alphaCutoff: 0.5, map: alpha({ wrapU: 1, wrapV: 1 }) }),
    part('mask-nearest', quadGeometry(1), place(2, bottom), size, { color: [0.9, 1, 0.9], alphaMode: 'mask', alphaCutoff: 0.5, map: alpha({ nearest: true }) }),
    part('blend-repeat', quadGeometry(1), place(3, bottom), size, { color: [0.9, 0.9, 1], alphaMode: 'blend', opacity: 0.9, map: alpha({}) }),
    part('normal-map', quadGeometry(1), place(4, bottom), size, { color: [0.7, 0.7, 0.75], roughness: 0.3, normalMap: { image: bumpyNormalMap(), colorSpace: 'linear', uvScale: [2, 2] } }),
  ]);
}

const NORMAL_MAP_SIZE = 64;

// A tangent-space normal map as 8-bit texels. 'bumpy' tilts the normal by the slope of a smooth egg-box height field; 'tilt-r' and
// 'tilt-g' tilt every texel 30 degrees along the map's red or green axis, so the tangent and the bitangent can be told apart.
function normalMapTexels(kind) {
  const data = new Uint8Array(NORMAL_MAP_SIZE * NORMAL_MAP_SIZE * 4);
  for (let y = 0; y < NORMAL_MAP_SIZE; y++) {
    for (let x = 0; x < NORMAL_MAP_SIZE; x++) {
      const offset = (y * NORMAL_MAP_SIZE + x) * 4;
      let tiltX = 0;
      let tiltY = 0;
      if (kind === 'bumpy') {
        const phaseX = (x + 0.5) / NORMAL_MAP_SIZE * 2 * Math.PI * 2;
        const phaseY = (y + 0.5) / NORMAL_MAP_SIZE * 2 * Math.PI * 2;
        tiltX = 0.6 * Math.cos(phaseX) * Math.sin(phaseY);
        tiltY = 0.6 * Math.sin(phaseX) * Math.cos(phaseY);
      } else if (kind === 'tilt-r') {
        tiltX = 0.5;
      } else if (kind === 'tilt-g') {
        tiltY = 0.5;
      }
      const length = Math.hypot(tiltX, tiltY, 1);
      data[offset] = Math.round((tiltX / length * 0.5 + 0.5) * 255);
      data[offset + 1] = Math.round((tiltY / length * 0.5 + 0.5) * 255);
      data[offset + 2] = Math.round((1 / length * 0.5 + 0.5) * 255);
      data[offset + 3] = 255;
    }
  }
  return { width: NORMAL_MAP_SIZE, height: NORMAL_MAP_SIZE, data };
}

// A UV sphere of radius one with smooth normals; u runs around the axis and v from the top pole down. The UVs repeat the map
// `repeatU` by `repeatV` times, so the texels are not stretched into one big patch.
function uvSphereGeometry(segments, rings, repeatU, repeatV) {
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  for (let ring = 0; ring <= rings; ring++) {
    const polar = Math.PI * ring / rings;
    for (let segment = 0; segment <= segments; segment++) {
      const azimuth = 2 * Math.PI * segment / segments;
      const x = Math.sin(polar) * Math.cos(azimuth);
      const y = Math.cos(polar);
      const z = Math.sin(polar) * Math.sin(azimuth);
      positions.push(x, y, z);
      normals.push(x, y, z);
      uvs.push(repeatU * segment / segments, repeatV * ring / rings);
    }
  }
  const stride = segments + 1;
  for (let ring = 0; ring < rings; ring++) {
    for (let segment = 0; segment < segments; segment++) {
      const first = ring * stride + segment;
      const second = first + stride;
      if (ring > 0) {
        indices.push(first, first + 1, second);
      }
      if (ring < rings - 1) {
        indices.push(first + 1, second + 1, second);
      }
    }
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(uvs), indices: new Uint32Array(indices) };
}

// One normal-mapped plane or sphere in front of a dark backdrop-free world, lit by the two point lights of `environment()` (#1111).
// Both the plane and the sphere repeat the map, and Cycles' Normal Map node reads the same texels (render-cycles.py flips green).
function normalMapScene(shape, mapKind, segments = 48, variant = {}) {
  const normalMap = { image: normalMapTexels(mapKind), colorSpace: 'linear' };
  const material = { color: [0.7, 0.7, 0.7], roughness: 0.6, ...(mapKind === 'none' ? {} : { normalMap }), ...variant.material };
  const geometry = shape === 'sphere' ? uvSphereGeometry(segments, segments / 2, 6, 3) : quadGeometry(4);
  const size = shape === 'sphere' ? [1.5, 1.5, 1.5] : [1.8, 1.8, 1];
  const parts = [part(shape, geometry, [0, 0, 0], size, material)];
  if (variant.sharedCopy) {
    // A second part on the same geometry, far out of frame, so `--instancing` keeps both as instances of one mesh.
    parts.push(part(`${shape}-copy`, geometry, [60, 0, -20], size, material));
  }
  return {
    parts,
    blenderWorld: { type: 'constant', value: variant.noAmbient ? 0 : LIGHT_LEVEL },
    environment: { ...environment(), ...(variant.oneLight ? { pointLights: environment().pointLights.slice(0, 1) } : {}), ...(variant.noAmbient ? { ambientIntensity: 0 } : {}) },
    camera: { eye: [0, 0, 6], target: [0, 0, 0], up: [0, 1, 0], fov: 40, near: 0.1, far: 50 },
  };
}

const DIFFUSE_ONLY = { material: { specular: 0, roughness: 1 } };

export const TEXTURE_SCENES = {
  'normal-plane-shared': () => normalMapScene('plane', 'bumpy', 48, { sharedCopy: true }),
  'normal-plane-tilt-r-shared': () => normalMapScene('plane', 'tilt-r', 48, { sharedCopy: true }),
  'normal-sphere-shared': () => normalMapScene('sphere', 'bumpy', 48, { sharedCopy: true }),
  'normal-plane-flat': () => normalMapScene('plane', 'none'),
  'normal-plane-tilt-r-diffuse': () => normalMapScene('plane', 'tilt-r', 48, DIFFUSE_ONLY),
  'normal-plane-tilt-r-diffuse-one': () => normalMapScene('plane', 'tilt-r', 48, { ...DIFFUSE_ONLY, oneLight: true }),
  'normal-plane-tilt-r-one': () => normalMapScene('plane', 'tilt-r', 48, { oneLight: true }),
  'normal-plane': () => normalMapScene('plane', 'bumpy'),
  'normal-sphere': () => normalMapScene('sphere', 'bumpy'),
  'normal-sphere-coarse': () => normalMapScene('sphere', 'bumpy', 16),
  'normal-sphere-fine': () => normalMapScene('sphere', 'bumpy', 96),
  'normal-sphere-flat': () => normalMapScene('sphere', 'none'),
  'normal-sphere-tilt-r-fine': () => normalMapScene('sphere', 'tilt-r', 96),
  'normal-sphere-tilt-r-diffuse': () => normalMapScene('sphere', 'tilt-r', 48, DIFFUSE_ONLY),
  'normal-sphere-tilt-r-diffuse-one': () => normalMapScene('sphere', 'tilt-r', 48, { ...DIFFUSE_ONLY, oneLight: true }),
  'normal-sphere-tilt-r-one': () => normalMapScene('sphere', 'tilt-r', 48, { oneLight: true }),
  'normal-sphere-tilt-r-diffuse-one-dark': () => normalMapScene('sphere', 'tilt-r', 48, { ...DIFFUSE_ONLY, oneLight: true, noAmbient: true }),
  'normal-sphere-flat-diffuse-one-dark': () => normalMapScene('sphere', 'none', 48, { ...DIFFUSE_ONLY, oneLight: true, noAmbient: true }),
  'normal-plane-tilt-r': () => normalMapScene('plane', 'tilt-r'),
  'normal-plane-tilt-g': () => normalMapScene('plane', 'tilt-g'),
  'normal-sphere-tilt-r': () => normalMapScene('sphere', 'tilt-r'),
  'normal-sphere-tilt-g': () => normalMapScene('sphere', 'tilt-g'),
  'tex-repeat': () => textureRepeatScene('srgb'),
  'tex-repeat-linear': () => textureRepeatScene('linear'),
  'tex-wraps': textureWrapsScene,
  'tex-emit-srgb': () => emissiveProbeScene('srgb'),
  'tex-emit-linear': () => emissiveProbeScene('linear'),
  'tex-emit-floor': () => emissiveFloorScene('srgb'),
  'tex-mask-alone': () => maskDiagnosticScene('alone'),
  'tex-mask-opaque-map': () => maskDiagnosticScene('opaque'),
  'tex-split-room': () => textureSplitScene('none'),
  'tex-split-colour': () => textureSplitScene('colour'),
  'tex-split-mask': () => textureSplitScene('mask'),
  'tex-split-flat': () => textureSplitScene('flat'),
};

async function writeScenes(outputDirectory) {
  const scenesDirectory = join(outputDirectory, 'scenes');
  await mkdir(scenesDirectory, { recursive: true });
  for (const [sceneId, build] of Object.entries(TEXTURE_SCENES)) {
    const description = await serializeSceneDescription(sceneId, build());
    await writeFile(join(scenesDirectory, `${sceneId}.json`), JSON.stringify(description));
    console.log(JSON.stringify({ sceneId, parts: description.parts.length, images: description.images.length }));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  if (!process.argv[2]) {
    throw new RangeError('Usage: node bench/cycles-parity/texture-scenes.mjs <outputDirectory>');
  }
  await writeScenes(resolve(process.argv[2]));
}
