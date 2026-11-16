// Draws a grey card, three coloured cards and a floor under one sky and one point light with the rasterizer (Glaze) and
// with three.js, and prints the mean luma, mean saturation and the card colours of each (issue #1178).
//   node bench/reference/exposure-parity.mjs <output directory> [--label before] [--defaults|--importer]
// By default the rasterizer is given the lights the scene has (key and fill off). --defaults leaves the key and fill lights
// at the renderer defaults, as a glTF import did before #1178 for a file with no directional light. --importer takes the
// lights from the glTF importer's own output for the same point light. Run it through gpu-lock.sh.
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const argumentsGiven = process.argv.slice(2);
const outputDirectory = argumentsGiven[0] ?? 'artifacts/1178';
const labelIndex = argumentsGiven.indexOf('--label');
const label = labelIndex >= 0 ? argumentsGiven[labelIndex + 1] : 'run';
const useDefaults = argumentsGiven.includes('--defaults');
const useImporter = argumentsGiven.includes('--importer');

await mkdir(outputDirectory, { recursive: true });
const server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
await server.listen();
const serverUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-gpu'] });
try {
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
  page.on('console', message => console.log('page:', message.text()));
  page.on('pageerror', error => console.log('pageerror:', error.message));
  await page.goto(`${serverUrl}/bench/reference/exposure-parity.html`, { timeout: 180000 });
  await page.waitForFunction(() => window.drawExposureParity, null, { timeout: 180000 });
  const environment = useDefaults || useImporter ? {} : { keyColor: [0, 0, 0], fillIntensity: 0 };
  const result = await page.evaluate(options => window.drawExposureParity(options), { environment, importer: useImporter });
  for (const [engine, drawn] of Object.entries(result)) {
    await writeFile(`${outputDirectory}/${label}-${engine}.png`, Buffer.from(drawn.png, 'base64'));
    const cards = Object.entries(drawn.samples).map(([name, rgb]) => `${name}=${rgb.join(',')}`).join(' ');
    console.log(`${engine.padEnd(14)} luma ${drawn.meanLuma.toFixed(1)} sat ${drawn.meanSaturation.toFixed(1)}  ${cards}`);
  }
} finally {
  await browser.close();
  await server.close();
}
