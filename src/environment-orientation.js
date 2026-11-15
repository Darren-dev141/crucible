// Where an authored equirectangular HDRI faces (#1371).
//
// Crucible's samplers read column 0.5 of a map toward -Z at rotation 0 (azimuth from -Z toward +X). three.js
// (EquirectangularReflectionMapping) and Cycles (default mapping) read it toward +X, one quarter of the width on, with the
// same winding. An HDRI made for either of them lit a Crucible scene from another side, so every HDRI that comes from an
// image (a file, a catalog entry, a bundled look) is turned a quarter of its width as it is loaded: the bright spot at
// column 0.25 of the file is then seen toward -Z, as in three.js and Cycles. The samplers, the path tracers, Cook and the
// probes keep one convention and read the turned rows.
//
// A scene made before this change gets its old look back with `environmentRotation` + Math.PI / 2.

/** The rows of an authored map turned a quarter of the width, so the file's column 0.25 faces -Z at rotation 0. */
export function alignEnvironmentRows(decoded) {
  const { width, height, data } = decoded;
  const channels = data.length / (width * height);
  const shift = Math.round(width / 4);
  if (shift === 0 || shift === width) return decoded;
  const turned = new Float32Array(data.length);
  const rowLength = width * channels;
  const shiftLength = shift * channels;
  for (let row = 0; row < height; row++) {
    const start = row * rowLength;
    // turned[column] = file[column - shift]: the last `shift` columns of the file become the first.
    turned.set(data.subarray(start + rowLength - shiftLength, start + rowLength), start);
    turned.set(data.subarray(start, start + rowLength - shiftLength), start + shiftLength);
  }
  return { ...decoded, data: turned };
}
