import test from "node:test";
import assert from "node:assert/strict";
import { S3Client } from "@aws-sdk/client-s3";
import { storageAdapter, syntheticPng } from "../src/storage";
import { medusaClient } from "../src/medusa";
import { processingClient } from "../src/processing";
test("Medusa adapter is read-only, no redirects/cache, and bounded", async () => {
  const calls: string[] = [];
  const fake: typeof fetch = async (input, init) => {
    calls.push(String(input));
    assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error"); assert.equal(init?.cache, "no-store"); assert.ok(init?.signal);
    return new Response("OK");
  };
  await medusaClient({ M2_ENV: "local", M2_MEDUSA_ORIGIN: "http://localhost:9000" }, fake).ready();
  assert.deepEqual(calls, ["http://localhost:9000/health"]);
  await assert.rejects(medusaClient({ M2_ENV: "local", M2_MEDUSA_ORIGIN: "http://localhost:9000" }, async () => new Response("private details", { status: 503 })).ready(), /unavailable/);
  assert.throws(() => processingClient({ M2_ENV: "staging", M2_PROCESSING_ORIGIN: "http://localhost:8080" }));
});
test("storage mock: private immutable keys, fixture validation and integrity", async () => {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  let metadata: Record<string, string> = {};
  const send = async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    calls.push({ name: command.constructor.name, input: command.input });
    if (command.constructor.name === "PutObjectCommand") metadata = command.input.Metadata as Record<string, string>;
    if (command.constructor.name === "GetObjectCommand") return { ContentType: "image/png", ContentLength: syntheticPng().length, Metadata: metadata, Body: { transformToByteArray: async () => syntheticPng() } };
    return {};
  };
  const adapter = storageAdapter({ M2_ENV: "local", M2_R2_ACCOUNT_ID: "0".repeat(32), M2_R2_BUCKET: "vynvori-staging-synthetic" }, { send } as unknown as Pick<S3Client, "send">);
  const id = "12345678-1234-4123-8123-123456789abc";
  await assert.rejects(adapter.upload(id, syntheticPng(), "image/svg+xml"));
  await assert.rejects(adapter.upload(id, Buffer.alloc(1025), "image/png"));
  await assert.rejects(adapter.upload("../escape", syntheticPng(), "image/png"));
  assert.equal(calls.length, 0);
  const object = await adapter.upload(id, syntheticPng(), "image/png");
  assert.ok(object.key.startsWith("private/staging/synthetic/v1/"));
  assert.equal(calls[0]?.input.IfNoneMatch, "*");
  assert.equal(calls[0]?.input.ACL, undefined);
  assert.deepEqual(Buffer.from(await adapter.read(id)), syntheticPng());
  metadata.sha256 = "bad";
  await assert.rejects(adapter.read(id), /integrity/);
  await adapter.remove(id);
  assert.equal(calls.at(-1)?.name, "DeleteObjectCommand");
  assert.throws(() => storageAdapter({ M2_ENV: "staging", M2_R2_ACCOUNT_ID: "0".repeat(32), M2_R2_BUCKET: "production" }));
});
