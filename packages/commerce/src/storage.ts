import "server-only";
import { createHash } from "node:crypto";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { required, scope, type InfraEnv } from "@vynvori/shared/infrastructure";

// One approved synthetic 1x1 PNG. M2 has no customer upload API.
export const syntheticPng = () => Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nWQAAAAASUVORK5CYII=", "base64");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function syntheticKey(runId: string, sha: string) {
  if (!uuid.test(runId) || !/^[a-f0-9]{64}$/.test(sha)) throw new Error("Invalid synthetic asset identity");
  return `private/staging/synthetic/v1/${runId}/${sha}.png`;
}
type Sender = Pick<S3Client, "send">;
export function storageAdapter(env: InfraEnv, sender?: Sender) {
  scope(env);
  const account = required(env, "M2_R2_ACCOUNT_ID");
  const bucket = required(env, "M2_R2_BUCKET");
  if (!/^[a-f0-9]{32}$/.test(account) || !/^vynvori-staging-[a-z0-9-]{3,40}$/.test(bucket)) throw new Error("Invalid staging R2 identity");
  const client = sender ?? new S3Client({
    endpoint: `https://${account}.r2.cloudflarestorage.com`, region: "auto", maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
    credentials: { accessKeyId: required(env, "M2_R2_ACCESS_KEY_ID"), secretAccessKey: required(env, "M2_R2_SECRET_ACCESS_KEY") },
  });
  function key(runId: string) { return syntheticKey(runId, digest(syntheticPng())); }
  return {
    async ready() { await client.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: AbortSignal.timeout(5000) }); },
    async upload(runId: string, bytes: Uint8Array, mime: string) {
      if (mime !== "image/png" || bytes.byteLength > 1024 || !Buffer.from(bytes).equals(syntheticPng())) throw new Error("Only approved synthetic PNG accepted");
      const objectKey = key(runId);
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: bytes, ContentLength: bytes.byteLength, ContentType: mime, IfNoneMatch: "*", Metadata: { sha256: digest(bytes), fixture: "m2-synthetic-v1" } }), { abortSignal: AbortSignal.timeout(5000) });
      return { version: 1 as const, key: objectKey, sha256: digest(bytes) };
    },
    async read(runId: string) {
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key(runId) }), { abortSignal: AbortSignal.timeout(5000) });
      if (result.ContentType !== "image/png" || result.ContentLength !== syntheticPng().length || !result.Body) throw new Error("Invalid synthetic object");
      const bytes = await result.Body.transformToByteArray();
      if (!Buffer.from(bytes).equals(syntheticPng()) || result.Metadata?.sha256 !== digest(bytes)) throw new Error("Synthetic object integrity failure");
      return bytes;
    },
    async remove(runId: string) { await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key(runId) }), { abortSignal: AbortSignal.timeout(5000) }); },
    close() { if (!sender) (client as S3Client).destroy(); },
  };
}
