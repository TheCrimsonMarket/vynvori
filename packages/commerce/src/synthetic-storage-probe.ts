import "server-only";
import { createHash } from "node:crypto";
import { r2Target, syntheticKey, syntheticPng, type storageAdapter } from "./storage";
import type { InfraEnv } from "@vynvori/shared/infrastructure";

type Phase = "NEW" | "PUT_PENDING" | "STORED" | "VERIFIED" | "DELETE_PENDING" | "COMPLETE" | "CONFLICT";
export type SyntheticProbeRecord = {
  version: 1; account: string; bucket: string; jurisdiction: string; runId: string; key: string;
  sha256: string; phase: Phase; putAttempts: number; deleteAttempts: number; verified: boolean;
};
type Storage = Pick<ReturnType<typeof storageAdapter>, "inspect" | "upload" | "read" | "remove">;
export function newSyntheticProbe(env: InfraEnv, runId: string): SyntheticProbeRecord {
  const target = r2Target(env);
  const sha256 = createHash("sha256").update(syntheticPng()).digest("hex");
  return { version: 1, account: target.account, bucket: target.bucket, jurisdiction: target.jurisdiction,
    runId, key: syntheticKey(runId, sha256), sha256, phase: "NEW", putAttempts: 0, deleteAttempts: 0, verified: false };
}
export function validateSyntheticProbe(env: InfraEnv, record: SyntheticProbeRecord) {
  const expected = newSyntheticProbe(env, record.runId);
  if (record.version !== 1 || record.account !== expected.account || record.bucket !== expected.bucket ||
    record.jurisdiction !== expected.jurisdiction || record.key !== expected.key || record.sha256 !== expected.sha256 ||
    !["NEW", "PUT_PENDING", "STORED", "VERIFIED", "DELETE_PENDING", "COMPLETE", "CONFLICT"].includes(record.phase) ||
    ![0, 1].includes(record.putAttempts) || ![0, 1].includes(record.deleteAttempts) || typeof record.verified !== "boolean" ||
    (record.phase === "NEW" ? record.putAttempts !== 0 || record.deleteAttempts !== 0 || record.verified : record.putAttempts !== 1) ||
    (record.deleteAttempts === 1 && !record.verified) ||
    (!["DELETE_PENDING", "COMPLETE"].includes(record.phase) && record.deleteAttempts !== 0) ||
    (["PUT_PENDING", "CONFLICT"].includes(record.phase) && record.verified) ||
    (["VERIFIED", "DELETE_PENDING", "COMPLETE"].includes(record.phase) && !record.verified) ||
    (["DELETE_PENDING", "COMPLETE"].includes(record.phase) && record.deleteAttempts !== 1)) throw new Error("R2_JOURNAL_INVALID_OR_TARGET_CHANGED");
}

// One PUT and one DELETE per durable run. Unknown outcomes are reconciled by
// HEAD/read; neither mutation is automatically repeated. A pending operation
// that remains unobservable requires operator investigation, never a new run.
export async function advanceSyntheticProbe(env: InfraEnv, storage: Storage, initial: SyntheticProbeRecord,
  save: (record: SyntheticProbeRecord) => Promise<void>): Promise<SyntheticProbeRecord> {
  validateSyntheticProbe(env, initial);
  let record = structuredClone(initial);
  const checkpoint = async (patch: Partial<SyntheticProbeRecord>) => {
    const next = { ...record, ...patch }; validateSyntheticProbe(env, next);
    await save(next); record = next;
  };
  if (record.phase === "COMPLETE") return record;
  if (record.phase === "CONFLICT") throw new Error("R2_EXISTING_OBJECT_CONFLICT_PRESERVED");
  if (record.phase === "NEW") {
    if ((await storage.inspect(record.runId)).status !== "absent") throw new Error("R2_EXISTING_OBJECT_PRESERVED");
    await checkpoint({ phase: "PUT_PENDING", putAttempts: 1 });
    try { await storage.upload(record.runId, syntheticPng(), "image/png"); }
    catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 412) {
        await checkpoint({ phase: "CONFLICT" }); throw new Error("R2_EXISTING_OBJECT_CONFLICT_PRESERVED");
      }
      // PUT_PENDING was persisted before the call. HEAD below can establish
      // ownership if the write committed but its acknowledgement was lost.
    }
  }
  const observed = await storage.inspect(record.runId);
  if (observed.status === "absent") {
    if (record.phase === "DELETE_PENDING" && record.verified) { await checkpoint({ phase: "COMPLETE" }); return record; }
    throw new Error("R2_PUT_OUTCOME_UNRESOLVED_OR_OBJECT_LOST");
  }
  if (record.phase === "DELETE_PENDING") throw new Error("R2_DELETE_OUTCOME_UNRESOLVED_PRESERVE_OBJECT");
  await checkpoint({ phase: "STORED" });
  await storage.read(record.runId);
  await checkpoint({ phase: "VERIFIED", verified: true });
  await checkpoint({ phase: "DELETE_PENDING", deleteAttempts: 1 });
  try { await storage.remove(record.runId); } catch { /* Reconcile; do not repeat DELETE. */ }
  if ((await storage.inspect(record.runId)).status !== "absent") throw new Error("R2_DELETE_OUTCOME_UNRESOLVED_PRESERVE_OBJECT");
  await checkpoint({ phase: "COMPLETE" });
  return record;
}
