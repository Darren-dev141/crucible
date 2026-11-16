// The irradiance grid read the way the shader reads it. Tests and measurement scripts use it; the renderer never does.
import { ENVIRONMENT_IRRADIANCE_HEIGHT, ENVIRONMENT_IRRADIANCE_WIDTH } from '../../src/environment-shading.js';

// Linear filtering across texels, wrapping around the seam, clamped at the poles.
export function evaluateIrradianceGrid(grid, normal) {
  const [x, y, z] = normal;
  const column = (Math.atan2(x, -z) / (2 * Math.PI) + 0.5) * ENVIRONMENT_IRRADIANCE_WIDTH - 0.5;
  const row = Math.min(Math.max(Math.acos(Math.min(Math.max(y, -1), 1)) / Math.PI * ENVIRONMENT_IRRADIANCE_HEIGHT - 0.5, 0), ENVIRONMENT_IRRADIANCE_HEIGHT - 1);
  const firstColumn = Math.floor(column);
  const firstRow = Math.floor(row);
  const columnBlend = column - firstColumn;
  const rowBlend = row - firstRow;
  const secondRow = Math.min(firstRow + 1, ENVIRONMENT_IRRADIANCE_HEIGHT - 1);
  const wrap = value => ((value % ENVIRONMENT_IRRADIANCE_WIDTH) + ENVIRONMENT_IRRADIANCE_WIDTH) % ENVIRONMENT_IRRADIANCE_WIDTH;
  const result = [0, 0, 0];
  for (const [sampleRow, rowWeight] of [[firstRow, 1 - rowBlend], [secondRow, rowBlend]]) {
    for (const [sampleColumn, columnWeight] of [[wrap(firstColumn), 1 - columnBlend], [wrap(firstColumn + 1), columnBlend]]) {
      const offset = (sampleRow * ENVIRONMENT_IRRADIANCE_WIDTH + sampleColumn) * 3;
      for (let channel = 0; channel < 3; channel++) result[channel] += grid[offset + channel] * rowWeight * columnWeight;
    }
  }
  return result;
}
