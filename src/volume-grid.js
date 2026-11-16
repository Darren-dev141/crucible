// Volume grids (#1045): a 3D texture of density, temperature and flame over the box of a local volume with `shape: "grid"`.
// A grid file holds half floats, x fastest, then y, then z, y up. `scripts/vdb-to-grid.py` writes one from an OpenVDB file.
//
//   bytes 0..3   "67VG"
//   bytes 4..7   uint32 version (1)
//   bytes 8..11  uint32 header length in bytes (a multiple of 4)
//   then         JSON header { resolution: [x, y, z], channels: ["density", ...], size: [x, y, z] (optional, scene units) }
//   then         for each channel in header order, x * y * z uint16 half floats

import { blackbodyChromaticity } from './local-volume-ramp-bake.js';

export const VOLUME_GRID_VERSION = 1;
export const VOLUME_GRID_MAX_AXIS = 256;
export const VOLUME_GRID_MAX_BYTES = 64 * 1024 * 1024;
export const VOLUME_GRID_CHANNELS = Object.freeze(['density', 'temperature', 'flame']);
const MAGIC = [0x36, 0x37, 0x56, 0x47];

// Blackbody emission (#1733). The light of a hot body at `kelvin` is its Stefan-Boltzmann radiance, sigma * T^4 / pi, times a colour of luminance 1 whose
// hue is the Planckian locus. Blender's Principled Volume uses the same convention (intern/cycles/kernel/svm/closure.h, the blackbody branch of the volume
// emission, and svm_math_blackbody_color_rec709 in svm/math_util.h), so a grid fire matches Cycles in brightness as well as colour. Written from the physics:
// the code and the tables here are our own. sigma is 5.670373e-8 W/m^2/K^4; the 1e-6 turns W/m^2 into the scene's radiance unit, as Cycles does.
export const BLACKBODY_RADIANCE_SCALE = 5.670373e-8 * 1e-6 / Math.PI;
// The hue is baked once, every 200 K from 800 K (Cycles holds its colour constant below that) to 12000 K, and blended linearly. The rasterizer's
// shader carries the same table (fog-shader.js), so the two agree to float precision.
export const BLACKBODY_TABLE_FIRST_KELVIN = 800;
export const BLACKBODY_TABLE_STEP_KELVIN = 200;
export const BLACKBODY_TABLE_COUNT = 57;
const BLACKBODY_LUMINANCE = [0.2126, 0.7152, 0.0722];

function bakeBlackbodyTable() {
  const table = new Float64Array(BLACKBODY_TABLE_COUNT * 3);
  const hue = new Float64Array(3);
  for (let entry = 0; entry < BLACKBODY_TABLE_COUNT; entry++) {
    blackbodyChromaticity(BLACKBODY_TABLE_FIRST_KELVIN + entry * BLACKBODY_TABLE_STEP_KELVIN, hue);
    const luminance = hue[0] * BLACKBODY_LUMINANCE[0] + hue[1] * BLACKBODY_LUMINANCE[1] + hue[2] * BLACKBODY_LUMINANCE[2];
    for (let channel = 0; channel < 3; channel++) table[entry * 3 + channel] = hue[channel] / luminance;
  }
  return table;
}

/** The linear RGB colour of luminance 1 of a blackbody at each table temperature, `BLACKBODY_TABLE_COUNT * 3` values. */
export const BLACKBODY_HUE_TABLE = bakeBlackbodyTable();

const floatBuffer = new Float32Array(1);
const floatBits = new Uint32Array(floatBuffer.buffer);

/** Converts half float bits to a number. */
export function halfToFloat(bits) {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

/** Converts a number to half float bits, rounding to nearest even; values past 65504 become infinity. */
export function floatToHalf(value) {
  floatBuffer[0] = value;
  const bits = floatBits[0];
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  const fraction = bits & 0x7fffff;
  if (((bits >>> 23) & 0xff) === 0xff) return sign | 0x7c00 | (fraction ? 0x200 : 0);
  if (exponent >= 31) return sign | 0x7c00;
  if (exponent <= 0) {
    if (exponent < -10) return sign;
    // Round after the whole shift: the bits shifted out decide ties, so a value just above a midpoint rounds up.
    const shift = 14 - exponent;
    const mantissa = fraction | 0x800000;
    const kept = mantissa >> shift;
    const remainder = mantissa - (kept << shift);
    const halfway = 1 << (shift - 1);
    return sign | (kept + (remainder > halfway || (remainder === halfway && kept & 1) ? 1 : 0));
  }
  const rounded = (fraction + 0xfff + ((fraction >> 13) & 1)) >> 13;
  return sign + (exponent << 10) + rounded;
}

function gridLabel(label) {
  return label ? `${label}: ` : '';
}

/** Throws unless the resolution is three integers within 1 to VOLUME_GRID_MAX_AXIS and the channels fit VOLUME_GRID_MAX_BYTES. */
export function checkVolumeGridShape(resolution, channelCount, label) {
  if (!Array.isArray(resolution) || resolution.length !== 3) throw new TypeError(`${gridLabel(label)}grid resolution must be [x, y, z]`);
  for (const axis of resolution) {
    if (!Number.isInteger(axis) || axis < 1 || axis > VOLUME_GRID_MAX_AXIS) {
      throw new RangeError(`${gridLabel(label)}grid resolution ${resolution.join('x')} is out of range: each axis is an integer from 1 to ${VOLUME_GRID_MAX_AXIS}; convert with scripts/vdb-to-grid.py --max-resolution ${VOLUME_GRID_MAX_AXIS}`);
    }
  }
  const bytes = resolution[0] * resolution[1] * resolution[2] * 2 * channelCount;
  if (bytes > VOLUME_GRID_MAX_BYTES) {
    throw new RangeError(`${gridLabel(label)}grid ${resolution.join('x')} with ${channelCount} channels is ${bytes} bytes, over the ${VOLUME_GRID_MAX_BYTES} byte limit; lower --max-resolution or drop a channel`);
  }
  return bytes;
}

function checkGridSize(size, label) {
  if (size !== undefined && (!Array.isArray(size) || size.length !== 3 || !size.every(extent => Number.isFinite(extent) && extent > 0))) {
    throw new TypeError(`${label} header size must be three positive numbers`);
  }
}

/** Packs channels (Float32Array of numbers, or Uint16Array of half float bits) into a grid file. `size` is optional, in scene units. */
export function encodeVolumeGrid({ resolution, channels, size }) {
  const names = Object.keys(channels);
  checkVolumeGridShape(resolution, names.length, 'encodeVolumeGrid');
  const unknownName = names.find(name => !VOLUME_GRID_CHANNELS.includes(name));
  if (unknownName !== undefined) throw new TypeError(`encodeVolumeGrid: channel "${unknownName}" is not one of ${VOLUME_GRID_CHANNELS.join(', ')}`);
  checkGridSize(size ?? undefined, 'encodeVolumeGrid');
  if (!names.includes('density')) throw new TypeError('encodeVolumeGrid: channels needs a "density" channel');
  const voxels = resolution[0] * resolution[1] * resolution[2];
  const header = JSON.stringify({ resolution, channels: names, ...(size ? { size } : {}) });
  const headerBytes = Math.ceil(header.length / 4) * 4;
  const bytes = new Uint8Array(12 + headerBytes + voxels * 2 * names.length);
  bytes.set(MAGIC, 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, VOLUME_GRID_VERSION, true);
  view.setUint32(8, headerBytes, true);
  bytes.set(new TextEncoder().encode(header.padEnd(headerBytes, ' ')), 12);
  names.forEach((name, index) => {
    const source = channels[name];
    if (source.length !== voxels) throw new RangeError(`encodeVolumeGrid: channel "${name}" holds ${source.length} values, expected ${voxels}`);
    const offset = 12 + headerBytes + index * voxels * 2;
    for (let voxel = 0; voxel < voxels; voxel++) view.setUint16(offset + voxel * 2, source instanceof Uint16Array ? source[voxel] : floatToHalf(source[voxel]), true);
  });
  return bytes;
}

/** Reads a grid file into `{ resolution, size, channels: { density: Uint16Array, ... } }`. Throws an error that says what is wrong with the bytes. */
export function decodeVolumeGrid(source, label = 'volume grid') {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
  if (bytes.length < 12 || MAGIC.some((value, index) => bytes[index] !== value)) throw new TypeError(`${label} is not a Crucible grid file (it must start with "67VG"); make one with scripts/vdb-to-grid.py`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, true);
  if (version !== VOLUME_GRID_VERSION) throw new RangeError(`${label} is grid file version ${version}; this build reads version ${VOLUME_GRID_VERSION}`);
  const headerBytes = view.getUint32(8, true);
  if (12 + headerBytes > bytes.length) throw new RangeError(`${label} ends inside its header`);
  let header;
  try {
    header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + headerBytes)));
  } catch {
    throw new TypeError(`${label} has a header that is not JSON`);
  }
  if (header === null || typeof header !== 'object' || Array.isArray(header)) throw new TypeError(`${label} header must be a JSON object with resolution and channels`);
  const names = header.channels;
  if (!Array.isArray(names) || names.length === 0 || names.some(name => !VOLUME_GRID_CHANNELS.includes(name)) || new Set(names).size !== names.length) {
    throw new TypeError(`${label} header channels must be a list of ${VOLUME_GRID_CHANNELS.join(', ')}`);
  }
  if (!names.includes('density')) throw new TypeError(`${label} has no density channel`);
  checkVolumeGridShape(header.resolution, names.length, label);
  const voxels = header.resolution[0] * header.resolution[1] * header.resolution[2];
  const dataStart = 12 + headerBytes;
  if (bytes.length !== dataStart + voxels * 2 * names.length) {
    throw new RangeError(`${label} holds ${bytes.length - dataStart} bytes of data, expected ${voxels * 2 * names.length} for ${header.resolution.join('x')} and ${names.length} channels`);
  }
  checkGridSize(header.size, label);
  const channels = Object.create(null);
  names.forEach((name, index) => {
    const values = new Uint16Array(voxels);
    for (let voxel = 0; voxel < voxels; voxel++) values[voxel] = view.getUint16(dataStart + (index * voxels + voxel) * 2, true);
    channels[name] = values;
  });
  return { resolution: header.resolution.slice(), size: header.size ? header.size.slice() : null, channels };
}

const registry = new Map();
let loader = null;

/** Names a decoded grid (decodeVolumeGrid) or grid file bytes so a volume's `grid` field can refer to it. */
export function registerVolumeGrid(name, source) {
  if (typeof name !== 'string' || name === '') throw new TypeError('registerVolumeGrid needs a non-empty name');
  registry.set(name, source instanceof Uint8Array || source instanceof ArrayBuffer ? decodeVolumeGrid(source, `grid "${name}"`) : source);
}

/** Sets the function that fetches grid bytes for a name no one registered (the MCP server reads files); it returns bytes or null. */
export function setVolumeGridLoader(load) {
  loader = load;
}

/** The decoded grid a volume's `grid` name refers to. Throws an error that names the field when nothing is registered. */
export function findVolumeGrid(name, label) {
  const registered = registry.get(name);
  if (registered) return registered;
  const bytes = loader ? loader(name) : null;
  if (bytes) {
    registerVolumeGrid(name, bytes);
    return registry.get(name);
  }
  throw new RangeError(`${label}.grid "${name}" is not loaded: call registerVolumeGrid("${name}", bytes) with the contents of a grid file made by scripts/vdb-to-grid.py`);
}

const decodedByGrid = new WeakMap();

/** The grid's channels as Float32Arrays, decoded once; a missing temperature or flame channel is left out. */
export function volumeGridFloats(grid) {
  let floats = decodedByGrid.get(grid);
  if (floats) return floats;
  floats = Object.create(null);
  const table = new Float32Array(65536);
  for (let bits = 0; bits < 65536; bits++) table[bits] = halfToFloat(bits);
  // Only the known channel names become keys, so a name read from a grid file can never write another property.
  for (const name of VOLUME_GRID_CHANNELS) {
    const values = grid.channels[name];
    if (values) floats[name] = Float32Array.from(values, bits => table[bits]);
  }
  decodedByGrid.set(grid, floats);
  return floats;
}

/**
 * Writes the density, temperature and flame at a point of the unit cube into `out`, trilinear with texel centres at (i + 0.5) / n, clamped at the
 * edges: what a linear filtered, clamped 3D texture returns. A channel the grid lacks reads 0, and `flame` reads the density when there is no flame channel.
 */
export function sampleVolumeGrid(floats, resolution, u, v, w, out) {
  const coordinate = [u * resolution[0] - 0.5, v * resolution[1] - 0.5, w * resolution[2] - 0.5];
  const base = [0, 0, 0];
  const fraction = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    const clamped = Math.min(Math.max(coordinate[axis], 0), resolution[axis] - 1);
    base[axis] = Math.min(Math.floor(clamped), resolution[axis] - 2 < 0 ? 0 : resolution[axis] - 2);
    fraction[axis] = resolution[axis] === 1 ? 0 : clamped - base[axis];
  }
  const strideY = resolution[0];
  const strideZ = resolution[0] * resolution[1];
  const channelNames = ['density', 'temperature', 'flame'];
  for (let channel = 0; channel < 3; channel++) {
    const data = floats[channelNames[channel]] ?? (channel === 2 ? floats.density : null);
    if (!data) {
      out[channel] = 0;
      continue;
    }
    let total = 0;
    for (let corner = 0; corner < 8; corner++) {
      const stepX = corner & 1;
      const stepY = (corner >> 1) & 1;
      const stepZ = (corner >> 2) & 1;
      const weight = (stepX ? fraction[0] : 1 - fraction[0]) * (stepY ? fraction[1] : 1 - fraction[1]) * (stepZ ? fraction[2] : 1 - fraction[2]);
      if (weight === 0) continue;
      const x = Math.min(base[0] + stepX, resolution[0] - 1);
      const y = Math.min(base[1] + stepY, resolution[1] - 1);
      const z = Math.min(base[2] + stepZ, resolution[2] - 1);
      total += weight * data[x + y * strideY + z * strideZ];
    }
    out[channel] = total;
  }
  return out;
}

/** Writes the linear RGB radiance of a blackbody at `kelvin` into `out` (zero at 0 K or below): sigma * T^4 / pi times the luminance 1 hue. See BLACKBODY_RADIANCE_SCALE. */
export function blackbodyRadiance(kelvin, out) {
  if (!(kelvin > 0)) {
    out[0] = out[1] = out[2] = 0;
    return out;
  }
  const position = Math.min(Math.max(kelvin - BLACKBODY_TABLE_FIRST_KELVIN, 0) / BLACKBODY_TABLE_STEP_KELVIN, BLACKBODY_TABLE_COUNT - 1);
  const lower = Math.min(Math.floor(position), BLACKBODY_TABLE_COUNT - 2);
  const blend = position - lower;
  const scale = BLACKBODY_RADIANCE_SCALE * kelvin ** 4;
  for (let channel = 0; channel < 3; channel++) {
    const low = BLACKBODY_HUE_TABLE[lower * 3 + channel];
    const high = BLACKBODY_HUE_TABLE[(lower + 1) * 3 + channel];
    out[channel] = (low + (high - low) * blend) * scale;
  }
  return out;
}
