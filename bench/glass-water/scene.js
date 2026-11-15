import { box } from '/src/geometry.js';
import { createEnvironmentMap } from '/src/environment.js';

// A small deterministic pavilion: a pool, a glass wall and a wall to reflect, under a procedural sky (issue #1178).
// The materials are what a glTF import produces for the Barcelona Pavilion's water and glass.
export const WATER_VARIANTS = {
  plain: { color: [0.02, 0.06, 0.08], roughness: 0.05 },
  transmissive: { color: [0.55, 0.8, 0.85], roughness: 0.05, transmission: 0.9, ior: 1.33, thickness: 0.5 },
};
export const GLASS_VARIANTS = {
  transmission: { color: [0.75, 0.95, 0.85], roughness: 0.02, transmission: 1, ior: 1.5, thickness: 0.02 },
  blend: { color: [0.55, 0.75, 0.65], roughness: 0.02, alphaMode: 'blend', opacity: 0.3 },
};

function placed(name, translation, scale, material) {
  const matrix = new Float32Array([scale[0], 0, 0, 0, 0, scale[1], 0, 0, 0, 0, scale[2], 0, translation[0], translation[1], translation[2], 1]);
  return { name, geometry: box(0, 1), matrix, material: { tag: 'surface', metallic: 0, emission: 0, ...material } };
}

export function pavilionParts({ water = 'plain', glass = 'transmission' } = {}) {
  return [
    placed('ground', [0, -0.5, 0], [60, 1, 60], { color: [0.45, 0.42, 0.38], roughness: 0.85 }),
    placed('pool', [0, 0.01, 0], [8, 0.1, 4], { ...WATER_VARIANTS[water] }),
    placed('onyx wall', [0, 2, -6], [12, 4, 0.4], { color: [0.8, 0.45, 0.08], roughness: 0.4 }),
    placed('glass wall', [5, 1.5, 1], [0.04, 3, 8], { ...GLASS_VARIANTS[glass] }),
    placed('far wall', [8, 1.5, 1], [0.4, 3, 10], { color: [0.12, 0.2, 0.12], roughness: 0.6 }),
  ];
}

export function skyMap() {
  const width = 256;
  const height = 128;
  const data = new Float32Array(width * height * 3);
  for (let row = 0; row < height; row++) {
    const polar = ((row + 0.5) / height) * Math.PI;
    for (let column = 0; column < width; column++) {
      const azimuth = ((column + 0.5) / width - 0.5) * Math.PI * 2;
      const direction = [Math.sin(polar) * Math.sin(azimuth), Math.cos(polar), -Math.sin(polar) * Math.cos(azimuth)];
      const up = Math.max(direction[1], 0);
      const sun = Math.pow(Math.max(direction[0] * 0.5 + direction[1] * 0.7 + direction[2] * 0.5, 0), 400) * 60;
      const offset = (row * width + column) * 3;
      data[offset] = (0.9 - up * 0.55) * 0.6 + sun;
      data[offset + 1] = (1.0 - up * 0.4) * 0.6 + sun;
      data[offset + 2] = (1.2 - up * 0.1) * 0.6 + sun * 0.9;
      if (direction[1] < 0) {
        data[offset] = 0.25;
        data[offset + 1] = 0.23;
        data[offset + 2] = 0.2;
      }
    }
  }
  return createEnvironmentMap({ width, height, data, showBackground: true });
}

export const CAMERA = { eye: [-2, 1.7, 11], target: [1.5, 0.4, 0], fov: 45 };
