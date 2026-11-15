// Compares two frames written by run.mjs with "capture":true: node bench/glaze-passes/diff-frames.mjs <before.rgba> <after.rgba> [<diff.png>] [width]
// Prints the largest difference of any colour channel and how many pixels differ. The optional PNG marks differing pixels in red on a dark copy.
import { readFile, writeFile } from 'node:fs/promises';
import { encodePng } from './png.mjs';

const [beforeFile, afterFile, pngFile, width = '1280'] = process.argv.slice(2);
if (!beforeFile || !afterFile) throw new Error('Pass the before and the after .rgba files.');
const before = await readFile(beforeFile);
const after = await readFile(afterFile);
if (before.length !== after.length) throw new Error(`The frames differ in size: ${before.length} and ${after.length} bytes.`);

let maximumChannelDifference = 0;
let differingPixels = 0;
let squaredSum = 0;
let pixelsOverEleven = 0;
const marks = Buffer.alloc(before.length);
for (let offset = 0; offset < before.length; offset += 4) {
  let pixelDifference = 0;
  for (let channel = 0; channel < 4; channel++) {
    pixelDifference = Math.max(pixelDifference, Math.abs(before[offset + channel] - after[offset + channel]));
  }
  for (let channel = 0; channel < 3; channel++) squaredSum += (before[offset + channel] - after[offset + channel]) ** 2;
  if (pixelDifference > 11) pixelsOverEleven++;
  maximumChannelDifference = Math.max(maximumChannelDifference, pixelDifference);
  const differs = pixelDifference > 0;
  if (differs) differingPixels++;
  marks[offset] = differs ? 255 : before[offset] >> 2;
  marks[offset + 1] = differs ? 0 : before[offset + 1] >> 2;
  marks[offset + 2] = differs ? 0 : before[offset + 2] >> 2;
  marks[offset + 3] = 255;
}
console.log(JSON.stringify({ pixels: before.length / 4, differingPixels, pixelsOverEleven, rmseOf255: Number(Math.sqrt(squaredSum / (before.length / 4 * 3)).toFixed(3)), maximumChannelDifference }));
if (pngFile) await writeFile(pngFile, encodePng(marks, Number(width)));
