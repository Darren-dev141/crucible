// Draws the pavilion test scene in Glaze: node bench/glass-water/run.mjs <out-directory> <variant>,<variant>
// A variant is water:glass[:mirror], for example plain:transmission:1 (mirror 1 turns on the planar water reflection).
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const [outputDirectory, variantList = 'plain:transmission:0'] = process.argv.slice(2);
await mkdir(outputDirectory, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
await server.listen();
const serverUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu'] });
try {
  for (const variant of variantList.split(',')) {
    const [water, glass, mirror = '0'] = variant.split(':');
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    page.on('pageerror', error => console.log('pageerror', error.message));
    await page.goto(`${serverUrl}/bench/glass-water/harness.html?water=${water}&glass=${glass}&mirror=${mirror}`);
    await page.waitForFunction(() => window.__done, null, { timeout: 120000 });
    console.log(variant, JSON.stringify(await page.evaluate(() => window.__done)));
    await page.locator('canvas').screenshot({ path: `${outputDirectory}/glaze-${water}-${glass}-mirror${mirror}.png` });
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
