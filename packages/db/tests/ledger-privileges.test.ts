import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { ensureWallet, getWalletSummary } from "../src/ledger-core";
import { ledgerMigrationPlan } from "../src/ledger-migrations";
import { databaseFor, dropLedger, freshEmptyDatabase, grantSyntheticCredits, ledgerPoolAs, ledgerTarget, registerSyntheticGrantSource } from "./ledger-fixture";

/**
 * Privilege-model B proof (ADR-0021 S2 addendum). CI's `synthetic` is a SUPERUSER, so a test run as synthetic would pass with
 * ANY design. Here the fixture connection (superuser) only creates roles, applies the migration while `SET ROLE <owner>`, and
 * seeds profiles/grant sources; every assertion about what the runtime may do runs as a NON-superuser runtime role.
 * Roles are cluster-global: random per-run names, dropped at the end. SYNTHETIC_* values are test-only.
 */
const SYNTHETIC_UNITS = 4;
const either = (...codes: string[]) => (e: unknown) => codes.includes((e as { code?: string }).code ?? "");
const code = (c: string, pattern?: RegExp) => (e: unknown) => (e as { code?: string }).code === c && (!pattern || pattern.test((e as Error).message));
const migrationSql = () => ledgerMigrationPlan().migrations.map(m => m.sql);

test("privilege model B: a non-superuser runtime role cannot move wallet balances, mint credits or alter the ledger", { skip: ledgerTarget.skip }, async t => {
  assert.ok(ledgerTarget.url, "CI_REQUIRE_PG_TESTS=1 requires M7_TEST_POSTGRES_URL or M2_CREATIVE_DATABASE_URL");
  const suffix = randomBytes(6).toString("hex"), owner = "m7_own_" + suffix, rt = "m7_rt_" + suffix, rtw = "m7_rtw_" + suffix;
  const database = databaseFor("privileges");
  const admin = await freshEmptyDatabase("privileges");
  const pools: Pool[] = [];
  const asRole = async (role: string, options: { searchPath?: string; max?: number } = {}) => { const pool = await ledgerPoolAs("privileges", role, options); pools.push(pool); return pool; };
  const rolesCreated: string[] = [];
  try {
    // ---- fixture (superuser): roles, identity schema, owner-only grants --------------------------------------------------------------
    for (const [role, extra] of [[owner, ""], [rt, ""], [rtw, ""]] as const) { await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB${extra}`); rolesCreated.push(role); }
    await admin.query(`GRANT pg_write_all_data TO ${rtw}`); // a managed-database admin role may include this
    for (const sql of JSON.parse(readFileSync(new URL("../auth-migrations/plan.json", import.meta.url), "utf8")).migrations.map((m: { file: string }) => readFileSync(new URL("../auth-migrations/" + m.file, import.meta.url), "utf8"))) await admin.query(sql);
    await admin.query(`GRANT CREATE ON DATABASE ${database} TO ${owner}`);
    await admin.query(`GRANT USAGE ON SCHEMA vynvori_identity TO ${owner}`);
    await admin.query(`GRANT REFERENCES ON vynvori_identity.profiles TO ${owner}`);

    await t.test("the migration applies as a plain non-superuser owner; exactly one definer function, owned by the owner, not executable by the runtime role", async () => {
      await admin.query(`SET ROLE ${owner}`);
      try { for (const sql of migrationSql()) await admin.query(sql); } finally { await admin.query("RESET ROLE"); }
      const definers = (await admin.query("SELECT p.proname, pg_get_userbyid(p.proowner) AS owner FROM pg_proc p WHERE p.pronamespace = 'vynvori_ledger'::regnamespace AND p.prosecdef")).rows;
      assert.deepEqual(definers, [{ proname: "ledger_entries_apply_to_wallet", owner }]);
      assert.equal((await admin.query("SELECT count(*)::int n FROM vynvori_ledger.ledger_grant_sources")).rows[0].n, 0, "0002 registered no grant source (applied by a non-superuser)");
      // runtime grants as the S9 proposal will shape them (test only; the migration grants nothing)
      for (const role of [rt, rtw]) {
        await admin.query(`GRANT USAGE ON SCHEMA vynvori_ledger TO ${role}`);
        await admin.query(`GRANT SELECT, INSERT ON vynvori_ledger.wallets TO ${role}`);
        await admin.query(`GRANT UPDATE (user_id) ON vynvori_ledger.wallets TO ${role}`);
        await admin.query(`GRANT SELECT, INSERT ON vynvori_ledger.ledger_entries, vynvori_ledger.ledger_commands TO ${role}`);
        await admin.query(`GRANT SELECT ON vynvori_ledger.ledger_grant_sources TO ${role}`);
      }
      assert.equal((await admin.query(`SELECT has_function_privilege($1, 'vynvori_ledger.ledger_entries_apply_to_wallet()', 'EXECUTE') AS x`, [rt])).rows[0].x, false);
    });

    const rtPool = await asRole(rt), rtwPool = await asRole(rtw);
    const profile = async () => { const id = randomUUID(); await admin.query("INSERT INTO vynvori_identity.profiles(id,issuer,subject) VALUES($1,'https://synthetic.invalid',$2)", [id, "s-" + id]); return id; };
    const buckets = async (user: string) => (await admin.query("SELECT available_units::text a, reserved_units::text r, held_for_review_units::text h, consumed_units::text c, revision::text rev FROM vynvori_ledger.wallets WHERE user_id=$1", [user])).rows[0];
    const ZERO = { a: "0", r: "0", h: "0", c: "0", rev: "0" };
    const source = await registerSyntheticGrantSource(admin);
    const victim = await profile();
    for (const pool of [rtPool, rtwPool]) assert.equal((await pool.query("SELECT current_user AS u, current_setting('is_superuser') AS su")).rows[0].su, "off", "pool connections really run as a non-superuser");
    assert.equal((await rtPool.query("SELECT current_user AS u")).rows[0].u, rt);

    await t.test("positive: the REAL runLedgerCommand + appendGrantEntry works end to end as the restricted role; bad shapes still fail", async () => {
      assert.deepEqual(await ensureWallet(rtPool, victim), { created: true });
      const result = await grantSyntheticCredits(rtPool, { userId: victim, grantSourceId: source, sourceRef: "priv-1", units: SYNTHETIC_UNITS });
      assert.equal(result.entries.length, 1);
      assert.deepEqual(await buckets(victim), { a: String(SYNTHETIC_UNITS), r: "0", h: "0", c: "0", rev: "1" }, "the definer function applied the entry");
      assert.equal((await getWalletSummary(rtPool, victim)).availableUnits, SYNTHETIC_UNITS);
      assert.equal((await grantSyntheticCredits(rtPool, { userId: victim, grantSourceId: source, sourceRef: "priv-1", units: SYNTHETIC_UNITS })).replayed, true);
      const commandId = randomUUID();
      await rtPool.query("INSERT INTO vynvori_ledger.ledger_commands(command_id,scope,idempotency_key,request_sha256,user_id,command_kind,outcome) VALUES($1,$2,$3,$4,$5,'raw_probe','applied')", [commandId, `${victim}:raw_probe`, "raw-probe-key-0123456789", "a".repeat(64), victim]);
      await assert.rejects(rtPool.query(`INSERT INTO vynvori_ledger.ledger_entries(entry_id,user_id,command_id,entry_kind,delta_available,delta_reserved,delta_held,delta_consumed,delta_external,grant_source_id,source_ref,cause_kind,cause_ref)
        VALUES($1,$2,$3,'grant',-5,0,0,0,5,$4,'bad-sign','grant',$5)`, [randomUUID(), victim, commandId, source, `${source}:bad-sign`]), code("23514"));
      assert.equal((await buckets(victim)).a, String(SYNTHETIC_UNITS));
    });

    await t.test("a runtime role cannot UPDATE any wallet bucket, upsert one, or create a wallet with credits", async () => {
      for (const column of ["available_units", "reserved_units", "held_for_review_units", "consumed_units", "revision"]) {
        await assert.rejects(rtPool.query(`UPDATE vynvori_ledger.wallets SET ${column} = ${column} + 1 WHERE user_id = $1`, [victim]), code("42501"), column);
        await assert.rejects(rtPool.query(`INSERT INTO vynvori_ledger.wallets(user_id, ${column}) VALUES($1, 5) ON CONFLICT (user_id) DO UPDATE SET ${column} = 999`, [victim]), code("42501"), "upsert " + column);
      }
      await assert.rejects(rtPool.query("UPDATE vynvori_ledger.wallets SET user_id = user_id WHERE user_id = $1", [victim]), code("23000", /only through ledger entries/), "the only column it may touch (FOR UPDATE needs it) still fires the guard");
      const other = await profile();
      await assert.rejects(rtPool.query("INSERT INTO vynvori_ledger.wallets(user_id, available_units) VALUES($1, 5)", [other]), code("23000", /created empty/));
      assert.equal((await buckets(victim)).a, String(SYNTHETIC_UNITS));
    });

    const exploit = async (pool: Pool, userId: string) => {
      const client = await pool.connect();
      try {
        await client.query("CREATE TEMP TABLE s2_exploit(x int)");
        await client.query("CREATE FUNCTION pg_temp.s2_exploit_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE vynvori_ledger.wallets SET available_units = 1000000 WHERE user_id = '" + userId + "'; RETURN NEW; END $$");
        await client.query("CREATE TRIGGER s2_exploit_tg AFTER INSERT ON s2_exploit FOR EACH ROW EXECUTE FUNCTION pg_temp.s2_exploit_fn()");
        await client.query("INSERT INTO s2_exploit VALUES (1)");
      } finally { client.release(true); }
    };
    await t.test("the TEMP-table trigger exploit (TEMP still granted) mints nothing: 42501, wallet unchanged", async () => {
      const before = await buckets(victim);
      assert.equal((await admin.query("SELECT has_database_privilege($1, current_database(), 'TEMP') AS x", [rt])).rows[0].x, true, "precondition: TEMP is still held through PUBLIC");
      await assert.rejects(exploit(rtPool, victim), code("42501"));
      assert.deepEqual(await buckets(victim), before);
    });

    await t.test("the same exploit by a role that ALSO holds pg_write_all_data is rejected by the hardened guard (owner check), wallet unchanged", async () => {
      const before = await buckets(victim);
      assert.equal((await admin.query("SELECT pg_has_role($1, 'pg_write_all_data', 'member') AS x", [rtw])).rows[0].x, true);
      assert.equal((await admin.query("SELECT has_table_privilege($1, 'vynvori_ledger.wallets', 'UPDATE') AS x", [rtw])).rows[0].x, true, "precondition: this role CAN update wallets by privilege alone");
      await assert.rejects(exploit(rtwPool, victim), code("23000", /only through ledger entries/));
      assert.deepEqual(await buckets(victim), before);
      await assert.rejects(rtwPool.query("UPDATE vynvori_ledger.wallets SET available_units = 1000000 WHERE user_id = $1", [victim]), code("23000", /only through ledger entries/), "and so is a direct update");
      assert.deepEqual(await buckets(victim), before);
    });

    await t.test("a runtime role cannot call, disable, drop or replace ledger machinery, truncate tables or relax replication", async () => {
      for (const sql of [
        "SELECT vynvori_ledger.ledger_entries_apply_to_wallet()",
        "SELECT vynvori_ledger.wallets_update_guard()",
        "ALTER TABLE vynvori_ledger.ledger_entries DISABLE TRIGGER ledger_entries_apply_to_wallet",
        "ALTER TABLE vynvori_ledger.wallets DISABLE TRIGGER ALL",
        "DROP TRIGGER ledger_entries_apply_to_wallet ON vynvori_ledger.ledger_entries",
        "ALTER TABLE vynvori_ledger.ledger_entries DROP CONSTRAINT ledger_entries_s2_grant_only",
        "CREATE OR REPLACE FUNCTION vynvori_ledger.wallets_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$",
        "CREATE FUNCTION vynvori_ledger.mint() RETURNS int LANGUAGE sql AS 'SELECT 1'",
        "DROP FUNCTION vynvori_ledger.reject_mutation() CASCADE",
        "TRUNCATE vynvori_ledger.ledger_entries", "TRUNCATE vynvori_ledger.wallets", "TRUNCATE vynvori_ledger.ledger_commands", "TRUNCATE vynvori_ledger.ledger_grant_sources",
        "SET session_replication_role = replica",
        "ALTER TABLE vynvori_ledger.wallets OWNER TO " + rt,
        "DROP TABLE vynvori_ledger.ledger_entries",
      ]) await assert.rejects(rtPool.query(sql), code("42501"), sql);
      assert.equal((await admin.query("SELECT count(*)::int n FROM pg_trigger WHERE tgrelid = 'vynvori_ledger.ledger_entries'::regclass AND NOT tgisinternal")).rows[0].n, 4, "all ledger_entries triggers still present");
    });

    await t.test("a runtime role cannot UPDATE or DELETE ledger entries or commands", async () => {
      for (const sql of ["UPDATE vynvori_ledger.ledger_entries SET source_ref = source_ref", "DELETE FROM vynvori_ledger.ledger_entries", "UPDATE vynvori_ledger.ledger_commands SET outcome = outcome", "DELETE FROM vynvori_ledger.ledger_commands"])
        await assert.rejects(rtPool.query(sql), code("42501"), sql);
    });

    await t.test("grant sources: no INSERT/UPDATE/DELETE privilege for the runtime role, and a grant entry without a registered source is rejected", async () => {
      for (const privilege of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) assert.equal((await admin.query("SELECT has_table_privilege($1, 'vynvori_ledger.ledger_grant_sources', $2) AS x", [rt, privilege])).rows[0].x, false, privilege);
      await assert.rejects(rtPool.query("INSERT INTO vynvori_ledger.ledger_grant_sources(grant_source_id,kind,label) VALUES($1,'synthetic_test','x')", [randomUUID()]), code("42501"));
      await assert.rejects(rtPool.query("UPDATE vynvori_ledger.ledger_grant_sources SET label = 'x'"), code("42501"));
      await assert.rejects(rtPool.query("DELETE FROM vynvori_ledger.ledger_grant_sources"), code("42501"));
      const user = await profile(); await ensureWallet(rtPool, user);
      const commandId = randomUUID();
      await rtPool.query("INSERT INTO vynvori_ledger.ledger_commands(command_id,scope,idempotency_key,request_sha256,user_id,command_kind,outcome) VALUES($1,$2,$3,$4,$5,'raw_probe','applied')", [commandId, `${user}:raw_probe`, "raw-probe-key-9876543210", "a".repeat(64), user]);
      const insert = (sourceId: string | null) => rtPool.query(`INSERT INTO vynvori_ledger.ledger_entries(entry_id,user_id,command_id,entry_kind,delta_available,delta_reserved,delta_held,delta_consumed,delta_external,grant_source_id,source_ref,cause_kind,cause_ref)
        VALUES($1,$2,$3,'grant',1000000,0,0,0,-1000000,$4,'forged-ref','grant',$5)`, [randomUUID(), user, commandId, sourceId, `${sourceId}:forged-ref`]);
      await assert.rejects(insert(null), either("23502", "23514"), "null source");
      await assert.rejects(insert(randomUUID()), either("23503", "23514"), "unregistered source");
      assert.deepEqual(await buckets(user), ZERO, "nothing moved");
    });

    await t.test("search_path decoys ahead of the real objects (pg_temp and a decoy schema) cannot redirect the definer or the guards", async () => {
      await admin.query(`CREATE SCHEMA decoy; GRANT USAGE, CREATE ON SCHEMA decoy TO ${rt}`);
      const pool = await asRole(rt, { searchPath: "pg_temp, decoy, vynvori_ledger, public", max: 1 }); // one connection: the pg_temp decoys live in it
      const user = await profile();
      assert.equal((await pool.query("SELECT current_user AS u, current_setting('search_path') AS sp")).rows[0].u, rt);
      for (const schema of ["decoy", "pg_temp"]) {
        await pool.query(`CREATE TABLE ${schema}.wallets(user_id uuid, available_units bigint DEFAULT 0, reserved_units bigint DEFAULT 0, held_for_review_units bigint DEFAULT 0, consumed_units bigint DEFAULT 0, revision bigint DEFAULT 0)`);
        await pool.query(`CREATE TABLE ${schema}.ledger_entries(x int)`);
        await pool.query(`CREATE FUNCTION ${schema}.pg_trigger_depth() RETURNS int LANGUAGE sql AS 'SELECT 99'`);
        await pool.query(`CREATE FUNCTION ${schema}.now() RETURNS timestamptz LANGUAGE sql AS $$ SELECT '1999-01-01'::timestamptz $$`);
        await pool.query(`CREATE FUNCTION ${schema}.current_user() RETURNS text LANGUAGE sql AS $$ SELECT 'nobody' $$`).catch(() => undefined);
      }
      await ensureWallet(pool, user);
      await grantSyntheticCredits(pool, { userId: user, grantSourceId: source, sourceRef: "decoy-1", units: SYNTHETIC_UNITS });
      await grantSyntheticCredits(pool, { userId: user, grantSourceId: source, sourceRef: "decoy-2", units: SYNTHETIC_UNITS });
      assert.deepEqual(await buckets(user), { a: String(2 * SYNTHETIC_UNITS), r: "0", h: "0", c: "0", rev: "2" }, "the real wallet moved");
      for (const schema of ["decoy", "pg_temp"]) { assert.equal((await pool.query(`SELECT count(*)::int n FROM ${schema}.wallets`)).rows[0].n, 0, schema + ".wallets untouched"); assert.equal((await pool.query(`SELECT count(*)::int n FROM ${schema}.ledger_entries`)).rows[0].n, 0); }
      await assert.rejects(pool.query("UPDATE vynvori_ledger.wallets SET available_units = 5 WHERE user_id = $1", [user]), code("42501"));
    });

    await t.test("structural: runtime is not the owner, not a superuser and not an owner member; the owner is neither superuser nor the runtime role", async () => {
      const roles = (await admin.query("SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolcanlogin FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname", [[owner, rt, rtw]])).rows;
      assert.equal(roles.length, 3);
      for (const row of roles) assert.deepEqual({ su: row.rolsuper, bypass: row.rolbypassrls, createrole: row.rolcreaterole, createdb: row.rolcreatedb }, { su: false, bypass: false, createrole: false, createdb: false }, row.rolname);
      assert.notEqual(owner, rt);
      for (const table of ["wallets", "ledger_commands", "ledger_entries", "ledger_grant_sources"]) assert.equal((await admin.query(`SELECT pg_get_userbyid(relowner) AS o FROM pg_class WHERE oid = 'vynvori_ledger.${table}'::regclass`)).rows[0].o, owner, table);
      assert.equal((await admin.query("SELECT pg_has_role($1, $2, 'member') AS x", [rt, owner])).rows[0].x, false);
      assert.equal((await admin.query("SELECT pg_has_role($1, 'pg_write_all_data', 'member') AS x", [rt])).rows[0].x, false, "the base runtime role holds no broad write role");
    });

    await t.test("TEMP: revoking it from the role alone does nothing while PUBLIC holds it; revoking from PUBLIC closes the exploit's first step", async () => {
      await admin.query(`REVOKE TEMPORARY ON DATABASE ${database} FROM ${rt}`);
      assert.equal((await admin.query("SELECT has_database_privilege($1, current_database(), 'TEMP') AS x", [rt])).rows[0].x, true, "still held through PUBLIC");
      await admin.query(`REVOKE TEMPORARY ON DATABASE ${database} FROM PUBLIC`);
      assert.equal((await admin.query("SELECT has_database_privilege($1, current_database(), 'TEMP') AS x", [rt])).rows[0].x, false);
      await assert.rejects(rtPool.query("CREATE TEMP TABLE s2_after_revoke(x int)"), code("42501"));
      await assert.rejects(exploit(rtPool, victim), code("42501"));
      assert.equal((await buckets(victim)).a, String(SYNTHETIC_UNITS));
      // the real command path does not need TEMP
      assert.equal((await grantSyntheticCredits(rtPool, { userId: victim, grantSourceId: source, sourceRef: "priv-after-revoke", units: SYNTHETIC_UNITS })).replayed, false);
    });
  } finally {
    for (const pool of pools) await pool.end().catch(() => undefined);
    await admin.end().catch(() => undefined);
    await dropLedger("privileges");
    const cleaner = await freshCleaner();
    for (const role of rolesCreated) await cleaner.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await cleaner.end().catch(() => undefined);
  }
});

/** Roles are cluster-global: drop them from the maintenance database after the disposable database is gone. */
async function freshCleaner() {
  const { Client } = await import("pg");
  const url = new URL(ledgerTarget.url!); url.pathname = "/postgres";
  const client = new Client({ connectionString: url.toString() }); await client.connect();
  return client;
}
