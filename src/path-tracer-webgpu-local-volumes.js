import { LOCAL_VOLUME_KEY_GAIN, LOCAL_VOLUME_LIGHT_DEPTH_SATURATION, LOCAL_VOLUME_SHADOW_STRENGTH, LOCAL_VOLUME_SKY_GAIN, LOCAL_VOLUME_SUN_FLATTEN, LOCAL_VOLUME_EDGE_WARP, LOCAL_VOLUME_STEPS_PER_NOISE_CELL } from './local-volumes.js';
import { LOCAL_VOLUME_MAXIMUM_STEPS, MAX_LOCAL_VOLUMES } from './local-volume-resolve.js';
import { meanEnvironmentRadiance } from './path-tracer-volume.js';

// Local volumes (environment.localVolumes: boxes and spheres of absorbing, emitting and scattering medium) on the WebGPU path
// tracer (#1048). The WGSL is the march of createLocalVolumeCrossing in path-tracer-volume.js: the same step count, jittered
// midpoints, profile with falloff and noise, and the same sun and sky terms for a scattering volume, so the two tracers draw one
// picture and differ by noise only. The march is spliced into the megakernel only for a scene that has volumes.
// Mesh and grid volumes need data the table below has no room for (a mesh BVH, a 3D texture): they stay on backend "cpu".

/** Vectors per volume in the table, and the two header vectors in front of them. */
export const LOCAL_VOLUME_TEXELS = 8;
export const LOCAL_VOLUME_HEADER_TEXELS = 2;

const IDENTITY_AXES = Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1]);

/** Throws for a volume the WebGPU tracer cannot draw, naming the kind and the backend that can; does nothing for a scene without volumes. */
export function assertWebGpuLocalVolumes(scene) {
  scene.localVolumes?.forEach((volume, index) => {
    const kind = volume.shape === 'mesh' || volume.part ? 'mesh' : volume.shape === 'grid' || volume.gridData ? 'grid' : null;
    if (kind) {
      throw new RangeError(`environment.localVolumes[${index}] is a ${kind} volume, which only backend "cpu" traces; the WebGPU path tracer draws box and sphere volumes. Use backend "cpu" or make it a box or sphere.`);
    }
    if (volume.emissionRamp) {
      throw new RangeError(`environment.localVolumes[${index}].emissionRamp is read by the rasterizer and backend "cpu"; the WebGPU path tracer has no room for the ramp. Use backend "cpu" or drop the ramp.`);
    }
  });
}

/**
 * The volume table for the WebGPU kernel: a header (the count, then the mean sky radiance that lights scattering volumes)
 * followed by eight vectors per volume:
 *   0 centre, shape (0 box, 1 sphere)   1 half extents, falloff   2 absorption times density, noise amount
 *   3 emission times strength, noise scale   4 steps, scatter, anisotropy, radius   5-7 the three rows of the box axes.
 */
export function packWebGpuLocalVolumes(volumes, environment) {
  if (volumes.length > MAX_LOCAL_VOLUMES) throw new RangeError(`The WebGPU path tracer holds at most ${MAX_LOCAL_VOLUMES} local volumes, got ${volumes.length}`);
  const table = new Float32Array((LOCAL_VOLUME_HEADER_TEXELS + volumes.length * LOCAL_VOLUME_TEXELS) * 4);
  table.set([volumes.length, 0, 0, 0], 0);
  table.set([...meanEnvironmentRadiance(environment), 0], 4);
  volumes.forEach((volume, index) => {
    const at = (LOCAL_VOLUME_HEADER_TEXELS + index * LOCAL_VOLUME_TEXELS) * 4;
    const isSphere = volume.shape === 'sphere';
    const half = isSphere ? [volume.radius, volume.radius, volume.radius] : volume.size.map(extent => extent / 2);
    const axes = volume.axes ?? IDENTITY_AXES;
    table.set([...volume.center, isSphere ? 1 : 0], at);
    table.set([...half, volume.falloff], at + 4);
    table.set([...volume.absorption.map(channel => channel * volume.density), volume.noiseAmount], at + 8);
    table.set([...volume.emission.map(channel => channel * volume.emissionStrength), volume.noiseScale], at + 12);
    table.set([volume.steps, volume.scatter ?? 0, volume.anisotropy ?? 0, isSphere ? volume.radius : 0], at + 16);
    for (let row = 0; row < 3; row++) table.set([axes[row * 3], axes[row * 3 + 1], axes[row * 3 + 2], 0], at + 20 + row * 4);
  });
  return table;
}

/** The march. `params.seedAndAtlas.w` is the vector index of the table header in the materials buffer. */
export const LOCAL_VOLUME_FUNCTIONS = /* wgsl */ `
const LOCAL_VOLUME_TEXELS: i32 = ${LOCAL_VOLUME_TEXELS};
const LOCAL_VOLUME_HEADER_TEXELS: i32 = ${LOCAL_VOLUME_HEADER_TEXELS};
const LOCAL_VOLUME_LIMIT: i32 = ${MAX_LOCAL_VOLUMES};
const LOCAL_VOLUME_MAXIMUM_STEPS: f32 = ${LOCAL_VOLUME_MAXIMUM_STEPS}.0;
const LOCAL_VOLUME_STEPS_PER_CELL: f32 = ${LOCAL_VOLUME_STEPS_PER_NOISE_CELL}.0;
const LOCAL_VOLUME_KEY_GAIN: f32 = ${LOCAL_VOLUME_KEY_GAIN}.0;
const LOCAL_VOLUME_DEPTH_SATURATION: f32 = ${LOCAL_VOLUME_LIGHT_DEPTH_SATURATION}.0;
const LOCAL_VOLUME_SHADOW_STRENGTH: f32 = ${LOCAL_VOLUME_SHADOW_STRENGTH};
const LOCAL_VOLUME_SKY_GAIN: f32 = ${LOCAL_VOLUME_SKY_GAIN};
const LOCAL_VOLUME_SUN_FLATTEN: f32 = ${LOCAL_VOLUME_SUN_FLATTEN};
const LOCAL_VOLUME_EDGE_WARP: f32 = ${LOCAL_VOLUME_EDGE_WARP}.0;

var<private> localSpan: vec2<f32>;

fn localVolumeTexel(volume: i32, offset: i32) -> vec4<f32> {
  return materials[i32(params.seedAndAtlas.w) + LOCAL_VOLUME_HEADER_TEXELS + volume * LOCAL_VOLUME_TEXELS + offset];
}

// The value noise of the rasterizer's post shader (local-volume-noise.js).
fn localLatticeHash(cell: vec3<f32>) -> f32 {
  var scrambled = fract(cell * 0.1031);
  let spread = scrambled.x * (scrambled.z + 31.32) + scrambled.y * (scrambled.y + 31.32) + scrambled.z * (scrambled.x + 31.32);
  scrambled += vec3<f32>(spread);
  return fract((scrambled.x + scrambled.y) * scrambled.z);
}

fn localVolumeNoise(position: vec3<f32>) -> f32 {
  let cell = floor(position);
  let fraction = position - cell;
  let smoothed = fraction * fraction * (3.0 - 2.0 * fraction);
  let lower = mix(
    mix(localLatticeHash(cell), localLatticeHash(cell + vec3<f32>(1.0, 0.0, 0.0)), smoothed.x),
    mix(localLatticeHash(cell + vec3<f32>(0.0, 1.0, 0.0)), localLatticeHash(cell + vec3<f32>(1.0, 1.0, 0.0)), smoothed.x),
    smoothed.y);
  let upper = mix(
    mix(localLatticeHash(cell + vec3<f32>(0.0, 0.0, 1.0)), localLatticeHash(cell + vec3<f32>(1.0, 0.0, 1.0)), smoothed.x),
    mix(localLatticeHash(cell + vec3<f32>(0.0, 1.0, 1.0)), localLatticeHash(cell + vec3<f32>(1.0, 1.0, 1.0)), smoothed.x),
    smoothed.y);
  return mix(lower, upper, smoothed.z);
}

fn localFadeProfile(ratio: f32) -> f32 {
  let clamped = clamp(ratio, 0.0, 1.0);
  return 1.0 - clamped * clamped * (3.0 - 2.0 * clamped);
}

fn localWarpedFadePosition(position: f32, noiseAmount: f32, noise: f32) -> f32 {
  let clamped = clamp(position, 0.0, 1.0);
  return clamped + (0.5 - noise) * noiseAmount * LOCAL_VOLUME_EDGE_WARP * 4.0 * clamped * (1.0 - clamped);
}

fn localAxesOffset(volume: i32, offset: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(dot(localVolumeTexel(volume, 5).xyz, offset), dot(localVolumeTexel(volume, 6).xyz, offset), dot(localVolumeTexel(volume, 7).xyz, offset));
}

// The density factor of a volume at a point (localVolumeProfile in local-volumes.js).
fn localVolumeProfile(volume: i32, point: vec3<f32>, withNoise: bool) -> f32 {
  let centre = localVolumeTexel(volume, 0);
  let extents = localVolumeTexel(volume, 1);
  let noiseAmount = localVolumeTexel(volume, 2).w;
  let noiseScale = localVolumeTexel(volume, 3).w;
  let offset = localAxesOffset(volume, point - centre.xyz);
  let noisy = withNoise && noiseAmount > 0.0;
  var noise = 0.5;
  if (noisy) { noise = localVolumeNoise(point * noiseScale); }
  let falloff = extents.w;
  var profile = 1.0;
  if (centre.w > 0.5) {
    let distance = length(offset) / extents.x;
    if (distance >= 1.0) { return 0.0; }
    if (falloff > 0.0) {
      profile = localFadeProfile(localWarpedFadePosition((distance - (1.0 - falloff)) / falloff, select(0.0, noiseAmount, noisy), noise));
    }
  } else {
    let ratio = abs(offset) / extents.xyz;
    if (max(ratio.x, max(ratio.y, ratio.z)) >= 1.0) { return 0.0; }
    if (falloff > 0.0) {
      let core = 1.0 - falloff;
      let fadeDistance = length(max(ratio - vec3<f32>(core), vec3<f32>(0.0)));
      profile = localFadeProfile(localWarpedFadePosition(fadeDistance / falloff, select(0.0, noiseAmount, noisy), noise));
    }
  }
  if (noisy) { profile *= 1.0 + (2.0 * noise - 1.0) * noiseAmount; }
  return profile;
}

// Where the ray is inside the volume, clipped to [0, limit]; the span goes to localSpan (localVolumeInterval in local-volumes.js).
fn localVolumeInterval(volume: i32, origin: vec3<f32>, rayDirection: vec3<f32>, limit: f32) -> bool {
  let centre = localVolumeTexel(volume, 0);
  let extents = localVolumeTexel(volume, 1);
  var entry = 0.0;
  var exitDistance = limit;
  if (centre.w > 0.5) {
    let offset = origin - centre.xyz;
    let along = dot(offset, rayDirection);
    let discriminant = along * along - (dot(offset, offset) - extents.x * extents.x);
    if (discriminant <= 0.0) { return false; }
    let root = sqrt(discriminant);
    entry = max(entry, -along - root);
    exitDistance = min(exitDistance, -along + root);
  } else {
    let relative = -localAxesOffset(volume, origin - centre.xyz);
    let alongDirection = localAxesOffset(volume, rayDirection);
    for (var axis = 0; axis < 3; axis++) {
      if (alongDirection[axis] == 0.0) {
        if (abs(relative[axis]) > extents[axis]) { return false; }
        continue;
      }
      let first = (relative[axis] - extents[axis]) / alongDirection[axis];
      let second = (relative[axis] + extents[axis]) / alongDirection[axis];
      entry = max(entry, min(first, second));
      exitDistance = min(exitDistance, max(first, second));
    }
  }
  if (!(entry < exitDistance)) { return false; }
  localSpan = vec2<f32>(entry, exitDistance);
  return true;
}

fn localVolumeStepCount(volume: i32, length: f32) -> f32 {
  let steps = localVolumeTexel(volume, 4).x;
  let noiseAmount = localVolumeTexel(volume, 2).w;
  if (!(noiseAmount > 0.0)) { return steps; }
  let cellSteps = ceil(length * localVolumeTexel(volume, 3).w * LOCAL_VOLUME_STEPS_PER_CELL);
  return min(LOCAL_VOLUME_MAXIMUM_STEPS, max(steps, cellSteps));
}

// The optical depth per channel from a point to the volume's far side along a direction, from midpoint taps of the profile.
fn localOpticalDepth(volume: i32, point: vec3<f32>, rayDirection: vec3<f32>, taps: i32) -> vec3<f32> {
  var exitDistance = 0.0;
  if (localVolumeInterval(volume, point, rayDirection, 1e30)) { exitDistance = max(localSpan.y, 0.0); }
  var profileSum = 0.0;
  for (var tap = 0; tap < taps; tap++) {
    let distance = exitDistance * (f32(tap) + 0.5) / f32(taps);
    profileSum += min(localVolumeProfile(volume, point + rayDirection * distance, false) * LOCAL_VOLUME_DEPTH_SATURATION, 1.0);
  }
  return localVolumeTexel(volume, 2).xyz * profileSum * exitDistance / f32(taps);
}

fn localSkyLight(volume: i32, point: vec3<f32>) -> vec3<f32> {
  var sky = vec3<f32>(0.0);
  sky += exp(-localOpticalDepth(volume, point, vec3<f32>(0.0, 1.0, 0.0), 1)) / 5.0;
  sky += exp(-localOpticalDepth(volume, point, vec3<f32>(1.0, 0.0, 0.0), 1)) / 5.0;
  sky += exp(-localOpticalDepth(volume, point, vec3<f32>(-1.0, 0.0, 0.0), 1)) / 5.0;
  sky += exp(-localOpticalDepth(volume, point, vec3<f32>(0.0, 0.0, 1.0), 1)) / 5.0;
  sky += exp(-localOpticalDepth(volume, point, vec3<f32>(0.0, 0.0, -1.0), 1)) / 5.0;
  return sky * materials[i32(params.seedAndAtlas.w) + 1].xyz * LOCAL_VOLUME_SKY_GAIN;
}

// The light one step of a scattering volume sends back along the ray: scatter * (1 - exp(-extinction * width)) * (sky + sun).
fn localScatteredLight(volume: i32, point: vec3<f32>, width: f32) -> vec3<f32> {
  var lightSum = localSkyLight(volume, point);
  let sunDirection = params.sunDirection.xyz;
  if (params.emittersFlagsSample.y == 1 && !occluded(point, sunDirection, params.environmentRotationAndRays.w)) {
    let flattened = normalize(vec3<f32>(sunDirection.x, sunDirection.y * LOCAL_VOLUME_SUN_FLATTEN, sunDirection.z));
    let sunDepth = localOpticalDepth(volume, point, flattened, 3);
    let phase = henyeyGreensteinPhase(localVolumeTexel(volume, 4).z, dot(sunDirection, direction));
    lightSum += params.sunColorAndCosine.xyz * phase * LOCAL_VOLUME_KEY_GAIN * exp(-sunDepth * LOCAL_VOLUME_SHADOW_STRENGTH);
  }
  let scatter = localVolumeTexel(volume, 4).y;
  let scattered = scatter * (vec3<f32>(1.0) - exp(-localVolumeTexel(volume, 2).xyz * width));
  return scattered * lightSum;
}

// Carries the ray through every local volume it crosses, nearest entry first: adds the light the volumes emit and scatter to the
// path and dims throughput by what they absorb. One random number offsets the samples inside each step.
fn crossLocalVolumes(depth: i32, origin: vec3<f32>, segmentLength: f32) {
  let jitter = nextRandom();
  let count = i32(materials[i32(params.seedAndAtlas.w)].x);
  var entries: array<f32, ${MAX_LOCAL_VOLUMES}>;
  var exits: array<f32, ${MAX_LOCAL_VOLUMES}>;
  var order: array<i32, ${MAX_LOCAL_VOLUMES}>;
  var crossed = 0;
  for (var volume = 0; volume < count; volume++) {
    if (!localVolumeInterval(volume, origin, direction, segmentLength)) { continue; }
    entries[volume] = localSpan.x;
    exits[volume] = localSpan.y;
    var slot = crossed;
    crossed++;
    while (slot > 0 && entries[order[slot - 1]] > localSpan.x) {
      order[slot] = order[slot - 1];
      slot--;
    }
    order[slot] = volume;
  }
  var emitted = vec3<f32>(0.0);
  for (var rank = 0; rank < crossed; rank++) {
    let volume = order[rank];
    let entry = entries[volume];
    let span = exits[volume] - entry;
    let stepCount = localVolumeStepCount(volume, span);
    let stepLength = span / stepCount;
    let extinction = localVolumeTexel(volume, 2).xyz;
    let emission = localVolumeTexel(volume, 3).xyz;
    let scatters = localVolumeTexel(volume, 4).y > 0.0;
    for (var stepIndex = 0; stepIndex < i32(stepCount); stepIndex++) {
      let point = origin + direction * (entry + (f32(stepIndex) + jitter) * stepLength);
      let profile = localVolumeProfile(volume, point, true);
      if (profile <= 0.0) { continue; }
      let width = profile * stepLength;
      if (scatters) { emitted += throughput * localScatteredLight(volume, point, width); }
      emitted += throughput * emission * width;
      throughput *= exp(-extinction * width);
    }
  }
  addRadiance(depth, emitted);
}
`;
