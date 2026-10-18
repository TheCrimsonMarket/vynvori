// Local operator only. Credentials remain in process memory; journals contain no secrets.
import { open, readFile, rename, unlink, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { r2Target, storageAdapter } from "../packages/commerce/src/storage";
import { advanceSyntheticProbe, newSyntheticProbe, validateSyntheticProbe, type SyntheticProbeRecord } from "../packages/commerce/src/synthetic-storage-probe";
import { required, type InfraEnv } from "@vynvori/shared/infrastructure";

export async function privateR2Proof(env: InfraEnv, request: typeof fetch = fetch) {
  const target = r2Target(env);
  const token = required(env, "M2_R2_CONTROL_API_TOKEN");
  async function get(suffix: string) {
    const response = await request(`https://api.cloudflare.com/client/v4/accounts/${target.account}/r2/buckets/${target.bucket}${suffix}`, {
      headers: { Authorization: `Bearer ${token}`, "cf-r2-jurisdiction": target.jurisdiction },
      redirect: "error", cache: "no-store", signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("R2_CONTROL_READ_FAILED");
    const body = await response.json();
    if (body.success !== true || !body.result) throw new Error("R2_CONTROL_READ_FAILED");
    return body.result;
  }
  const bucket = await get("");
  const managed = await get("/domains/managed");
  const custom = await get("/domains/custom");
  const lifecycle = await get("/lifecycle");
  if (bucket.name !== target.bucket || (bucket.jurisdiction || "default") !== target.jurisdiction ||
      managed.enabled !== false || !Array.isArray(custom.domains) || custom.domains.length !== 0) throw new Error("R2_PRIVACY_OR_TARGET_NOT_VERIFIED");
  return { checkedAt: new Date().toISOString(), ...target, bucketCreatedAt: bucket.creation_date,
    location: bucket.location, bucketId: managed.bucketId, publicDevelopmentEnabled: managed.enabled,
    customDomains: custom.domains, lifecycleRules: lifecycle.rules };
}

async function persist(file: string, record: SyntheticProbeRecord) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(record, null, 2) + "\n"); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, file);
}

export async function runR2Probe(env: InfraEnv, journal?: string) {
  const proof = await privateR2Proof(env); // Fresh control-plane proof before object mutations.
  const file = journal ? path.resolve(journal) : path.join(await mkdtemp(path.join(tmpdir(), "VYNVORI-R2-")), "journal.json");
  const lock = await open(`${file}.lock`, "wx", 0o600); // Never automatically break a stale lock.
  let storage: ReturnType<typeof storageAdapter> | undefined;
  try {
    let record: SyntheticProbeRecord;
    if (journal) { record = JSON.parse(await readFile(file, "utf8")); validateSyntheticProbe(env, record); }
    else { record = newSyntheticProbe(env, randomUUID()); await persist(file, record); }
    console.error(JSON.stringify({ event: "r2_probe_journal", file, runId: record.runId }));
    storage = storageAdapter(env);
    await storage.ready();
    const result = await advanceSyntheticProbe(env, storage, record, next => persist(file, next));
    return { proof, journal: file, result };
  } finally {
    storage?.close(); await lock.close(); await unlink(`${file}.lock`);
  }
}
