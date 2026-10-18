import "server-only";
import { createHash } from "node:crypto";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand, HeadObjectCommand } from "@aws-sdk/client-s3";
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
export function r2Target(env: InfraEnv) {
  scope(env);
  const account = required(env, "M2_R2_ACCOUNT_ID");
  const bucket = required(env, "M2_R2_BUCKET");
  if (!/^[a-f0-9]{32}$/.test(account) || !/^vynvori-staging-[a-z0-9-]{3,40}$/.test(bucket)) throw new Error("Invalid staging R2 identity");
  const jurisdiction = env.M2_R2_JURISDICTION ?? (env.M2_ENV === "local" ? "default" : required(env, "M2_R2_JURISDICTION"));
  if (!["default", "us", "eu"].includes(jurisdiction)) throw new Error("Unsupported R2 jurisdiction");
  return { account, bucket, jurisdiction, endpoint: `https://${account}${jurisdiction === "default" ? "" : `.${jurisdiction}`}.r2.cloudflarestorage.com` };
}
export function storageAdapter(env: InfraEnv, sender?: Sender) {
  const { bucket, endpoint } = r2Target(env);
  const client = sender ?? new S3Client({
    endpoint, region: "auto", maxAttempts: 1,
    requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
    credentials: { accessKeyId: required(env, "M2_R2_ACCESS_KEY_ID"), secretAccessKey: required(env, "M2_R2_SECRET_ACCESS_KEY") },
  });
  function key(runId: string) { return syntheticKey(runId, digest(syntheticPng())); }
  function owned(runId: string, result: { ContentType?: string | undefined; ContentLength?: number | undefined; Metadata?: Record<string, string> | undefined }) {
    return result.ContentType === "image/png" && result.ContentLength === syntheticPng().length &&
      result.Metadata?.sha256 === digest(syntheticPng()) && result.Metadata.fixture === "m2-synthetic-v1" && result.Metadata.run_id === runId;
  }
  async function inspect(runId: string) {
    const objectKey = key(runId);
    try {
      const result = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }), { abortSignal: AbortSignal.timeout(5000) });
      if (!owned(runId, result)) throw new Error("Foreign or invalid synthetic object; preserve it");
      return { status: "owned" as const, key: objectKey };
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return { status: "absent" as const, key: objectKey };
      throw error; // AccessDenied, timeout and network errors never mean absent.
    }
  }
  return {
    inspect,
    async ready() { await client.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: AbortSignal.timeout(5000) }); },
    async upload(runId: string, bytes: Uint8Array, mime: string) {
      if (mime !== "image/png" || bytes.byteLength > 1024 || !Buffer.from(bytes).equals(syntheticPng())) throw new Error("Only approved synthetic PNG accepted");
      const objectKey = key(runId);
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: bytes, ContentLength: bytes.byteLength, ContentType: mime, IfNoneMatch: "*", Metadata: { sha256: digest(bytes), fixture: "m2-synthetic-v1", run_id: runId } }), { abortSignal: AbortSignal.timeout(5000) });
      return { version: 1 as const, key: objectKey, sha256: digest(bytes) };
    },
    async read(runId: string, signal?: AbortSignal) {
      const objectKey = key(runId);
      const controller = new AbortController();
      let body: (AsyncIterable<Uint8Array> & { destroy?: () => void }) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      const deadline = new Promise<never>((_, reject) => {
        abort = () => { controller.abort(); body?.destroy?.(); reject(new Error("Synthetic read aborted or timed out")); };
        timer = setTimeout(abort, 5000);
        signal?.addEventListener("abort", abort, { once: true });
      });
      try {
        if (signal?.aborted) throw new Error("Synthetic read aborted");
        const result = await Promise.race([client.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }), { abortSignal: controller.signal }), deadline]);
        body = result.Body as unknown as typeof body;
        if (!owned(runId, result) || !body || typeof body[Symbol.asyncIterator] !== "function") throw new Error("Invalid synthetic object");
        const stream = body;
        const consume = async () => {
          const chunks: Uint8Array[] = [];
          let total = 0;
          for await (const chunk of stream) {
            if (!(chunk instanceof Uint8Array) || total + chunk.byteLength > syntheticPng().length) throw new Error("Synthetic object exceeds byte limit");
            total += chunk.byteLength; chunks.push(chunk);
          }
          const bytes = Buffer.concat(chunks);
          if (!bytes.equals(syntheticPng())) throw new Error("Synthetic object integrity failure");
          return bytes;
        };
        return await Promise.race([consume(), deadline]);
      } finally {
        clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort);
        controller.abort(); body?.destroy?.();
      }
    },
    async remove(runId: string) {
      if ((await inspect(runId)).status === "owned") await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key(runId) }), { abortSignal: AbortSignal.timeout(5000) });
    },
    close() { if (!sender) (client as S3Client).destroy(); },
  };
}
