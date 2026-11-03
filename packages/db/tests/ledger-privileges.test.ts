import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import type { Pool } from "pg";
import { ensureWallet, getWalletSummary } from "../src/ledger-core";
import { ledgerMigrationPlan } from "../src/ledger-migrations";
import { databaseFor, dropLedger, freshEmptyDatabase, grantSyntheticCredits, ledgerPoolAs, ledgerTarget, registerSyntheticGrantSource } from "./ledger-fixture";

/**
 * Privilege-model B proof (ADR-0021 S2 addendum). CI's `synthetic` is a SUPERUSER, so a test run as synthetic would pass with
 * ANY design. Here the fixture connection (superuser) only creates roles, applies the migration while `SET ROLE <owner>`, and
 * seeds profiles/grant sources; every assertion about what the runtime may do runs as a NON-superuser role. Roles are
 * cluster-global: random per-run names (some deliberately mixed-case or punctuated), dropped at the end, leaks reported.
 * Pool budget: at most 5 pooled connections at any time (rt 2 + rtw 1 + at most 2 short-lived single-connection pools).
 * SYNTHETIC_* values are test-only.
 */
const SYNTHETIC_UNITS = 4, MAX_POOL_CONNECTIONS = 5;
const either = (...codes: string[]) => (e: unknown) => codes.includes((e as { code?: string }).code ?? "");
const code = (c: string, pattern?: RegExp) => (e: unknown) => (e as { code?: string }).code === c && (!pattern || pattern.test((e as Error).message));
const migrationSql = () => ledgerMigrationPlan().migrations.map(m => m.sql);
const q = (identifier: string) => '"' + identifier.replace(/"/g, '""') + '"';
const APPLY = "vynvori_ledger.ledger_entries_apply_to_wallet()";

test("privilege model B: a non-superuser runtime role cannot move wallet balances, mint credits or alter the ledger", { skip: ledgerTarget.skip }, async t => {
  assert.ok(ledgerTarget.url, "CI_REQUIRE_PG_TESTS=1 requires M7_TEST_POSTGRES_URL or M2_CREATIVE_DATABASE_URL");
  const suffix = randomBytes(6).toString("hex");
  const owner = "m7_own_" + suffix, rt = "m7_rt_" + suffix, rtw = "m7_rtw_" + suffix, rtt = "m7_rtt_" + suffix, definer = "m7_def_" + suffix;
  const database = databaseFor("privileges");
  const admin = await freshEmptyDatabase("privileges");
  const pools = new Set<Pool>(); let live = 0, peak = 0;
  const maxOf = new Map<Pool, number>();
  const open = async (role: string, options: { searchPath?: string; max?: number } = {}) => {
    const max = options.max ?? 1;
    live += max; peak = Math.max(peak, live); assert.ok(live <= MAX_POOL_CONNECTIONS, "pool budget exceeded");
    const pool = await ledgerPoolAs("privileges", role, { ...options, max }); pools.add(pool); maxOf.set(pool, max); return pool;
  };
  const close = async (pool: Pool) => { if (pools.delete(pool)) { live -= maxOf.get(pool) ?? 0; await pool.end(); } };
  const withRole = async <T>(role: string, work: (pool: Pool) => Promise<T>, options: { searchPath?: string } = {}) => { const pool = await open(role, options); try { return await work(pool); } finally { await close(pool); } };
  const rolesCreated: string[] = [];
  const mkRole = async (name: string, extra = "") => { await admin.query(`CREATE ROLE ${q(name)} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB${extra}`); rolesCreated.push(name); };
  try {
    try {
      // ---- fixture (superuser): roles, identity schema, owner-only grants ------------------------------------------------------
      for (const role of [owner, rt, rtw, rtt]) await mkRole(role);
      await admin.query(`GRANT pg_write_all_data TO ${q(rtw)}`); // a managed-database admin role may include this
      for (const sql of JSON.parse(readFileSync(new URL("../auth-migrations/plan.json", import.meta.url), "utf8")).migrations.map((m: { file: string }) => readFileSync(new URL("../auth-migrations/" + m.file, import.meta.url), "utf8"))) await admin.query(sql);
      await admin.query(`GRANT CREATE ON DATABASE ${database} TO ${q(owner)}`);
      await admin.query(`GRANT USAGE ON SCHEMA vynvori_identity TO ${q(owner)}`);
      await admin.query(`GRANT REFERENCES ON vynvori_identity.profiles TO ${q(owner)}`);

      await t.test("the migration applies as a plain non-superuser owner; exactly one definer function, owned by the owner, not executable by the runtime role", async () => {
        await admin.query(`SET ROLE ${q(owner)}`);
        try { for (const sql of migrationSql()) await admin.query(sql); } finally { await admin.query("RESET ROLE"); }
        // runtime grants as the S9 proposal will shape them (test only; the migration grants nothing)
        for (const role of [rt, rtw]) {
          await admin.query(`GRANT USAGE ON SCHEMA vynvori_ledger TO ${q(role)}`);
          await admin.query(`GRANT SELECT, INSERT ON vynvori_ledger.wallets TO ${q(role)}`);
          await admin.query(`GRANT UPDATE (user_id) ON vynvori_ledger.wallets TO ${q(role)}`);
          await admin.query(`GRANT SELECT, INSERT ON vynvori_ledger.ledger_entries, vynvori_ledger.ledger_commands TO ${q(role)}`);
          await admin.query(`GRANT SELECT ON vynvori_ledger.ledger_grant_sources TO ${q(role)}`);
        }
        // a role with TABLE-level UPDATE on wallets that is NOT in pg_write_all_data: only the design (not missing privileges) can stop it
        await admin.query(`GRANT USAGE ON SCHEMA vynvori_ledger TO ${q(rtt)}`);
        await admin.query(`GRANT SELECT, UPDATE ON vynvori_ledger.wallets TO ${q(rtt)}`);
        assert.equal((await admin.query(`SELECT has_function_privilege($1, '${APPLY}', 'EXECUTE') AS x`, [rt])).rows[0].x, false);
        const definers = (await admin.query("SELECT p.proname, pg_get_userbyid(p.proowner) AS owner FROM pg_proc p WHERE p.pronamespace = 'vynvori_ledger'::regnamespace AND p.prosecdef")).rows;
        assert.deepEqual(definers, [{ proname: "ledger_entries_apply_to_wallet", owner }]);
        assert.equal((await admin.query("SELECT count(*)::int n FROM vynvori_ledger.ledger_grant_sources")).rows[0].n, 0, "0002 registered no grant source (applied by a non-superuser)");
      });

      const rtPool = await open(rt, { max: 2 }), rtwPool = await open(rtw);
      const profile = async () => { const id = randomUUID(); await admin.query("INSERT INTO vynvori_identity.profiles(id,issuer,subject) VALUES($1,'https://synthetic.invalid',$2)", [id, "s-" + id]); return id; };
      const buckets = async (user: string) => (await admin.query("SELECT available_units::text a, reserved_units::text r, held_for_review_units::text h, consumed_units::text c, revision::text rev FROM vynvori_ledger.wallets WHERE user_id=$1", [user])).rows[0];
      const ZERO = { a: "0", r: "0", h: "0", c: "0", rev: "0" };
      const source = await registerSyntheticGrantSource(admin);
      const victim = await profile();
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
      await t.test("the TEMP-table trigger exploit by a role WITHOUT balance privileges fails (privilege check only; the design tests follow)", async () => {
        const before = await buckets(victim);
        assert.equal((await admin.query("SELECT has_database_privilege($1, current_database(), 'TEMP') AS x", [rt])).rows[0].x, true, "precondition: TEMP is still held through PUBLIC");
        await assert.rejects(exploit(rtPool, victim), code("42501"));
        assert.deepEqual(await buckets(victim), before);
      });

      await t.test("DESIGN: a role holding TABLE-level UPDATE on wallets (not pg_write_all_data) is stopped by the guard, directly and through a TEMP trigger: 23000", async () => {
        const before = await buckets(victim);
        await withRole(rtt, async pool => {
          assert.equal((await admin.query("SELECT has_table_privilege($1, 'vynvori_ledger.wallets', 'UPDATE') AS x, pg_has_role($1, 'pg_write_all_data', 'member') AS w", [rtt])).rows[0].x, true);
          await assert.rejects(pool.query("UPDATE vynvori_ledger.wallets SET available_units = 1000000 WHERE user_id = $1", [victim]), code("23000", /only through ledger entries/), "direct");
          await assert.rejects(exploit(pool, victim), code("23000", /only through ledger entries/), "TEMP trigger (depth 2, wrong user)");
        });
        assert.deepEqual(await buckets(victim), before);
      });

      await t.test("DESIGN: the same exploit by a role that ALSO holds pg_write_all_data is rejected by the guard (current user is not the function owner), wallet unchanged", async () => {
        const before = await buckets(victim);
        assert.equal((await admin.query("SELECT pg_has_role($1, 'pg_write_all_data', 'member') AS x", [rtw])).rows[0].x, true);
        assert.equal((await admin.query("SELECT has_table_privilege($1, 'vynvori_ledger.wallets', 'UPDATE') AS x", [rtw])).rows[0].x, true, "precondition: this role CAN update wallets by privilege alone");
        await assert.rejects(exploit(rtwPool, victim), code("23000", /only through ledger entries/));
        await assert.rejects(rtwPool.query("UPDATE vynvori_ledger.wallets SET available_units = 1000000 WHERE user_id = $1", [victim]), code("23000", /only through ledger entries/), "and so is a direct update");
        assert.deepEqual(await buckets(victim), before);
      });

      await t.test("a runtime role cannot call, disable, drop or replace ledger machinery, truncate tables or relax replication", async () => {
        for (const sql of [
          `SELECT ${APPLY}`, "SELECT vynvori_ledger.wallets_update_guard()",
          "ALTER TABLE vynvori_ledger.ledger_entries DISABLE TRIGGER ledger_entries_apply_to_wallet", "ALTER TABLE vynvori_ledger.wallets DISABLE TRIGGER ALL",
          "DROP TRIGGER ledger_entries_apply_to_wallet ON vynvori_ledger.ledger_entries",
          "ALTER TABLE vynvori_ledger.ledger_entries DROP CONSTRAINT ledger_entries_s2_grant_only",
          "CREATE OR REPLACE FUNCTION vynvori_ledger.wallets_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$",
          "CREATE FUNCTION vynvori_ledger.mint() RETURNS int LANGUAGE sql AS 'SELECT 1'", "DROP FUNCTION vynvori_ledger.reject_mutation() CASCADE",
          "TRUNCATE vynvori_ledger.ledger_entries", "TRUNCATE vynvori_ledger.wallets", "TRUNCATE vynvori_ledger.ledger_commands", "TRUNCATE vynvori_ledger.ledger_grant_sources",
          "SET session_replication_role = replica", `ALTER TABLE vynvori_ledger.wallets OWNER TO ${q(rt)}`, "DROP TABLE vynvori_ledger.ledger_entries",
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

      await t.test("trigger context: even with EXECUTE granted, the definer function cannot be attached to a runtime-owned TEMP table", async () => {
        const before = await buckets(victim);
        const attach = (pool: Pool) => pool.connect().then(async client => {
          try {
            await client.query("CREATE TEMP TABLE x2(user_id uuid, delta_available bigint, delta_reserved bigint, delta_held bigint, delta_consumed bigint)");
            await client.query(`CREATE TRIGGER t2 AFTER INSERT ON x2 FOR EACH ROW EXECUTE FUNCTION ${APPLY}`);
            await client.query("INSERT INTO x2 VALUES ($1, 1000000, 0, 0, 0)", [victim]);
          } finally { client.release(true); }
        });
        await assert.rejects(attach(rtPool), code("42501"), "without EXECUTE the trigger cannot even be created");
        await admin.query(`GRANT EXECUTE ON FUNCTION ${APPLY} TO ${q(rt)}`); // what a blanket schema-wide EXECUTE grant in the S9 proposal would do
        try { await assert.rejects(attach(rtPool), code("23000", /unexpected context/)); } finally { await admin.query(`REVOKE EXECUTE ON FUNCTION ${APPLY} FROM ${q(rt)}`); }
        assert.deepEqual(await buckets(victim), before, "wallet unchanged, no entries minted");
        assert.equal((await admin.query("SELECT count(*)::int n FROM vynvori_ledger.ledger_entries WHERE user_id=$1", [victim])).rows[0].n, 1);
      });

      await t.test("search_path: every function pins it, and a decoy operator AHEAD of pg_catalog in the caller's path cannot redirect the definer", async () => {
        const functions = (await admin.query("SELECT p.proname, p.proconfig FROM pg_proc p WHERE p.pronamespace = 'vynvori_ledger'::regnamespace")).rows;
        assert.ok(functions.length >= 5);
        for (const fn of functions) assert.ok((fn.proconfig as string[] | null)?.includes("search_path=pg_catalog, pg_temp"), `${fn.proname} pins search_path`);
        await admin.query(`CREATE SCHEMA decoy; GRANT USAGE ON SCHEMA decoy TO PUBLIC;
          CREATE FUNCTION decoy.fake_add(bigint, bigint) RETURNS bigint LANGUAGE sql IMMUTABLE AS 'SELECT 1000::bigint';
          CREATE OPERATOR decoy.+ (LEFTARG = bigint, RIGHTARG = bigint, FUNCTION = decoy.fake_add);
          CREATE TABLE decoy.wallets(user_id uuid, available_units bigint, revision bigint)`);
        const user = await profile();
        await withRole(rt, async pool => {
          assert.match(String((await pool.query("SHOW search_path")).rows[0].search_path), /^decoy, pg_catalog/);
          assert.equal((await pool.query("SELECT 2::bigint + 3::bigint AS s")).rows[0].s, "1000", "the decoy really wins for this session's own SQL");
          await ensureWallet(pool, user);
          await grantSyntheticCredits(pool, { userId: user, grantSourceId: source, sourceRef: "decoy-1", units: SYNTHETIC_UNITS });
          await grantSyntheticCredits(pool, { userId: user, grantSourceId: source, sourceRef: "decoy-2", units: SYNTHETIC_UNITS });
        }, { searchPath: "decoy, pg_catalog, vynvori_ledger" });
        assert.deepEqual(await buckets(user), { a: String(2 * SYNTHETIC_UNITS), r: "0", h: "0", c: "0", rev: "2" }, "the real wallet moved by the real amount");
        assert.equal((await admin.query("SELECT count(*)::int n FROM decoy.wallets")).rows[0].n, 0);
      });

      await t.test("structural: runtime is not the owner, not a superuser and not an owner member; the owner is neither superuser nor the runtime role", async () => {
        const roles = (await admin.query("SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname", [[owner, rt, rtw, rtt]])).rows;
        assert.equal(roles.length, 4);
        for (const row of roles) assert.deepEqual({ su: row.rolsuper, bypass: row.rolbypassrls, createrole: row.rolcreaterole, createdb: row.rolcreatedb }, { su: false, bypass: false, createrole: false, createdb: false }, row.rolname);
        assert.notEqual(owner, rt);
        for (const table of ["wallets", "ledger_commands", "ledger_entries", "ledger_grant_sources"]) assert.equal((await admin.query(`SELECT pg_get_userbyid(relowner) AS o FROM pg_class WHERE oid = 'vynvori_ledger.${table}'::regclass`)).rows[0].o, owner, table);
        assert.equal((await admin.query("SELECT pg_has_role($1, $2, 'member') AS x", [rt, owner])).rows[0].x, false);
        assert.equal((await admin.query("SELECT pg_has_role($1, 'pg_write_all_data', 'member') AS x", [rt])).rows[0].x, false, "the base runtime role holds no broad write role");
        // A role that OWNS the tables can DISABLE TRIGGER and bypass everything: the owner must be distinct from the runtime role.
        await admin.query(`SET ROLE ${q(owner)}`);
        try { await admin.query("ALTER TABLE vynvori_ledger.wallets DISABLE TRIGGER wallets_update_guard"); await admin.query("ALTER TABLE vynvori_ledger.wallets ENABLE TRIGGER wallets_update_guard"); } finally { await admin.query("RESET ROLE"); }
      });

      await t.test("S9 step: re-owning ONLY the apply function to a dedicated NOLOGIN role keeps the legitimate path working and blocks everyone else (old table owner, runtime, superuser)", async () => {
        await mkRole(definer);
        await admin.query(`GRANT USAGE ON SCHEMA vynvori_ledger TO ${q(definer)}`);
        await admin.query(`GRANT SELECT, UPDATE ON vynvori_ledger.wallets TO ${q(definer)}`);
        await admin.query(`ALTER FUNCTION ${APPLY} OWNER TO ${q(definer)}`);
        assert.equal((await admin.query(`SELECT pg_get_userbyid(proowner) AS o FROM pg_proc WHERE oid = '${APPLY}'::regprocedure`)).rows[0].o, definer);
        assert.equal((await admin.query("SELECT pg_get_userbyid(relowner) AS o FROM pg_class WHERE oid = 'vynvori_ledger.wallets'::regclass")).rows[0].o, owner, "tables keep the migration login as owner");
        const user = await profile(); await ensureWallet(rtPool, user);
        await grantSyntheticCredits(rtPool, { userId: user, grantSourceId: source, sourceRef: "s9-1", units: SYNTHETIC_UNITS });
        assert.deepEqual(await buckets(user), { a: String(SYNTHETIC_UNITS), r: "0", h: "0", c: "0", rev: "1" }, "legitimate runLedgerCommand + appendGrantEntry still works");
        const before = await buckets(victim);
        await withRole(owner, async pool => {
          await assert.rejects(pool.query("UPDATE vynvori_ledger.wallets SET available_units = 1000000 WHERE user_id = $1", [victim]), code("23000", /only through ledger entries/), "old table owner, direct");
          await assert.rejects(exploit(pool, victim), code("23000", /only through ledger entries/), "old table owner, through a trigger");
        });
        await assert.rejects(exploit(rtPool, victim), code("42501"), "runtime still blocked");
        await assert.rejects(rtwPool.query("UPDATE vynvori_ledger.wallets SET available_units = 1000000 WHERE user_id = $1", [victim]), code("23000"), "broad write role still blocked");
        // break-glass: a SUPERUSER that is not the function owner is blocked too (documented in the ADR)
        await assert.rejects(admin.query("UPDATE vynvori_ledger.wallets SET available_units = 1000000 WHERE user_id = $1", [victim]), code("23000", /only through ledger entries/), "superuser direct");
        await admin.query("CREATE TEMP TABLE su_exploit(x int); CREATE FUNCTION pg_temp.su_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE vynvori_ledger.wallets SET available_units = 1000000; RETURN NEW; END $$; CREATE TRIGGER su_tg AFTER INSERT ON su_exploit FOR EACH ROW EXECUTE FUNCTION pg_temp.su_fn()");
        await assert.rejects(admin.query("INSERT INTO su_exploit VALUES (1)"), code("23000", /only through ledger entries/), "superuser through a trigger");
        await admin.query("DROP TABLE su_exploit; DROP FUNCTION pg_temp.su_fn()");
        assert.deepEqual(await buckets(victim), before);
      });

      await t.test("owner comparison is by NAME: a mixed-case or punctuated function owner works; a case-colliding attacker holding pg_write_all_data is rejected", async () => {
        const mixed = "M7_Owner_" + suffix, dotted = "m7.dot_" + suffix, lower = "m7_foo_" + suffix, attacker = "M7_Foo_" + suffix;
        for (const [index, name] of [mixed, dotted, lower].entries()) {
          await mkRole(name);
          await admin.query(`GRANT USAGE ON SCHEMA vynvori_ledger TO ${q(name)}`);
          await admin.query(`GRANT SELECT, UPDATE ON vynvori_ledger.wallets TO ${q(name)}`);
          await admin.query(`ALTER FUNCTION ${APPLY} OWNER TO ${q(name)}`);
          const user = await profile(); await ensureWallet(rtPool, user);
          await grantSyntheticCredits(rtPool, { userId: user, grantSourceId: source, sourceRef: "quoted-" + index, units: SYNTHETIC_UNITS });
          assert.equal((await buckets(user)).a, String(SYNTHETIC_UNITS), `legitimate path works for owner ${name}`);
        }
        // the function is now owned by lower-case `m7_foo_x`; the attacker's name case-folds to the same identifier
        await mkRole(attacker); await admin.query(`GRANT pg_write_all_data TO ${q(attacker)}`); await admin.query(`GRANT USAGE ON SCHEMA vynvori_ledger TO ${q(attacker)}`); await admin.query(`GRANT SELECT ON vynvori_ledger.wallets TO ${q(attacker)}`); // pg_write_all_data has no SELECT; the exploit's WHERE needs it
        assert.equal((await admin.query("SELECT lower($1) = $2 AS same", [attacker, lower])).rows[0].same, true, "precondition: the names differ only by case");
        const before = await buckets(victim);
        await withRole(attacker, async pool => { await assert.rejects(exploit(pool, victim), code("23000", /only through ledger entries/)); });
        assert.deepEqual(await buckets(victim), before);
        await admin.query(`ALTER FUNCTION ${APPLY} OWNER TO ${q(definer)}`);
      });

      await t.test("TEMP: revoking it from the role alone does nothing while PUBLIC holds it; revoking from PUBLIC closes the exploit's first step", async () => {
        await admin.query(`REVOKE TEMPORARY ON DATABASE ${database} FROM ${q(rt)}`);
        assert.equal((await admin.query("SELECT has_database_privilege($1, current_database(), 'TEMP') AS x", [rt])).rows[0].x, true, "still held through PUBLIC");
        await admin.query(`REVOKE TEMPORARY ON DATABASE ${database} FROM PUBLIC`);
        assert.equal((await admin.query("SELECT has_database_privilege($1, current_database(), 'TEMP') AS x", [rt])).rows[0].x, false);
        await assert.rejects(rtPool.query("CREATE TEMP TABLE s2_after_revoke(x int)"), code("42501"));
        await assert.rejects(exploit(rtwPool, victim), code("42501"), "even a broad write role cannot start the exploit without TEMP");
        // the real command path does not need TEMP
        assert.equal((await grantSyntheticCredits(rtPool, { userId: victim, grantSourceId: source, sourceRef: "priv-after-revoke", units: SYNTHETIC_UNITS })).replayed, false);
      });
      assert.ok(peak <= MAX_POOL_CONNECTIONS, `peak pooled connections ${peak}`);
    } finally {
      const leaked: string[] = [];
      try {
        for (const pool of [...pools]) await close(pool).catch(() => undefined);
        await admin.end().catch(() => undefined);
        await dropLedger("privileges");
      } finally {
        // roles are cluster-global: drop from the maintenance database even if the database drop threw; REPORT any that remain
        const cleaner = new Client({ connectionString: (() => { const u = new URL(ledgerTarget.url!); u.pathname = "/postgres"; return u.toString(); })() });
        await cleaner.connect();
        try { for (const role of rolesCreated) { try { await cleaner.query(`DROP ROLE IF EXISTS ${q(role)}`); } catch { leaked.push(role); } } } finally { await cleaner.end().catch(() => undefined); }
        if (leaked.length) { console.error("LEAKED ROLES (drop manually): " + leaked.join(", ")); throw new Error("leaked cluster roles: " + leaked.join(", ")); }
      }
    }
  } finally { /* outer guard keeps the structure explicit: cleanup above always runs */ }
});
