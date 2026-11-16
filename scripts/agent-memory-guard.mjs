// The memory guard of render and review jobs: a job fails when the Node process or the live browser heap stays above its limit.

export const NODE_RSS_LIMIT_BYTES = 512 * 1024 ** 2;
export const BROWSER_HEAP_LIMIT_BYTES = 256 * 1024 ** 2;

/**
 * The browser heap in use, counting only memory the page still holds.
 * `Runtime.getHeapUsage` also counts garbage that was not collected yet, and a scene with a physics bake
 * leaves tens of MiB of it behind on its first frame. Above the limit the heap is collected and read again,
 * so only memory that survives a collection (a real leak or a scene that really needs more) trips the guard.
 */
export async function sampleBrowserHeap(session, limitBytes = BROWSER_HEAP_LIMIT_BYTES) {
  let usage = await session.send('Runtime.getHeapUsage');
  if (usage.usedSize > limitBytes) {
    await session.send('HeapProfiler.collectGarbage');
    usage = await session.send('Runtime.getHeapUsage');
  }
  return usage.usedSize;
}

// The native path tracer and the OIDN denoiser run inside the Node process, so a native job holds memory the JS limit never
// meant to cover: the traced scene tables (fixed) and the denoiser's buffers, frame planes and temporal history (per pixel).
// Sized from native + OIDN video jobs of the demo room (#1186, RTX 3060, Windows): peak RSS 1224 MiB at 960 x 540, 1360 MiB at
// 1280 x 720 and 2149 MiB at 1920 x 1080. Taking the 960 x 540 to 1280 x 720 slope back to no pixels leaves a fixed part of
// about 540 MiB above the 512 MiB base; with 25 percent on top the fixed allowance is 640 MiB. A software adapter gets more, below.
export const NATIVE_FIXED_ALLOWANCE_BYTES = 640 * 1024 ** 2;
export const NATIVE_BYTES_PER_PIXEL = 1024;
export const NATIVE_ALLOWANCE_CAP_BYTES = 2048 * 1024 ** 2;

// A software Vulkan adapter (lavapipe on a Linux runner without a GPU) keeps its device buffers and the JIT-compiled kernel
// in the Node process, so RSS holds what a real GPU keeps in its own memory. Measured on GitHub's ubuntu runner (#1186,
// llvmpipe, LLVM 21): one bare trace of Cook's room fixture peaks at 836 MiB with a warm shader cache and 1262 MiB cold at
// 320 x 240, about 430 MiB for the compile at every frame size; the first native + wavelet video job of the demo room at
// 960 x 540 on a fresh runner peaked at 3226 MiB, against a 1705 MiB limit. 2304 MiB on top leaves that job 24 percent to spare.
export const SOFTWARE_ADAPTER_ALLOWANCE_BYTES = 2304 * 1024 ** 2;

/** True for an adapter that renders on the CPU, so its device memory is counted in the process RSS. */
export function isSoftwareAdapter(adapterName) {
  return typeof adapterName === 'string' && /llvmpipe|lavapipe|swiftshader/i.test(adapterName);
}

/** Extra Node RSS a native tracer job may hold on top of the base limit, from its frame size, never above the cap. */
export function nativeNodeAllowanceBytes({ width, height }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`nativeNodeAllowanceBytes needs a positive integer width and height, got ${width} x ${height}.`);
  }
  const allowance = NATIVE_FIXED_ALLOWANCE_BYTES + width * height * NATIVE_BYTES_PER_PIXEL;
  return Math.min(allowance, NATIVE_ALLOWANCE_CAP_BYTES);
}

/**
 * The extra Node RSS one runtime grants, shared by every job and review it runs.
 * The in-process OIDN device and the tracer tables live "for the life of the process", so the memory a native job
 * leaves behind is still in RSS when the next raster job or review starts. The allowance therefore only grows: it is
 * raised by each native frame and never dropped, not when a job falls back to another backend and not when it ends.
 * One figure for the whole process: the frame part from the largest native frame, plus the software adapter part once a trace ran on one.
 */
export function createNativeMemoryAllowance() {
  let grantedBytes = 0;
  let adapterBytes = 0;
  return {
    /** Called when a frame really traces natively. */
    grantForFrame({ width, height }) {
      grantedBytes = Math.max(grantedBytes, nativeNodeAllowanceBytes({ width, height }));
    },
    /** Called with the adapter a native trace ran on; a software adapter adds its device memory, a GPU adds nothing. */
    grantForAdapter(adapterName) {
      if (isSoftwareAdapter(adapterName)) adapterBytes = SOFTWARE_ADAPTER_ALLOWANCE_BYTES;
    },
    get bytes() {
      return grantedBytes + adapterBytes;
    },
  };
}

/** A job that never used the native tracer passes no allowance, so its limit is the base 512 MiB. */
export function exceedsMemoryGuard({ nodeBytes, browserHeapBytes, nativeAllowanceBytes = 0 }) {
  return nodeBytes > NODE_RSS_LIMIT_BYTES + nativeAllowanceBytes || browserHeapBytes > BROWSER_HEAP_LIMIT_BYTES;
}

/** The error an agent reads when the guard trips: which limit, what was observed, and what to change. */
export function memoryGuardMessage({ subject, nodeBytes, browserHeapBytes, nativeAllowanceBytes = 0 }) {
  const mebibytes = (bytes) => Math.round(bytes / 1024 ** 2);
  const nodeLimitBytes = NODE_RSS_LIMIT_BYTES + nativeAllowanceBytes;
  if (nodeBytes > nodeLimitBytes) {
    const allowanceNote = nativeAllowanceBytes > 0 ? ` (${mebibytes(NODE_RSS_LIMIT_BYTES)} MiB base plus ${mebibytes(nativeAllowanceBytes)} MiB for the native tracer)` : '';
    return `${subject} exceeded its Node RSS guard: ${mebibytes(nodeBytes)} MiB used, ${mebibytes(nodeLimitBytes)} MiB allowed${allowanceNote}. Use a smaller frame size or a non-native backend.`;
  }
  return `${subject} exceeded its sampled browser heap guard: ${mebibytes(browserHeapBytes)} MiB used, ${mebibytes(BROWSER_HEAP_LIMIT_BYTES)} MiB allowed. Use a smaller frame size or fewer objects in the scene.`;
}
