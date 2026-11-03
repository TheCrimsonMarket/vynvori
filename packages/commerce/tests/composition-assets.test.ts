import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { inspectImage, ImageRejectedError } from "../src/image-inspect";
import { compositionAssetStorage } from "../src/composition-storage";
import { SYNTHETIC_IMAGE_LIMITS } from "./composition-synthetic";
import { png, jpeg, webp, sha256 } from "./composition-fixtures";

const limits = SYNTHETIC_IMAGE_LIMITS;
const reject = (bytes: Uint8Array, code: ImageRejectedError["code"]) => assert.throws(() => inspectImage(bytes, limits), (e: unknown) => e instanceof ImageRejectedError && e.code === code);

test("image inspection decides type from magic bytes and reports exact dimensions + content hash", () => {
  assert.deepEqual(inspectImage(png(640, 480), limits), { mime: "image/png", widthPx: 640, heightPx: 480, sha256: sha256(png(640, 480)) });
  assert.equal(inspectImage(jpeg(1200, 800), limits).widthPx, 1200);
  const w = inspectImage(webp(321, 123), limits); assert.deepEqual([w.mime, w.widthPx, w.heightPx], ["image/webp", 321, 123]);
});
test("image inspection rejects empty, oversized, vector/other formats, animation, bombs, CRC damage and trailing bytes", () => {
  reject(Buffer.alloc(0), "EMPTY");
  reject(Buffer.alloc(limits.maxBytes + 1, 1), "TOO_LARGE");
  reject(Buffer.from("<?xml version='1.0'?><svg xmlns='http://www.w3.org/2000/svg'/>"), "UNSUPPORTED");
  reject(Buffer.from("%PDF-1.7 ..........................."), "UNSUPPORTED");
  reject(Buffer.from("GIF89a" + "\0".repeat(40)), "UNSUPPORTED");
  reject(webp(8, 8, true), "ANIMATED");
  reject(png(limits.maxSide + 1, 10), "DIMENSIONS"); reject(png(limits.maxSide, limits.maxSide), "DIMENSIONS"); reject(jpeg(40000, 40000), "DIMENSIONS");
  const damaged = Buffer.from(png()); damaged[20] = damaged[20]! ^ 0xff; reject(damaged, "MALFORMED");
  reject(Buffer.concat([png(), Buffer.from("PK\u0003\u0004")]), "MALFORMED");
  reject(png().subarray(0, png().length - 5), "MALFORMED");
  reject(Buffer.concat([jpeg(), Buffer.from([0, 0])]), "MALFORMED");
  reject(Buffer.concat([webp(), Buffer.from([1])]), "MALFORMED");
});

const goodKey = (hash: string, id = "0b7f4a52-8d1f-4c8e-9e15-0a3f2f5b7c11") => `private/composition/v1/${id}/${hash}`;
const env = { M2_ENV: "local", M2_R2_ACCOUNT_ID: "a".repeat(32), M2_R2_BUCKET: "vynvori-staging-test" } as never;
function fakeS3() {
  const calls: { name: string; input: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  let existing: { Metadata?: Record<string, string>; ContentLength?: number; body?: Buffer } | null = null;
  const sender = { async send(command: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
    const name = command.constructor.name; calls.push({ name, input: command.input });
    if (name === "PutObjectCommand") { if (existing) throw Object.assign(new Error("exists"), { $metadata: { httpStatusCode: 412 } }); existing = { Metadata: command.input.Metadata, ContentLength: command.input.ContentLength, body: Buffer.from(command.input.Body) }; return {}; }
    if (name === "HeadObjectCommand") return { Metadata: existing?.Metadata, ContentLength: existing?.ContentLength };
    if (name === "GetObjectCommand") return { Metadata: existing?.Metadata, ContentLength: existing?.ContentLength, Body: (async function* () { yield existing!.body!; })() };
    throw new Error("unexpected " + name);
  } };
  return { sender, calls, seed(value: typeof existing) { existing = value; } };
}
test("asset storage writes write-once private objects with server-built keys and never exposes a URL", async () => {
  const bytes = png(10, 10), hash = createHash("sha256").update(bytes).digest("hex"), fake = fakeS3();
  const storage = compositionAssetStorage(env, fake.sender as never);
  await storage.put(goodKey(hash), bytes, "image/png", hash);
  const put = fake.calls[0]!.input; assert.equal(put.IfNoneMatch, "*"); assert.equal(put.Bucket, "vynvori-staging-test"); assert.equal(put.ACL, undefined);
  assert.deepEqual([...await storage.get(goodKey(hash), hash, bytes.length)], [...bytes]);
  await storage.put(goodKey(hash), bytes, "image/png", hash); // lost-ack retry: 412 + verified same bytes => ok
  assert.equal(fake.calls.filter(c => c.name === "PutObjectCommand").length, 2);
  assert.equal("presign" in storage, false);
});
test("asset storage refuses hostile keys, hash/MIME mismatch, overwrite of a foreign object and tampered reads", async () => {
  const bytes = png(10, 10), hash = sha256(bytes), fake = fakeS3(), storage = compositionAssetStorage(env, fake.sender as never);
  for (const key of ["../etc/passwd", "private/composition/v1/x/" + hash, `public/composition/v1/0b7f4a52-8d1f-4c8e-9e15-0a3f2f5b7c11/${hash}`, goodKey(hash) + "/../x", goodKey("f".repeat(64))])
    await assert.rejects(storage.put(key, bytes, "image/png", hash));
  await assert.rejects(storage.put(goodKey(hash), bytes, "image/svg+xml", hash));
  await assert.rejects(storage.put(goodKey("e".repeat(64)), bytes, "image/png", "e".repeat(64))); // hash is not the content hash
  assert.equal(fake.calls.length, 0);
  fake.seed({ Metadata: { sha256: "0".repeat(64) }, ContentLength: bytes.length, body: Buffer.from(bytes) });
  await assert.rejects(storage.put(goodKey(hash), bytes, "image/png", hash), /Foreign object/);
  fake.seed({ Metadata: { sha256: hash }, ContentLength: bytes.length, body: Buffer.concat([bytes.subarray(0, bytes.length - 1), Buffer.from([0])]) });
  await assert.rejects(storage.get(goodKey(hash), hash, bytes.length), /integrity/);
  fake.seed({ Metadata: { sha256: hash }, ContentLength: bytes.length + 5, body: Buffer.from(bytes) });
  await assert.rejects(storage.get(goodKey(hash), hash, bytes.length));
});
