// Operator CLI only; never imported by public /api/health.
import { readiness, scope } from "@vynvori/shared/infrastructure";
import { medusaClient } from "@vynvori/commerce";
import { storageAdapter, syntheticPng } from "@vynvori/commerce/storage";
import { processingClient } from "@vynvori/commerce/processing";
import { connectDatabase } from "@vynvori/db";
import { randomUUID } from "node:crypto";
async function main() {
scope(process.env);
const checks = await Promise.all([
  readiness("medusa", process.env.M2_MEDUSA_ORIGIN ? () => medusaClient(process.env).ready() : undefined),
  readiness("database", process.env.M2_CREATIVE_DATABASE_URL ? async () => { const db = connectDatabase(process.env); try { await db.ready(); } finally { await db.close(); } } : undefined),
  readiness("storage", process.env.M2_R2_BUCKET ? async () => {
    const storage = storageAdapter(process.env);
    const id = randomUUID();
    console.error(JSON.stringify({ event: "synthetic_storage_smoke", runId: id }));
    try { await storage.upload(id, syntheticPng(), "image/png"); await storage.read(id); }
    finally { try { await storage.remove(id); } finally { storage.close(); } }
  } : undefined),
  readiness("processing", process.env.M2_PROCESSING_ORIGIN ? () => processingClient(process.env).ready() : undefined),
]);
console.log(JSON.stringify(checks));
if (checks.some(check => check.status !== "ready")) process.exitCode = 1;
}
main().catch(() => { console.error(JSON.stringify({ version: 1, status: "configuration_invalid" })); process.exitCode = 1; });
