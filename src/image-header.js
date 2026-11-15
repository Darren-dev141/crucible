// Image sizes read from the file header alone, so a limit can refuse an image before anything decodes its pixels.

const RIFF_TAG = 0x52494646;
const WEBP_TAG = 0x57454250;
const PNG_SIGNATURE_HIGH = 0x89504e47;
const PNG_SIGNATURE_LOW = 0x0d0a1a0a;
const PNG_HEADER_CHUNK = 0x49484452;
const JPEG_FRAME_MARKERS = [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf];

/** Read the size from a WebP header: the extended (VP8X), lossy (VP8) or lossless (VP8L) layout. */
function webpImageSize(bytes, header) {
  if (bytes.length < 30 || header.getUint32(0) !== RIFF_TAG || header.getUint32(8) !== WEBP_TAG) return null;
  const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (chunk === 'VP8X') {
    const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
    const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
    return { width, height };
  }
  if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { width: header.getUint16(26, true) & 0x3fff, height: header.getUint16(28, true) & 0x3fff };
  }
  if (chunk === 'VP8L' && bytes[20] === 0x2f) {
    const bits = header.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  return null;
}

// Markers that stand alone, with no length field: TEM, RST0 to RST7 and SOI. A decoder steps over them, so the reader must too.
function isStandaloneJpegMarker(marker) {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8);
}

function jpegImageSize(bytes, header) {
  let offset = 2;
  while (offset + 2 <= bytes.length) {
    if (bytes[offset++] !== 0xff) break;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x00 || isStandaloneJpegMarker(marker)) continue;
    if (offset + 2 > bytes.length) break;
    const length = header.getUint16(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if (JPEG_FRAME_MARKERS.includes(marker) && length >= 7) {
      return { width: header.getUint16(offset + 5), height: header.getUint16(offset + 3) };
    }
    offset += length;
  }
  return null;
}

/** The { width, height } a PNG, JPEG or WebP header declares, or null when the bytes are none of those or the header is cut short. */
export function readImageDimensions(bytes) {
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let size = null;
  if (bytes.length >= 24 && header.getUint32(0) === PNG_SIGNATURE_HIGH && header.getUint32(4) === PNG_SIGNATURE_LOW && header.getUint32(12) === PNG_HEADER_CHUNK) {
    size = { width: header.getUint32(16), height: header.getUint32(20) };
  } else if (bytes.length >= 4 && header.getUint16(0) === 0xffd8) {
    size = jpegImageSize(bytes, header);
  }
  size ??= webpImageSize(bytes, header);
  return size?.width && size?.height ? size : null;
}

/**
 * The message for an image over the sequence-frame limits, or null when its header says it fits. `maxSide` is pixels on a side
 * and `maxDecodedBytes` the RGBA bytes one decoded frame may take. An image whose size the header does not give is refused too,
 * because a decoder might still read it and the limit could not be checked. `oversizeAdvice` is appended to the over-limit messages only.
 */
export function imageLimitProblem(bytes, label, { maxSide, maxDecodedBytes }, oversizeAdvice = '') {
  const advice = oversizeAdvice ? ` ${oversizeAdvice}` : '';
  const size = readImageDimensions(bytes);
  if (!size) {
    return `${label} has no readable size in its header, so the ${maxSide} pixel and ${maxDecodedBytes / 1048576} MiB frame limits cannot be checked. Re-save it as a standard PNG, JPEG or WebP.`;
  }
  if (size.width > maxSide || size.height > maxSide) {
    return `${label} is ${size.width}x${size.height}; frames are at most ${maxSide} pixels on a side.${advice}`;
  }
  if (size.width * size.height * 4 > maxDecodedBytes) {
    return `${label} is ${size.width}x${size.height}, which decodes to more than ${maxDecodedBytes / 1048576} MiB.${advice}`;
  }
  return null;
}
