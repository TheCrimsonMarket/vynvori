import "server-only";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const folder = fileURLToPath(new URL("../ledger-migrations", import.meta.url));
/** Disposable test databases only: vynvori_m7_<name>_test. No remote target exists in this plan. */
export const LEDGER_TEST_DATABASE = /^vynvori_m7_[a-z0-9]+(?:_[a-z0-9]+)*_test$/;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
type Plan = { version: number; purpose: string; requires: string[]; journalSchema: string; migrations: { file: string; sha256: string }[] };
export class LedgerMigrationError extends Error {
  constructor(readonly code: "PLAN_INVALID" | "TARGET_REJECTED" | "PREREQUISITE_MISSING" | "HISTORY_OR_SCHEMA_DRIFT" | "EXECUTION_FAILED" | "OUTCOME_UNKNOWN") { super(code); this.name = "LedgerMigrationError"; }
}
/** Reads the reviewed plan and verifies each SQL file against its pinned SHA-256. No environment/database access. */
export function ledgerMigrationPlan(directory = folder) {
  try {
    const raw = readFileSync(directory + "/plan.json", "utf8"), plan = JSON.parse(raw) as Plan;
    if (plan.version !== 1 || plan.purpose !== "vynvori-credit-ledger" || plan.journalSchema !== "vynvori_ledger_migrations" || !plan.migrations.length) throw new Error();
    const migrations = plan.migrations.map(entry => {
      if (!/^\d{4}_[a-z_]+\.sql$/.test(entry.file)) throw new Error();
      const sql = readFileSync(directory + "/" + entry.file, "utf8");
      if (digest(sql) !== entry.sha256) throw new Error();
      return { ...entry, sql };
    });
    return { digest: digest(raw), plan, migrations };
  } catch { throw new LedgerMigrationError("PLAN_INVALID"); }
}
/**
 * LOCAL synthetic database only. M7 S1 does NOT authorise any staging/production apply: that needs the founder's
 * separate remote-database approval and its own pinned target (see ADR-0021 §Rollout). Host, database-name, role-string and plan-digest checks reject
 * before any statement; the server-side database/user check follows inside the transaction. No grants, no retries, no down migration (the manual rollback script refuses while
 * ledger relations exist).
 */
export async function applyLedgerMigrations(client: Client, expected: { database: string; role: string; planSha256: string }) {
  if (!(client instanceof Client)) throw new LedgerMigrationError("TARGET_REJECTED");
  const loaded = ledgerMigrationPlan(); let commitStarted = false;
  if (!LEDGER_TEST_DATABASE.test(expected.database) || expected.role !== "synthetic" || client.host !== "127.0.0.1" || expected.planSha256 !== loaded.digest) throw new LedgerMigrationError("TARGET_REJECTED");
  try {
    await client.query("BEGIN"); await client.query("SET LOCAL lock_timeout='4s'");
    await client.query("SELECT pg_advisory_xact_lock(742110,7)");
    const target = (await client.query("SELECT current_database() AS db,current_user AS role,session_user AS login")).rows[0];
    if (target.db !== expected.database || target.role !== expected.role || target.login !== expected.role) throw new LedgerMigrationError("TARGET_REJECTED");
    for (const schema of loaded.plan.requires) if (!(await client.query("SELECT to_regnamespace($1) AS ns", [schema])).rows[0].ns) throw new LedgerMigrationError("PREREQUISITE_MISSING");
    const journal = loaded.plan.journalSchema;
    const hasJournal = !!(await client.query("SELECT to_regnamespace($1) AS ns", [journal])).rows[0].ns;
    const hasSchema = !!(await client.query("SELECT to_regnamespace('vynvori_ledger') AS ns")).rows[0].ns;
    if (hasJournal !== hasSchema) throw new LedgerMigrationError("HISTORY_OR_SCHEMA_DRIFT");
    if (!hasJournal) await client.query(`CREATE SCHEMA ${journal}; CREATE TABLE ${journal}.applied(file text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = (await client.query(`SELECT file,sha256 FROM ${journal}.applied ORDER BY file`)).rows as { file: string; sha256: string }[];
    if (applied.length > loaded.migrations.length || applied.some((row, index) => row.file !== loaded.migrations[index]!.file || row.sha256 !== loaded.migrations[index]!.sha256)) throw new LedgerMigrationError("HISTORY_OR_SCHEMA_DRIFT");
    for (const migration of loaded.migrations.slice(applied.length)) {
      await client.query(migration.sql);
      await client.query(`INSERT INTO ${journal}.applied(file,sha256) VALUES($1,$2)`, [migration.file, migration.sha256]);
    }
    commitStarted = true; await client.query("COMMIT");
    return { applied: loaded.migrations.length - applied.length, total: loaded.migrations.length, planSha256: loaded.digest };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* unknown connection state is never retried */ }
    if (commitStarted) throw new LedgerMigrationError("OUTCOME_UNKNOWN");
    throw error instanceof LedgerMigrationError ? error : new LedgerMigrationError("EXECUTION_FAILED");
  }
}
