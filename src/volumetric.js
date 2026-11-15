const DEFAULT_MINIMUM = Object.freeze([-100, 0, -100]);
const DEFAULT_MAXIMUM = Object.freeze([100, 20, 100]);
const DEFAULT_COLOR = Object.freeze([0.8, 0.85, 0.9]);
const DEFAULT_AMBIENT = Object.freeze([0.03, 0.035, 0.04]);
const DEFAULT_DRIFT = Object.freeze([0.03, 0, 0]);

export function finiteRange(value, minimum, maximum, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

/** Three numbers in a range, as a new array. */
export function vectorField(value, minimum, maximum, label) {
  if (!Array.isArray(value) || value.length !== 3) throw new TypeError(`${label} must be an array of three numbers`);
  return value.map(component => finiteRange(component, minimum, maximum, label));
}

function vector(value, minimum, maximum, label) {
  if (value?.length !== 3) throw new TypeError(`${label} requires three components`);
  for (let axis = 0; axis < 3; axis++) finiteRange(value[axis], minimum, maximum, label);
  return value;
}

export const FOG_FIELD_MAXIMUM_SIZE = 2048;
export const FOG_PROFILES = Object.freeze(['exponential', 'smoothstep']);

/** Checks a fog field and returns it unchanged: { width, height, data } with RGBA floats, row 0 at the box's minimum z. */
export function validateFogField(field) {
  if (!field || typeof field !== 'object' || Array.isArray(field)) throw new TypeError('Fog field must be an object with width, height and data');
  for (const label of ['width', 'height']) {
    const size = field[label];
    if (!Number.isInteger(size) || size < 1 || size > FOG_FIELD_MAXIMUM_SIZE) throw new RangeError(`Fog field ${label} must be an integer between 1 and ${FOG_FIELD_MAXIMUM_SIZE}`);
  }
  if (!(field.data instanceof Float32Array)) throw new TypeError('Fog field data must be a Float32Array of RGBA values');
  if (field.data.length !== field.width * field.height * 4) throw new RangeError(`Fog field data must hold width * height * 4 = ${field.width * field.height * 4} values, got ${field.data.length}`);
  for (let index = 0; index < field.data.length; index++) {
    if (!Number.isFinite(field.data[index])) throw new RangeError(`Fog field data must be finite; index ${index} is not`);
  }
  return field;
}

// What a fog without detail controls uses: one octave, no warp, the noise as is, the layer top fading from half its height.
const DEFAULT_DETAIL = { detailOctaves: 1, detailAmount: 0.5, warp: 0, contrast: 1, profileSoftness: 0.5, keyScattering: 1, scatterOctaves: 1, multiScatter: 0.5, multiExtinction: 0.5, multiAnisotropy: 0.5, keyTransmittance: 0, surfaceTransmittance: 0 };
const DETAIL_LIMITS = {
  detailOctaves: [1, 3, 'Volume detail octaves'],
  detailAmount: [0, 1, 'Volume detail amount'],
  warp: [0, 4, 'Volume warp'],
  contrast: [0, 4, 'Volume contrast'],
  profileSoftness: [0, 0.95, 'Volume profile softness'],
  keyScattering: [0, 10, 'Volume key scattering'],
  scatterOctaves: [1, 4, 'Volume scatter octaves'],
  multiScatter: [0, 1, 'Volume multi scatter'],
  multiExtinction: [0, 1, 'Volume multi extinction'],
  multiAnisotropy: [0, 1, 'Volume multi anisotropy'],
  keyTransmittance: [0, 1, 'Volume key transmittance'],
  surfaceTransmittance: [0, 1, 'Volume surface transmittance'],
};

/** The twelve detail fields of a resolved volume fog with defaults filled in. Anything unset or out of range throws like the core fields. */
export function resolveFogDetail(volume) {
  const detail = { ...DEFAULT_DETAIL };
  for (const [field, [minimum, maximum, label]] of Object.entries(DETAIL_LIMITS)) {
    if (volume[field] !== undefined) detail[field] = finiteRange(volume[field], minimum, maximum, label);
  }
  if (!Number.isInteger(detail.detailOctaves)) throw new RangeError('Volume detail octaves must be an integer');
  if (!Number.isInteger(detail.scatterOctaves)) throw new RangeError('Volume scatter octaves must be an integer');
  return detail;
}

export function resolveVolumeFog(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('volumeFog must be an object');
  const density = finiteRange(input.density ?? 0, 0, 10, 'Volume density');
  const minimum = vector(input.minimum ?? DEFAULT_MINIMUM, -1e5, 1e5, 'Volume minimum');
  const maximum = vector(input.maximum ?? DEFAULT_MAXIMUM, -1e5, 1e5, 'Volume maximum');
  for (let axis = 0; axis < 3; axis++) {
    if (Math.fround(maximum[axis]) <= Math.fround(minimum[axis])) throw new RangeError('Volume bounds must remain ordered after Float32 rounding');
  }
  const color = vector(input.color ?? DEFAULT_COLOR, 0, 1, 'Volume color');
  const ambient = vector(input.ambient ?? DEFAULT_AMBIENT, 0, 10, 'Volume ambient');
  const drift = vector(input.drift ?? DEFAULT_DRIFT, -100, 100, 'Volume drift');
  const steps = finiteRange(input.steps ?? 16, 8, 48, 'Volume steps');
  if (!Number.isInteger(steps)) throw new RangeError('Volume steps must be an integer');
  const anisotropy = finiteRange(input.anisotropy ?? 0.3, -0.9, 0.9, 'Volume anisotropy');
  const noiseAmount = finiteRange(input.noiseAmount ?? 0.5, 0, 1, 'Volume noise amount');
  const noiseScale = finiteRange(input.noiseScale ?? 0.3, 0.001, 100, 'Volume noise scale');
  const maxDistance = finiteRange(input.maxDistance ?? 100, 0.01, 1e4, 'Volume maximum distance');
  const heightFalloff = finiteRange(input.heightFalloff ?? 0, 0, 1e5, 'Volume height falloff');
  // The detail fields (detailOctaves ... surfaceTransmittance) pass through with the other unknown fields, checked here so a bad value fails when the scene is built.
  resolveFogDetail(input);
  const resolved = { ...input, density, minimum, maximum, color, ambient, drift, steps, anisotropy, noiseAmount, noiseScale, maxDistance, heightFalloff };
  // Left out when unset, so the renderer can derive it from the scene (volumeShadowAmbient).
  if (input.shadowAmbient !== undefined) {
    resolved.shadowAmbient = finiteRange(input.shadowAmbient, 0, 1, 'Volume shadow ambient');
  }
  if (input.field !== undefined) resolved.field = validateFogField(input.field);
  // Left out when unset, like shadowAmbient: the renderer applies the defaults, and a fog without them resolves as before.
  if (input.flowStrength !== undefined) resolved.flowStrength = finiteRange(input.flowStrength, 0, 100, 'Volume flow strength');
  if (input.flowPeriod !== undefined) resolved.flowPeriod = finiteRange(input.flowPeriod, 0.01, 1000, 'Volume flow period');
  if (input.profile !== undefined) {
    if (!FOG_PROFILES.includes(input.profile)) throw new RangeError(`Volume profile must be one of ${FOG_PROFILES.join(', ')}`);
    resolved.profile = input.profile;
  }
  return resolved;
}
