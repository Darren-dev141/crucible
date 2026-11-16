// Spark streaks (#1758): emissive particles that are flung out of a blast, cool along the blackbody curve over their life and are drawn
// stretched along their velocity. Each spark is a closed-form function of its seeded launch (src/particles.js: gravity, drag, wind), so a
// seek repeats exactly. The colour is the physical blackbody of #1751 (src/volume-grid.js), the same table the grid fireball uses, so a
// spark and the fire around it agree in hue and in brightness at a given temperature.

import { particleStateAt } from './particles.js';
import { blackbodyRadiance } from './volume-grid.js';

export const SPARK_LIMITS = Object.freeze({
  maxCount: 4096,
  maxSpeed: 300,
  minLifetime: 0.05,
  maxLifetime: 5,
  minRadius: 0.0005,
  maxRadius: 1,
  minKelvin: 300,
  maxKelvin: 6000,
  maxIntensity: 1000,
  maxShutter: 0.5,
});

export const SPARK_DEFAULTS = Object.freeze({
  // Half a frame at 24 frames per second: a 180 degree shutter, used when no `shutter` is set.
  shutter: 1 / 48,
  temperature: Object.freeze([2500, 800]),
  intensity: 12,
});

// A spark fades out over the last share of its life, so it never ends on a pop at its dark red.
export const SPARK_FADE_FRACTION = 0.15;

const VERTICES_PER_SPARK = 6;
// Corners: across, -across, along, -along, through, -through (the winding of src/spume.js).
const OCTAHEDRON_TRIANGLES = [0, 2, 4, 4, 2, 1, 1, 2, 5, 5, 2, 0, 4, 3, 0, 1, 3, 4, 5, 3, 1, 0, 3, 5];
export const SPARK_VERTICES = VERTICES_PER_SPARK;

/** The temperature of a spark at `lifeFraction` (0 at birth, 1 at death): linear from `temperature[0]` to `temperature[1]` kelvin. */
export function sparkKelvin(lifeFraction, temperature) {
  return temperature[0] + (temperature[1] - temperature[0]) * Math.min(Math.max(lifeFraction, 0), 1);
}

/**
 * Writes the linear RGB radiance of a spark at `lifeFraction` into `out`: its blackbody at that temperature (sigma * T^4 / pi times the
 * luminance 1 hue) times `intensity`, tapered to zero over the last `SPARK_FADE_FRACTION` of its life.
 */
export function sparkRadiance(lifeFraction, temperature, intensity, out) {
  blackbodyRadiance(sparkKelvin(lifeFraction, temperature), out);
  const fade = Math.min(1, (1 - lifeFraction) / SPARK_FADE_FRACTION);
  const factor = intensity * Math.max(fade, 0);
  out[0] *= factor;
  out[1] *= factor;
  out[2] *= factor;
  return out;
}

const tailState = { position: [0, 0, 0], scale: 0, fraction: 0 };
const headState = { position: [0, 0, 0], scale: 0, fraction: 0 };

/**
 * The streak of one spark at `time`: `head` is where it is, `tail` where it was `shutter` seconds earlier (not before its birth), so the
 * length is the distance it travels while the shutter is open. `radius` is 0 for a spark that is not born or already dead.
 * The tail is asked first: a spark that is stepped (floor bounce) continues forward from the tail's time to the head's.
 */
export function sparkStreakAt(launches, index, forces, time, shutter, target) {
  const tailTime = Math.max(time - shutter, launches.birth[index]);
  particleStateAt(launches, index, forces, 'constant', tailTime, tailState);
  particleStateAt(launches, index, forces, 'constant', time, headState);
  target.radius = headState.scale;
  target.fraction = headState.fraction;
  for (let axis = 0; axis < 3; axis++) {
    target.head[axis] = headState.position[axis];
    target.tail[axis] = headState.scale > 0 ? tailState.position[axis] : headState.position[axis];
  }
  return target;
}

function perpendicularAxes(along) {
  const helper = Math.abs(along[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
  const first = [along[1] * helper[2] - along[2] * helper[1], along[2] * helper[0] - along[0] * helper[2], along[0] * helper[1] - along[1] * helper[0]];
  const length = Math.hypot(...first);
  first[0] /= length;
  first[1] /= length;
  first[2] /= length;
  const second = [along[1] * first[2] - along[2] * first[1], along[2] * first[0] - along[0] * first[2], along[0] * first[1] - along[1] * first[0]];
  return [first, second];
}

/**
 * One mesh of stretched octahedra, one per spark, in world space: positions, normals, indices and `colors` holding each spark's linear
 * radiance (draw it with an `unlit` material of colour [1, 1, 1], which outputs colour times vertex colour). A hidden spark collapses to a point
 * with colour 0.
 */
export function buildSparkMesh(launches, forces, time, look) {
  const { shutter, temperature, intensity } = look;
  const positions = new Float32Array(launches.count * VERTICES_PER_SPARK * 3);
  const normals = new Float32Array(positions.length);
  const colors = new Float32Array(positions.length);
  const indices = new Uint32Array(launches.count * OCTAHEDRON_TRIANGLES.length);
  const streak = { head: [0, 0, 0], tail: [0, 0, 0], radius: 0, fraction: 0 };
  const radiance = [0, 0, 0];
  for (let index = 0; index < launches.count; index++) {
    sparkStreakAt(launches, index, forces, time, shutter, streak);
    const visible = streak.radius > 0;
    if (visible) sparkRadiance(streak.fraction, temperature, intensity, radiance);
    const along = [streak.head[0] - streak.tail[0], streak.head[1] - streak.tail[1], streak.head[2] - streak.tail[2]];
    const travel = Math.hypot(...along);
    const direction = travel > 1e-9 ? along.map(component => component / travel) : [0, 1, 0];
    const [across, through] = perpendicularAxes(direction);
    const halfLength = streak.radius + travel / 2;
    const corners = [[across, streak.radius], [across, -streak.radius], [direction, halfLength], [direction, -halfLength], [through, streak.radius], [through, -streak.radius]];
    for (let corner = 0; corner < VERTICES_PER_SPARK; corner++) {
      const vertex = (index * VERTICES_PER_SPARK + corner) * 3;
      const [axis, extent] = corners[corner];
      const sign = Math.sign(extent);
      for (let component = 0; component < 3; component++) {
        positions[vertex + component] = (streak.head[component] + streak.tail[component]) / 2 + axis[component] * extent;
        normals[vertex + component] = axis[component] * sign || (component === 1 ? 1 : 0);
        colors[vertex + component] = visible ? radiance[component] : 0;
      }
    }
    for (let corner = 0; corner < OCTAHEDRON_TRIANGLES.length; corner++) {
      indices[index * OCTAHEDRON_TRIANGLES.length + corner] = index * VERTICES_PER_SPARK + OCTAHEDRON_TRIANGLES[corner];
    }
  }
  return { positions, normals, colors, indices };
}
