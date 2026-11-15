// The WebGPU path tracer kernels compile with FXC, the D3D12 compiler Dawn uses where dxcompiler.dll is missing (#1350): the bundled Chromium on Windows is such a browser.
// The megakernel used to fail there with E_FAIL because the shadow ray traversal was inlined once per branch of addLights. FXC exists only on Windows, so elsewhere this skips.
import assert from 'node:assert/strict';
import test from 'node:test';
import { withWebGpuPage } from './helpers/webgpu-page.js';

async function compileKernels() {
  const kernel = await import('/src/path-tracer-webgpu-kernel.js');
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();
  const variants = {
    'megakernel': { code: kernel.buildMegakernelSource({ hasVolume: false, hasSubsurface: false }), entries: ['main'] },
    'megakernel with a volume and subsurface': { code: kernel.buildMegakernelSource({ hasVolume: true, hasSubsurface: true }), entries: ['main'] },
    'wavefront': { code: kernel.WAVEFRONT_SOURCE, entries: ['generatePaths', 'extendPaths', 'shadePaths', 'shadowPaths', 'resolvePaths'] },
  };
  const failures = [];
  for (const [name, { code, entries }] of Object.entries(variants)) {
    const module = device.createShaderModule({ code });
    for (const entryPoint of entries) {
      device.pushErrorScope('validation');
      try {
        await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint } });
      } catch (error) {
        failures.push(`${name} ${entryPoint}: ${String(error.message).split('\n')[0]}`);
      }
      await device.popErrorScope();
    }
  }
  return failures;
}

test('the bundled Chromium compiles every path tracer kernel with FXC', async context => {
  if (process.platform !== 'win32') {
    context.skip('FXC is the Windows D3D12 compiler');
    return;
  }
  await withWebGpuPage(context, async page => {
    assert.deepEqual(await page.evaluate(compileKernels), []);
  }, { bundled: true });
});
