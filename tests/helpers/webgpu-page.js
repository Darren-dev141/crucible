// Starts the Vite dev server and headless Chrome with a WebGPU adapter for the tests that run the WebGPU path tracer on real hardware.
// Where Chrome, playwright or an adapter is missing the test skips on a developer machine and fails on CI, as withDevServerPage does.
import { spawn } from 'node:child_process';
import { freePort } from './free-port.js';
import { skipOrThrow } from './dev-server-browser.js';

const WEBGPU_ARGUMENTS = [process.platform === 'win32' ? '--use-angle=d3d11' : '--use-angle=swiftshader', '--enable-unsafe-webgpu', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-features=Vulkan'];

async function startServer(port) {
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('The dev server did not start.')), 30000);
    server.stdout.on('data', data => {
      if (/ready in/.test(data.toString())) {
        clearTimeout(timeout);
        resolve();
      }
    });
    server.on('exit', code => {
      clearTimeout(timeout);
      reject(new Error(`The dev server exited ${code}.`));
    });
  });
  return server;
}

// The Google Chrome install ships dxcompiler.dll, which Dawn needs to compile the path tracer kernel for D3D12 on Windows; the bundled test Chromium does not, and its FXC fallback fails on the kernel.
async function launchWebGpuChrome(chromium) {
  try {
    return await chromium.launch({ headless: true, channel: 'chrome', args: WEBGPU_ARGUMENTS });
  } catch {
    return chromium.launch({ headless: true, args: WEBGPU_ARGUMENTS });
  }
}

/** Runs `body(page)` on the dev server's page in headless Chrome with a WebGPU adapter, and cleans up. */
export async function withWebGpuPage(testContext, body) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    skipOrThrow(testContext, 'playwright is not installed');
    return;
  }
  const port = await freePort();
  const server = await startServer(port);
  let browser;
  try {
    try {
      browser = await launchWebGpuChrome(chromium);
    } catch (error) {
      skipOrThrow(testContext, `Chrome did not start: ${error.message.split('\n')[0]}`);
      return;
    }
    const page = await browser.newPage({ viewport: { width: 128, height: 128 } });
    await page.goto(`http://127.0.0.1:${port}/`);
    if (!await page.evaluate(async () => Boolean(navigator.gpu && await navigator.gpu.requestAdapter()))) {
      skipOrThrow(testContext, 'Chrome has no WebGPU adapter');
      return;
    }
    await body(page);
  } finally {
    await browser?.close();
    server.kill();
  }
}
