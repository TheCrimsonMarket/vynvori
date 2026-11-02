import "server-only";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { readMigrationFiles } from "drizzle-orm/migrator";

const folder = fileURLToPath(new URL("../auth-migrations", import.meta.url));
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
type Manifest = { version: number; purpose: string; target: { database: string; host: string; migrationRole: string }; journalSchema: string; migrations: { file: string; when: number; sha256: string }[] };
export class IdentityMigrationError extends Error {
  constructor(readonly code: "PLAN_INVALID" | "TARGET_REJECTED" | "HISTORY_OR_SCHEMA_DRIFT" | "EXECUTION_FAILED" | "OUTCOME_UNKNOWN") { super(code); this.name = "IdentityMigrationError"; }
}
/** Drizzle's journal reader plus explicit reviewed SQL hashes; no environment/database access. */
export function identityMigrationPlan(directory = folder) {
  try {
    const raw = readFileSync(directory + "/plan.json", "utf8"), manifest = JSON.parse(raw) as Manifest;
    const migrations = readMigrationFiles({ migrationsFolder: directory });
    if (manifest.version !== 1 || manifest.purpose !== "vynvori-identity-staging" || manifest.journalSchema !== "vynvori_identity_migrations" || migrations.length !== manifest.migrations.length || !migrations.length) throw new Error();
    migrations.forEach((migration, index) => {
      const expected = manifest.migrations[index]!;
      if (!/^\d{4}_[a-z_]+\.sql$/.test(expected.file) || !Number.isSafeInteger(expected.when) || migration.hash !== expected.sha256 || migration.folderMillis !== expected.when ||
          (index > 0 && expected.when <= manifest.migrations[index - 1]!.when) || digest(readFileSync(directory + "/" + expected.file, "utf8")) !== expected.sha256) throw new Error();
    });
    return { digest: digest(raw), manifest, migrations };
  } catch { throw new IdentityMigrationError("PLAN_INVALID"); }
}
export function identityMigrationTarget(env: Readonly<Record<string, string | undefined>>, plan = identityMigrationPlan(), mode: "apply" | "inspect" = "apply") {
  try {
    if (env.M1B_IDENTITY_MIGRATION_PLAN_SHA256 !== plan.digest || env.VERCEL_ENV === "production" || env.NODE_TLS_REJECT_UNAUTHORIZED && env.NODE_TLS_REJECT_UNAUTHORIZED !== "1") throw new Error();
    const url = new URL(env.M1B_IDENTITY_MIGRATION_DATABASE_URL ?? "");
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.username || !url.password || url.hash) throw new Error();
    const local = env.M1B_IDENTITY_MIGRATION_SCOPE === "local" && url.hostname === "127.0.0.1" && url.pathname === "/vynvori_m1b_migration_test" && url.username === "synthetic" && !url.search;
    const staging = env.M1B_IDENTITY_MIGRATION_SCOPE === "staging" && url.hostname === plan.manifest.target.host && !url.port && url.pathname === "/" + plan.manifest.target.database &&
      decodeURIComponent(url.username) === plan.manifest.target.migrationRole && [...url.searchParams].length === 1 && url.searchParams.get("sslmode") === "verify-full";
    if (!(local || staging) || env[mode === "apply" ? "M1B_APPLY_IDENTITY_MIGRATIONS" : "M1B_INSPECT_IDENTITY_MIGRATIONS"] !== (local ? "vynvori_m1b_migration_test" : "vynvori_creative_staging")) throw new Error();
    return { url, database: url.pathname.slice(1), role: decodeURIComponent(url.username), planSha256: plan.digest };
  } catch { throw new IdentityMigrationError("TARGET_REJECTED"); }
}
async function physicalDigest(client: Client): Promise<string> {
  const result = await client.query(`SELECT jsonb_build_object(
    'schema',(SELECT jsonb_agg(jsonb_build_array(nspname,pg_get_userbyid(nspowner))) FROM pg_namespace WHERE nspname='vynvori_identity'),
    'relations',(SELECT jsonb_agg(jsonb_build_array(c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner)) ORDER BY c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='vynvori_identity'),
    'columns',(SELECT jsonb_agg(jsonb_build_array(c.relname,a.attnum,a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid)) ORDER BY c.relname,a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE n.nspname='vynvori_identity' AND a.attnum>0 AND NOT a.attisdropped),
    'constraints',(SELECT jsonb_agg(jsonb_build_array(c.conname,c.contype,c.convalidated,pg_get_constraintdef(c.oid,true)) ORDER BY r.relname,c.conname) FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname='vynvori_identity'),
    'indexes',(SELECT jsonb_agg(jsonb_build_array(indexname,indexdef) ORDER BY indexname) FROM pg_indexes WHERE schemaname='vynvori_identity'),
    'triggers',(SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='vynvori_identity' AND NOT t.tgisinternal),
    'routines',(SELECT jsonb_agg(jsonb_build_array(p.proname,pg_get_functiondef(p.oid)) ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='vynvori_identity')
    ) AS definition`);
  return digest(JSON.stringify(result.rows[0].definition));
}
/** Metadata-only read transaction for recovery after an unknown outcome or a restore. */
export async function inspectIdentityMigrations(client: Client) {
  const plan = identityMigrationPlan();
  try {
    await client.query("BEGIN READ ONLY"); await client.query("SET LOCAL search_path=pg_catalog");
    const schemas = (await client.query("SELECT to_regnamespace('vynvori_identity') AS identity,to_regnamespace('vynvori_identity_migrations') AS history")).rows[0];
    if (!!schemas.identity !== !!schemas.history) throw new IdentityMigrationError("HISTORY_OR_SCHEMA_DRIFT");
    if (!schemas.history) return { applied: 0, pending: plan.migrations.length, planSha256: plan.digest, schemaSha256: null };
    const rows = (await client.query("SELECT hash,created_at,schema_hash FROM vynvori_identity_migrations.__drizzle_migrations ORDER BY created_at")).rows;
    const schemaSha256 = await physicalDigest(client);
    if (!rows.length || rows.length > plan.migrations.length || rows.some((row, index) => row.hash !== plan.migrations[index]!.hash || Number(row.created_at) !== plan.migrations[index]!.folderMillis) || rows.at(-1)!.schema_hash !== schemaSha256) throw new IdentityMigrationError("HISTORY_OR_SCHEMA_DRIFT");
    return { applied: rows.length, pending: plan.migrations.length - rows.length, planSha256: plan.digest, schemaSha256 };
  } catch (error) { throw error instanceof IdentityMigrationError ? error : new IdentityMigrationError("EXECUTION_FAILED"); }
  finally { await client.query("ROLLBACK"); }
}
/** Dedicated connection only; all metadata and domain DDL commit atomically. No grants, retries or down migration. */
export async function applyIdentityMigrations(client: Client, expected: { database: string; role: string; planSha256: string }) {
  if (!(client instanceof Client)) throw new IdentityMigrationError("TARGET_REJECTED");
  const plan = identityMigrationPlan(); let commitStarted = false;
  const local = expected.database === "vynvori_m1b_migration_test" && expected.role === "synthetic" && client.host === "127.0.0.1";
  const staging = expected.database === plan.manifest.target.database && expected.role === plan.manifest.target.migrationRole && client.host === plan.manifest.target.host && !!client.ssl;
  if (!(local || staging) || expected.planSha256 !== plan.digest) throw new IdentityMigrationError("TARGET_REJECTED");
  try {
    await client.query("BEGIN"); await client.query("SET LOCAL search_path=pg_catalog"); await client.query("SET LOCAL lock_timeout='4s'");
    await client.query("SELECT pg_advisory_xact_lock(742110,1)");
    const target = (await client.query("SELECT current_database() AS db,current_user AS role,session_user AS login")).rows[0];
    if (target.db !== expected.database || target.role !== expected.role || target.login !== expected.role) throw new IdentityMigrationError("TARGET_REJECTED");
    const existing = (await client.query("SELECT to_regnamespace('vynvori_identity') AS identity,to_regnamespace('vynvori_identity_migrations') AS history")).rows[0];
    if (!!existing.identity !== !!existing.history) throw new IdentityMigrationError("HISTORY_OR_SCHEMA_DRIFT");
    if (!existing.history) await client.query(`CREATE SCHEMA vynvori_identity_migrations;
      CREATE TABLE vynvori_identity_migrations.__drizzle_migrations(id serial PRIMARY KEY,hash text NOT NULL,created_at bigint NOT NULL UNIQUE,schema_hash text NOT NULL)`);
    const rows = (await client.query("SELECT hash,created_at,schema_hash FROM vynvori_identity_migrations.__drizzle_migrations ORDER BY created_at")).rows;
    if (rows.length > plan.migrations.length || rows.some((row, index) => row.hash !== plan.migrations[index]!.hash || Number(row.created_at) !== plan.migrations[index]!.folderMillis) ||
        (existing.history && !rows.length) || (rows.length && rows.at(-1)!.schema_hash !== await physicalDigest(client))) throw new IdentityMigrationError("HISTORY_OR_SCHEMA_DRIFT");
    for (const migration of plan.migrations.slice(rows.length)) {
      for (const statement of migration.sql) await client.query(statement);
      await client.query("INSERT INTO vynvori_identity_migrations.__drizzle_migrations(hash,created_at,schema_hash) VALUES($1,$2,$3)", [migration.hash, migration.folderMillis, await physicalDigest(client)]);
    }
    commitStarted = true; await client.query("COMMIT");
    return { applied: plan.migrations.length - rows.length, total: plan.migrations.length, planSha256: plan.digest };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* Unknown connection state never triggers a retry. */ }
    if (commitStarted) throw new IdentityMigrationError("OUTCOME_UNKNOWN");
    throw error instanceof IdentityMigrationError ? error : new IdentityMigrationError("EXECUTION_FAILED");
  }
}
