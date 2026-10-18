import test from "node:test";
import assert from "node:assert/strict";
import { S3Client } from "@aws-sdk/client-s3";
import { storageAdapter, r2Target, syntheticPng } from "../src/storage";
import { advanceSyntheticProbe, newSyntheticProbe, type SyntheticProbeRecord } from "../src/synthetic-storage-probe";
import { privateR2Proof } from "../../../scripts/r2-operator";

const env = { M2_ENV: "staging", M2_R2_ACCOUNT_ID: "0".repeat(32), M2_R2_BUCKET: "vynvori-staging-tests", M2_R2_JURISDICTION: "us" };
const id = "12345678-1234-4123-8123-123456789abc";
function httpError(code: number) { return Object.assign(new Error("injected"), { $metadata: { httpStatusCode: code } }); }
function fixture(options: { put?: "lost" | "not-sent" | "conflict"; remove?: "lost" | "not-sent"; read?: "bad" | "oversized" | "hang"; head?: number } = {}) {
  let object: { ContentType: string; ContentLength: number; Metadata: Record<string, string> } | undefined;
  const calls: string[] = []; let destroyed = false;
  const send = async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const name = command.constructor.name; calls.push(name);
    if (name === "HeadObjectCommand") {
      if (options.head) throw httpError(options.head);
      if (!object) throw httpError(404);
      return object;
    }
    if (name === "PutObjectCommand") {
      assert.equal(command.input.IfNoneMatch, "*");
      if (options.put === "conflict" || object) throw httpError(412);
      if (options.put === "not-sent") throw new Error("injected timeout before commit");
      object = { ContentType: "image/png", ContentLength: syntheticPng().length, Metadata: { ...command.input.Metadata as Record<string, string> } };
      if (options.put === "lost") throw new Error("injected lost acknowledgement");
      return {};
    }
    if (name === "GetObjectCommand") {
      assert.ok(object);
      return { ...object, Body: { destroy() { destroyed = true; }, async *[Symbol.asyncIterator]() {
        if (options.read === "hang") await new Promise(() => {});
        yield options.read === "oversized" ? Buffer.alloc(1000) : options.read === "bad" ? Buffer.alloc(syntheticPng().length) : syntheticPng();
      } } };
    }
    if (name === "DeleteObjectCommand") {
      if (options.remove === "not-sent") throw new Error("injected timeout before delete");
      object = undefined;
      if (options.remove === "lost") throw new Error("injected lost delete acknowledgement");
    }
    return {};
  };
  const storage = storageAdapter(env, { send } as unknown as Pick<S3Client, "send">);
  let journal = newSyntheticProbe(env, id);
  const save = async (next: SyntheticProbeRecord) => { journal = structuredClone(next); };
  return { storage, calls, save, get journal() { return journal; }, get object() { return object; }, get destroyed() { return destroyed; } };
}
test("staging requires an explicit supported jurisdiction", () => {
  assert.equal(r2Target(env).endpoint, `https://${env.M2_R2_ACCOUNT_ID}.us.r2.cloudflarestorage.com`);
  assert.equal(r2Target({ ...env, M2_R2_JURISDICTION: "eu" }).endpoint, `https://${env.M2_R2_ACCOUNT_ID}.eu.r2.cloudflarestorage.com`);
  assert.throws(() => r2Target({ ...env, M2_R2_JURISDICTION: undefined }));
  assert.throws(() => r2Target({ ...env, M2_R2_JURISDICTION: "other" }));
});
test("round trip checkpoints once, verifies bytes, deletes, and replay performs no calls", async () => {
  const f = fixture(); const result = await advanceSyntheticProbe(env, f.storage, f.journal, f.save);
  assert.equal(result.phase, "COMPLETE"); assert.equal(result.verified, true);
  assert.equal(f.calls.filter(c => c === "PutObjectCommand").length, 1);
  assert.equal(f.calls.filter(c => c === "DeleteObjectCommand").length, 1);
  const count = f.calls.length;
  await advanceSyntheticProbe(env, f.storage, f.journal, f.save); assert.equal(f.calls.length, count);
});
test("PUT committed with lost acknowledgement reconciles without repeating PUT", async () => {
  const f = fixture({ put: "lost" });
  assert.equal((await advanceSyntheticProbe(env, f.storage, f.journal, f.save)).phase, "COMPLETE");
  assert.equal(f.calls.filter(c => c === "PutObjectCommand").length, 1);
});
test("unobserved PUT remains pending on resume, never issues another PUT or DELETE", async () => {
  const f = fixture({ put: "not-sent" });
  for (let i = 0; i < 2; i++) await assert.rejects(advanceSyntheticProbe(env, f.storage, f.journal, f.save), /UNRESOLVED/);
  assert.equal(f.journal.phase, "PUT_PENDING");
  assert.equal(f.calls.filter(c => c === "PutObjectCommand").length, 1);
  assert.ok(!f.calls.includes("DeleteObjectCommand"));
});
test("conditional collision is terminal and preserved, including resume", async () => {
  const f = fixture({ put: "conflict" });
  for (let i = 0; i < 2; i++) await assert.rejects(advanceSyntheticProbe(env, f.storage, f.journal, f.save), /CONFLICT_PRESERVED/);
  assert.equal(f.journal.phase, "CONFLICT"); assert.ok(!f.calls.includes("DeleteObjectCommand"));
});
test("preexisting same fixture is preserved before any mutation", async () => {
  const f = fixture(); await f.storage.upload(id, syntheticPng(), "image/png"); const count = f.calls.length;
  await assert.rejects(advanceSyntheticProbe(env, f.storage, f.journal, f.save), /EXISTING_OBJECT_PRESERVED/);
  assert.deepEqual(f.calls.slice(count), ["HeadObjectCommand"]); assert.ok(f.object);
});
test("lost DELETE acknowledgement reconciles absent and does not repeat DELETE", async () => {
  const f = fixture({ remove: "lost" });
  assert.equal((await advanceSyntheticProbe(env, f.storage, f.journal, f.save)).phase, "COMPLETE");
  assert.equal(f.calls.filter(c => c === "DeleteObjectCommand").length, 1);
});
test("unobserved DELETE stays pending on resume and preserves object", async () => {
  const f = fixture({ remove: "not-sent" });
  for (let i = 0; i < 2; i++) await assert.rejects(advanceSyntheticProbe(env, f.storage, f.journal, f.save), /DELETE_OUTCOME_UNRESOLVED/);
  assert.equal(f.journal.phase, "DELETE_PENDING"); assert.ok(f.object);
  assert.equal(f.calls.filter(c => c === "DeleteObjectCommand").length, 1);
});
test("corrupt body fails integrity and is never automatically deleted", async () => {
  const f = fixture({ read: "bad" });
  await assert.rejects(advanceSyntheticProbe(env, f.storage, f.journal, f.save), /integrity/);
  assert.equal(f.journal.phase, "STORED"); assert.ok(!f.calls.includes("DeleteObjectCommand")); assert.equal(f.destroyed, true);
});
test("stream byte cap and abort release the body", async () => {
  const large = fixture({ read: "oversized" }); await large.storage.upload(id, syntheticPng(), "image/png");
  await assert.rejects(large.storage.read(id), /byte limit/); assert.equal(large.destroyed, true);
  const hanging = fixture({ read: "hang" }); await hanging.storage.upload(id, syntheticPng(), "image/png");
  await assert.rejects(hanging.storage.read(id, AbortSignal.timeout(20)), /aborted/); assert.equal(hanging.destroyed, true);
});
test("HEAD AccessDenied is never interpreted as absence", async () => {
  const f = fixture({ head: 403 });
  await assert.rejects(advanceSyntheticProbe(env, f.storage, f.journal, f.save)); assert.ok(!f.calls.includes("PutObjectCommand"));
});
test("foreign metadata prevents both reads and removal", async () => {
  const f = fixture(); await f.storage.upload(id, syntheticPng(), "image/png");
  f.object!.Metadata.run_id = "different";
  await assert.rejects(f.storage.read(id), /Invalid/); await assert.rejects(f.storage.remove(id), /preserve/);
  assert.ok(!f.calls.includes("DeleteObjectCommand"));
});
test("failed journal save before mutation sends no PUT", async () => {
  const f = fixture();
  await assert.rejects(advanceSyntheticProbe(env, f.storage, f.journal, async () => { throw new Error("disk full"); }), /disk full/);
  assert.ok(!f.calls.includes("PutObjectCommand"));
});
test("crash checkpoint after PUT resumes existing object without a second PUT", async () => {
  const f = fixture();
  await assert.rejects(advanceSyntheticProbe(env, f.storage, f.journal, async next => {
    if (next.phase === "STORED") throw new Error("disk full"); await f.save(next);
  }));
  assert.equal(f.journal.phase, "PUT_PENDING");
  await advanceSyntheticProbe(env, f.storage, f.journal, f.save);
  assert.equal(f.calls.filter(c => c === "PutObjectCommand").length, 1);
});
test("target changes and invalid journal states fail before any S3 call", async () => {
  const f = fixture();
  for (const patch of [{ bucket: "different" }, { jurisdiction: "eu" }, { key: "other" }, { putAttempts: 2 }, { phase: "STORED", putAttempts: 1, verified: true, deleteAttempts: 1 }]) {
    await assert.rejects(advanceSyntheticProbe(env, f.storage, { ...f.journal, ...patch } as SyntheticProbeRecord, f.save));
  }
  assert.deepEqual(f.calls, []);
});
test("privacy preflight rejects public development access, custom domains and wrong jurisdiction", async () => {
  for (const scenario of ["private", "dev", "custom", "wrong"] as const) {
    const request: typeof fetch = async (url, init) => {
      assert.equal((init?.headers as Record<string, string>)["cf-r2-jurisdiction"], "us");
      const u = String(url);
      const result = u.endsWith("/domains/managed") ? { enabled: scenario === "dev" } : u.endsWith("/domains/custom") ? { domains: scenario === "custom" ? [{}] : [] } : u.endsWith("/lifecycle") ? { rules: [] } : { name: env.M2_R2_BUCKET, jurisdiction: scenario === "wrong" ? "eu" : "us" };
      return Response.json({ success: true, result });
    };
    const promise = privateR2Proof({ ...env, M2_R2_CONTROL_API_TOKEN: "test-placeholder" }, request);
    if (scenario === "private") await promise; else await assert.rejects(promise, /PRIVACY_OR_TARGET/);
  }
});
