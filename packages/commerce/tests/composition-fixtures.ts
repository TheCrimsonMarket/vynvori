import { crc32, deflateSync } from "node:zlib";
import { createHash } from "node:crypto";
import { LICENSED_FONTS, CompositionSceneV1Schema, EMPTY_SYNTHETIC_SCENE, type CompositionSceneV1 } from "@vynvori/contracts";
import type { CompositionAssetStorage } from "../src/composition-storage";

const be32 = (n: number) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
function chunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  return Buffer.concat([be32(data.length), body, be32(crc32(body))]);
}
/** A structurally valid PNG whose IHDR declares `w`x`h` but whose pixel payload is tiny (parser never inflates). */
export function png(w = 4, h = 4, salt = 0): Buffer {
  const ihdr = Buffer.concat([be32(w), be32(h), Buffer.from([8, 2, 0, 0, 0])]);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.from([salt, 0, 0, 0]))), chunk("IEND", Buffer.alloc(0))]);
}
export function jpeg(w = 8, h = 8): Buffer {
  const sof = Buffer.from([0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0]);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0]), sof, Buffer.from([0xff, 0xda, 0, 4, 0, 0, 0x12, 0x34, 0xff, 0xd9])]);
}
export function webp(w = 8, h = 8, animated = false): Buffer {
  const vp8x = Buffer.from([animated ? 0x02 : 0, 0, 0, 0, (w - 1) & 255, ((w - 1) >> 8) & 255, ((w - 1) >> 16) & 255, (h - 1) & 255, ((h - 1) >> 8) & 255, ((h - 1) >> 16) & 255]);
  const body = Buffer.concat([Buffer.from("WEBP", "latin1"), Buffer.from("VP8X", "latin1"), Buffer.from([10, 0, 0, 0]), vp8x]);
  return Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.from([body.length & 255, (body.length >> 8) & 255, 0, 0]), body]);
}
export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function memoryStorage(): CompositionAssetStorage & { objects: Map<string, { bytes: Uint8Array; mime: string }>; failNext?: boolean } {
  const objects = new Map<string, { bytes: Uint8Array; mime: string }>();
  const storage = {
    objects, failNext: false,
    async put(key: string, bytes: Uint8Array, mime: string, hash: string) {
      if (storage.failNext) { storage.failNext = false; throw new Error("injected storage failure"); }
      if (sha256(bytes) !== hash || !key.endsWith("/" + hash)) throw new Error("bad write");
      if (!objects.has(key)) objects.set(key, { bytes, mime });
    },
    async get(key: string, hash: string) { const object = objects.get(key); if (!object || sha256(object.bytes) !== hash) throw new Error("missing"); return object.bytes; },
  };
  return storage;
}

const font = LICENSED_FONTS[0]!;
export const imageLayer = (layerId: string, assetId: string, assetSha: string, over: Record<string, unknown> = {}) =>
  ({ kind: "image", layerId, sourceAssetId: assetId, sourceAssetSha256: assetSha, xMm: 20.0004, yMm: 20.1234, widthMm: 100, heightMm: 100, rotationDeg: 12.5, zIndex: 0, visible: true, ...over });
export const textLayer = (layerId: string, over: Record<string, unknown> = {}) =>
  ({ kind: "text", layerId, text: "I'M ONLY MAPPING", fontAssetId: font.fontAssetId, fontFileSha256: font.fileSha256, fontLicenseVersion: font.licenseVersion, fontSizePt: 30, color: "#ffffff", xMm: 20, yMm: 150, widthMm: 100, heightMm: 20, rotationDeg: 0, zIndex: 1, visible: true, ...over });
export function sceneWith(front: unknown[] = [], back: unknown[] = []): CompositionSceneV1 {
  return CompositionSceneV1Schema.parse({ ...EMPTY_SYNTHETIC_SCENE(), pages: [{ zoneId: "front", layers: front }, { zoneId: "back", layers: back }] });
}
