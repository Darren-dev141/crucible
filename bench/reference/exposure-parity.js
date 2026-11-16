// Runs in the page: draws one grey card, three coloured cards and a floor under a sky gradient and one point light, with
// the rasterizer and with three.js, and returns the pixels of both (issue #1178). The scene is plain: the same material
// numbers, the same HDRI, the same candela, exposure 1 and an ACES curve on both sides.
import {
  ACESFilmicToneMapping, Color, DataTexture, EquirectangularReflectionMapping, FloatType, Mesh, MeshStandardMaterial, BoxGeometry,
  PerspectiveCamera, PMREMGenerator, PointLight, RGBAFormat, Scene, ShaderChunk, SRGBColorSpace, WebGLRenderer, LinearFilter,
} from 'three';
import { CrucibleRenderer } from '/src/renderer.js';
import { createEnvironmentMap } from '/src/hdri.js';
import { box } from '/src/geometry.js';
import { readPunctualLights } from '/src/gltf-lights.js';

const SIZE = 512;
const SKY_WIDTH = 64;
const SKY_HEIGHT = 32;
const SKY_ZENITH = [0.5, 0.8, 1.4];
const SKY_HORIZON = [1.6, 1.5, 1.3];
const SKY_GROUND = [0.25, 0.22, 0.2];
const LIGHT_POSITION = [0, 3, 0];
const LIGHT_CANDELA = 8;
const CAMERA_HEIGHT = 8;
const CAMERA_FOV_DEGREES = 40;
// The floor and four cards: name, x, z, albedo. The first card is the grey card, the next three carry colour.
const CARDS = [
  { name: 'grey-card', x: -1.2, z: -1.2, color: [0.18, 0.18, 0.18] },
  { name: 'red', x: 1.2, z: -1.2, color: [0.8, 0.1, 0.1] },
  { name: 'green', x: -1.2, z: 1.2, color: [0.1, 0.6, 0.1] },
  { name: 'blue', x: 1.2, z: 1.2, color: [0.1, 0.2, 0.8] },
];
const FLOOR_COLOR = [0.5, 0.5, 0.5];

function skyPixels() {
  const data = new Float32Array(SKY_WIDTH * SKY_HEIGHT * 4);
  for (let row = 0; row < SKY_HEIGHT; row++) {
    const elevation = 1 - 2 * (row + 0.5) / SKY_HEIGHT;
    const above = Math.max(elevation, 0);
    const below = Math.max(-elevation, 0);
    for (let column = 0; column < SKY_WIDTH; column++) {
      for (let channel = 0; channel < 3; channel++) {
        const sky = SKY_HORIZON[channel] + (SKY_ZENITH[channel] - SKY_HORIZON[channel]) * above;
        data[(row * SKY_WIDTH + column) * 4 + channel] = elevation >= 0 ? sky : SKY_HORIZON[channel] + (SKY_GROUND[channel] - SKY_HORIZON[channel]) * Math.min(below * 3, 1);
      }
      data[(row * SKY_WIDTH + column) * 4 + 3] = 1;
    }
  }
  return data;
}

// A three.js DataTexture starts at its bottom row, the rasterizer's equirectangular map at the top row.
function topRowLast(data) {
  const rowLength = SKY_WIDTH * 4;
  const flipped = new Float32Array(data.length);
  for (let row = 0; row < SKY_HEIGHT; row++) flipped.set(data.subarray(row * rowLength, (row + 1) * rowLength), (SKY_HEIGHT - 1 - row) * rowLength);
  return flipped;
}

function placement(x, y, z, scaleX, scaleY, scaleZ) {
  return [scaleX, 0, 0, 0, 0, scaleY, 0, 0, 0, 0, scaleZ, 0, x, y, z, 1];
}

function sceneObjects() {
  const objects = [{ name: 'floor', x: 0, y: -0.05, z: 0, size: [10, 0.1, 10], color: FLOOR_COLOR }];
  for (const card of CARDS) objects.push({ name: card.name, x: card.x, y: 0.01, z: card.z, size: [1.6, 0.02, 1.6], color: card.color });
  return objects;
}

// Pixel of the top of a card for a camera straight above the origin that looks down with up = -z.
function cardPixel(x, z) {
  const scale = (SIZE / 2) / (CAMERA_HEIGHT * Math.tan(CAMERA_FOV_DEGREES / 2 * Math.PI / 180));
  return [Math.round(SIZE / 2 + x * scale), Math.round(SIZE / 2 + z * scale)];
}

function samplePoints() {
  return [{ name: 'floor', x: 0, z: 0 }, ...CARDS].map(point => ({ name: point.name, pixel: cardPixel(point.x, point.z) }));
}

function readRgba(canvas, gl) {
  const pixels = new Uint8Array(SIZE * SIZE * 4);
  gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  return { pixels, canvas };
}

function summarize(pixels, flipRows) {
  const read = (column, row) => {
    const sourceRow = flipRows ? SIZE - 1 - row : row;
    const offset = (sourceRow * SIZE + column) * 4;
    return [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
  };
  const samples = {};
  for (const point of samplePoints()) {
    const total = [0, 0, 0];
    const half = 6;
    for (let dy = -half; dy <= half; dy++) for (let dx = -half; dx <= half; dx++) {
      const value = read(point.pixel[0] + dx, point.pixel[1] + dy);
      for (let channel = 0; channel < 3; channel++) total[channel] += value[channel];
    }
    samples[point.name] = total.map(value => Math.round(value / (2 * half + 1) ** 2));
  }
  let luma = 0;
  let saturation = 0;
  for (let index = 0; index < SIZE * SIZE; index++) {
    const red = pixels[index * 4];
    const green = pixels[index * 4 + 1];
    const blue = pixels[index * 4 + 2];
    luma += 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    const high = Math.max(red, green, blue);
    saturation += high === 0 ? 0 : (high - Math.min(red, green, blue)) / high * 255;
  }
  return { samples, meanLuma: luma / (SIZE * SIZE), meanSaturation: saturation / (SIZE * SIZE) };
}

function pngOf(canvas) {
  return canvas.toDataURL('image/png').split(',')[1];
}

function drawRaster(options) {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  document.body.append(canvas);
  const map = createEnvironmentMap({ width: SKY_WIDTH, height: SKY_HEIGHT, data: skyPixels(), intensity: 1, showBackground: true });
  const importedLights = readPunctualLights(
    { nodes: [{ extensions: { KHR_lights_punctual: { light: 0 } } }], extensions: { KHR_lights_punctual: { lights: [{ type: 'point', intensity: LIGHT_CANDELA }] } } },
    [{ nodeIndex: 0, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...LIGHT_POSITION, 1] }],
  ).lights;
  const pointLights = options.importer ? importedLights.pointLights.map(light => ({ ...light, radius: 0.05 })) : [{ position: LIGHT_POSITION, color: [1, 1, 1], intensity: LIGHT_CANDELA, range: 0, radius: 0.05 }];
  const environment = {
    world: true, fogDensity: 0, map, pointLights,
    ...(options.importer ? { keyIntensity: importedLights.keyIntensity, fillIntensity: importedLights.fillIntensity } : {}),
    ...options.environment,
  };
  const parts = sceneObjects().map(object => ({
    name: object.name, geometry: box(0, 1), matrix: placement(object.x, object.y, object.z, ...object.size),
    material: { tag: 'surface', emission: 0, color: object.color, metallic: 0, roughness: 0.5 },
  }));
  const renderer = new CrucibleRenderer(canvas, parts, { ground: false, hdr: false, depth: false, samples: 4, pixelRatio: 1, memoryBudgetMiB: 512, world: true, environment, viewTransform: options.viewTransform ?? 'aces' });
  renderer.resize();
  renderer.render({ eye: [0, CAMERA_HEIGHT, 0], target: [0, 0, 0], up: [0, 0, -1], fov: CAMERA_FOV_DEGREES, near: 0.1, far: 100, environment, time: 0, exposure: 1, effects: {} });
  const { pixels } = readRgba(canvas, renderer.context);
  const result = { ...summarize(pixels, true), png: pngOf(canvas) };
  renderer.dispose();
  canvas.remove();
  return result;
}

function drawThree({ narkowicz }) {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  document.body.append(canvas);
  if (narkowicz) {
    ShaderChunk.tonemapping_pars_fragment = ShaderChunk.tonemapping_pars_fragment.replace(
      /vec3 ACESFilmicToneMapping\( vec3 color \) \{/,
      'vec3 ACESFilmicToneMapping( vec3 color ) { return saturate( ( color * ( 2.51 * color + 0.03 ) ) / ( color * ( 2.43 * color + 0.59 ) + 0.14 ) );\n',
    );
  }
  const renderer = new WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(SIZE, SIZE, false);
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.outputColorSpace = SRGBColorSpace;
  const sky = new DataTexture(topRowLast(skyPixels()), SKY_WIDTH, SKY_HEIGHT, RGBAFormat, FloatType);
  sky.mapping = EquirectangularReflectionMapping;
  sky.magFilter = LinearFilter;
  sky.minFilter = LinearFilter;
  sky.needsUpdate = true;
  const generator = new PMREMGenerator(renderer);
  const scene = new Scene();
  scene.environment = generator.fromEquirectangular(sky).texture;
  scene.background = scene.environment;
  const light = new PointLight(0xffffff, LIGHT_CANDELA, 0, 2);
  light.position.set(...LIGHT_POSITION);
  scene.add(light);
  for (const object of sceneObjects()) {
    const mesh = new Mesh(new BoxGeometry(...object.size), new MeshStandardMaterial({ color: new Color().setRGB(...object.color), metalness: 0, roughness: 0.5 }));
    mesh.position.set(object.x, object.y, object.z);
    scene.add(mesh);
  }
  const camera = new PerspectiveCamera(CAMERA_FOV_DEGREES, 1, 0.1, 100);
  camera.position.set(0, CAMERA_HEIGHT, 0);
  camera.up.set(0, 0, -1);
  camera.lookAt(0, 0, 0);
  renderer.render(scene, camera);
  const gl = renderer.getContext();
  const { pixels } = readRgba(canvas, gl);
  const result = { ...summarize(pixels, true), png: pngOf(canvas) };
  renderer.dispose();
  canvas.remove();
  return result;
}

window.drawExposureParity = options => ({
  glaze: drawRaster(options),
  three: drawThree({ narkowicz: false }),
  threeNarkowicz: drawThree({ narkowicz: true }),
});
