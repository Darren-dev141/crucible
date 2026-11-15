import test, { after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentRuntime } from '../scripts/agent-runtime.mjs';
import { createAgentAssetCatalog } from '../scripts/agent-asset-catalog.mjs';
import { isPreviewHost } from '../scripts/preview-host.mjs';
import { addonCapabilities, addonFileFor, addonImportMap } from '../scripts/mcp-addons.mjs';
import { sampleBrowserHeap, exceedsMemoryGuard } from '../scripts/agent-memory-guard.mjs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, truncate, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readVolumeGridFiles } from '../src/mcp-volume-grids.js';
import { writeWebBuild } from '../scripts/web-export.mjs';
import { EXPORT_DIRECTORY_NAME, RENDER_HISTORY_FILE, normalizeJobSettings } from '../scripts/agent-render-jobs.mjs';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createContext, Script } from 'node:vm';
import { VEGETATION_CAPABILITY_NOTE } from '../src/agent-vegetation-notes.js';
import { CROWD_CAPABILITY_NOTE } from '../src/agent-crowd-notes.js';
import { SETTLE_CAPABILITY_NOTE } from '../src/settle-notes.js';
import { RENDER_ESTIMATE_NOTE, estimateRenderJob, historyWithJob, parseHistory, renderReport, sceneSizeFrom } from '../scripts/agent-render-estimate.mjs';
import { RENDER_BUDGET_NOTE, chooseBudgetSettings, parseBudget } from '../scripts/agent-render-budget.mjs';
import { RENDER_QUALITY_NOTE, applyQuality, tierReport } from '../scripts/agent-render-quality.mjs';
import { GAME_CAPABILITIES } from '../src/game-setup-notes.js';
import { USER_PASS_CAPABILITIES } from '../src/user-pass.js';
import { MESH_BLEND_CAPABILITIES } from '../src/mesh-blend.js';
import { MATERIAL_SNIPPET_CAPABILITIES } from '../src/material-snippet.js';
import { AGENT_SCENE_CAPABILITIES, AGENT_SCENE_DEFAULT_LIMITS, RENDER_PASS_NAMES, RENDER_PASS_DEPTH_RANGE, VIDEO_ENCODERS, MAXIMUM_VIDEO_SECONDS, MAXIMUM_JOB_FPS, MAXIMUM_JOB_FRAMES, MAXIMUM_JOB_SIDE, MAXIMUM_JOB_PIXELS, MAXIMUM_MEMORY_MIB, BAKE_WORKER_MAXIMUM_SECONDS } from '../src/agent-scene-capabilities.js';
import { recipeAssetNeeds } from '../src/agent-scene-assets.js';
import { gameAssetIds } from '../src/game-assets.js';
import { sequenceFrameIds } from '../src/agent-texture-sequence.js';
import { catalogLookReferences, BUNDLED_ENVIRONMENT_NAMES, BUNDLED_CUBE_LOOK_NAMES } from '../src/look-catalog.js';
import { TEXTURE_SEQUENCE_CAPABILITIES } from '../src/texture-sequence-limits.js';
import { AGENT_ASSET_LIMITS, assertCombinedAssetBytes } from '../src/agent-asset-limits.js';
import { PATH_TRACER_CAPABILITIES } from '../src/path-tracer-capabilities.js';
import { audioInputArguments, createAudioLibrary, measureStreamSeconds } from '../scripts/job-audio.mjs';
import { filmTimelineDuration, filmTimelineShotStarts, sampleFilmTimeline } from '../src/film-timeline.js';
import { normalizeReview, REVIEW_LIMITS } from '../scripts/agent-review.mjs';
import { BRANCH_LIMITS, validateBranchName } from '../src/agent-branches.js';
import { sessionProblem, SCENE_STORE_LIMITS } from '../src/agent-errors.js';
import { ANNOTATE_LIMITS } from '../src/agent-annotate.js';
import * as packLimits from '../src/pack-manifest.js';
import { createPackRegistry } from '../scripts/agent-packs.mjs';

const HARNESS_TEST_TIMEOUT_MS = 30000;

function runTest(name, body) {
  return test(name, { timeout: HARNESS_TEST_TIMEOUT_MS }, body);
}

runTest('runtime reports real scene capabilities without launching a browser and closes idempotently', async () => {
  const runtime = createAgentRuntime({ backend: 'cpu', memory: 64 });
  const capabilities = await runtime.capabilities();
  assert.equal(capabilities.phase, 'idle');
  assert.equal(capabilities.scene.schemaVersion, 1);
  assert.equal(capabilities.preview.maximumActiveScenes, 4);
  assert.equal(capabilities.preview.memoryBudgetMiB, 64);
  assert.equal(capabilities.preview.backend, 'cpu');
  assert.equal(capabilities.review.maximumShots, 4);
  assert.equal(capabilities.review.maximumGridHeight, 1008);
  assert.equal(capabilities.review.maximumPendingFrames, 1);
  assert.equal(capabilities.sceneLimits.maxGeometryBytes, 32 * 1024 * 1024);
  await runtime.close();
  await runtime.close();
  assert.equal((await runtime.capabilities()).phase, 'closed');
  await assert.rejects(runtime.create({ recipe: {} }), /closed/);
});

const openHarnesses = [];

// Every test must end in seconds: a runtime that throws inside the sandbox leaves page promises and
// deadline timers pending, which kept the CI shard alive for 15 minutes (#1212).
afterEach(async () => {
  const harnesses = openHarnesses.splice(0);
  for (const { runtime, sandboxTimers, releasePages } of harnesses) {
    releasePages();
    let closeTimer;
    await Promise.race([runtime.close().catch(() => {}),
      new Promise(resolve => { closeTimer = setTimeout(resolve, 2000); })]);
    clearTimeout(closeTimer);
    for (const timer of sandboxTimers) clearTimeout(timer);
  }
});

// Race a "started" signal against the call that should start it, so a throw inside the runtime
// fails the test with that error instead of waiting for a signal that never comes.
function startedOrFailed(started, pending) {
  return Promise.race([started, pending.then(() => undefined)]);
}

// Names the runtime module imports, resolved from the module's own import lines so a new
// constant cannot be missing from the sandbox.
async function importedBindings(source) {
  const bindings = {};
  const importPattern = /^import\s+(?:(\w+)|\{([^}]*)\})\s+from\s+'([^']+)'/gm;
  for (const [, defaultName, namedList, specifier] of source.matchAll(importPattern)) {
    if (specifier.endsWith('.json')) continue;
    const moduleUrl = specifier.startsWith('.') ? new URL(`../scripts/${specifier}`, import.meta.url).href : specifier;
    const namespace = await import(moduleUrl);
    if (defaultName) bindings[defaultName] = namespace.default;
    for (const entry of (namedList ?? '').split(',').map(item => item.trim()).filter(Boolean)) {
      const [exported, local = exported] = entry.split(/\s+as\s+/);
      bindings[local] = namespace[exported];
    }
  }
  return bindings;
}

async function reviewRuntimeHarness({ failShot, blockShot = false, oversize = false, deadlineMs,
  failDispose = false, heapSize = 1024, stallPrivatePage = false, blockPrivateCreate = false, resumeDelayMs = 0, suspendDelayMs = 0, sceneBake, exportedRecipe, runtimeOptions = {}, contextOverrides = {}, lookBytesPerPixel = 0 } = {}) {
  const events = [];
  const sandboxTimers = new Set();
  const viewports = [];
  const deadlines = [];
  let privatePage;
  let sourceRevision = 0;
  let resolveShotStarted;
  const shotStarted = new Promise(resolve => { resolveShotStarted = resolve; });
  let resolveAcquisitionStarted;
  const acquisitionStarted = new Promise(resolve => { resolveAcquisitionStarted = resolve; });
  let resolvePrivatePage;
  const acquiredPage = new Promise(resolve => { resolvePrivatePage = () => resolve(privatePage = new FakePage(true)); });
  const recipe = { format: 'crucible.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [], ...(sceneBake ? { bake: sceneBake } : {}) };
  class FakePage {
    constructor(privateTarget) { this.privateTarget = privateTarget; this.closed = false; }
    route() {}
    setDefaultTimeout() {}
    setViewportSize(size) { this.viewport = size; viewports.push(size); }
    goto() {}
    waitForFunction() {}
    isClosed() { return this.closed; }
    context() { return { newCDPSession: async () => ({
      send: async () => ({ usedSize: heapSize }), detach: async () => { events.push('detach'); },
    }) }; }
    async evaluate(callback, { method, input }) {
      events.push(`${this.privateTarget ? 'private' : 'source'}:${method}`);
      if (method === 'create' && this.privateTarget && blockPrivateCreate) return new Promise((resolve, reject) => { this.rejectShot = reject; });
      if (method === 'create') return { sessionId: input.sessionId, revision: 0 };
      if (method === 'exportRecipe') return { recipe: exportedRecipe, revision: 1 };
      if (method === 'exportGlb') return { data: Buffer.from('glb bytes').toString('base64') };
      if (method === 'snapshot') {
        if (input.expectedRevision !== sourceRevision) throw new Error('Stale revision for render snapshot.');
        return { sourceRevision, recipe };
      }
      if (method === 'reviewShot') {
        resolveShotStarted();
        if (blockShot) return new Promise((resolve, reject) => { this.rejectShot = reject; });
        if (input.index === failShot) throw new Error('Injected partial shot failure');
        return { label: input.shot.label, motionTime: input.shot.motionTime,
          rendererTime: input.shot.rendererTime, graphics: 'SwiftShader', width: 384, height: 384 };
      }
      if (method === 'look') {
        const { width, height } = this.viewport;
        return { mimeType: 'image/png', data: Buffer.alloc(Math.round(width * height * lookBytesPerPixel)).toString('base64'), metadata: { width, height } };
      }
      if (method === 'reviewResult') return { mimeType: 'image/png',
        data: Buffer.alloc(oversize ? 1024 * 1024 + 1 : 16).toString('base64') };
      if (method === 'dispose' && failDispose) throw new Error('Injected disposal failure');
      if (method === 'resume' && resumeDelayMs) await new Promise(resolve => setTimeout(resolve, resumeDelayMs));
      if (method === 'suspend' && suspendDelayMs) await new Promise(resolve => setTimeout(resolve, suspendDelayMs));
      if (method === 'apply') { sourceRevision++; return { revision: sourceRevision }; }
      return {};
    }
    async close() {
      if (this.closed) return;
      this.closed = true;
      events.push(`${this.privateTarget ? 'private' : 'source'}:close`);
      this.rejectShot?.(new Error('Review page closed'));
    }
  }
  const sourcePage = new FakePage(false);
  let pageCount = 0;
  const browser = { isConnected: () => true,
    newPage: async () => {
      if (++pageCount === 1) return sourcePage;
      resolveAcquisitionStarted();
      return stallPrivatePage ? acquiredPage : (privatePage = new FakePage(true));
    },
    close: async () => { await privatePage?.close(); await sourcePage.close(); events.push('browser:close'); },
  };
  const originalSource = await readFile(new URL('../scripts/agent-runtime.mjs', import.meta.url), 'utf8');
  let source = originalSource
    .replace(/^import .+;\r?$/gm, '')
    .replace('export function createAgentRuntime', 'function createAgentRuntime')
    .replaceAll('import.meta.url', JSON.stringify(import.meta.url))
    .replace("import('playwright-core')", 'Promise.resolve({ chromium: globalThis.chromium })');
  if (deadlineMs) source = source.replace('const EVALUATION_TIMEOUT_MS = 30000;', `const EVALUATION_TIMEOUT_MS = ${deadlineMs};`);
  const context = createContext({ ...(await importedBindings(originalSource)),
    packageMetadata: { version: 'test' }, existsSync: () => true, readFile: async () => '',
    createRequire: () => ({ resolve: () => { throw new Error('no peer in tests'); } }),
    runAnnotateSession: async () => ({ outcome: 'timeout' }), openInDefaultBrowser: async () => {},
    createNativeTracerLocator: () => ({ find: async () => ({ reason: 'no native tracer in tests' }) }),
    createAgentRenderJobs: async () => ({ list: () => [], close: async () => {} }), resolveJobRoot: path => path,
    chromium: { launch: async () => browser }, URL, Buffer, AbortController, process, performance, clearTimeout, runtimeOptions, ...contextOverrides,
    setTimeout: (callback, delay) => {
      deadlines.push(delay);
      const timer = setTimeout(callback, delay);
      sandboxTimers.add(timer);
      return timer;
    },
  });
  new Script(`${source}\nglobalThis.runtime = createAgentRuntime({ backend: 'cpu', ...runtimeOptions });`).runInContext(context);
  const runtime = context.runtime;
  openHarnesses.push({ runtime, sandboxTimers, releasePages: () => { resolvePrivatePage(); privatePage?.rejectShot?.(new Error('Harness cleanup')); } });
  const created = await runtime.create({ recipe });
  return { runtime, sessionId: created.sessionId, deadlines, events, viewports, shotStarted, acquisitionStarted, resolvePrivatePage };
}

function boundedResult(promise) {
  let timer;
  return Promise.race([promise.then(() => 'settled', () => 'settled'),
    new Promise(resolve => { timer = setTimeout(() => resolve('stalled'), 150); }),
  ]).finally(() => clearTimeout(timer));
}

runTest('scene_look steps a busy PNG down by 0.75 until it fits the 1 MiB budget and says which size came back (#1197)', async () => {
  const busy = await reviewRuntimeHarness({ lookBytesPerPixel: 2 });
  const stepped = await busy.runtime.look({ sessionId: busy.sessionId, width: 1024, height: 640 });
  assert.deepEqual(busy.viewports.slice(-2).map(size => `${size.width}x${size.height}`), ['1024x640', '768x480']);
  assert.equal(stepped.metadata.returnedWidth, 768);
  assert.equal(stepped.metadata.returnedHeight, 480);
  await busy.runtime.close();
  assert.equal(stepped.metadata.requestedWidth, 1024);
  assert.match(stepped.metadata.note, /1024x640.*768x480/);
  const calm = await reviewRuntimeHarness({ lookBytesPerPixel: 0.5 });
  const unchanged = await calm.runtime.look({ sessionId: calm.sessionId, width: 1024, height: 640 });
  assert.equal(calm.viewports.length, 1);
  assert.equal(unchanged.metadata.note, undefined);
  await calm.runtime.close();
});

runTest('scene_look fails only when the fourth step down still does not fit, naming that size (#1197)', async () => {
  const hopeless = await reviewRuntimeHarness({ lookBytesPerPixel: 50 });
  await assert.rejects(hopeless.runtime.look({ sessionId: hopeless.sessionId, width: 1024, height: 640 }), /even at 324x202/);
  assert.equal(hopeless.viewports.length, 5);
  await hopeless.runtime.close();
});

runTest('an edit of a scene with a bake, or one that adds a bake, gets the bake deadline; a plain edit keeps 30 s', async () => {
  const plain = await reviewRuntimeHarness();
  await plain.runtime.apply({ sessionId: plain.sessionId, operations: [{ type: 'set-camera', camera: {} }] });
  await plain.runtime.apply({ sessionId: plain.sessionId, operations: [{ type: 'set-bake', bake: { preset: 'draft' } }] });
  await plain.runtime.apply({ sessionId: plain.sessionId, operations: [{ type: 'set-camera', camera: {} }] });
  await plain.runtime.apply({ sessionId: plain.sessionId, operations: [{ type: 'set-bake', bake: null }] });
  await plain.runtime.apply({ sessionId: plain.sessionId, operations: [{ type: 'set-camera', camera: {} }] });
  const applyDeadlines = plain.deadlines.slice(-5);
  assert.deepEqual(applyDeadlines, [30000, 120000, 120000, 120000, 30000]);
  await plain.runtime.close();
  const baked = await reviewRuntimeHarness({ sceneBake: { preset: 'draft' } });
  assert.equal(baked.deadlines.at(-1), 120000, 'creating a scene with a bake gets the bake deadline');
  await baked.runtime.apply({ sessionId: baked.sessionId, operations: [{ type: 'set-node', id: 'a' }] });
  assert.equal(baked.deadlines.at(-1), 120000, 'moving a part in a baked scene gets the bake deadline');
  await baked.runtime.close();
});

runTest('review deadline rejects stalled page acquisition and disposes a late page', async () => {
  const { runtime, sessionId, events, acquisitionStarted, resolvePrivatePage } = await reviewRuntimeHarness({
    stallPrivatePage: true, deadlineMs: 40,
  });
  const pending = runtime.review({ sessionId, expectedRevision: 0, shots: [{}] });
  try {
    await startedOrFailed(acquisitionStarted, pending);
    assert.equal(await boundedResult(pending), 'settled', 'deadline must reject without waiting for newPage');
    await assert.rejects(pending, /deadline/);
    assert.equal((await runtime.capabilities()).phase, 'ready');
    resolvePrivatePage();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(events.includes('private:close'));
    assert.ok(!events.includes('private:create'));
    assert.equal((await runtime.apply({ sessionId })).revision, 1);
  } finally {
    resolvePrivatePage();
    await pending.catch(() => {});
    await runtime.close();
  }
});

runTest('close interrupts stalled page acquisition and late resolution cannot resurrect the runtime', async () => {
  const { runtime, sessionId, events, acquisitionStarted, resolvePrivatePage } = await reviewRuntimeHarness({ stallPrivatePage: true });
  const pending = runtime.review({ sessionId, expectedRevision: 0, shots: [{}] });
  pending.catch(() => {});
  await startedOrFailed(acquisitionStarted, pending);
  const closing = runtime.close();
  try {
    assert.equal(await boundedResult(closing), 'settled', 'close must not wait for newPage');
    await closing;
    await assert.rejects(pending, /closing|closed/);
    assert.ok(events.includes('browser:close'));
    resolvePrivatePage();
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(events.includes('private:close'));
    assert.ok(!events.includes('private:create'));
    assert.ok(!events.includes('source:resume'));
    assert.equal((await runtime.capabilities()).phase, 'closed');
  } finally {
    resolvePrivatePage();
    await pending.catch(() => {});
    await closing;
  }
});

runTest('review queue releases private renderer before source resume, including partial and size failures', async () => {
  for (const options of [{}, { failShot: 1 }, { oversize: true }, { heapSize: 256 * 1024 ** 2 + 1 }]) {
    const { runtime, sessionId, events } = await reviewRuntimeHarness(options);
    try {
      const pending = runtime.review({ sessionId, expectedRevision: 0, shots: [{ motionTime: 1 }, {}] });
      if (options.failShot !== undefined || options.oversize || options.heapSize) await assert.rejects(pending, /partial shot|1 MiB|heap guard/);
      else {
        const result = await pending;
        assert.equal(result.metadata.sourceRevision, 0);
        assert.equal(result.metadata.shots[1].motionTime, null);
        assert.equal(result.metadata.maximumPendingFrames, 1);
      }
      assert.ok(events.indexOf('private:dispose') < events.indexOf('private:close'));
      assert.ok(events.indexOf('private:close') < events.indexOf('source:resume'));
      assert.equal(events.filter(event => event === 'source:resume').length, 1);
      assert.equal((await runtime.apply({ sessionId })).revision, 1);
    } finally { await runtime.close(); }
  }
});

runTest('queued review detaches its request before a caller can mutate shot clocks', async () => {
  const { runtime, sessionId } = await reviewRuntimeHarness();
  try {
    const input = { sessionId, expectedRevision: 0, shots: [{ motionTime: 1 }] };
    const pending = runtime.review(input);
    input.shots[0].motionTime = 99;
    input.shots.push({ motionTime: 88 });
    const result = await pending;
    assert.equal(result.metadata.shots.length, 1);
    assert.equal(result.metadata.shots[0].motionTime, 1);
  } finally { await runtime.close(); }
});

runTest('successful review elapsed time includes source renderer recovery', async () => {
  const { runtime, sessionId } = await reviewRuntimeHarness({ resumeDelayMs: 30 });
  try {
    const result = await runtime.review({ sessionId, expectedRevision: 0, shots: [{}] });
    assert.ok(result.metadata.elapsedSeconds >= 0.02, 'elapsed must include the delayed source resume');
    assert.equal((await runtime.capabilities()).phase, 'ready');
  } finally { await runtime.close(); }
});

runTest('total review deadline closes private page and restores the usable source', async () => {
  const { runtime, sessionId, events } = await reviewRuntimeHarness({ blockShot: true, deadlineMs: 40 });
  try {
    await assert.rejects(runtime.review({ sessionId, expectedRevision: 0, shots: [{}] }), /total 30 second deadline/);
    assert.ok(events.includes('private:close'));
    assert.ok(events.includes('source:resume'));
    assert.equal((await runtime.capabilities()).phase, 'ready');
    assert.equal((await runtime.apply({ sessionId })).revision, 1);
  } finally { await runtime.close(); }
});

runTest('a job cut short by its deadline leaves the runtime usable although the scene page is slow to resume (#1256)', async () => {
  let runJob;
  const controller = { list: () => [], close: async () => {}, submit: async () => ({ jobId: 'job' }) };
  const { runtime, sessionId, events } = await reviewRuntimeHarness({ blockPrivateCreate: true, resumeDelayMs: 100, deadlineMs: 40,
    runtimeOptions: { jobs: join(tmpdir(), 'crucible-job-root-test') },
    contextOverrides: { createAgentRenderJobs: async ({ run }) => { runJob = run; return controller; } } });
  try {
    await runtime.submitJob({ sessionId, expectedRevision: 0, settings: { kind: 'image', width: 64, height: 64 } });
    const abortController = new AbortController();
    setTimeout(() => abortController.abort(new Error('Render job exceeded its elapsed deadline.')), 20);
    await assert.rejects(runJob({ jobId: randomUUID(), sessionId, directory: tmpdir(), snapshot: { recipe: {} },
      settings: { kind: 'image', width: 64, height: 64 }, signal: abortController.signal, progress: async () => {} }), /Review page closed/);
    assert.ok(events.includes('source:resume'));
    assert.equal((await runtime.capabilities()).phase, 'ready');
    assert.equal((await runtime.apply({ sessionId })).revision, 1);
  } finally { await runtime.close(); }
});

runTest('a slow suspend at job start does not fail the runtime (#1256)', async () => {
  let runJob;
  const controller = { list: () => [], close: async () => {}, submit: async () => ({ jobId: 'job' }) };
  const { runtime, sessionId, events } = await reviewRuntimeHarness({ blockPrivateCreate: true, suspendDelayMs: 100, deadlineMs: 40,
    runtimeOptions: { jobs: join(tmpdir(), 'crucible-job-root-test') },
    contextOverrides: { createAgentRenderJobs: async ({ run }) => { runJob = run; return controller; } } });
  try {
    await runtime.submitJob({ sessionId, expectedRevision: 0, settings: { kind: 'image', width: 64, height: 64 } });
    const abortController = new AbortController();
    setTimeout(() => abortController.abort(new Error('Render job exceeded its elapsed deadline.')), 150);
    await assert.rejects(runJob({ jobId: randomUUID(), sessionId, directory: tmpdir(), snapshot: { recipe: {} },
      settings: { kind: 'image', width: 64, height: 64 }, signal: abortController.signal, progress: async () => {} }));
    assert.ok(events.includes('source:suspend'));
    assert.equal((await runtime.capabilities()).phase, 'ready');
  } finally { await runtime.close(); }
});

runTest('private disposal failure still closes its page before restoring source', async () => {
  const { runtime, sessionId, events } = await reviewRuntimeHarness({ failDispose: true });
  try {
    await assert.rejects(runtime.review({ sessionId, expectedRevision: 0, shots: [{}] }), /disposal failure/);
    assert.ok(events.indexOf('private:close') < events.indexOf('source:resume'));
    assert.equal((await runtime.capabilities()).phase, 'ready');
  } finally { await runtime.close(); }
});

runTest('review stale revisions and strict runtime fields reject before leasing source', async () => {
  const { runtime, sessionId, events } = await reviewRuntimeHarness();
  try {
    await assert.rejects(runtime.review({ sessionId, expectedRevision: 1, shots: [{}] }), /Stale/);
    await assert.rejects(runtime.review({ sessionId, expectedRevision: 0, shots: [{ url: 'https://example.com' }] }), /unknown/i);
    assert.ok(!events.includes('source:suspend'));
    assert.equal((await runtime.apply({ sessionId })).revision, 1);
  } finally { await runtime.close(); }
});

runTest('runtime close promptly aborts a pending private review and skips source resume', async () => {
  const { runtime, sessionId, events, shotStarted } = await reviewRuntimeHarness({ blockShot: true });
  const pending = runtime.review({ sessionId, expectedRevision: 0, shots: [{}] });
  const rejected = assert.rejects(pending, /closed/);
  await startedOrFailed(shotStarted, pending);
  assert.equal((await runtime.capabilities()).phase, 'reviewing');
  await runtime.close();
  await rejected;
  assert.ok(events.includes('private:close'));
  assert.ok(events.includes('browser:close'));
  assert.ok(!events.includes('source:resume'));
  assert.equal((await runtime.capabilities()).phase, 'closed');
});

runTest('invalid preview configuration rejects before any browser or renderer allocation', () => {
  assert.throws(() => createAgentRuntime({ backend: 'fake' }), /backend/);
  for (const memory of [0, 31, 385, 1024, 64.5, NaN]) {
    assert.throws(() => createAgentRuntime({ memory }), /memory/);
  }
  assert.throws(() => createAgentRuntime({ browser: 'does-not-exist-browser.exe' }), /browser/);
  assert.throws(() => createAgentRuntime({ assets: 'relative-path' }), /absolute/);
});

runTest('requests cannot address an absent session or enter a closing runtime', async () => {
  const runtime = createAgentRuntime();
  await assert.rejects(runtime.inspect({ sessionId: 'missing' }), /Unknown|No scene is active/);
  await assert.rejects(runtime.look({ sessionId: 'missing' }), /Unknown|No scene is active/);
  const closing = runtime.close();
  await assert.rejects(runtime.checkpoint({ sessionId: 'missing' }), /closing|closed/);
  await closing;
});

runTest('runtime close settles a pending scene_ask_user at once and stops its page server (#1246)', async () => {
  let sessionSignal;
  const waitForSignal = async ({ signal }) => {
    sessionSignal = signal;
    return new Promise(resolve => signal.addEventListener('abort', () => resolve({ outcome: 'aborted' }), { once: true }));
  };
  const { runtime, sessionId } = await reviewRuntimeHarness({ contextOverrides: { runAnnotateSession: waitForSignal } });
  const asking = runtime.askUser({ sessionId, timeoutSeconds: 600 });
  const askingOutcome = asking.then(() => 'resolved', error => error.message);
  while (!sessionSignal) await new Promise(resolve => setTimeout(resolve, 5));
  const started = performance.now();
  await runtime.close();
  assert.match(await askingOutcome, /closed|closing/);
  assert.ok(sessionSignal.aborted);
  assert.ok(performance.now() - started < 3000);
});

runTest('a failed browser launch leaves the runtime idle so the next call retries (#1246)', async () => {
  const runtime = createAgentRuntime({ backend: 'cpu', memory: 64, browser: process.execPath });
  after(() => runtime.close());
  const first = await runtime.create({ recipe: {} }).then(() => undefined, error => error.message);
  assert.ok(first, 'a node executable is not a browser, so the first launch must fail');
  assert.equal((await runtime.capabilities()).phase, 'idle');
  const second = await runtime.create({ recipe: {} }).then(() => undefined, error => error.message);
  assert.ok(second);
  assert.doesNotMatch(second, /The agent runtime is failed/);
});

runTest('a recipe over the combined asset limit is refused from file sizes before any grid file is read (#1246)', async () => {
  const gridDirectory = await mkdtemp(join(tmpdir(), 'crucible-grid-limit-'));
  const previousDirectory = process.env.JS67_GRID_DIRECTORY;
  process.env.JS67_GRID_DIRECTORY = gridDirectory;
  after(async () => {
    if (previousDirectory === undefined) delete process.env.JS67_GRID_DIRECTORY;
    else process.env.JS67_GRID_DIRECTORY = previousDirectory;
    await rm(gridDirectory, { recursive: true, force: true });
  });
  const frameBytes = 40 * 1024 * 1024;
  for (const name of ['first.67vg', 'second.67vg']) {
    await writeFile(join(gridDirectory, name), '');
    await truncate(join(gridDirectory, name), frameBytes);
  }
  let gridReads = 0;
  const countingRead = (...argumentsList) => {
    gridReads++;
    return readVolumeGridFiles(...argumentsList);
  };
  const { runtime } = await reviewRuntimeHarness({ contextOverrides: { readVolumeGridFiles: countingRead } });
  gridReads = 0;
  const recipe = { format: 'crucible.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [],
    environment: { localVolumes: [{ shape: 'grid', frames: ['first.67vg', 'second.67vg'] }] } };
  await assert.rejects(runtime.create({ recipe }), error => error instanceof RangeError
    && error.message.includes('maxCombinedBytes') && error.message.includes(String(2 * frameBytes)));
  assert.equal(gridReads, 0);
});

// A catalog that reports sizes and counts how often a file is read, so a test can prove a call was refused before any read.
function countingCatalog(sizeByAssetId) {
  const counts = { sizeCalls: 0, reads: 0 };
  const catalog = {
    counts,
    list: () => ({ assets: [] }),
    size: async assetId => {
      counts.sizeCalls++;
      return sizeByAssetId[assetId];
    },
    read: async () => {
      counts.reads++;
      return Buffer.alloc(0);
    },
  };
  return catalog;
}

const catalogAssetIds = ['a', 'b', 'c'].map(letter => letter.repeat(64));

async function catalogLimitHarness(sizeEach) {
  const catalog = countingCatalog(Object.fromEntries(catalogAssetIds.map(assetId => [assetId, sizeEach])));
  const harness = await reviewRuntimeHarness({
    runtimeOptions: { assets: join(tmpdir(), 'crucible-counting-catalog') },
    contextOverrides: { createAgentAssetCatalog: async () => catalog },
  });
  catalog.counts.sizeCalls = 0;
  return { ...harness, catalog };
}

function refusedAtTotal(total) {
  return error => error instanceof RangeError && error.message.includes('maxCombinedBytes') && error.message.includes(String(total));
}

runTest('placed catalog assets over the combined limit are refused from sizes before any read (#1246)', async () => {
  const sizeEach = 30 * 1024 * 1024;
  const { runtime, catalog } = await catalogLimitHarness(sizeEach);
  const recipe = { format: 'crucible.scene', schemaVersion: 1, geometries: [], materials: [],
    nodes: catalogAssetIds.map((assetId, index) => ({ id: `placed-${index}`, asset: { id: assetId } })) };
  await assert.rejects(runtime.create({ recipe }), refusedAtTotal(3 * sizeEach));
  assert.equal(catalog.counts.sizeCalls, 3);
  assert.equal(catalog.counts.reads, 0);
});

runTest('map sequence frames over the combined limit are refused from sizes before any read (#1246)', async () => {
  const sizeEach = 40 * 1024 * 1024;
  const { runtime, catalog } = await catalogLimitHarness(sizeEach);
  const recipe = { format: 'crucible.scene', schemaVersion: 1, geometries: [], nodes: [],
    materials: [{ id: 'screen', map: { sequence: { frames: catalogAssetIds.slice(0, 2), fps: 24 } } }] };
  await assert.rejects(runtime.create({ recipe }), refusedAtTotal(2 * sizeEach));
  assert.equal(catalog.counts.reads, 0);
});

runTest('motion source assets count in the sum before a scene_apply reads them (#1246)', async () => {
  const sizeEach = 30 * 1024 * 1024;
  const { runtime, sessionId, catalog } = await catalogLimitHarness(sizeEach);
  const motion = { layers: catalogAssetIds.map(assetId => ({ from: { asset: assetId } })) };
  await assert.rejects(runtime.apply({ sessionId, operations: [{ type: 'set-motion', motion }] }), refusedAtTotal(3 * sizeEach));
  assert.equal(catalog.counts.reads, 0);
});

// The same GLB with one extra field in its JSON chunk, so the catalog gives it another asset id.
function withDistinctDocument(bytes, marker) {
  const jsonLength = bytes.readUInt32LE(12);
  const document = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
  document.asset = { ...document.asset, extras: { marker } };
  const json = Buffer.from(JSON.stringify(document));
  const paddedLength = Math.ceil(json.length / 4) * 4;
  const binary = bytes.subarray(20 + jsonLength);
  const result = Buffer.alloc(20 + paddedLength + binary.length, 32);
  bytes.copy(result, 0, 0, 20);
  result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(paddedLength, 12);
  json.copy(result, 20);
  binary.copy(result, 20 + paddedLength);
  return result;
}

runTest('two textured GLBs whose embedded images pass the combined limit are refused by the real catalog (#1282)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crucible-textured-limit-'));
  try {
    await cp(new URL('./fixtures/kenney-boat/', import.meta.url), directory, { recursive: true });
    const boat = await readFile(join(directory, 'boat-fishing-small.glb'));
    const secondBoat = withDistinctDocument(boat, 'second');
    await writeFile(join(directory, 'boat-second.glb'), secondBoat);
    const sharedImageBytes = Buffer.alloc(34 * 1024 * 1024);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(sharedImageBytes);
    await writeFile(join(directory, 'Textures', 'colormap.png'), sharedImageBytes);
    const onDiskTotal = boat.length + secondBoat.length + sharedImageBytes.length;
    assert.ok(onDiskTotal < AGENT_ASSET_LIMITS.maxCombinedBytes, 'on disk the files fit, so only the embedded sizes can trip the limit');
    const realCatalog = await createAgentAssetCatalog(directory);
    let reads = 0;
    const countingRealCatalog = {
      list: () => realCatalog.list(),
      size: assetId => realCatalog.size(assetId),
      read: assetId => {
        reads++;
        return realCatalog.read(assetId);
      },
    };
    const { runtime } = await reviewRuntimeHarness({
      runtimeOptions: { assets: directory },
      contextOverrides: { createAgentAssetCatalog: async () => countingRealCatalog },
    });
    const assetIds = realCatalog.list().assets.map(asset => asset.assetId);
    assert.equal(assetIds.length, 2);
    const recipe = { format: 'crucible.scene', schemaVersion: 1, geometries: [], materials: [],
      nodes: assetIds.map((assetId, index) => ({ id: `boat-${index}`, asset: { id: assetId } })) };
    await assert.rejects(runtime.create({ recipe }), error => error instanceof RangeError && error.message.includes('maxCombinedBytes'));
    assert.equal(reads, 0, 'the refusal comes from size() before any file is read and base64 encoded');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

runTest('the preview server accepts only its own loopback host', () => {
  assert.equal(isPreviewHost('127.0.0.1:4100', 4100), true);
  assert.equal(isPreviewHost('evil.example:4100', 4100), false);
  assert.equal(isPreviewHost('localhost:4100', 4100), false);
  assert.equal(isPreviewHost('127.0.0.1:4101', 4100), false);
  assert.equal(isPreviewHost(undefined, 4100), false);
});

async function webExportHarness({ exportedRecipe, failCopy = () => false, seedJobsDirectory } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'crucible-web-runtime-'));
  const buildDirectory = join(root, 'build');
  await mkdir(join(buildDirectory, 'mcp'), { recursive: true });
  await writeFile(join(buildDirectory, 'game.js'), 'export {};');
  const jobsDirectory = join(root, 'jobs');
  await mkdir(jobsDirectory);
  await seedJobsDirectory?.(jobsDirectory);
  const failingWriteWebBuild = async options => {
    if (failCopy()) {
      await mkdir(join(options.outputDirectory, 'engine'), { recursive: true });
      throw new Error('Injected copy failure');
    }
    return writeWebBuild(options);
  };
  const harness = await reviewRuntimeHarness({
    exportedRecipe,
    runtimeOptions: { jobs: jobsDirectory, previewUrl: pathToFileURL(join(buildDirectory, 'mcp', 'preview.js')) },
    contextOverrides: { writeWebBuild: failingWriteWebBuild },
  });
  const keptBuilds = async () => (await readdir(join(jobsDirectory, EXPORT_DIRECTORY_NAME))).filter(name => name.startsWith('web-'));
  after(() => harness.runtime.close());
  return { ...harness, keptBuilds };
}

const PLAYABLE_RECIPE = { format: 'crucible.scene', schemaVersion: 1, geometries: [], materials: [], nodes: [], game: { player: { node: 'creature' }, physics: false } };

runTest('exportWeb keeps only the newest four builds and returns a real entry page', async () => {
  const { runtime, sessionId, keptBuilds } = await webExportHarness({ exportedRecipe: PLAYABLE_RECIPE });
  const entries = [];
  for (let index = 0; index < 5; index++) entries.push((await runtime.exportWeb({ sessionId })).entry);
  assert.equal((await keptBuilds()).length, 4);
  await assert.rejects(stat(entries[0]), { code: 'ENOENT' });
  for (const entry of entries.slice(1)) assert.ok((await stat(entry)).isFile());
});

// Files and folders an earlier server run left in the exports folder, oldest first (modified one minute apart).
async function leaveEarlierExports(jobsDirectory, { glbCount, webBuildCount }) {
  const exportsDirectory = join(jobsDirectory, EXPORT_DIRECTORY_NAME);
  await mkdir(exportsDirectory);
  const names = [
    ...Array.from({ length: glbCount }, () => `${randomUUID()}.glb`),
    ...Array.from({ length: webBuildCount }, () => `web-${randomUUID()}`),
  ];
  const start = Date.now() / 1000 - 3600;
  for (const [index, name] of names.entries()) {
    const path = join(exportsDirectory, name);
    if (name.startsWith('web-')) await mkdir(path);
    else await writeFile(path, 'earlier glb');
    await utimes(path, start + index * 60, start + index * 60);
  }
  return names.map(name => join(exportsDirectory, name));
}

runTest('exports left by an earlier run count toward the newest four web builds and eight GLBs (#1246)', async () => {
  let earlier;
  const { runtime, sessionId, keptBuilds } = await webExportHarness({ exportedRecipe: PLAYABLE_RECIPE,
    seedJobsDirectory: async directory => { earlier = await leaveEarlierExports(directory, { glbCount: 8, webBuildCount: 4 }); } });
  const glbEarlier = earlier.filter(path => path.endsWith('.glb'));
  const webEarlier = earlier.filter(path => !path.endsWith('.glb'));
  await runtime.exportWeb({ sessionId });
  assert.equal((await keptBuilds()).length, 4);
  await assert.rejects(stat(webEarlier[0]), { code: 'ENOENT' });
  assert.ok((await stat(webEarlier[1])).isDirectory());
  await runtime.exportGlb({ sessionId });
  const keptGlbs = (await readdir(join(dirname(webEarlier[0])))).filter(name => name.endsWith('.glb'));
  assert.equal(keptGlbs.length, 8);
  await assert.rejects(stat(glbEarlier[0]), { code: 'ENOENT' });
  assert.ok((await stat(glbEarlier[1])).isFile());
});

runTest('a half-written web export is removed and never evicts or uses up a kept build', async () => {
  let breakCopy = false;
  const { runtime, sessionId, keptBuilds } = await webExportHarness({ exportedRecipe: PLAYABLE_RECIPE, failCopy: () => breakCopy });
  const goodEntries = [];
  for (let index = 0; index < 4; index++) goodEntries.push((await runtime.exportWeb({ sessionId })).entry);
  breakCopy = true;
  for (let attempt = 0; attempt < 5; attempt++) await assert.rejects(runtime.exportWeb({ sessionId }), /Injected copy failure/);
  assert.equal((await keptBuilds()).length, 4);
  for (const entry of goodEntries) assert.ok((await stat(entry)).isFile());
});

runTest('exportWeb refuses a scene without a game or with physics, and earlier builds stay', async () => {
  const { runtime, sessionId, keptBuilds } = await webExportHarness({ exportedRecipe: PLAYABLE_RECIPE });
  await runtime.exportWeb({ sessionId });
  const refused = [
    [{ ...PLAYABLE_RECIPE, game: undefined }, /no game/],
    [{ ...PLAYABLE_RECIPE, game: { ...PLAYABLE_RECIPE.game, physics: true } }, /game\.physics is true/],
  ];
  for (const [recipe, message] of refused) {
    const refusing = await webExportHarness({ exportedRecipe: recipe });
    for (let attempt = 0; attempt < 5; attempt++) await assert.rejects(refusing.runtime.exportWeb({ sessionId: refusing.sessionId }), message);
    assert.equal((await refusing.keptBuilds().catch(() => [])).length, 0);
  }
  assert.equal((await keptBuilds()).length, 1);
});

runTest('exportWeb needs a jobs folder', async () => {
  const harness = await reviewRuntimeHarness({ exportedRecipe: PLAYABLE_RECIPE });
  after(() => harness.runtime.close());
  await assert.rejects(harness.runtime.exportWeb({ sessionId: harness.sessionId }), /--jobs/);
});
