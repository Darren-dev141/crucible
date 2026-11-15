// A renderer disposed while its programs are still linking leaves no GPU objects behind, and resize on a lost context stays quiet (#1266).
// It runs in headless Chrome from the Vite dev server; it skips locally when Chrome cannot start and fails on CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { withDevServerPage } from './helpers/dev-server-browser.js';

// Runs the scenario on a fresh deferred renderer whose context counts live objects per kind.
async function liveObjectsAfter(page, scenarioSource) {
  return page.evaluate(async (source) => {
    const { box } = await import('/src/geometry.js');
    const { CrucibleRenderer } = await import('/src/renderer.js');
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
    const renderer = new CrucibleRenderer(canvas, [{ name: 'box', geometry: box(0, 1), matrix: identity, material }], { samples: 1, pixelRatio: 1, deferProgramLink: true });
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
  }, scenarioSource);
}

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
    const result = await liveObjectsAfter(page, 'const ready = renderer.programsReady(); renderer.dispose(); await ready;');
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
      renderer.dispose();
    `);
    assert.equal(result.error, null);
  });
});
