// What the native tracer's adapter can hold, compared with a scene before the scene leaves the page. The engine (Cook)
// reports the capacity once with readAdapterCapacity(); a scene over a limit fails here with one error that names what is over,
// instead of reaching the device and failing deep inside the trace. This is separate from the Node memory guard
// (agent-memory-guard.mjs), which watches the host process while a job runs.

const FALLBACK_TEXEL_BYTES = 4;

// One entry per limit the engine reports: the count it bounds, the capacity field with the limit, and what to drop.
const CAPACITY_LIMITS = [
  { key: 'uniqueTriangles', limitField: 'maxUniqueTriangles', label: 'unique triangles',
    advice: 'Pass fewer unique triangles: decimate meshes, drop detail that is far from the camera, or reuse one geometry as instances.' },
  { key: 'instances', limitField: 'maxInstances', label: 'instances',
    advice: 'Pass fewer parts: merge small parts that share a material, or drop parts the camera does not see.' },
  { key: 'textureTexels', limitField: 'maxTextureTexels', label: 'texture texels',
    advice: 'Pass smaller textures: shrink the largest images, or drop textures from parts the camera does not see.' },
];

/**
 * The counts of an export that decide whether it fits the adapter. `exported` is an export or the manifest of a chunked
 * export (`tables` hold bytes, or `chunks.tables` hold their byte lengths). Triangles are the unique ones, instances are 0
 * for a flattened scene, and texels are the words of the texture table divided by the bytes one texel costs.
 */
export function countNativeExport(exported, { texelBytes = FALLBACK_TEXEL_BYTES } = {}) {
  const textureBytes = exported.chunks?.tables?.textureTexels ?? exported.tables?.textureTexels?.byteLength ?? 0;
  return {
    uniqueTriangles: exported.counts?.triangleCount ?? exported.triangleCount ?? exported.triangles ?? 0,
    instances: exported.counts?.instanceCount ?? exported.instances ?? 0,
    textureTexels: Math.ceil(textureBytes / (texelBytes > 0 ? texelBytes : FALLBACK_TEXEL_BYTES)),
  };
}

/**
 * Compares the counts of a scene with the adapter capacity. Returns null when it fits (a count equal to its limit fits), or one
 * sentence naming the first count that is over: the field, the count, the limit and what to drop. A limit the capacity does
 * not report is not checked. `deviceLocalMemoryBytes` may be absent; no limit is derived from it here, because the engine
 * already turns the memory into the counts above.
 */
export function nativeCapacityProblem(counts, capacity) {
  for (const { key, limitField, label, advice } of CAPACITY_LIMITS) {
    const limit = capacity?.[limitField];
    if (!Number.isFinite(limit)) continue;
    const count = counts[key];
    if (count > limit) {
      const adapter = capacity.adapter ? ` of ${capacity.adapter}` : '';
      return `The scene has ${count.toLocaleString('en-US')} ${label} (${key}), over the ${limit.toLocaleString('en-US')} (${limitField}) the native adapter${adapter} can hold, ${(count - limit).toLocaleString('en-US')} too many. ${advice}`;
    }
  }
  return null;
}

/** The capacity used by a scene, for the render report: each count with its limit, and the adapter's own numbers. */
export function describeCapacityUse(counts, capacity) {
  const use = {
    adapter: capacity.adapter,
    ...(capacity.deviceLocalMemoryBytes === undefined
      ? { deviceLocalMemoryNote: capacity.deviceLocalMemorySource ?? 'the adapter reported no device-local memory' }
      : { deviceLocalMemoryBytes: capacity.deviceLocalMemoryBytes }),
    includesAccelerationStructure: capacity.includesAccelerationStructure === true,
  };
  for (const { key, limitField } of CAPACITY_LIMITS) {
    const limit = capacity[limitField];
    use[key] = { used: counts[key], limit: Number.isFinite(limit) ? limit : null };
  }
  return use;
}

const capacityByEngine = new WeakMap();

/**
 * The adapter capacity of a loaded engine, read once per engine. Resolves with `{ capacity }`, or `{ reason }` when the engine
 * has no readAdapterCapacity or the call throws (no adapter, an addon built before it existed): the scene is then exported
 * unchecked, as before, and the engine still refuses what it cannot hold.
 */
export function readNativeCapacity(engine) {
  if (typeof engine?.readAdapterCapacity !== 'function') {
    return { reason: 'the installed render engine has no readAdapterCapacity, so the scene was not checked against the adapter.' };
  }
  if (!capacityByEngine.has(engine)) {
    try {
      capacityByEngine.set(engine, { capacity: engine.readAdapterCapacity() });
    } catch (error) {
      capacityByEngine.set(engine, { reason: `the adapter capacity could not be read (${error.message}), so the scene was not checked against it.` });
    }
  }
  return capacityByEngine.get(engine);
}

/**
 * Throws when an export cannot fit `capacity`, before any table is read from the page. The error carries `nativeCapacity: true`
 * so a job reports it instead of retrying the scene on another backend. Returns the capacity use for the report.
 */
export function requireExportFitsCapacity(exported, capacity) {
  const counts = countNativeExport(exported, { texelBytes: capacity.texelBytes });
  const problem = nativeCapacityProblem(counts, capacity);
  if (problem) {
    const error = new RangeError(problem);
    error.nativeCapacity = true;
    throw error;
  }
  return describeCapacityUse(counts, capacity);
}
