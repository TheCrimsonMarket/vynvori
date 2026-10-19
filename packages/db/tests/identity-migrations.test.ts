import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { identityMigrationPlan, identityMigrationTarget, applyIdentityMigrations } from "../src/identity-migrations";

test("identity migration plan uses a separate Drizzle journal and exact reviewed hashes", () => {
  const plan = identityMigrationPlan(); assert.equal(plan.migrations.length, 4); assert.match(plan.digest, /^[a-f0-9]{64}$/);
  assert.equal(plan.manifest.journalSchema, "vynvori_identity_migrations");
});
test("identity migration guard rejects missing approval, root fallback and unsafe targets", () => {
  const plan = identityMigrationPlan(), url = "postgresql://vynvori_staging_app:synthetic@" + plan.manifest.target.host + "/vynvori_creative_staging?sslmode=verify-full";
  const env = { M1B_IDENTITY_MIGRATION_SCOPE: "staging", M1B_IDENTITY_MIGRATION_DATABASE_URL: url, M1B_APPLY_IDENTITY_MIGRATIONS: "vynvori_creative_staging", M1B_IDENTITY_MIGRATION_PLAN_SHA256: plan.digest };
  assert.equal(identityMigrationTarget(env).role, "vynvori_staging_app");
  for (const patch of [{ M1B_APPLY_IDENTITY_MIGRATIONS: "" }, { M1B_IDENTITY_MIGRATION_PLAN_SHA256: "other" },
    { M1B_IDENTITY_MIGRATION_DATABASE_URL: undefined, DATABASE_URL: url }, { VERCEL_ENV: "production" },
    { M1B_IDENTITY_MIGRATION_DATABASE_URL: url.replace("verify-full", "require") }, { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    { M1B_IDENTITY_MIGRATION_DATABASE_URL: url.replace("vynvori_staging_app", "vynvori_identity_runtime_scoped") },
    { M1B_IDENTITY_MIGRATION_DATABASE_URL: url + "&sslmode=disable" }]) assert.throws(() => identityMigrationTarget({ ...env, ...patch }));
});
const connection = process.env.M1B_TEST_MIGRATION_POSTGRES_URL;
test("identity migration atomicity, replay and drift in disposable PostgreSQL", { skip: !connection }, async t => {
  const url = new URL(connection!); assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.pathname, "/vynvori_m1b_migration_test"); assert.equal(url.username, "synthetic");
  const client = new Client({ connectionString: url.toString() }); await client.connect();
  const plan = identityMigrationPlan(), expected = { database: "vynvori_m1b_migration_test", role: "synthetic", planSha256: plan.digest };
  try {
    await t.test("wrong database or plan cannot write", async () => {
      await assert.rejects(applyIdentityMigrations(client, { ...expected, database: "production" }), /TARGET_REJECTED/);
      await assert.rejects(applyIdentityMigrations(client, { ...expected, planSha256: "stale" }), /TARGET_REJECTED/);
    });
    await t.test("failure after the first migration rolls back identity and journal schemas", async () => {
      const query = client.query.bind(client);
      client.query = ((sql: string, ...args: unknown[]) => {
        if (typeof sql === "string" && sql.includes("CREATE TABLE vynvori_identity.commerce_mappings")) throw new Error("synthetic-mid-migration-failure");
        return (query as (...values: unknown[]) => unknown)(sql, ...args);
      }) as typeof client.query;
      try { await assert.rejects(applyIdentityMigrations(client, expected), /EXECUTION_FAILED/); } finally { client.query = query; }
      const row = (await client.query("SELECT to_regnamespace('vynvori_identity') AS a,to_regnamespace('vynvori_identity_migrations') AS b")).rows[0];
      assert.equal(row.a, null); assert.equal(row.b, null);
    });
    await t.test("an untracked schema is preserved and rejected", async () => {
      await client.query("CREATE SCHEMA vynvori_identity");
      await assert.rejects(applyIdentityMigrations(client, expected), /HISTORY_OR_SCHEMA_DRIFT/);
      await client.query("ALTER SCHEMA vynvori_identity RENAME TO synthetic_conflict_retained");
    });
    await t.test("apply and explicit replay preserve one exact four-entry history", async () => {
      assert.equal((await applyIdentityMigrations(client, expected)).applied, 4);
      assert.equal((await applyIdentityMigrations(client, expected)).applied, 0);
      assert.equal((await client.query("SELECT COUNT(*)::int AS n FROM vynvori_identity_migrations.__drizzle_migrations")).rows[0].n, 4);
    });
    await t.test("changed history is rejected before further DDL", async () => {
      await client.query("UPDATE vynvori_identity_migrations.__drizzle_migrations SET hash='synthetic-drift' WHERE created_at=$1", [plan.migrations[0]!.folderMillis]);
      await assert.rejects(applyIdentityMigrations(client, expected), /HISTORY_OR_SCHEMA_DRIFT/);
      await client.query("UPDATE vynvori_identity_migrations.__drizzle_migrations SET hash=$1 WHERE created_at=$2", [plan.migrations[0]!.hash, plan.migrations[0]!.folderMillis]);
    });
    await t.test("physical schema drift is rejected despite unchanged history", async () => {
      await client.query("ALTER TABLE vynvori_identity.sessions RENAME COLUMN token_hash TO synthetic_changed_hash");
      await assert.rejects(applyIdentityMigrations(client, expected), /HISTORY_OR_SCHEMA_DRIFT/);
      await client.query("ALTER TABLE vynvori_identity.sessions RENAME COLUMN synthetic_changed_hash TO token_hash");
      assert.equal((await applyIdentityMigrations(client, expected)).applied, 0);
    });
    await t.test("lost commit acknowledgement reports unknown; explicit inspection/replay finds committed history", async () => {
      const query = client.query.bind(client);
      client.query = (async (sql: string, ...args: unknown[]) => {
        const result = await (query as (...values: unknown[]) => Promise<unknown>)(sql, ...args);
        if (sql === "COMMIT") throw new Error("synthetic-lost-commit-response");
        return result;
      }) as typeof client.query;
      try { await assert.rejects(applyIdentityMigrations(client, expected), /OUTCOME_UNKNOWN/); } finally { client.query = query; }
      assert.equal((await applyIdentityMigrations(client, expected)).applied, 0);
    });
    await t.test("restricted identity grants do not expose migration history or DDL", async () => {
      await client.query(`CREATE ROLE synthetic_identity_grants NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
        REVOKE CREATE,TEMPORARY ON DATABASE vynvori_m1b_migration_test FROM PUBLIC; REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT USAGE ON SCHEMA vynvori_identity TO synthetic_identity_grants;
        GRANT SELECT,INSERT,UPDATE ON vynvori_identity.profiles,vynvori_identity.login_transactions,vynvori_identity.sessions,vynvori_identity.guest_drafts,vynvori_identity.commerce_mappings TO synthetic_identity_grants;
        SET ROLE synthetic_identity_grants`);
      try {
        await client.query("SELECT id FROM vynvori_identity.profiles LIMIT 1");
        for (const sql of ["SELECT * FROM vynvori_identity_migrations.__drizzle_migrations", "CREATE TABLE vynvori_identity.forbidden(id int)", "DELETE FROM vynvori_identity.sessions", "TRUNCATE vynvori_identity.sessions", "CREATE TEMP TABLE forbidden(id int)"])
          await assert.rejects(client.query(sql), { code: "42501" });
      } finally { await client.query("RESET ROLE"); }
    });
  } finally { await client.end(); }
});
