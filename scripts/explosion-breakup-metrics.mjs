// The numbers behind scripts/measure-explosion-breakup.mjs (#1736): how much a fireball or smoke cloud "breaks up", measured on a picture so a
// recipe can be tuned toward a reference frame instead of judged by eye. All of it is deterministic and works on plain luminance arrays.
//
// A frame is first reduced to a normalised view: the cloud's mask is found by a threshold relative to the frame's own bright end, its centroid and
// equivalent radius are measured, and the frame is resampled to a square window of WINDOW_RADII radii on a side with the cloud at a fixed size.
// That makes a 640 pixel reference and a 1024 pixel render comparable, because both clouds then span the same number of samples.

export const VIEW_SIZE = 192;
export const VIEW_RADIUS = 48;
const WINDOW_RADII = VIEW_SIZE / VIEW_RADIUS;
const RAY_COUNT = 64;
const MASK_FRACTION = 0.5;

export function srgbToLinear(byte) {
  const value = byte / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** Linear luminance of a decoded PNG ({ width, height, channels, pixels }), optionally cropped to { x, y, width, height }. */
export function luminanceImage(png, crop = { x: 0, y: 0, width: png.width, height: png.height }) {
  const luminance = new Float64Array(crop.width * crop.height);
  const rgb = new Float64Array(crop.width * crop.height * 3);
  for (let row = 0; row < crop.height; row++) {
    for (let column = 0; column < crop.width; column++) {
      const source = ((crop.y + row) * png.width + crop.x + column) * png.channels;
      const target = row * crop.width + column;
      for (let channel = 0; channel < 3; channel++) rgb[target * 3 + channel] = srgbToLinear(png.pixels[source + channel]);
      luminance[target] = 0.2126 * rgb[target * 3] + 0.7152 * rgb[target * 3 + 1] + 0.0722 * rgb[target * 3 + 2];
    }
  }
  return { width: crop.width, height: crop.height, luminance, rgb };
}

function percentile(values, fraction) {
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
}

/** The pixels brighter than MASK_FRACTION of the frame's 99.5th percentile over its median, keeping only the largest connected piece and filling its holes. */
export function cloudMask(image, fraction = MASK_FRACTION) {
  const { width, height, luminance } = image;
  const floor = percentile(luminance, 0.5);
  const top = percentile(luminance, 0.995);
  const threshold = floor + (top - floor) * fraction;
  const raw = luminance.map(value => (value > threshold ? 1 : 0));
  const mask = largestComponent(raw, width, height);
  return fillHoles(mask, width, height);
}

function largestComponent(raw, width, height) {
  const label = new Int32Array(raw.length);
  let best = { id: 0, size: 0 };
  let nextId = 0;
  const stack = [];
  for (let start = 0; start < raw.length; start++) {
    if (!raw[start] || label[start]) continue;
    nextId++;
    let size = 0;
    stack.push(start);
    label[start] = nextId;
    while (stack.length) {
      const index = stack.pop();
      size++;
      const x = index % width;
      const y = (index - x) / width;
      const neighbours = [x > 0 ? index - 1 : -1, x < width - 1 ? index + 1 : -1, y > 0 ? index - width : -1, y < height - 1 ? index + width : -1];
      for (const neighbour of neighbours) {
        if (neighbour >= 0 && raw[neighbour] && !label[neighbour]) {
          label[neighbour] = nextId;
          stack.push(neighbour);
        }
      }
    }
    if (size > best.size) best = { id: nextId, size };
  }
  return Uint8Array.from(label, value => (value === best.id && best.id ? 1 : 0));
}

function fillHoles(mask, width, height) {
  const outside = new Uint8Array(mask.length);
  const stack = [];
  const seed = index => {
    if (!mask[index] && !outside[index]) {
      outside[index] = 1;
      stack.push(index);
    }
  };
  for (let x = 0; x < width; x++) {
    seed(x);
    seed((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    seed(y * width);
    seed(y * width + width - 1);
  }
  while (stack.length) {
    const index = stack.pop();
    const x = index % width;
    const y = (index - x) / width;
    if (x > 0) seed(index - 1);
    if (x < width - 1) seed(index + 1);
    if (y > 0) seed(index - width);
    if (y < height - 1) seed(index + width);
  }
  return mask.map((value, index) => (value || !outside[index] ? 1 : 0));
}

export function maskGeometry(mask, width) {
  let area = 0;
  let sumX = 0;
  let sumY = 0;
  for (let index = 0; index < mask.length; index++) {
    if (!mask[index]) continue;
    area++;
    sumX += index % width;
    sumY += Math.floor(index / width);
  }
  return { area, centerX: sumX / area, centerY: sumY / area, radius: Math.sqrt(area / Math.PI) };
}

/** Perimeter (counted edge faces between a mask pixel and a non-mask pixel, so 4-connected) over the square root of the area: counting pixel faces makes a disc of any radius score 8/sqrt(pi) = 4.51. */
export function silhouetteRoughness(mask, width, height) {
  let perimeter = 0;
  let area = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      area++;
      if (x === 0 || !mask[y * width + x - 1]) perimeter++;
      if (x === width - 1 || !mask[y * width + x + 1]) perimeter++;
      if (y === 0 || !mask[(y - 1) * width + x]) perimeter++;
      if (y === height - 1 || !mask[(y + 1) * width + x]) perimeter++;
    }
  }
  return perimeter / Math.sqrt(area);
}

function sample(image, x, y) {
  const clampedX = Math.min(image.width - 1, Math.max(0, x));
  const clampedY = Math.min(image.height - 1, Math.max(0, y));
  const left = Math.floor(clampedX);
  const top = Math.floor(clampedY);
  const right = Math.min(image.width - 1, left + 1);
  const bottom = Math.min(image.height - 1, top + 1);
  const fx = clampedX - left;
  const fy = clampedY - top;
  const at = (column, row) => image.luminance[row * image.width + column];
  return (at(left, top) * (1 - fx) + at(right, top) * fx) * (1 - fy) + (at(left, bottom) * (1 - fx) + at(right, bottom) * fx) * fy;
}

/** Resamples the image to VIEW_SIZE squared, centred on the cloud, with the cloud's equivalent radius at VIEW_RADIUS samples (3 by 3 samples per cell). */
export function normalisedView(image, geometry) {
  const scale = geometry.radius / VIEW_RADIUS;
  const luminance = new Float64Array(VIEW_SIZE * VIEW_SIZE);
  const subsamples = 3;
  for (let row = 0; row < VIEW_SIZE; row++) {
    for (let column = 0; column < VIEW_SIZE; column++) {
      let total = 0;
      for (let sy = 0; sy < subsamples; sy++) {
        for (let sx = 0; sx < subsamples; sx++) {
          const x = geometry.centerX + (column - VIEW_SIZE / 2 + (sx + 0.5) / subsamples) * scale;
          const y = geometry.centerY + (row - VIEW_SIZE / 2 + (sy + 0.5) / subsamples) * scale;
          total += sample(image, x, y);
        }
      }
      luminance[row * VIEW_SIZE + column] = total / (subsamples * subsamples);
    }
  }
  return { width: VIEW_SIZE, height: VIEW_SIZE, luminance };
}

/**
 * How fast the cloud fades at its edge, in cloud radii: along RAY_COUNT rays from the centre, the distance between the point where the luminance has
 * fallen 10 percent of the way from the core to the background and the point where it has fallen 90 percent, median over the rays. A hard-edged ball is
 * near 0, a soft thinning cloud is large.
 */
export function edgeFalloffWidth(view) {
  const rays = [];
  for (let ray = 0; ray < RAY_COUNT; ray++) {
    const angle = (ray / RAY_COUNT) * Math.PI * 2;
    const profile = [];
    for (let step = 0; step <= VIEW_RADIUS * 2 * 4; step++) {
      const radius = step / 4;
      profile.push(sample(view, VIEW_SIZE / 2 + Math.cos(angle) * radius, VIEW_SIZE / 2 + Math.sin(angle) * radius));
    }
    const core = percentile(profile.slice(0, VIEW_RADIUS * 4 * 0.5), 0.5);
    const background = percentile(profile.slice(Math.floor(profile.length * 0.9)), 0.5);
    if (core <= background * 1.05) continue;
    const crossing = fraction => {
      const level = core - (core - background) * fraction;
      for (let step = 1; step < profile.length; step++) if (profile[step] < level) return step / 4;
      return profile.length / 4;
    };
    rays.push((crossing(0.9) - crossing(0.1)) / VIEW_RADIUS);
  }
  return rays.length ? percentile(rays, 0.5) : 0;
}

/** Earth mover's distance between the luminance distributions of two views, over the pixels within two radii, in sRGB-encoded luminance (0 to 1). */
export function luminanceHistogramDistance(viewA, viewB, bins = 64) {
  const histogram = view => {
    const counts = new Float64Array(bins);
    let total = 0;
    for (let row = 0; row < VIEW_SIZE; row++) {
      for (let column = 0; column < VIEW_SIZE; column++) {
        if (Math.hypot(column - VIEW_SIZE / 2, row - VIEW_SIZE / 2) > VIEW_RADIUS * 1.8) continue;
        const linear = Math.min(1, Math.max(0, view.luminance[row * VIEW_SIZE + column]));
        const encoded = linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** (1 / 2.4) - 0.055;
        counts[Math.min(bins - 1, Math.floor(encoded * bins))]++;
        total++;
      }
    }
    return counts.map(count => count / total);
  };
  const first = histogram(viewA);
  const second = histogram(viewB);
  let distance = 0;
  let cumulative = 0;
  for (let bin = 0; bin < bins; bin++) {
    cumulative += first[bin] - second[bin];
    distance += Math.abs(cumulative) / bins;
  }
  return distance;
}

/** Root mean square difference of two views in sRGB-encoded luminance. */
export function viewRmse(viewA, viewB) {
  const encode = linear => {
    const clamped = Math.min(1, Math.max(0, linear));
    return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
  };
  let sum = 0;
  for (let index = 0; index < viewA.luminance.length; index++) sum += (encode(viewA.luminance[index]) - encode(viewB.luminance[index])) ** 2;
  return Math.sqrt(sum / viewA.luminance.length);
}

/** Everything one frame contributes: mask geometry, roughness of the mask in the normalised view, edge falloff and the view itself. */
export function describeFrame(image) {
  const mask = cloudMask(image);
  const geometry = maskGeometry(mask, image.width);
  const view = normalisedView(image, geometry);
  const viewMask = cloudMask(view);
  return {
    view,
    geometry,
    roughness: silhouetteRoughness(viewMask, VIEW_SIZE, VIEW_SIZE),
    edgeFalloff: edgeFalloffWidth(view),
  };
}

/** The numbers of a candidate frame against a reference frame. */
export function compareFrames(reference, candidate) {
  return {
    roughness: { reference: reference.roughness, candidate: candidate.roughness, ratio: candidate.roughness / reference.roughness },
    edgeFalloff: { reference: reference.edgeFalloff, candidate: candidate.edgeFalloff, ratio: candidate.edgeFalloff / reference.edgeFalloff },
    histogramDistance: luminanceHistogramDistance(reference.view, candidate.view),
    rmse: viewRmse(reference.view, candidate.view),
  };
}
