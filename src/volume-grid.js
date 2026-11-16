// Volume grids (#1045): a 3D texture of density, temperature and flame over the box of a local volume with `shape: "grid"`.
// A grid file holds half floats, x fastest, then y, then z, y up. `scripts/vdb-to-grid.py` writes one from an OpenVDB file.
//
//   bytes 0..3   "67VG"
//   bytes 4..7   uint32 version (1)
//   bytes 8..11  uint32 header length in bytes (a multiple of 4)
//   then         JSON header { resolution: [x, y, z], channels: ["density", ...], size: [x, y, z] (optional, scene units) }
//   then         for each channel in header order, x * y * z uint16 half floats

export const VOLUME_GRID_VERSION = 1;
export const VOLUME_GRID_MAX_AXIS = 256;
export const VOLUME_GRID_MAX_BYTES = 64 * 1024 * 1024;
export const VOLUME_GRID_CHANNELS = Object.freeze(['density', 'temperature', 'flame']);
const MAGIC = [0x36, 0x37, 0x56, 0x47];

// Blackbody emission: the colour of a hot body at `kelvin` (Tanner Helland's fit to the Planckian locus, to linear RGB) times (kelvin / 1500)^4 up to a
// cap, so a 3000 K flame is 16 times as bright as a 1500 K ember. The rasterizer's fog-shader.js repeats it, so keep the two in step.
export const BLACKBODY_REFERENCE_KELVIN = 1500;
export const BLACKBODY_MAXIMUM_GAIN = 50;
/** Empty voxels the rasterizer's texture adds on every face of a grid, so the field ramps to 0 across the outer half voxel as an OpenVDB grid does (#1752). */
export const GRID_BORDER_VOXELS = 1;
const BLACKBODY_MINIMUM_KELVIN = 1000;

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
 * Writes the density, temperature and flame at a point of the unit cube into `out`, trilinear with texel centres at (i + 0.5) / n and 0 beyond the grid's faces,
 * as an OpenVDB grid reads (the rasterizer's textures have a border of empty voxels, GRID_BORDER_VOXELS, for the same ramp). A channel the grid lacks reads 0,
 * and `flame` reads the density when there is no flame channel. With `baked` (bakedGridEmission) the blackbody radiance at the point goes to out[3] to out[5],
 * interpolated after the blackbody, so the field is what Cycles' one linear tap averages to and the fourth power of the blackbody never amplifies the crease of
 * an interpolated temperature (#1752). `out` then needs six entries.
 */
export function sampleVolumeGrid(floats, resolution, u, v, w, out, baked = null) {
  gatherCorners(resolution, u, v, w);
  out[0] = mixCorners(floats.density);
  out[1] = mixCorners(floats.temperature);
  out[2] = mixCorners(floats.flame ?? floats.density);
  if (baked) {
    out[3] = mixCorners(baked.red);
    out[4] = mixCorners(baked.green);
    out[5] = mixCorners(baked.blue);
  }
  return out;
}

const cornerVoxel = new Int32Array(8);
const cornerWeight = new Float64Array(8);

// The eight voxels around a point and their trilinear weights; a voxel beyond the grid, or with weight 0, is -1 and reads 0.
function gatherCorners(resolution, u, v, w) {
  const x = u * resolution[0] - 0.5;
  const y = v * resolution[1] - 0.5;
  const z = w * resolution[2] - 0.5;
  const baseX = Math.floor(x);
  const baseY = Math.floor(y);
  const baseZ = Math.floor(z);
  const fractionX = x - baseX;
  const fractionY = y - baseY;
  const fractionZ = z - baseZ;
  for (let corner = 0; corner < 8; corner++) {
    const stepX = corner & 1;
    const stepY = (corner >> 1) & 1;
    const stepZ = (corner >> 2) & 1;
    const voxelX = baseX + stepX;
    const voxelY = baseY + stepY;
    const voxelZ = baseZ + stepZ;
    const weight = (stepX ? fractionX : 1 - fractionX) * (stepY ? fractionY : 1 - fractionY) * (stepZ ? fractionZ : 1 - fractionZ);
    const inside = voxelX >= 0 && voxelY >= 0 && voxelZ >= 0 && voxelX < resolution[0] && voxelY < resolution[1] && voxelZ < resolution[2];
    cornerVoxel[corner] = inside && weight !== 0 ? voxelX + resolution[0] * (voxelY + resolution[1] * voxelZ) : -1;
    cornerWeight[corner] = weight;
  }
}

function mixCorners(data) {
  if (!data) return 0;
  let total = 0;
  for (let corner = 0; corner < 8; corner++) {
    const voxel = cornerVoxel[corner];
    if (voxel >= 0) total += cornerWeight[corner] * data[voxel];
  }
  return total;
}

const bakedEmissionByGrid = new WeakMap();

/**
 * The blackbody radiance of every voxel's temperature times `temperatureScale`, as three Float32Arrays (`red`, `green`, `blue`) with the grid's voxel order,
 * decoded once per grid and scale. Each value is at most BLACKBODY_MAXIMUM_GAIN, far under the half float limit of 65504, so the rasterizer uploads it as is. The
 * blackbody intensity and emission strength stay uniforms. A grid without a temperature channel bakes to all zeros.
 */
export function bakedGridEmission(grid, temperatureScale) {
  const cached = bakedEmissionByGrid.get(grid);
  if (cached?.temperatureScale === temperatureScale) return cached;
  const temperature = volumeGridFloats(grid).temperature;
  const voxels = grid.resolution[0] * grid.resolution[1] * grid.resolution[2];
  const baked = { temperatureScale, red: new Float32Array(voxels), green: new Float32Array(voxels), blue: new Float32Array(voxels) };
  const radiance = [0, 0, 0];
  if (temperature) {
    for (let voxel = 0; voxel < voxels; voxel++) {
      if (!(temperature[voxel] > 0)) continue;
      blackbodyRadiance(temperature[voxel] * temperatureScale, radiance);
      baked.red[voxel] = radiance[0];
      baked.green[voxel] = radiance[1];
      baked.blue[voxel] = radiance[2];
    }
  }
  bakedEmissionByGrid.set(grid, baked);
  return baked;
}

/** Writes the linear RGB radiance of a blackbody at `kelvin` into `out` (zero below 0 K). See BLACKBODY_REFERENCE_KELVIN. */
export function blackbodyRadiance(kelvin, out) {
  if (!(kelvin > 0)) {
    out[0] = out[1] = out[2] = 0;
    return out;
  }
  const hundreds = Math.max(kelvin, BLACKBODY_MINIMUM_KELVIN) / 100;
  const red = hundreds <= 66 ? 255 : 329.698727446 * (hundreds - 60) ** -0.1332047592;
  const green = hundreds <= 66 ? 99.4708025861 * Math.log(hundreds) - 161.1195681661 : 288.1221695283 * (hundreds - 60) ** -0.0755148492;
  const blue = hundreds >= 66 ? 255 : hundreds <= 19 ? 0 : 138.5177312231 * Math.log(hundreds - 10) - 305.0447927307;
  const gain = Math.min((kelvin / BLACKBODY_REFERENCE_KELVIN) ** 4, BLACKBODY_MAXIMUM_GAIN);
  out[0] = (Math.min(Math.max(red, 0), 255) / 255) ** 2.2 * gain;
  out[1] = (Math.min(Math.max(green, 0), 255) / 255) ** 2.2 * gain;
  out[2] = (Math.min(Math.max(blue, 0), 255) / 255) ** 2.2 * gain;
  return out;
}
