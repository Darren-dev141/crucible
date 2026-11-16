// Draws the pavilion test scene in Glaze: node bench/glass-water/run.mjs <out-directory> <variant>,<variant>
// A variant is water:glass[:mirror[:probe]], for example plain:blend:0:1 (mirror 1 turns on the planar water reflection,
// probe 1 places a reflection probe on the glass wall). Each variant prints the mean linear-free sRGB of the glass wall region.
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { createServer } from 'vite';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const [outputDirectory, variantList = 'plain:transmission:0'] = process.argv.slice(2);
await mkdir(outputDirectory, { recursive: true });

async function regionMean(png, [left, top, right, bottom]) {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const total = [0, 0, 0];
  let count = 0;
  for (let y = Math.max(top, 0); y < Math.min(bottom, info.height); y++) {
    for (let x = Math.max(left, 0); x < Math.min(right, info.width); x++) {
      for (let channel = 0; channel < 3; channel++) total[channel] += data[(y * info.width + x) * info.channels + channel];
      count++;
    }
  }
  return total.map(value => Math.round(value / count * 10) / 10);
}

const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
await server.listen();
const serverUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu'] });
try {
  for (const variant of variantList.split(',')) {
    const [water, glass, mirror = '0', probe = '0'] = variant.split(':');
    const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
    page.on('pageerror', error => console.log('pageerror', error.message));
    await page.goto(`${serverUrl}/bench/glass-water/harness.html?water=${water}&glass=${glass}&mirror=${mirror}&probe=${probe}`);
    await page.waitForFunction(() => window.__done, null, { timeout: 120000 });
    const done = await page.evaluate(() => window.__done);
    const file = `${outputDirectory}/glaze-${water}-${glass}-mirror${mirror}-probe${probe}.png`;
    const png = await page.locator('canvas').screenshot({ path: file });
    console.log(variant, JSON.stringify({ ...done, wallMeanRgb: await regionMean(png, done.wallRegion) }));
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
