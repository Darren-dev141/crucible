import { MAX_POINT_LIGHTS } from './light-limits.js';
import { resolveLocalVolumes } from './local-volumes.js';
import { bindLocalVolumeParts } from './local-volume-parts.js';

// The source radius of an emission light is half the volume's radius, never below this, so a small volume is not a pinpoint.
const MINIMUM_LIGHT_RADIUS = 0.05;
const LIGHT_RADIUS_PER_VOLUME_RADIUS = 0.5;

/** True when the volume lights its surroundings: it emits, its light is on and its strength is above zero. */
export function volumeEmitsLight(volume) {
  return volume.emissionLight && volume.emissionStrength > 0 && volume.emission.some(channel => channel > 0);
}

/**
 * True when any packed volume adds light to the frame: a glow colour with strength, or a grid's blackbody light. The renderer asks
 * this to decide whether bloom needs the volumes in its input. Pass the buffers of packLocalVolumes.
 */
export function packedVolumesEmit(buffers) {
  for (let index = 0; index < buffers.count; index++) {
    const glow = buffers.emission[index * 4] + buffers.emission[index * 4 + 1] + buffers.emission[index * 4 + 2];
    if (glow > 0 || buffers.grid[index * 4 + 2] > 0) return true;
  }
  return false;
}

function volumeCapacity(volume) {
  if (volume.shape === 'sphere') return (4 / 3) * Math.PI * volume.radius ** 3;
  return volume.size[0] * volume.size[1] * volume.size[2];
}

function volumeRadius(volume) {
  if (volume.shape === 'sphere') return volume.radius;
  return Math.cbrt((volumeCapacity(volume) * 3) / (4 * Math.PI));
}

/**
 * The point light of one emitting volume, at its centre. The emission is radiance per unit length, so the volume sends
 * `emission * strength * volume` of intensity in every direction; the colour is the emission scaled to its brightest channel.
 */
export function emissionLightOf(volume) {
  const brightest = Math.max(...volume.emission);
  return {
    position: [...volume.center],
    color: volume.emission.map(channel => channel / brightest),
    intensity: brightest * volume.emissionStrength * volumeCapacity(volume),
    radius: Math.max(MINIMUM_LIGHT_RADIUS, volumeRadius(volume) * LIGHT_RADIUS_PER_VOLUME_RADIUS),
  };
}

/**
 * The environment with one automatic point light per emitting local volume appended to its `pointLights`, at the volume's
 * place at `volumeTime`. The lights the scene names keep their slots; the emission lights fill what is left of the
 * renderer's point light limit, brightest first, and the dimmer volumes get none. With no emitting volume the same
 * environment object is returned.
 */
export function withVolumeEmissionLights(environment, parts, volumeTime = 0) {
  const resolved = resolveLocalVolumes(environment.localVolumes, 'environment.localVolumes');
  if (!resolved.some(volumeEmitsLight)) return environment;
  const lights = bindLocalVolumeParts(resolved, parts, { time: volumeTime }).filter(volumeEmitsLight).map(emissionLightOf);
  const named = environment.pointLights ?? [];
  const room = Math.max(0, MAX_POINT_LIGHTS - named.length);
  const winners = lights.sort((first, second) => second.intensity - first.intensity).slice(0, room);
  return { ...environment, pointLights: [...named, ...winners] };
}
