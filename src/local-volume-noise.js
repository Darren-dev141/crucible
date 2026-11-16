// The value noise the rasterizer's post shader draws local volumes with (localVolumeNoise in fog-shader.js), written for the CPU path
// tracer so both renderers read one field. The hash uses only multiplies, adds and fract, and every step is rounded to a 32-bit float
// as the shader's is, so the two agree to a few float32 steps (a sine hash would not: a GPU's sine is not specified bit for bit).

const round = Math.fround;

const fract = value => round(value - Math.floor(value));

function latticeHash(x, y, z) {
  let scrambledX = fract(round(x * round(0.1031)));
  let scrambledY = fract(round(y * round(0.1031)));
  let scrambledZ = fract(round(z * round(0.1031)));
  const offset = round(31.32);
  const spread = round(round(round(scrambledX * round(scrambledZ + offset)) + round(scrambledY * round(scrambledY + offset))) + round(scrambledZ * round(scrambledX + offset)));
  scrambledX = round(scrambledX + spread);
  scrambledY = round(scrambledY + spread);
  scrambledZ = round(scrambledZ + spread);
  return fract(round(round(scrambledX + scrambledY) * scrambledZ));
}

function smooth(fraction) {
  return round(round(fraction * fraction) * round(3 - round(2 * fraction)));
}

function mix(first, second, amount) {
  return round(round(first * round(1 - amount)) + round(second * amount));
}

/** The shader's cloudNoise at a point, 0 to 1 with a mean near 0.5. */
export function localVolumeNoise(x, y, z) {
  const positionX = round(x);
  const positionY = round(y);
  const positionZ = round(z);
  const cellX = Math.floor(positionX);
  const cellY = Math.floor(positionY);
  const cellZ = Math.floor(positionZ);
  const fractionX = smooth(round(positionX - cellX));
  const fractionY = smooth(round(positionY - cellY));
  const fractionZ = smooth(round(positionZ - cellZ));
  const lower = mix(
    mix(latticeHash(cellX, cellY, cellZ), latticeHash(cellX + 1, cellY, cellZ), fractionX),
    mix(latticeHash(cellX, cellY + 1, cellZ), latticeHash(cellX + 1, cellY + 1, cellZ), fractionX),
    fractionY,
  );
  const upper = mix(
    mix(latticeHash(cellX, cellY, cellZ + 1), latticeHash(cellX + 1, cellY, cellZ + 1), fractionX),
    mix(latticeHash(cellX, cellY + 1, cellZ + 1), latticeHash(cellX + 1, cellY + 1, cellZ + 1), fractionX),
    fractionY,
  );
  return mix(lower, upper, fractionZ);
}

const NOISE_LACUNARITY = 2;
const NOISE_GAIN = 0.5;

/**
 * Fractal value noise: `octaves` copies of localVolumeNoise, each at twice the frequency and half the weight of the one before, divided by the weights so the mean stays
 * near 0.5. One octave (or no count) is localVolumeNoise itself. The shader's localVolumeFractalNoise repeats it.
 */
export function localVolumeFractalNoise(x, y, z, octaves) {
  if (!(octaves > 1)) return localVolumeNoise(x, y, z);
  let sum = 0;
  let weight = 1;
  let weightSum = 0;
  let frequency = 1;
  for (let octave = 0; octave < octaves; octave++) {
    sum = round(sum + round(weight * localVolumeNoise(x * frequency, y * frequency, z * frequency)));
    weightSum = round(weightSum + weight);
    weight = round(weight * NOISE_GAIN);
    frequency *= NOISE_LACUNARITY;
  }
  return round(sum / weightSum);
}

/** The factor the shader multiplies the profile by: mix(1, 2 * noise(position * scale), amount). */
export function localVolumeNoiseFactor(volume, x, y, z) {
  const noise = localVolumeFractalNoise(x * volume.noiseScale, y * volume.noiseScale, z * volume.noiseScale, volume.noiseOctaves);
  return 1 + (2 * noise - 1) * volume.noiseAmount;
}
