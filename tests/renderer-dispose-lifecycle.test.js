// A renderer disposed while its programs are still linking leaves no GPU objects behind, and resize on a lost context stays quiet (#1266).
// It runs in headless Chrome from the Vite dev server; it skips locally when Chrome cannot start and fails on CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withDevServerPage } from './helpers/dev-server-browser.js';

// Runs the scenario on a fresh deferred renderer whose context counts live objects per kind.
async function liveObjectsAfter(page, scenarioSource, { withEnvironment = false } = {}) {
  return page.evaluate(async ({ source, withEnvironment }) => {
    const { box } = await import('/src/geometry.js');
    const { CrucibleRenderer } = await import('/src/renderer.js');
    const { createEnvironmentMap } = await import('/src/environment.js');
    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const material = { tag: 'surface', color: [0.5, 0.5, 0.5], metallic: 0, roughness: 0.5, emission: 0 };
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    document.body.append(canvas);
    const context = canvas.getContext('webgl2');
    const live = new Map();
    for (const kind of ['Program', 'Shader', 'Texture', 'Framebuffer', 'Renderbuffer']) {
      const create = context[`create${kind}`].bind(context);
      const remove = context[`delete${kind}`].bind(context);
      context[`create${kind}`] = (...args) => {
        const object = create(...args);
        live.set(object, kind);
        return object;
      };
      context[`delete${kind}`] = (object) => {
        live.delete(object);
        return remove(object);
      };
    }
    const renderer = new CrucibleRenderer(canvas, [{ name: 'box', geometry: box(0, 1), matrix: identity, material }], { samples: 1, pixelRatio: 1, deferProgramLink: true, ...(withEnvironment ? { environment: { map: createEnvironmentMap({ width: 8, height: 4, data: new Float32Array(8 * 4 * 3).fill(0.5) }) } } : {}) });
    const scenario = new Function('renderer', 'context', `return (async () => { ${source} })();`);
    let error = null;
    try {
      await scenario(renderer, context);
    } catch (thrown) {
      error = thrown.message;
    }
    const counts = {};
    for (const kind of live.values()) counts[kind] = (counts[kind] ?? 0) + 1;
    return { counts, error };
  }, { source: scenarioSource, withEnvironment });
}

// SwiftShader has no KHR_parallel_shader_compile, so programsReady would finish at once. This stub makes the extension exist and every link report
// "still compiling", which is what a real GPU driver does for a while, so the wait loop actually runs.
const SIMULATE_SLOW_DRIVER = `
  const realGetExtension = context.getExtension.bind(context);
  context.getExtension = (name) => (name === 'KHR_parallel_shader_compile' ? { COMPLETION_STATUS_KHR: 0x91B1 } : realGetExtension(name));
  const realGetProgramParameter = context.getProgramParameter.bind(context);
  context.getProgramParameter = (program, parameter) => (parameter === 0x91B1 ? false : realGetProgramParameter(program, parameter));
`;
// Resolves 'settled' when the promise finishes, or 'hung' when it is still waiting after the timeout.
const SETTLES_OR_HANGS = `
  const settlement = (promise) => Promise.race([promise.then(() => 'settled'), new Promise(resolve => setTimeout(() => resolve('hung'), 1500))]);
`;

test('dispose before programsReady deletes the pending programs and shaders', async (testContext) => {
  await withDevServerPage(testContext, async (page) => {
    const result = await liveObjectsAfter(page, 'renderer.dispose();');
    assert.equal(result.error, null);
    assert.deepEqual(result.counts, {});
  });
});

test('programsReady after dispose builds nothing on the disposed renderer', async (testContext) => {
  await withDevServerPage(testContext, async (page) => {
    const result = await liveObjectsAfter(page, 'renderer.dispose(); await renderer.programsReady(); await renderer.prepareFrame({});');
    assert.equal(result.error, null);
    assert.deepEqual(result.counts, {});
  });
});

test('dispose while programsReady is waiting settles it without building', async (testContext) => {
  await withDevServerPage(testContext, async (page) => {
    const result = await liveObjectsAfter(page, `${SIMULATE_SLOW_DRIVER}${SETTLES_OR_HANGS}
      const ready = renderer.programsReady();
      await new Promise(resolve => setTimeout(resolve, 50));
      renderer.dispose();
      if (await settlement(ready) !== 'settled') throw new Error('programsReady kept waiting after dispose');
    `);
    assert.equal(result.error, null);
    assert.deepEqual(result.counts, {});
  });
});

test('dispose while prepareFrame is waiting resolves false without building', async (testContext) => {
  await withDevServerPage(testContext, async (page) => {
    const result = await liveObjectsAfter(page, `${SIMULATE_SLOW_DRIVER}${SETTLES_OR_HANGS}
      const prepared = renderer.prepareFrame({});
      await new Promise(resolve => setTimeout(resolve, 50));
      renderer.dispose();
      if (await settlement(prepared) !== 'settled') throw new Error('prepareFrame kept waiting after dispose');
      if (await prepared !== false) throw new Error('prepareFrame must resolve false on a disposed renderer');
    `);
    assert.equal(result.error, null);
    assert.deepEqual(result.counts, {});
  });
});

test('dispose before programsReady frees the environment map programs too', async (testContext) => {
  await withDevServerPage(testContext, async (page) => {
    const result = await liveObjectsAfter(page, 'renderer.dispose();', { withEnvironment: true });
    assert.equal(result.error, null);
    assert.deepEqual(result.counts, {});
  });
});

test('resize on a lost context returns without the dimensions error', async (testContext) => {
  await withDevServerPage(testContext, async (page) => {
    const result = await liveObjectsAfter(page, `
      await renderer.programsReady();
      context.getExtension('WEBGL_lose_context').loseContext();
      await new Promise(resolve => setTimeout(resolve, 50));
      renderer.resize();
      renderer.render({ eye: [3, 2, 3] });
      renderer.dispose();
    `);
    assert.equal(result.error, null);
    assert.deepEqual(result.counts, {});
  });
});
