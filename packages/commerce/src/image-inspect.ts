import { createHash } from "node:crypto";
import { crc32 as zlibCrc32 } from "node:zlib";

export type ImageLimits = Readonly<{ maxBytes: number; maxPixels: number; maxSide: number }>;
export type InspectedImage = Readonly<{ mime: "image/png" | "image/jpeg" | "image/webp"; widthPx: number; heightPx: number; sha256: string }>;
export class ImageRejectedError extends Error {
  constructor(readonly code: "EMPTY" | "TOO_LARGE" | "UNSUPPORTED" | "MALFORMED" | "DIMENSIONS" | "ANIMATED") { super(code); this.name = "ImageRejectedError"; }
}

const u32 = (b: Uint8Array, o: number) => ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
const fail = (code: ImageRejectedError["code"]): never => { throw new ImageRejectedError(code); };

function png(b: Uint8Array): { widthPx: number; heightPx: number } {
  let offset = 8, width = 0, height = 0, sawIdat = false, ended = false, first = true;
  while (offset + 12 <= b.length) {
    const length = u32(b, offset), type = String.fromCharCode(b[offset + 4]!, b[offset + 5]!, b[offset + 6]!, b[offset + 7]!);
    if (length > 0x7fffffff || offset + 12 + length > b.length) fail("MALFORMED");
    if (first && (type !== "IHDR" || length !== 13)) fail("MALFORMED");
    const data = b.subarray(offset + 8, offset + 8 + length);
    if (zlibCrc32(b.subarray(offset + 4, offset + 8 + length)) !== u32(b, offset + 8 + length)) fail("MALFORMED");
    if (type === "IHDR") { width = u32(data, 0); height = u32(data, 4); }
    else if (type === "acTL") fail("ANIMATED");
    else if (type === "IDAT") sawIdat = true;
    first = false; offset += 12 + length;
    if (type === "IEND") { ended = true; break; }
  }
  if (!ended || !sawIdat || offset !== b.length) fail("MALFORMED"); // trailing bytes (polyglots) are rejected
  return { widthPx: width, heightPx: height };
}
function jpeg(b: Uint8Array): { widthPx: number; heightPx: number } {
  let offset = 2, dims: { widthPx: number; heightPx: number } | null = null;
  while (offset + 2 <= b.length) {
    if (b[offset] !== 0xff) fail("MALFORMED");
    const marker = b[offset + 1]!;
    if (marker === 0xff) { offset += 1; continue; }
    if (marker === 0xd9) return offset + 2 === b.length && dims ? dims : fail("MALFORMED");
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd8) || marker === 0x01) { offset += 2; continue; }
    if (offset + 4 > b.length) fail("MALFORMED");
    const length = (b[offset + 2]! << 8) | b[offset + 3]!;
    if (length < 2 || offset + 2 + length > b.length) fail("MALFORMED");
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 8) fail("MALFORMED");
      dims = { heightPx: (b[offset + 5]! << 8) | b[offset + 6]!, widthPx: (b[offset + 7]! << 8) | b[offset + 8]! };
    }
    offset += 2 + length;
    if (marker === 0xda) { // entropy-coded data follows; scan to the next real marker
      while (offset + 1 < b.length && !(b[offset] === 0xff && b[offset + 1] !== 0x00 && !(b[offset + 1]! >= 0xd0 && b[offset + 1]! <= 0xd7))) offset += 1;
    }
  }
  return fail("MALFORMED");
}
function webp(b: Uint8Array): { widthPx: number; heightPx: number } {
  if (b.length < 30 || (b[4]! | (b[5]! << 8) | (b[6]! << 16) | (b[7]! << 24)) + 8 !== b.length) fail("MALFORMED"); // RIFF size must equal the file: no trailing payload
  const kind = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!), le24 = (o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
  if (kind === "VP8X") {
    if (b[20]! & 0x02) fail("ANIMATED");
    return { widthPx: le24(24) + 1, heightPx: le24(27) + 1 };
  }
  if (kind === "VP8L") {
    if (b[20] !== 0x2f) fail("MALFORMED");
    const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0;
    return { widthPx: (bits & 0x3fff) + 1, heightPx: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (kind === "VP8 ") {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) fail("MALFORMED");
    return { widthPx: (b[26]! | (b[27]! << 8)) & 0x3fff, heightPx: (b[28]! | (b[29]! << 8)) & 0x3fff };
  }
  return fail("UNSUPPORTED");
}

/**
 * Structural validation of an untrusted customer original WITHOUT decoding pixels: type is decided from magic bytes
 * (never the filename or declared Content-Type), container structure/CRC/trailing bytes are verified and decoded
 * memory is bounded from the declared dimensions. SVG, GIF, PDF, PSD, HEIC and animated images are rejected.
 * This is a pre-storage gate, NOT malware scanning (ACC-07 scanning/derivative work remains with M5 processing).
 */
export function inspectImage(bytes: Uint8Array, limits: ImageLimits): InspectedImage {
  if (bytes.byteLength === 0) fail("EMPTY");
  if (bytes.byteLength > limits.maxBytes) fail("TOO_LARGE");
  let mime: InspectedImage["mime"], dims: { widthPx: number; heightPx: number };
  const png8 = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length > 20 && png8.every((v, i) => bytes[i] === v)) { mime = "image/png"; dims = png(bytes); }
  else if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) { mime = "image/jpeg"; dims = jpeg(bytes); }
  else if (bytes.length >= 30 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") { mime = "image/webp"; dims = webp(bytes); }
  else return fail("UNSUPPORTED");
  const { widthPx, heightPx } = dims;
  if (!Number.isSafeInteger(widthPx) || !Number.isSafeInteger(heightPx) || widthPx < 1 || heightPx < 1 || widthPx > limits.maxSide || heightPx > limits.maxSide || widthPx * heightPx > limits.maxPixels) fail("DIMENSIONS");
  return { mime, widthPx, heightPx, sha256: createHash("sha256").update(bytes).digest("hex") };
}
