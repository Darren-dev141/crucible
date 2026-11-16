// The GLSL a program needs to read a reflection probe, shared by the lit program (reflection-probes.js) and the liquid
// pass (liquid-shader.js), so glass that transmits light and a part that does not look up the same room. This module
// imports nothing, so the liquid shader can carry it without carrying the probe tracer.

/** probeEnabled is 0 for no probe, 1 for a probe, and 2 for a probe that knows the floor under it (see `probeEnabledState`). */
export const probeUniformsGlsl = `uniform float probeEnabled;
uniform vec4 probeFloor;
`;

// probeEnabled is 2 when the probe knows its floor: a ray heading down is looked up toward where it meets that floor,
// seen from the probe, as a box-projected cube map does, because the probe sits at the part's centre and not at the shaded point.
export const probeLookupGlsl = `vec3 probeSampleDirection(vec3 reflected, vec3 position) {
  if (probeEnabled > 1.5 && reflected.y < -0.01 && position.y > probeFloor.w) {
    return normalize(position + reflected * ((probeFloor.w - position.y) / reflected.y) - probeFloor.xyz);
  }
  return reflected;
}
`;

/** The value of the `probeEnabled` uniform for the probe map of a batch: 0 without one, 2 when it carries a floor, else 1. */
export function probeEnabledState(probeMap) {
  if (!probeMap) return 0;
  return probeMap.parallax ? 2 : 1;
}
