// Operator CLI only; never imported by public /api/health.
import { readiness, scope } from "@vynvori/shared/infrastructure";
import { medusaClient } from "@vynvori/commerce";
import { runR2Probe } from "./r2-operator";
import { processingClient } from "@vynvori/commerce/processing";
import { connectDatabase } from "@vynvori/db";
async function main() {
scope(process.env);
const checks = await Promise.all([
  readiness("medusa", process.env.M2_MEDUSA_ORIGIN ? () => medusaClient(process.env).ready() : undefined),
  readiness("database", process.env.M2_CREATIVE_DATABASE_URL ? async () => { const db = connectDatabase(process.env); try { await db.ready(); } finally { await db.close(); } } : undefined),
  readiness("storage", process.env.M2_R2_BUCKET ? async () => {
    await runR2Probe(process.env, process.env.M2_R2_PROBE_JOURNAL);
  } : undefined),
  readiness("processing", process.env.M2_PROCESSING_ORIGIN ? () => processingClient(process.env).ready() : undefined),
]);
console.log(JSON.stringify(checks));
if (checks.some(check => check.status !== "ready")) process.exitCode = 1;
}
main().catch(() => { console.error(JSON.stringify({ version: 1, status: "configuration_invalid" })); process.exitCode = 1; });
