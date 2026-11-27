import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import type { Pool } from "pg";
import { ensureWallet, getWalletSummary } from "../src/ledger-core";
import { ledgerMigrationPlan } from "../src/ledger-migrations";
import { databaseFor, dropLedger, freshEmptyDatabase, grantSyntheticCredits, ledgerPoolAs, ledgerTarget, registerSyntheticGrantSource } from "./ledger-fixture";
import { assessQuoteForAuthorization, getQuote, issueQuote, renewQuote } from "../src/ledger-quotes";
import { authorizeQuote, getReservation, recordWorkflowRef, releaseReservation } from "../src/ledger-reservations";
import { holdReservation, settleReservation } from "../src/ledger-settlement";
import { recordVendorCostEvidence } from "../src/ledger-evidence";
import { SYNTHETIC_BUNDLE_HOLD, SYNTHETIC_CHARGES, SYNTHETIC_FINAL_HOLD, SYNTHETIC_HOLDS, consent, currentPricePolicy, eligibilityPort, issueTestQuote, releaseEvidence } from "./ledger-reservation-fixture";

/**
 * Privilege-model B proof (ADR-0021 S2 addendum). CI's `synthetic` is a SUPERUSER, so a test run as synthetic would pass with
 * ANY design. Here the fixture connection (superuser) only creates roles, applies the migration while `SET ROLE <owner>`, and
 * seeds profiles/grant sources; every assertion about what the runtime may do runs as a NON-superuser role. Roles are
 * cluster-global: random per-run names (some deliberately mixed-case or punctuated), dropped at the end, leaks reported.
 * Pool budget: at most 5 pooled connections at any time (rt 2 + rtw 1 + at most 2 short-lived single-connection pools).
 * S5 (0005) adds the reservation definer, its exact S9 privileges and the TEMP-trigger / broad-write-role probes on reservations.
 * SYNTHETIC_* values are test-only.
 */
const SYNTHETIC_UNITS = 4, MAX_POOL_CONNECTIONS = 5;
const QV_FN = "vynvori_ledger.ledger_quotes_check_version", ALLOC_FN = "vynvori_ledger.ledger_quote_check_allocation_sums";
const QV_CHECK = `${QV_FN}()`, ALLOC_SUM = `${ALLOC_FN}()`;
const alwaysCurrentPricePolicy = { isPriceVersionCurrent: async () => true, allocationsFor: async () => { throw new Error("not used by assessQuoteForAuthorization"); } };
/** A minimal valid promo_single_preview QuoteViewV3: 0/0, no allocations, the cheapest shape for a privilege probe. */
function syntheticPromoView(quoteId: string, quoteVersionId: string) {
  const issuedAt = new Date().toISOString(), expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  return {
    quoteId, quoteVersionId, issuedAt, expiresAt, pricePolicyVersion: "priv-pv", capabilitySnapshotId: "priv-cap",
    creditsQuoted: 0, maxHoldUnits: 0,
    wallet: { unit: "credits", availableUnits: 0, reservedUnits: 0, heldForReviewUnits: 0, snapshotAt: issuedAt, walletRevision: "0" },
    consentTextVersion: "priv-ctv", included: [] as string[], excluded: [] as string[],
    authorizationHint: { quoteId, checkedAt: issuedAt, canAuthorize: false, reasonCodes: [] as string[], quoteVersionId },
    offerKind: "promo_single_preview" as const, directionId: "priv-direction", finalRenderIncludedInThisPurchase: false, physicalGarmentIncluded: false,
  };
}
const either = (...codes: string[]) => (e: unknown) => codes.includes((e as { code?: string }).code ?? "");
const code = (c: string, pattern?: RegExp) => (e: unknown) => (e as { code?: string }).code === c && (!pattern || pattern.test((e as Error).message));
const migrationSql = () => ledgerMigrationPlan().migrations.map(m => m.sql);
const q = (identifier: string) => '"' + identifier.replace(/"/g, '""') + '"';
const APPLY = "vynvori_ledger.ledger_entries_apply_to_wallet()";
const APPLY_RESERVATION = "vynvori_ledger.ledger_entries_apply_to_reservation()";
/** Every S5 (0005) trigger function, with a timing at which it can be attached to a TEMP table for the context-check probe. */
const S5_FUNCTIONS = ["ledger_authorizations_check_insert", "ledger_packages_check_insert", "credit_reservations_check_insert", "credit_reservations_update_guard",
  "credit_reservations_check_not_pending", "ledger_authorizations_check_complete", "ledger_entries_bind_reservation", "ledger_entries_apply_to_reservation",
  "ledger_quotes_refuse_authorized_lineage"].map(name => `vynvori_ledger.${name}()`);

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

      await t.test("the migration applies as a plain non-superuser owner; exactly two definer functions, owned by the owner, not executable by the runtime role", async () => {
        await admin.query(`SET ROLE ${q(owner)}`);
        try { for (const sql of migrationSql()) await admin.query(sql); } finally { await admin.query("RESET ROLE"); }
        // runtime grants as the S9 proposal will shape them (test only; the migration grants nothing)
        for (const role of [rt, rtw]) {
          await admin.query(`GRANT USAGE ON SCHEMA vynvori_ledger TO ${q(role)}`);
          await admin.query(`GRANT SELECT, INSERT ON vynvori_ledger.wallets TO ${q(role)}`);
          await admin.query(`GRANT UPDATE (user_id) ON vynvori_ledger.wallets TO ${q(role)}`);
          await admin.query(`GRANT SELECT, INSERT ON vynvori_ledger.ledger_entries, vynvori_ledger.ledger_commands TO ${q(role)}`);
          await admin.query(`GRANT SELECT ON vynvori_ledger.ledger_grant_sources TO ${q(role)}`);
          // S3 (ADR-0021 addendum A5): exactly SELECT, INSERT on the three quote tables; no UPDATE anywhere.
          await admin.query(`GRANT SELECT, INSERT ON vynvori_ledger.ledger_quote_lineages, vynvori_ledger.ledger_quotes, vynvori_ledger.ledger_quote_allocations TO ${q(role)}`);
          // S5 (ADR-0021 S5 addendum): SELECT, INSERT on the three S5 tables and UPDATE of the dispatch marker column only.
          // SELECT on ledger_authorizations is needed by issueQuote/renewQuote too (the lineage-authorized trigger reads it).
          await admin.query(`GRANT SELECT, INSERT ON vynvori_ledger.ledger_authorizations, vynvori_ledger.ledger_packages, vynvori_ledger.credit_reservations TO ${q(role)}`);
          await admin.query(`GRANT UPDATE (workflow_ref) ON vynvori_ledger.credit_reservations TO ${q(role)}`);
          // S6 (ADR-0021 S6 addendum): SELECT, INSERT on vendor_cost_evidence; settle and hold need nothing new (they write
          // ledger_entries and ledger_commands, already granted; the reservation definer moves the state).
          await admin.query(`GRANT SELECT, INSERT ON vynvori_ledger.vendor_cost_evidence TO ${q(role)}`);
        }
        // a role with TABLE-level UPDATE on wallets that is NOT in pg_write_all_data: only the design (not missing privileges) can stop it
        await admin.query(`GRANT USAGE ON SCHEMA vynvori_ledger TO ${q(rtt)}`);
        await admin.query(`GRANT SELECT, UPDATE ON vynvori_ledger.wallets TO ${q(rtt)}`);
        assert.equal((await admin.query(`SELECT has_function_privilege($1, '${APPLY}', 'EXECUTE') AS x`, [rt])).rows[0].x, false);
        const definers = (await admin.query("SELECT p.proname, pg_get_userbyid(p.proowner) AS owner FROM pg_proc p WHERE p.pronamespace = 'vynvori_ledger'::regnamespace AND p.prosecdef")).rows;
        assert.deepEqual(definers.sort((a, b) => a.proname.localeCompare(b.proname)), [{ proname: "ledger_entries_apply_to_reservation", owner }, { proname: "ledger_entries_apply_to_wallet", owner }], "exactly two definers: S2's wallet writer and S5's reservation writer");
        assert.equal((await admin.query(`SELECT has_function_privilege($1, '${APPLY_RESERVATION}', 'EXECUTE') AS x`, [rt])).rows[0].x, false);
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
          "ALTER TABLE vynvori_ledger.ledger_entries DROP CONSTRAINT ledger_entries_sign_shape",
          "CREATE OR REPLACE FUNCTION vynvori_ledger.wallets_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$",
          "CREATE FUNCTION vynvori_ledger.mint() RETURNS int LANGUAGE sql AS 'SELECT 1'", "DROP FUNCTION vynvori_ledger.reject_mutation() CASCADE",
          "TRUNCATE vynvori_ledger.ledger_entries", "TRUNCATE vynvori_ledger.wallets", "TRUNCATE vynvori_ledger.ledger_commands", "TRUNCATE vynvori_ledger.ledger_grant_sources",
          "SET session_replication_role = replica", `ALTER TABLE vynvori_ledger.wallets OWNER TO ${q(rt)}`, "DROP TABLE vynvori_ledger.ledger_entries",
        ]) await assert.rejects(rtPool.query(sql), code("42501"), sql);
        assert.equal((await admin.query("SELECT count(*)::int n FROM pg_trigger WHERE tgrelid = 'vynvori_ledger.ledger_entries'::regclass AND NOT tgisinternal")).rows[0].n, 6, "all ledger_entries triggers still present (4 from S2, 2 from S5)");
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
        await assert.rejects(rtPool.query(`SELECT ${APPLY}`), code("42501"), "direct invocation without EXECUTE");
        await admin.query(`GRANT EXECUTE ON FUNCTION ${APPLY} TO ${q(rt)}`); // what a blanket schema-wide EXECUTE grant in the S9 proposal would do
        try {
          await assert.rejects(attach(rtPool), code("23000", /unexpected context/));
          await assert.rejects(rtPool.query(`SELECT ${APPLY}`), code("0A000", /trigger functions can only be called as triggers/), "direct invocation WITH EXECUTE is still refused");
          await assert.rejects(rtPool.query(`SELECT * FROM ${APPLY}`), either("0A000", "42804", "42809", "42883"), "and so is calling it as a table function");
        } finally { await admin.query(`REVOKE EXECUTE ON FUNCTION ${APPLY} FROM ${q(rt)}`); }
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

      await t.test("the definer owner's privileges are EXACTLY USAGE on the schema + SELECT and UPDATE on wallets: the path works with only these, and fails when any one is removed", async () => {
        const exact = "m7_exact_" + suffix;
        await mkRole(exact);
        const privileges: [string, string, string][] = [
          ["USAGE on schema vynvori_ledger", `GRANT USAGE ON SCHEMA vynvori_ledger TO ${q(exact)}`, `REVOKE USAGE ON SCHEMA vynvori_ledger FROM ${q(exact)}`],
          ["SELECT on vynvori_ledger.wallets", `GRANT SELECT ON vynvori_ledger.wallets TO ${q(exact)}`, `REVOKE SELECT ON vynvori_ledger.wallets FROM ${q(exact)}`],
          ["UPDATE on vynvori_ledger.wallets", `GRANT UPDATE ON vynvori_ledger.wallets TO ${q(exact)}`, `REVOKE UPDATE ON vynvori_ledger.wallets FROM ${q(exact)}`],
        ];
        for (const [, grant] of privileges) await admin.query(grant);
        await admin.query(`ALTER FUNCTION ${APPLY} OWNER TO ${q(exact)}`);
        try {
          const user = await profile(); await ensureWallet(rtPool, user);
          let n = 0;
          const attempt = () => grantSyntheticCredits(rtPool, { userId: user, grantSourceId: source, sourceRef: "exact-" + n++, units: SYNTHETIC_UNITS });
          await attempt();
          assert.equal((await buckets(user)).a, String(SYNTHETIC_UNITS), "works with exactly the listed privileges and nothing else");
          const held = (await admin.query("SELECT has_table_privilege($1, 'vynvori_ledger.wallets', p) AS x, p FROM unnest(ARRAY['INSERT','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p", [exact])).rows;
          assert.ok(held.every(r => r.x === false), "no other table privilege is held");
          for (const [label, grant, revoke] of privileges) {
            await admin.query(revoke);
            const before = await buckets(user);
            await assert.rejects(attempt(), (e: unknown) => (e as { sqlstate?: string }).sqlstate === "42501", `without ${label} the legitimate path fails (privilege not padded)`);
            assert.deepEqual(await buckets(user), before, "nothing moved on the failed attempt");
            await admin.query(grant);
            await attempt();
          }
          assert.equal((await buckets(user)).a, String(4 * SYNTHETIC_UNITS), "restored after each removal");
        } finally { await admin.query(`ALTER FUNCTION ${APPLY} OWNER TO ${q(definer)}`); }
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

      await t.test("S3 positive: issueQuote/renewQuote/getQuote/assessQuoteForAuthorization work end to end as the restricted runtime role", async () => {
        const user = await profile(); await ensureWallet(rtPool, user);
        const quoteId = "priv-quote-1";
        const issued = await issueQuote(rtPool, { userId: user, quoteView: syntheticPromoView(quoteId, quoteId + "-v1"), modelRef: "priv-model", allocations: [], idempotencyKey: "priv-issue-key-1" });
        assert.equal(issued.record.versionNo, 1);
        const renewed = await renewQuote(rtPool, { userId: user, quoteId, expectedLatestVersionNo: 1, quoteView: syntheticPromoView(quoteId, quoteId + "-v2"), modelRef: "priv-model", allocations: [], idempotencyKey: "priv-renew-key-1" });
        assert.equal(renewed.record.versionNo, 2);
        const fetched = await getQuote(rtPool, user, quoteId + "-v2");
        assert.equal(fetched.record.quoteVersionId, quoteId + "-v2");
        const assessment = await assessQuoteForAuthorization(rtPool, { userId: user, quoteVersionId: quoteId + "-v2", now: new Date(), pricePolicy: alwaysCurrentPricePolicy });
        assert.deepEqual(assessment, { ok: true });
      });

      await t.test("S3: a runtime role cannot UPDATE, DELETE or TRUNCATE any quote table", async () => {
        for (const sql of [
          "UPDATE vynvori_ledger.ledger_quote_lineages SET created_at = created_at", "DELETE FROM vynvori_ledger.ledger_quote_lineages", "TRUNCATE vynvori_ledger.ledger_quote_lineages",
          "UPDATE vynvori_ledger.ledger_quotes SET model_ref = model_ref", "DELETE FROM vynvori_ledger.ledger_quotes", "TRUNCATE vynvori_ledger.ledger_quotes",
          "UPDATE vynvori_ledger.ledger_quote_allocations SET hold_units = hold_units", "DELETE FROM vynvori_ledger.ledger_quote_allocations", "TRUNCATE vynvori_ledger.ledger_quote_allocations",
        ]) await assert.rejects(rtPool.query(sql), code("42501"), sql);
      });

      await t.test("S3: the new trigger functions cannot be called directly, with or without EXECUTE, and a TEMP-table trigger using them is rejected by the context check", async () => {
        const attachVersionCheck = (pool: Pool) => pool.connect().then(async client => {
          try {
            await client.query("CREATE TEMP TABLE qv_exploit(quote_version_id text, quote_id text, version_no int, user_id uuid, operation_kind text)");
            await client.query(`CREATE TRIGGER qv_tg BEFORE INSERT ON qv_exploit FOR EACH ROW EXECUTE FUNCTION ${QV_CHECK}`);
            await client.query("INSERT INTO qv_exploit VALUES ('x','x',1,$1,'promo_single_preview')", [victim]);
          } finally { client.release(true); }
        });
        const attachAllocSumCheck = (pool: Pool) => pool.connect().then(async client => {
          try {
            await client.query("CREATE TEMP TABLE as_exploit(quote_version_id text)");
            await client.query(`CREATE TRIGGER as_tg AFTER INSERT ON as_exploit FOR EACH ROW EXECUTE FUNCTION ${ALLOC_SUM}`);
            await client.query("INSERT INTO as_exploit VALUES ('x')");
          } finally { client.release(true); }
        });
        await assert.rejects(rtPool.query(`SELECT ${QV_CHECK}`), code("42501"), "no EXECUTE: version check");
        await assert.rejects(rtPool.query(`SELECT ${ALLOC_SUM}`), code("42501"), "no EXECUTE: allocation sum check");
        await assert.rejects(attachVersionCheck(rtPool), code("42501"), "without EXECUTE the version-check trigger cannot even be created");
        await assert.rejects(attachAllocSumCheck(rtPool), code("42501"), "without EXECUTE the allocation-sum trigger cannot even be created");
        await admin.query(`GRANT EXECUTE ON FUNCTION ${QV_CHECK} TO ${q(rt)}`);
        await admin.query(`GRANT EXECUTE ON FUNCTION ${ALLOC_SUM} TO ${q(rt)}`);
        try {
          await assert.rejects(attachVersionCheck(rtPool), code("23000", /unexpected context/), "with EXECUTE, the context check still rejects a foreign trigger");
          await assert.rejects(attachAllocSumCheck(rtPool), code("23000", /unexpected context/), "with EXECUTE, the context check still rejects a foreign trigger");
          await assert.rejects(rtPool.query(`SELECT ${QV_CHECK}`), code("0A000", /trigger functions can only be called as triggers/), "direct invocation WITH EXECUTE is still refused");
          await assert.rejects(rtPool.query(`SELECT ${ALLOC_SUM}`), code("0A000", /trigger functions can only be called as triggers/), "direct invocation WITH EXECUTE is still refused");
        } finally {
          await admin.query(`REVOKE EXECUTE ON FUNCTION ${QV_CHECK} FROM ${q(rt)}`);
          await admin.query(`REVOKE EXECUTE ON FUNCTION ${ALLOC_SUM} FROM ${q(rt)}`);
        }
      });

      await t.test("S3: a runtime role cannot disable/drop the quote triggers or replace the quote functions", async () => {
        for (const sql of [
          "ALTER TABLE vynvori_ledger.ledger_quotes DISABLE TRIGGER ledger_quotes_check_version", "ALTER TABLE vynvori_ledger.ledger_quotes DISABLE TRIGGER ALL",
          "ALTER TABLE vynvori_ledger.ledger_quote_allocations DISABLE TRIGGER ALL",
          "DROP TRIGGER ledger_quotes_check_version ON vynvori_ledger.ledger_quotes", "DROP TRIGGER ledger_quotes_check_allocation_sums ON vynvori_ledger.ledger_quotes",
          "DROP TRIGGER ledger_quote_allocations_check_sums ON vynvori_ledger.ledger_quote_allocations",
          `CREATE OR REPLACE FUNCTION ${QV_FN}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
          `CREATE OR REPLACE FUNCTION ${ALLOC_FN}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`,
          "DROP FUNCTION vynvori_ledger.ledger_quotes_check_version() CASCADE",
        ]) await assert.rejects(rtPool.query(sql), code("42501"), sql);
        assert.equal((await admin.query("SELECT count(*)::int n FROM pg_trigger WHERE tgrelid = 'vynvori_ledger.ledger_quotes'::regclass AND NOT tgisinternal")).rows[0].n, 5, "all ledger_quotes triggers still present (4 from S3, 1 from S5)");
      });

      await t.test("S3: the runtime role holds no UPDATE privilege, table- or column-level, on any quote table", async () => {
        for (const table of ["ledger_quote_lineages", "ledger_quotes", "ledger_quote_allocations"]) {
          assert.equal((await admin.query("SELECT has_table_privilege($1, $2, 'UPDATE') AS x", [rt, `vynvori_ledger.${table}`])).rows[0].x, false, table);
        }
        for (const [table, column] of [["ledger_quotes", "model_ref"], ["ledger_quote_allocations", "hold_units"]] as const) {
          assert.equal((await admin.query("SELECT has_column_privilege($1, $2, $3, 'UPDATE') AS x", [rt, `vynvori_ledger.${table}`, column])).rows[0].x, false, `${table}.${column}`);
        }
      });


      // ---- S5 (0005): reservations ---------------------------------------------------------------------------------------------
      const reservationRow = async (id: string) => (await admin.query("SELECT state, hold_units::text h, charge_units::text c, workflow_ref w FROM vynvori_ledger.credit_reservations WHERE reservation_id=$1", [id])).rows[0];
      const runAs = async (pool: Pool, ...statements: [string, unknown[]?][]) => { const client = await pool.connect(); try { for (const [sql, values] of statements) await client.query(sql, values); } finally { client.release(true); } };
      const s5User = await profile();
      let s5Bundle!: Awaited<ReturnType<typeof authorizeQuote>>;
      let s5Keys = 0;
      const s5Authorize = (pool: Pool, user: string, quoteVersionId: string, originalPackageId?: string) =>
        authorizeQuote(pool, { userId: user, quoteVersionId, idempotencyKey: `priv-s5-authorize-${String(s5Keys++).padStart(4, "0")}`, consent: consent(), ...(originalPackageId ? { originalPackageId } : {}), now: new Date(), pricePolicy: currentPricePolicy, eligibility: eligibilityPort() });

      await t.test("S5 positive: authorize (bundle and final), dispatch and release work end to end as the restricted runtime role", async () => {
        await ensureWallet(rtPool, s5User);
        await grantSyntheticCredits(rtPool, { userId: s5User, grantSourceId: source, sourceRef: "s5-funds", units: SYNTHETIC_BUNDLE_HOLD + SYNTHETIC_FINAL_HOLD });
        s5Bundle = await s5Authorize(rtPool, s5User, await issueTestQuote(rtPool, s5User, "bundle", "priv-s5-bundle"));
        assert.deepEqual(s5Bundle.reservations.map(r => [r.state, r.holdUnits]), SYNTHETIC_HOLDS.map(h => ["reserved", h]));
        assert.deepEqual(await buckets(s5User), { a: String(SYNTHETIC_FINAL_HOLD), r: String(SYNTHETIC_BUNDLE_HOLD), h: "0", c: "0", rev: "4" });
        const final = await s5Authorize(rtPool, s5User, await issueTestQuote(rtPool, s5User, "final", "priv-s5-final"), s5Bundle.packageId!);
        assert.deepEqual(await buckets(s5User), { a: "0", r: String(SYNTHETIC_BUNDLE_HOLD + SYNTHETIC_FINAL_HOLD), h: "0", c: "0", rev: "5" });
        const target = final.reservations[0]!;
        assert.equal((await recordWorkflowRef(rtPool, { userId: s5User, component: "priv", reservationId: target.reservationId, workflowRef: "wf/priv-1", idempotencyKey: "priv-s5-dispatch-0001" })).workflowRef, "wf/priv-1");
        assert.equal((await releaseReservation(rtPool, { userId: s5User, component: "priv", reservationId: target.reservationId, evidence: releaseEvidence(target.operationId), idempotencyKey: "priv-s5-release-00001" })).state, "released");
        assert.deepEqual(await buckets(s5User), { a: String(SYNTHETIC_FINAL_HOLD), r: String(SYNTHETIC_BUNDLE_HOLD), h: "0", c: "0", rev: "6" });
        await recordWorkflowRef(rtPool, { userId: s5User, component: "priv", reservationId: s5Bundle.reservations[0]!.reservationId, workflowRef: "wf/priv-2", idempotencyKey: "priv-s5-dispatch-0002" });
        assert.equal((await getReservation(rtPool, s5User, s5Bundle.reservations[0]!.reservationId)).workflowRef, "wf/priv-2");
      });

      await t.test("S6 positive: settle and hold work end to end as the restricted runtime role with no new privilege; vendor-cost evidence is insert-only", async () => {
        const user = await profile(); await ensureWallet(rtPool, user);
        await grantSyntheticCredits(rtPool, { userId: user, grantSourceId: source, sourceRef: "s6-funds", units: SYNTHETIC_BUNDLE_HOLD });
        const bundle = await s5Authorize(rtPool, user, await issueTestQuote(rtPool, user, "bundle", "priv-s6-bundle"));
        const [toSettle, toHold] = [bundle.reservations[0]!, bundle.reservations[1]!];
        for (const [i, r] of [toSettle, toHold].entries()) await recordWorkflowRef(rtPool, { userId: user, component: "priv", reservationId: r.reservationId, workflowRef: `wf/priv-s6-${i}`, idempotencyKey: `priv-s6-dispatch-000${i}` });
        assert.equal((await settleReservation(rtPool, { userId: user, component: "priv", reservationId: toSettle.reservationId, evidence: { transition: "settle", operationId: toSettle.operationId, evidenceKind: "persisted_delivered", evidenceRef: "priv-s6-settle", hasVerifiedManifestHash: true, ownerAndRightsVerified: true }, idempotencyKey: "priv-s6-settle-00001" })).state, "settled");
        assert.equal((await holdReservation(rtPool, { userId: user, component: "priv", reservationId: toHold.reservationId, evidence: { transition: "hold", operationId: toHold.operationId, evidenceKind: "persistence_failed_under_review", evidenceRef: "priv-s6-hold", reason: "persistence_unconfirmed" }, idempotencyKey: "priv-s6-hold-0000001" })).state, "reconciliation_hold");
        const hold0 = SYNTHETIC_HOLDS[0], hold1 = SYNTHETIC_HOLDS[1], charge0 = SYNTHETIC_CHARGES[0];
        assert.deepEqual(await buckets(user), { a: String(hold0 - charge0), r: String(SYNTHETIC_BUNDLE_HOLD - hold0 - hold1), h: String(hold1), c: String(charge0), rev: "6" });
        const before = [await reservationRow(toSettle.reservationId), await reservationRow(toHold.reservationId), await buckets(user)];
        const evidence = await recordVendorCostEvidence(rtPool, { component: "priv", operationId: toSettle.operationId, reservationId: toSettle.reservationId, evidenceKind: "invoice", evidenceRef: "priv-s6-invoice", amountUsdMicros: 1234567 });
        assert.equal(evidence.replayed, false);
        assert.deepEqual([await reservationRow(toSettle.reservationId), await reservationRow(toHold.reservationId), await buckets(user)], before, "vendor-cost evidence moved nothing");
        for (const sql of ["UPDATE vynvori_ledger.vendor_cost_evidence SET amount_usd_micros = 0", "DELETE FROM vynvori_ledger.vendor_cost_evidence", "TRUNCATE vynvori_ledger.vendor_cost_evidence", "ALTER TABLE vynvori_ledger.vendor_cost_evidence DISABLE TRIGGER ALL", "DROP TABLE vynvori_ledger.vendor_cost_evidence"])
          await assert.rejects(rtPool.query(sql), code("42501"), `runtime: ${sql}`);
        for (const sql of ["UPDATE vynvori_ledger.vendor_cost_evidence SET amount_usd_micros = 0", "DELETE FROM vynvori_ledger.vendor_cost_evidence"])
          await assert.rejects(rtwPool.query(sql), code("23000", /append-only/), `pg_write_all_data: ${sql}`);
        assert.equal((await admin.query("SELECT amount_usd_micros::text AS m FROM vynvori_ledger.vendor_cost_evidence WHERE evidence_id = $1", [evidence.evidenceId])).rows[0].m, "1234567");
        for (const column of ["amount_usd_micros", "reservation_id", "evidence_kind"]) assert.equal((await admin.query("SELECT has_column_privilege($1, 'vynvori_ledger.vendor_cost_evidence', $2, 'UPDATE') AS x", [rt, column])).rows[0].x, false, column);
      });

      await t.test("S5: the runtime role holds no privilege to change state, units, authorizations or packages (42501); its one updatable column cannot rewrite a recorded reference (23000)", async () => {
        const [dispatched, fresh] = [s5Bundle.reservations[0]!, s5Bundle.reservations[1]!];
        const before = [await reservationRow(dispatched.reservationId), await reservationRow(fresh.reservationId), await buckets(s5User)];
        for (const sql of [
          "UPDATE vynvori_ledger.credit_reservations SET state = 'released'", "UPDATE vynvori_ledger.credit_reservations SET hold_units = 1", "UPDATE vynvori_ledger.credit_reservations SET charge_units = 1",
          "UPDATE vynvori_ledger.credit_reservations SET user_id = user_id", "DELETE FROM vynvori_ledger.credit_reservations", "TRUNCATE vynvori_ledger.credit_reservations",
          "UPDATE vynvori_ledger.ledger_authorizations SET consent_text_version = 'x'", "DELETE FROM vynvori_ledger.ledger_authorizations", "TRUNCATE vynvori_ledger.ledger_authorizations",
          "UPDATE vynvori_ledger.ledger_packages SET state = 'closed'", "DELETE FROM vynvori_ledger.ledger_packages", "TRUNCATE vynvori_ledger.ledger_packages",
        ]) await assert.rejects(rtPool.query(sql), code("42501"), sql);
        for (const [table, column, expected] of [["credit_reservations", "workflow_ref", true], ["credit_reservations", "state", false], ["credit_reservations", "hold_units", false], ["credit_reservations", "charge_units", false], ["ledger_packages", "state", false], ["ledger_authorizations", "quote_version_id", false]] as const)
          assert.equal((await admin.query("SELECT has_column_privilege($1, $2, $3, 'UPDATE') AS x", [rt, `vynvori_ledger.${table}`, column])).rows[0].x, expected, `${table}.${column}`);
        await assert.rejects(rtPool.query("UPDATE vynvori_ledger.credit_reservations SET workflow_ref = 'wf/forged' WHERE reservation_id = $1", [dispatched.reservationId]), code("23000", /recorded once/), "a recorded reference is never rewritten");
        await assert.rejects(rtPool.query("UPDATE vynvori_ledger.credit_reservations SET workflow_ref = NULL WHERE reservation_id = $1", [dispatched.reservationId]), code("23000", /recorded once/), "nor cleared");
        await assert.rejects(rtPool.query("UPDATE vynvori_ledger.credit_reservations SET workflow_ref = workflow_ref WHERE reservation_id = $1", [fresh.reservationId]), code("23000", /recorded once/), "a no-op update is not a dispatch");
        assert.deepEqual([await reservationRow(dispatched.reservationId), await reservationRow(fresh.reservationId), await buckets(s5User)], before);
      });

      await t.test("S5 DESIGN: a role with TABLE-level UPDATE on credit_reservations, and one with pg_write_all_data, cannot move state or units directly or through a TEMP trigger (23000)", async () => {
        const target = s5Bundle.reservations[0]!; // reserved AND dispatched: the one state from which a release edge exists
        const before = [await reservationRow(target.reservationId), await buckets(s5User)];
        await admin.query(`GRANT SELECT, UPDATE ON vynvori_ledger.credit_reservations TO ${q(rtt)}`);
        const tempTrigger = (pool: Pool, set: string) => runAs(pool,
          ["CREATE TEMP TABLE s5_exploit(x int)"],
          [`CREATE FUNCTION pg_temp.s5_exploit_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE vynvori_ledger.credit_reservations SET ${set} WHERE reservation_id = '${target.reservationId}'; RETURN NEW; END $$`],
          ["CREATE TRIGGER s5_exploit_tg AFTER INSERT ON s5_exploit FOR EACH ROW EXECUTE FUNCTION pg_temp.s5_exploit_fn()"],
          ["INSERT INTO s5_exploit VALUES (1)"]);
        const probe = async (pool: Pool, label: string) => {
          await assert.rejects(pool.query("UPDATE vynvori_ledger.credit_reservations SET state = 'released' WHERE reservation_id = $1", [target.reservationId]), code("23000", /only through ledger entries/), `${label}: direct state`);
          await assert.rejects(pool.query("UPDATE vynvori_ledger.credit_reservations SET hold_units = 1, charge_units = 1 WHERE reservation_id = $1", [target.reservationId]), code("23000", /immutable/), `${label}: direct units`);
          await assert.rejects(tempTrigger(pool, "state = 'released'"), code("23000", /only through ledger entries/), `${label}: TEMP trigger (depth 2, not the function owner)`);
          await assert.rejects(tempTrigger(pool, "state = 'settled'"), code("23000", /only through ledger entries/), `${label}: TEMP trigger to settled (an S6 edge, but only for the function owner)`);
          await assert.rejects(tempTrigger(pool, "state = 'reconciliation_hold'"), code("23000", /only through ledger entries/), `${label}: TEMP trigger to reconciliation_hold (S6 edge, function owner only)`);
        };
        await withRole(rtt, pool => probe(pool, "table-level UPDATE"));
        assert.equal((await admin.query("SELECT has_table_privilege($1, 'vynvori_ledger.credit_reservations', 'UPDATE') AS x", [rtw])).rows[0].x, true, "precondition: pg_write_all_data CAN update reservations by privilege alone");
        await probe(rtwPool, "pg_write_all_data");
        await assert.rejects(rtwPool.query("DELETE FROM vynvori_ledger.credit_reservations WHERE reservation_id = $1", [target.reservationId]), code("23000", /append-only/), "pg_write_all_data: delete");
        await assert.rejects(rtwPool.query("UPDATE vynvori_ledger.ledger_packages SET state = 'closed'"), code("23000", /append-only/), "pg_write_all_data: package state (no transition exists before S7)");
        await assert.rejects(rtwPool.query("UPDATE vynvori_ledger.ledger_authorizations SET consent_text_version = 'forged'"), code("23000", /append-only/), "pg_write_all_data: authorization");
        assert.deepEqual([await reservationRow(target.reservationId), await buckets(s5User)], before, "reservation and wallet unchanged");
      });

      await t.test("S5: the reservation definer and every S5 trigger function cannot be called directly; with EXECUTE granted a TEMP-table trigger is refused by the context check", async () => {
        const before = [await reservationRow(s5Bundle.reservations[0]!.reservationId), await buckets(s5User)];
        const attach = (fn: string) => runAs(rtPool, ["CREATE TEMP TABLE s5_ctx(user_id uuid, reservation_id uuid, entry_kind text)"],
          [`CREATE TRIGGER s5_ctx_tg AFTER INSERT ON s5_ctx FOR EACH ROW EXECUTE FUNCTION ${fn}`], ["INSERT INTO s5_ctx VALUES ($1, $2, 'release')", [s5User, s5Bundle.reservations[0]!.reservationId]]);
        for (const fn of S5_FUNCTIONS) {
          await assert.rejects(rtPool.query(`SELECT ${fn}`), code("42501"), `no EXECUTE: ${fn}`);
          await assert.rejects(attach(fn), code("42501"), `without EXECUTE the trigger cannot even be created: ${fn}`);
          await admin.query(`GRANT EXECUTE ON FUNCTION ${fn} TO ${q(rt)}`);
          try {
            await assert.rejects(attach(fn), code("23000", /unexpected context/), `with EXECUTE, the context check rejects a foreign trigger: ${fn}`);
            await assert.rejects(rtPool.query(`SELECT ${fn}`), code("0A000", /trigger functions can only be called as triggers/), `direct invocation WITH EXECUTE: ${fn}`);
          } finally { await admin.query(`REVOKE EXECUTE ON FUNCTION ${fn} FROM ${q(rt)}`); }
        }
        assert.deepEqual([await reservationRow(s5Bundle.reservations[0]!.reservationId), await buckets(s5User)], before);
      });

      await t.test("S5: a runtime role cannot disable, drop or replace the S5 triggers, functions, FK or constraints", async () => {
        for (const sql of [
          "ALTER TABLE vynvori_ledger.credit_reservations DISABLE TRIGGER ALL", "ALTER TABLE vynvori_ledger.credit_reservations DISABLE TRIGGER credit_reservations_update_guard",
          "ALTER TABLE vynvori_ledger.ledger_entries DISABLE TRIGGER ledger_entries_bind_reservation", "ALTER TABLE vynvori_ledger.ledger_authorizations DISABLE TRIGGER ALL", "ALTER TABLE vynvori_ledger.ledger_packages DISABLE TRIGGER ALL",
          "ALTER TABLE vynvori_ledger.ledger_quotes DISABLE TRIGGER ledger_quotes_refuse_authorized_lineage",
          "DROP TRIGGER credit_reservations_update_guard ON vynvori_ledger.credit_reservations", "DROP TRIGGER ledger_entries_apply_to_reservation ON vynvori_ledger.ledger_entries",
          "ALTER TABLE vynvori_ledger.ledger_entries DROP CONSTRAINT ledger_entries_reservation_fk", "ALTER TABLE vynvori_ledger.credit_reservations DROP CONSTRAINT credit_reservations_kind_shape",
          "DROP INDEX vynvori_ledger.ledger_entries_one_terminal_per_reservation",
          "CREATE OR REPLACE FUNCTION vynvori_ledger.credit_reservations_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$",
          "CREATE OR REPLACE FUNCTION vynvori_ledger.ledger_entries_bind_reservation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$",
          `DROP FUNCTION ${APPLY_RESERVATION} CASCADE`, `ALTER FUNCTION ${APPLY_RESERVATION} OWNER TO ${q(rt)}`, `ALTER TABLE vynvori_ledger.credit_reservations OWNER TO ${q(rt)}`,
          "DROP TABLE vynvori_ledger.credit_reservations",
        ]) await assert.rejects(rtPool.query(sql), code("42501"), sql);
        const triggers = (await admin.query("SELECT c.relname, count(*)::int n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'vynvori_ledger'::regnamespace AND NOT t.tgisinternal AND t.tgenabled = 'O' AND c.relname IN ('credit_reservations','ledger_authorizations','ledger_packages') GROUP BY 1 ORDER BY 1")).rows;
        assert.deepEqual(triggers, [{ relname: "credit_reservations", n: 5 }, { relname: "ledger_authorizations", n: 4 }, { relname: "ledger_packages", n: 3 }], "every S5 trigger present and enabled");
      });

      await t.test("S9 step for S5: re-owning ONLY the reservation definer to a dedicated role with EXACTLY USAGE + SELECT + UPDATE(state) on credit_reservations keeps the path working, fails when any one is removed, and blocks the old owner and a superuser", async () => {
        const exact = "m7_resdef_" + suffix;
        await mkRole(exact);
        const privileges: [string, string, string][] = [
          ["USAGE on schema vynvori_ledger", `GRANT USAGE ON SCHEMA vynvori_ledger TO ${q(exact)}`, `REVOKE USAGE ON SCHEMA vynvori_ledger FROM ${q(exact)}`],
          ["SELECT on vynvori_ledger.credit_reservations", `GRANT SELECT ON vynvori_ledger.credit_reservations TO ${q(exact)}`, `REVOKE SELECT ON vynvori_ledger.credit_reservations FROM ${q(exact)}`],
          ["UPDATE (state) on vynvori_ledger.credit_reservations", `GRANT UPDATE (state) ON vynvori_ledger.credit_reservations TO ${q(exact)}`, `REVOKE UPDATE (state) ON vynvori_ledger.credit_reservations FROM ${q(exact)}`],
        ];
        for (const [, grant] of privileges) await admin.query(grant);
        await admin.query(`ALTER FUNCTION ${APPLY_RESERVATION} OWNER TO ${q(exact)}`);
        assert.equal((await admin.query("SELECT pg_get_userbyid(relowner) AS o FROM pg_class WHERE oid = 'vynvori_ledger.credit_reservations'::regclass")).rows[0].o, owner, "tables keep the migration login as owner");
        const user = await profile(); await ensureWallet(rtPool, user);
        await grantSyntheticCredits(rtPool, { userId: user, grantSourceId: source, sourceRef: "s9-res-funds", units: 5 * SYNTHETIC_BUNDLE_HOLD });
        let n = 0;
        const attempt = async () => s5Authorize(rtPool, user, await issueTestQuote(rtPool, user, "bundle", `priv-s9-bundle-${n++}`));
        const first = await attempt();
        assert.ok(first.reservations.every(r => r.state === "reserved"), "reserve works with exactly the listed privileges");
        const held = (await admin.query("SELECT has_table_privilege($1, 'vynvori_ledger.credit_reservations', p) AS x FROM unnest(ARRAY['INSERT','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p", [exact])).rows;
        assert.ok(held.every(r => r.x === false), "no other table privilege is held");
        assert.equal((await admin.query("SELECT has_column_privilege($1, 'vynvori_ledger.credit_reservations', 'workflow_ref', 'UPDATE') AS x", [exact])).rows[0].x, false, "the definer cannot touch the dispatch marker");
        const dispatchedId = first.reservations[0]!.reservationId, operationId = first.reservations[0]!.operationId;
        await recordWorkflowRef(rtPool, { userId: user, component: "priv", reservationId: dispatchedId, workflowRef: "wf/s9-1", idempotencyKey: "priv-s9-dispatch-0001" });
        assert.equal((await releaseReservation(rtPool, { userId: user, component: "priv", reservationId: dispatchedId, evidence: releaseEvidence(operationId), idempotencyKey: "priv-s9-release-00001" })).state, "released", "release works too");
        for (const [label, grant, revoke] of privileges) {
          await admin.query(revoke);
          const before = await buckets(user);
          await assert.rejects(attempt(), (e: unknown) => (e as { sqlstate?: string }).sqlstate === "42501", `without ${label} the legitimate path fails (privilege not padded)`);
          assert.deepEqual(await buckets(user), before, "nothing moved on the failed attempt");
          await admin.query(grant);
        }
        // S6 edges run through the same re-owned definer with the same three privileges: settle and hold need nothing more.
        const second = await attempt();
        for (const [i, r] of second.reservations.slice(0, 2).entries()) await recordWorkflowRef(rtPool, { userId: user, component: "priv", reservationId: r.reservationId, workflowRef: `wf/s9-s6-${i}`, idempotencyKey: `priv-s9-s6-dispatch-${i}` });
        assert.equal((await settleReservation(rtPool, { userId: user, component: "priv", reservationId: second.reservations[0]!.reservationId, evidence: { transition: "settle", operationId: second.reservations[0]!.operationId, evidenceKind: "persisted_delivered", evidenceRef: "s9-settle", hasVerifiedManifestHash: true, ownerAndRightsVerified: true }, idempotencyKey: "priv-s9-settle-000001" })).state, "settled", "settle works with exactly the listed privileges");
        assert.equal((await holdReservation(rtPool, { userId: user, component: "priv", reservationId: second.reservations[1]!.reservationId, evidence: { transition: "hold", operationId: second.reservations[1]!.operationId, evidenceKind: "outcome_unknown", evidenceRef: "s9-hold", reason: "outcome_unknown" }, idempotencyKey: "priv-s9-hold-00000001" })).state, "reconciliation_hold", "hold works with exactly the listed privileges");
        const target = first.reservations[1]!, before = await reservationRow(target.reservationId);
        await withRole(owner, async pool => {
          await assert.rejects(pool.query("UPDATE vynvori_ledger.credit_reservations SET state = 'released' WHERE reservation_id = $1", [target.reservationId]), code("23000", /only through ledger entries/), "old table owner, direct");
        });
        await assert.rejects(admin.query("UPDATE vynvori_ledger.credit_reservations SET state = 'released' WHERE reservation_id = $1", [target.reservationId]), code("23000", /only through ledger entries/), "superuser that is not the function owner, direct");
        await admin.query(`CREATE TEMP TABLE su_s5(x int); CREATE FUNCTION pg_temp.su_s5_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE vynvori_ledger.credit_reservations SET state = 'released' WHERE reservation_id = '${target.reservationId}'; RETURN NEW; END $$; CREATE TRIGGER su_s5_tg AFTER INSERT ON su_s5 FOR EACH ROW EXECUTE FUNCTION pg_temp.su_s5_fn()`);
        await assert.rejects(admin.query("INSERT INTO su_s5 VALUES (1)"), code("23000", /only through ledger entries/), "superuser through a trigger");
        await admin.query("DROP TABLE su_s5; DROP FUNCTION pg_temp.su_s5_fn()");
        assert.deepEqual(await reservationRow(target.reservationId), before);
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
