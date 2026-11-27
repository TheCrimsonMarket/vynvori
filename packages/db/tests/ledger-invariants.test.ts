import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { LedgerError, type LedgerDb } from "../src/ledger-core";
import { checkWalletInvariants, findOrphanedReservations, type InvariantFinding, type OrphanedReservation } from "../src/ledger-invariants";
import { claimPromo } from "../src/ledger-promo";
import { authorizeQuote, recordWorkflowRef, releaseReservation } from "../src/ledger-reservations";
import { holdReservation, settleReservation } from "../src/ledger-settlement";
import { dropLedger, freshLedger, grantSyntheticCredits, ledgerPool, ledgerTarget, registerSyntheticGrantSource, syntheticProfileWithWallet } from "./ledger-fixture";
import { SYNTHETIC_BUNDLE_HOLD, consent, currentPricePolicy, eligibilityPort, issueTestQuote, releaseEvidence } from "./ledger-reservation-fixture";

/**
 * ADR-0021 D14 / S8: checkWalletInvariants and findOrphanedReservations. Both are read-only and report-only.
 * Non-concurrency pool cap of 5 (D15). Every unit is a SYNTHETIC test value. Corruption happens ONLY in this file, through the
 * superuser fixture connection of a disposable database (session_replication_role = replica, or a dropped constraint / trigger,
 * always restored): the checker itself never has, and never needs, such a privilege. Database cases skip locally (NOT_RUN) and
 * count only when the CI foundation job runs them.
 */
const code = (c: string) => (e: unknown) => e instanceof LedgerError && e.code === c;
let keyCounter = 0;
const key = (label: string) => `${label}-${String(++keyCounter).padStart(6, "0")}-${randomUUID().slice(0, 8)}`;
const qid = (label: string) => `${label}-${randomUUID()}`;
const settleEvidence = (operationId: string, evidenceRef = "plane-b/delivered-1") => ({ transition: "settle", operationId, evidenceKind: "persisted_delivered", evidenceRef, hasVerifiedManifestHash: true, ownerAndRightsVerified: true });
const holdEvidence = (operationId: string) => ({ transition: "hold", operationId, evidenceKind: "outcome_unknown", evidenceRef: "plane-b/unknown-1", reason: "outcome_unknown" });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---- no database needed -------------------------------------------------------------------------------------------------

test("findOrphanedReservations requires olderThan: no default, a real Date, checked before any SQL (type-level and runtime)", async () => {
  const db = { acquire: async () => { throw new Error("no SQL may run"); }, query: async () => { throw new Error("no SQL may run"); } } as unknown as LedgerDb;
  // @ts-expect-error the options argument is required
  const noOptions = () => findOrphanedReservations(db);
  // @ts-expect-error olderThan is required
  const noCutoff = () => findOrphanedReservations(db, {});
  // @ts-expect-error olderThan must be a Date, not a string
  const stringCutoff = () => findOrphanedReservations(db, { olderThan: "2026-01-01T00:00:00Z" });
  // @ts-expect-error olderThan must be a Date, not a number
  const numberCutoff = () => findOrphanedReservations(db, { olderThan: 0 });
  for (const call of [noOptions, noCutoff, stringCutoff, numberCutoff, () => findOrphanedReservations(db, { olderThan: new Date(Number.NaN) }),
    () => findOrphanedReservations(db, null as never), () => findOrphanedReservations(db, { olderThan: undefined as never }), () => findOrphanedReservations(db, { olderThan: { getTime: () => 0 } as never })])
    await assert.rejects(call(), code("INVALID_INPUT"));
});

test("both checks reject a connection source that is neither a pool nor an acquire() provider, without a driver message", async () => {
  await assert.rejects(checkWalletInvariants({} as never), code("INVALID_INPUT"));
  await assert.rejects(findOrphanedReservations({ query: async () => ({ rows: [], rowCount: 0 }) } as never, { olderThan: new Date() }), code("INVALID_INPUT"));
  const failing = { connect: async () => { throw new Error("password authentication failed for user postgres at 10.0.0.1"); } } as never;
  await assert.rejects(checkWalletInvariants(failing), (e: unknown) => e instanceof LedgerError && e.code === "TRANSIENT" && !/password|10\.0\.0\.1/.test(String(e.message) + JSON.stringify(e)));
});

test("a failing statement surfaces only a code and SQLSTATE, rolls back, and destroys a connection whose state is unknown", async () => {
  const log: string[] = []; let destroyed: boolean | undefined;
  const serverError = Object.assign(new Error("relation vynvori_ledger.wallets does not exist (secret detail)"), { code: "42P01", severity: "ERROR" });
  const db = { acquire: async () => ({
    query: async (text: string) => { log.push(text.trim().split(/\s+/)[0]!); if (/^SELECT now/.test(text.trim())) throw serverError; return { rows: [], rowCount: 0 }; },
    release: (destroy?: boolean) => { destroyed = destroy; },
  }) } as unknown as LedgerDb;
  await assert.rejects(checkWalletInvariants(db), (e: unknown) => e instanceof LedgerError && e.code === "DATABASE_ERROR" && e.sqlstate === "42P01" && !/secret|wallets/.test(String(e.message)));
  assert.equal(log.at(-1), "ROLLBACK");
  assert.equal(destroyed, false, "a server-reported error leaves a clean, rolled-back connection that may be reused");
  const lost = { acquire: async () => ({ query: async () => { throw new Error("Connection terminated unexpectedly"); }, release: (destroy?: boolean) => { destroyed = destroy; } }) } as unknown as LedgerDb;
  await assert.rejects(checkWalletInvariants(lost), code("DATABASE_ERROR"));
  assert.equal(destroyed, true, "no server report: the connection is destroyed, never reused");
});

// ---- disposable PostgreSQL ----------------------------------------------------------------------------------------------

test("an empty migrated ledger has no findings and no orphans", { skip: ledgerTarget.skip }, async () => {
  assert.ok(ledgerTarget.url, "CI_REQUIRE_PG_TESTS=1 requires M7_TEST_POSTGRES_URL or M2_CREATIVE_DATABASE_URL");
  const client = await freshLedger("invariants");
  const { pool } = await ledgerPool("invariants", "standard");
  try {
    const report = await checkWalletInvariants(pool);
    assert.deepEqual(report.findings, []);
    assert.equal(report.ok, true);
    assert.deepEqual(report.truncated, []);
    assert.ok(!Number.isNaN(Date.parse(report.checkedAt)));
    const orphans = await findOrphanedReservations(pool, { olderThan: new Date(Date.now() + 60_000) });
    assert.deepEqual({ orphans: orphans.orphans, truncated: orphans.truncated }, { orphans: [], truncated: false });
  } finally { await pool.end(); await client.end(); await dropLedger("invariants"); }
});

test("ledger invariants and orphan detection in disposable PostgreSQL", { skip: ledgerTarget.skip }, async t => {
  assert.ok(ledgerTarget.url, "CI_REQUIRE_PG_TESTS=1 requires M7_TEST_POSTGRES_URL or M2_CREATIVE_DATABASE_URL");
  const client: Client = await freshLedger("invariants");
  const { pool, max } = await ledgerPool("invariants", "standard");
  assert.ok(max <= 5, "D15: non-concurrency files cap their pool at 5");
  try {
    const source = await registerSyntheticGrantSource(client);
    let funds = 0, grantedUnits = 0;
    const fund = (userId: string, units: number) => { grantedUnits += units; return grantSyntheticCredits(pool, { userId, grantSourceId: source, sourceRef: `funds-${++funds}`, units }); };
    const authorizeBundle = async (userId: string, extra = 0) => {
      await fund(userId, SYNTHETIC_BUNDLE_HOLD + extra);
      return authorizeQuote(pool, { userId, quoteVersionId: await issueTestQuote(pool, userId, "bundle", qid("bundle")), idempotencyKey: key("authorize"), consent: consent(), now: new Date(), pricePolicy: currentPricePolicy, eligibility: eligibilityPort() });
    };
    const dispatch = (userId: string, reservationId: string) => recordWorkflowRef(pool, { userId, component: "workflow", reservationId, workflowRef: "wf/" + randomUUID(), idempotencyKey: key("dispatch") });
    type Reservation = Awaited<ReturnType<typeof authorizeBundle>>["reservations"][number];
    const three = (b: Awaited<ReturnType<typeof authorizeBundle>>) => b.reservations as unknown as [Reservation, Reservation, Reservation];

    // ---- fixture: one of every state, built only through the ordinary commands ----
    const bundleUser = await syntheticProfileWithWallet(client);
    const [b0, b1, b2] = three(await authorizeBundle(bundleUser));
    for (const r of [b0, b1, b2]) await dispatch(bundleUser, r.reservationId);
    await settleReservation(pool, { userId: bundleUser, component: "workflow", reservationId: b0.reservationId, evidence: settleEvidence(b0.operationId), idempotencyKey: key("settle") });
    await holdReservation(pool, { userId: bundleUser, component: "workflow", reservationId: b1.reservationId, evidence: holdEvidence(b1.operationId), idempotencyKey: key("hold") });
    // b2 stays reserved and dispatched.
    const releaseUser = await syntheticProfileWithWallet(client);
    const [s0, s1, s2] = three(await authorizeBundle(releaseUser));
    await dispatch(releaseUser, s0.reservationId);
    await releaseReservation(pool, { userId: releaseUser, component: "workflow", reservationId: s0.reservationId, evidence: releaseEvidence(s0.operationId), idempotencyKey: key("release") });
    // s1 and s2 are never dispatched.
    const promoUser = await syntheticProfileWithWallet(client);
    const promo = await claimPromo(pool, { userId: promoUser, operationId: "promo-op-" + randomUUID(), idempotencyKey: key("promo") });
    const quoteUser = await syntheticProfileWithWallet(client);
    const quoteVersionId = await issueTestQuote(pool, quoteUser, "bundle", qid("unauthorized"));

    // ---- helpers over the superuser fixture connection ----
    const identity = (f: Pick<InvariantFinding, "invariant" | "userId" | "subjectId">) => `${f.invariant}|${f.userId}|${f.subjectId}`;
    const baseline = await checkWalletInvariants(pool);
    const baselineKeys = new Set(baseline.findings.map(identity));
    const added = async () => (await checkWalletInvariants(pool)).findings.filter(f => !baselineKeys.has(identity(f)));
    const summary = (findings: readonly InvariantFinding[]) => findings.map(identity).sort();
    const want = (...items: [string, string | null, string | null][]) => items.map(([invariant, userId, subjectId]) => identity({ invariant: invariant as never, userId, subjectId })).sort();
    /** Runs `work` as one transaction with triggers bypassed (replica role), as only a superuser can. The checker never has this. */
    const asSuperuser = async (work: (c: Client) => Promise<unknown>) => {
      await client.query("BEGIN");
      try { await client.query("SET LOCAL session_replication_role = replica"); await work(client); await client.query("COMMIT"); } catch (error) { await client.query("ROLLBACK"); throw error; }
    };
    const one = async (sql: string, values: unknown[] = []) => (await client.query(sql, values)).rows[0] as Record<string, string>;
    const find = (findings: readonly InvariantFinding[], invariant: string) => findings.find(f => f.invariant === invariant);
    const ensureBaseline = async (label: string) => assert.deepEqual(summary((await checkWalletInvariants(pool)).findings), summary(baseline.findings), `${label}: restored state reports exactly the baseline`);
    const constraintDef = async (table: string, name: string) => (await one("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1 AND conrelid = $2::regclass", [name, `vynvori_ledger.${table}`]))["def"]!;
    const triggerDef = async (table: string, name: string) => (await one("SELECT pg_get_triggerdef(t.oid) AS def FROM pg_trigger t WHERE t.tgname = $1 AND t.tgrelid = $2::regclass", [name, `vynvori_ledger.${table}`]))["def"]!;

    await t.test("populated through ordinary commands, the only finding is the registered synthetic grant source (D12), with its grant count and units", async () => {
      assert.equal(baseline.ok, false);
      assert.equal(baseline.findings.length, 1);
      const f = baseline.findings[0]!;
      assert.equal(f.invariant, "SYNTHETIC_GRANT_SOURCE_REGISTERED");
      assert.equal(f.subjectId, source); assert.match(f.subjectId!, UUID);
      assert.deepEqual(f.detail, { grants: String(funds), grantedUnits: String(grantedUnits) });
      assert.deepEqual(baseline.truncated, []);
    });

    await t.test("wallet bucket drift: each bucket and the revision are compared with the entry sums, with the exact expected and actual values", async () => {
      const w = await one("SELECT available_units::text a, revision::text rev FROM vynvori_ledger.wallets WHERE user_id = $1", [bundleUser]);
      await asSuperuser(c => c.query("UPDATE vynvori_ledger.wallets SET available_units = available_units + 7 WHERE user_id = $1", [bundleUser]));
      let got = await added();
      assert.deepEqual(summary(got), want(["WALLET_BUCKET_MISMATCH", bundleUser, bundleUser]));
      assert.equal(got[0]!.detail["availableExpected"], w["a"]); assert.equal(got[0]!.detail["availableActual"], String(Number(w["a"]) + 7));
      assert.equal(got[0]!.detail["reservedActual"], got[0]!.detail["reservedExpected"], "only the drifted bucket differs");
      await asSuperuser(c => c.query("UPDATE vynvori_ledger.wallets SET available_units = available_units - 7, revision = revision + 1 WHERE user_id = $1", [bundleUser]));
      got = await added();
      assert.deepEqual(summary(got), want(["WALLET_BUCKET_MISMATCH", bundleUser, bundleUser]), "a revision that does not match the entry count is a finding on its own");
      assert.equal(got[0]!.detail["revisionActual"], String(Number(w["rev"]) + 1)); assert.equal(got[0]!.detail["revisionExpected"], w["rev"]);
      assert.equal(got[0]!.detail["availableActual"], got[0]!.detail["availableExpected"]);
      await asSuperuser(c => c.query("UPDATE vynvori_ledger.wallets SET revision = revision - 1 WHERE user_id = $1", [bundleUser]));
      await ensureBaseline("bucket drift");
    });

    await t.test("an entry written while the wallet-apply trigger is disabled is found twice over: the disabled trigger and the wallet that did not move", async () => {
      const user = await syntheticProfileWithWallet(client);
      await client.query("ALTER TABLE vynvori_ledger.ledger_entries DISABLE TRIGGER ledger_entries_apply_to_wallet");
      try {
        await fund(user, 11);
        const got = await added();
        assert.deepEqual(summary(got), want(["TRIGGER_DISABLED", null, "ledger_entries.ledger_entries_apply_to_wallet"], ["WALLET_BUCKET_MISMATCH", user, user]));
        const f = find(got, "WALLET_BUCKET_MISMATCH")!;
        assert.equal(f.detail["availableExpected"], "11"); assert.equal(f.detail["availableActual"], "0"); assert.equal(f.detail["revisionExpected"], "1"); assert.equal(f.detail["revisionActual"], "0");
        assert.equal(find(got, "TRIGGER_DISABLED")!.detail["state"], "D");
      } finally { await client.query("ALTER TABLE vynvori_ledger.ledger_entries ENABLE TRIGGER ledger_entries_apply_to_wallet"); }
      assert.deepEqual(summary(await added()), want(["WALLET_BUCKET_MISMATCH", user, user]), "re-enabling the trigger clears only the trigger finding; the lost wallet movement stays visible");
      await asSuperuser(c => c.query("UPDATE vynvori_ledger.wallets SET available_units = 11, revision = 1 WHERE user_id = $1", [user]));
      await ensureBaseline("disabled apply trigger");
    });

    await t.test("each critical trigger, when dropped (DROP OWNED BY ... CASCADE does exactly this), is reported missing; recreating it clears the finding", async () => {
      for (const [table, name] of [["ledger_entries", "ledger_entries_apply_to_wallet"], ["wallets", "wallets_update_guard"], ["wallets", "wallets_insert_guard"], ["credit_reservations", "credit_reservations_update_guard"],
        ["ledger_entries", "ledger_entries_apply_to_reservation"], ["ledger_entries", "ledger_entries_bind_reservation"], ["ledger_entries", "ledger_entries_immutable"], ["ledger_quotes", "ledger_quotes_check_allocation_sums"]] as const) {
        const def = await triggerDef(table, name);
        await client.query(`DROP TRIGGER ${name} ON vynvori_ledger.${table}`);
        try { assert.deepEqual(summary(await added()), want(["TRIGGER_MISSING", null, `${table}.${name}`]), name); }
        finally { await client.query(def); }
        await ensureBaseline("recreated " + name);
      }
    });

    await t.test("a trigger enabled only for replicas, one of a different shape or function, an extra trigger and a rewrite rule are each reported; 'always' is accepted", async () => {
      await client.query("ALTER TABLE vynvori_ledger.wallets ENABLE REPLICA TRIGGER wallets_update_guard");
      try {
        const got = await added();
        assert.deepEqual(summary(got), want(["TRIGGER_DISABLED", null, "wallets.wallets_update_guard"]));
        assert.equal(got[0]!.detail["state"], "R");
      } finally { await client.query("ALTER TABLE vynvori_ledger.wallets ENABLE TRIGGER wallets_update_guard"); }
      await client.query("ALTER TABLE vynvori_ledger.wallets ENABLE ALWAYS TRIGGER wallets_update_guard");
      try { await ensureBaseline("enable always"); } finally { await client.query("ALTER TABLE vynvori_ledger.wallets ENABLE TRIGGER wallets_update_guard"); }

      const def = await triggerDef("ledger_entries", "ledger_entries_check_command");
      await client.query("DROP TRIGGER ledger_entries_check_command ON vynvori_ledger.ledger_entries");
      await client.query("CREATE TRIGGER ledger_entries_check_command AFTER INSERT ON vynvori_ledger.ledger_entries FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.ledger_entries_check_command()");
      try { assert.deepEqual(summary(await added()), want(["TRIGGER_MISMATCH", null, "ledger_entries.ledger_entries_check_command"]), "BEFORE became AFTER"); }
      finally { await client.query("DROP TRIGGER ledger_entries_check_command ON vynvori_ledger.ledger_entries"); await client.query(def); }
      await client.query("DROP TRIGGER ledger_entries_check_command ON vynvori_ledger.ledger_entries");
      await client.query("CREATE TRIGGER ledger_entries_check_command BEFORE INSERT ON vynvori_ledger.ledger_entries FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.reject_mutation()");
      try {
        const got = await added();
        assert.deepEqual(summary(got), want(["TRIGGER_MISMATCH", null, "ledger_entries.ledger_entries_check_command"]), "same name, wrong function");
        assert.equal(got[0]!.detail["function"], "vynvori_ledger.reject_mutation");
      } finally { await client.query("DROP TRIGGER ledger_entries_check_command ON vynvori_ledger.ledger_entries"); await client.query(def); }
      await ensureBaseline("restored check_command");

      await client.query("CREATE TRIGGER zz_extra BEFORE DELETE ON vynvori_ledger.wallets FOR EACH ROW EXECUTE FUNCTION vynvori_ledger.reject_mutation()");
      try { assert.deepEqual(summary(await added()), want(["TRIGGER_UNEXPECTED", null, "wallets.zz_extra"])); } finally { await client.query("DROP TRIGGER zz_extra ON vynvori_ledger.wallets"); }
      await client.query("CREATE RULE zz_rule AS ON DELETE TO vynvori_ledger.wallets DO INSTEAD NOTHING");
      try { assert.deepEqual(summary(await added()), want(["RULE_UNEXPECTED", null, "wallets.zz_rule"])); } finally { await client.query("DROP RULE zz_rule ON vynvori_ledger.wallets"); }
      await ensureBaseline("extra trigger and rule removed");
    });

    await t.test("exactly the reviewed functions are definer-rights, and every function keeps its pinned search_path", async () => {
      await client.query("ALTER FUNCTION vynvori_ledger.ledger_entries_apply_to_wallet() SECURITY INVOKER");
      try { const got = await added(); assert.deepEqual(summary(got), want(["FUNCTION_PRIVILEGE_MISMATCH", null, "ledger_entries_apply_to_wallet"])); assert.deepEqual(got[0]!.detail, { securityDefiner: false, expectedSecurityDefiner: true }); }
      finally { await client.query("ALTER FUNCTION vynvori_ledger.ledger_entries_apply_to_wallet() SECURITY DEFINER"); }
      await client.query("ALTER FUNCTION vynvori_ledger.reject_mutation() SECURITY DEFINER");
      try { const got = await added(); assert.deepEqual(summary(got), want(["FUNCTION_PRIVILEGE_MISMATCH", null, "reject_mutation"])); assert.deepEqual(got[0]!.detail, { securityDefiner: true, expectedSecurityDefiner: false }); }
      finally { await client.query("ALTER FUNCTION vynvori_ledger.reject_mutation() SECURITY INVOKER"); }
      await client.query("ALTER FUNCTION vynvori_ledger.wallets_update_guard() RESET search_path");
      try { assert.deepEqual(summary(await added()), want(["FUNCTION_SEARCH_PATH_UNPINNED", null, "wallets_update_guard"])); }
      finally { await client.query("ALTER FUNCTION vynvori_ledger.wallets_update_guard() SET search_path = pg_catalog, pg_temp"); }
      await client.query("ALTER FUNCTION vynvori_ledger.wallets_update_guard() SET search_path = vynvori_ledger, pg_catalog");
      try { assert.deepEqual(summary(await added()), want(["FUNCTION_SEARCH_PATH_UNPINNED", null, "wallets_update_guard"]), "a different search_path is not the pinned one"); }
      finally { await client.query("ALTER FUNCTION vynvori_ledger.wallets_update_guard() SET search_path = pg_catalog, pg_temp"); }
      await ensureBaseline("function settings restored");
    });

    await t.test("an unbalanced entry (its CHECKs dropped) and a negative or out-of-range bucket are found even though the database would normally refuse them", async () => {
      const balanced = await constraintDef("ledger_entries", "ledger_entries_balanced"), sign = await constraintDef("ledger_entries", "ledger_entries_sign_shape");
      const entryId = randomUUID(), commandId = randomUUID();
      await asSuperuser(async c => {
        await c.query("ALTER TABLE vynvori_ledger.ledger_entries DROP CONSTRAINT ledger_entries_balanced");
        await c.query("ALTER TABLE vynvori_ledger.ledger_entries DROP CONSTRAINT ledger_entries_sign_shape");
        await c.query("INSERT INTO vynvori_ledger.ledger_commands(command_id, scope, idempotency_key, request_sha256, user_id, command_kind, outcome) VALUES($1, $2, $3, repeat('a', 64), $4, 'grant_credits', 'applied')",
          [commandId, `${quoteUser}:grant_credits`, "corrupt-" + randomUUID(), quoteUser]);
        await c.query(`INSERT INTO vynvori_ledger.ledger_entries(entry_id, user_id, command_id, entry_kind, delta_available, delta_reserved, delta_held, delta_consumed, delta_external, grant_source_id, source_ref, cause_kind, cause_ref)
          VALUES($1, $2, $3, 'grant', 5, 0, 0, 0, 0, $4::uuid, 'unbalanced', 'grant', $4::text || ':unbalanced')`, [entryId, quoteUser, commandId, source]);
      });
      try {
        const got = await added();
        assert.deepEqual(summary(got), want(["ENTRY_UNBALANCED", quoteUser, entryId], ["WALLET_BUCKET_MISMATCH", quoteUser, quoteUser]));
        assert.deepEqual(find(got, "ENTRY_UNBALANCED")!.detail, { entryKind: "grant", imbalance: "5" });
      } finally {
        await asSuperuser(async c => {
          await c.query("DELETE FROM vynvori_ledger.ledger_entries WHERE entry_id = $1", [entryId]);
          await c.query("DELETE FROM vynvori_ledger.ledger_commands WHERE command_id = $1", [commandId]);
          await c.query(`ALTER TABLE vynvori_ledger.ledger_entries ADD CONSTRAINT ledger_entries_balanced ${balanced}`);
          await c.query(`ALTER TABLE vynvori_ledger.ledger_entries ADD CONSTRAINT ledger_entries_sign_shape ${sign}`);
        });
      }
      await ensureBaseline("unbalanced entry removed");

      const bounds = await constraintDef("wallets", "wallets_available_bounds");
      await asSuperuser(async c => { await c.query("ALTER TABLE vynvori_ledger.wallets DROP CONSTRAINT wallets_available_bounds"); await c.query("UPDATE vynvori_ledger.wallets SET available_units = -1 WHERE user_id = $1", [quoteUser]); });
      try {
        const got = await added();
        assert.deepEqual(summary(got), want(["WALLET_BUCKET_OUT_OF_RANGE", quoteUser, quoteUser], ["WALLET_BUCKET_MISMATCH", quoteUser, quoteUser]));
        assert.equal(find(got, "WALLET_BUCKET_OUT_OF_RANGE")!.detail["available"], "-1");
        await asSuperuser(c => c.query("UPDATE vynvori_ledger.wallets SET available_units = 9007199254740992 WHERE user_id = $1", [quoteUser]));
        assert.equal(find(await added(), "WALLET_BUCKET_OUT_OF_RANGE")!.detail["available"], "9007199254740992", "above the safe-integer range is reported as text, never rounded");
      } finally {
        await asSuperuser(async c => { await c.query("UPDATE vynvori_ledger.wallets SET available_units = 0 WHERE user_id = $1", [quoteUser]); await c.query(`ALTER TABLE vynvori_ledger.wallets ADD CONSTRAINT wallets_available_bounds ${bounds}`); });
      }
      await ensureBaseline("out-of-range bucket restored");
    });

    await t.test("reservation state is compared with the entry trail and with the wallet buckets, state by state", async () => {
      const set = (reservationId: string, state: string) => asSuperuser(c => c.query("UPDATE vynvori_ledger.credit_reservations SET state = $2 WHERE reservation_id = $1", [reservationId, state]));
      const wallet = await one("SELECT reserved_units::text r, held_for_review_units::text h, consumed_units::text c FROM vynvori_ledger.wallets WHERE user_id = $1", [bundleUser]);
      const cases: [string, [string, string | null, string | null][]][] = [
        ["released", [["RESERVED_BUCKET_MISMATCH", bundleUser, bundleUser], ["RESERVATION_TRAIL_MISMATCH", bundleUser, b2.reservationId]]],
        ["reconciliation_hold", [["RESERVED_BUCKET_MISMATCH", bundleUser, bundleUser], ["HELD_BUCKET_MISMATCH", bundleUser, bundleUser], ["RESERVATION_TRAIL_MISMATCH", bundleUser, b2.reservationId]]],
        ["settled", [["RESERVED_BUCKET_MISMATCH", bundleUser, bundleUser], ["CONSUMED_BUCKET_MISMATCH", bundleUser, bundleUser], ["RESERVATION_TRAIL_MISMATCH", bundleUser, b2.reservationId]]],
        ["authorization_requested", [["RESERVED_BUCKET_MISMATCH", bundleUser, bundleUser], ["RESERVATION_TRAIL_MISMATCH", bundleUser, b2.reservationId]]],
        ["operator_remedy", [["RESERVED_BUCKET_MISMATCH", bundleUser, bundleUser], ["RESERVATION_TRAIL_MISMATCH", bundleUser, b2.reservationId]]],
      ];
      for (const [state, expected] of cases) {
        await set(b2.reservationId, state);
        try {
          const got = await added();
          assert.deepEqual(summary(got), want(...expected), state);
          const trail = find(got, "RESERVATION_TRAIL_MISMATCH")!;
          assert.equal(trail.detail["state"], state); assert.equal(trail.detail["expectedState"], "reserved");
          assert.equal(trail.detail["reason"], state === "authorization_requested" ? "committed_authorization_requested" : "state_trail_mismatch");
          const bucket = find(got, "RESERVED_BUCKET_MISMATCH")!;
          assert.equal(bucket.detail["actual"], wallet["r"]); assert.equal(bucket.detail["expected"], String(Number(wallet["r"]) - b2.holdUnits), "the wallet still holds b2's units, the reservations no longer do");
          if (state === "reconciliation_hold") { const h = find(got, "HELD_BUCKET_MISMATCH")!; assert.equal(h.detail["actual"], wallet["h"]); assert.equal(h.detail["expected"], String(Number(wallet["h"]) + b2.holdUnits)); }
          if (state === "settled") { const c = find(got, "CONSUMED_BUCKET_MISMATCH")!; assert.equal(c.detail["actual"], wallet["c"]); assert.equal(c.detail["expected"], String(Number(wallet["c"]) + b2.chargeUnits)); }
        } finally { await set(b2.reservationId, "reserved"); }
      }
      // A reserve entry whose amounts differ from its reservation (still balanced, so no CHECK refuses it).
      await asSuperuser(c => c.query("UPDATE vynvori_ledger.ledger_entries SET delta_available = delta_available - 1, delta_reserved = delta_reserved + 1 WHERE reservation_id = $1 AND entry_kind = 'reserve'", [b2.reservationId]));
      try {
        const got = await added();
        assert.deepEqual(summary(got), want(["RESERVATION_TRAIL_MISMATCH", bundleUser, b2.reservationId], ["WALLET_BUCKET_MISMATCH", bundleUser, bundleUser]));
        assert.equal(find(got, "RESERVATION_TRAIL_MISMATCH")!.detail["reason"], "entry_amount_mismatch");
      } finally { await asSuperuser(c => c.query("UPDATE vynvori_ledger.ledger_entries SET delta_available = delta_available + 1, delta_reserved = delta_reserved - 1 WHERE reservation_id = $1 AND entry_kind = 'reserve'", [b2.reservationId])); }
      // A terminal state with no terminal entry: the released reservation s0 claims to be settled.
      await set(s0.reservationId, "settled");
      try { assert.deepEqual(summary((await added()).filter(f => f.invariant === "RESERVATION_TRAIL_MISMATCH")), want(["RESERVATION_TRAIL_MISMATCH", releaseUser, s0.reservationId])); }
      finally { await set(s0.reservationId, "released"); }
      await ensureBaseline("reservation states restored");
    });

    await t.test("allocation sums are re-derived per quote version, and an authorization must reserve exactly its allocations", async () => {
      await asSuperuser(c => c.query("UPDATE vynvori_ledger.ledger_quote_allocations SET hold_units = hold_units + 1 WHERE quote_version_id = $1 AND operation_index = 0", [quoteVersionId]));
      try {
        const got = await added();
        assert.deepEqual(summary(got), want(["ALLOCATION_SUM_MISMATCH", quoteUser, quoteVersionId]));
        assert.equal(got[0]!.detail["holdSum"], String(Number(got[0]!.detail["holdQuoted"]) + 1)); assert.equal(got[0]!.detail["allocations"], "3");
      } finally { await asSuperuser(c => c.query("UPDATE vynvori_ledger.ledger_quote_allocations SET hold_units = hold_units - 1 WHERE quote_version_id = $1 AND operation_index = 0", [quoteVersionId])); }
      const authorizationId = (await one("SELECT authorization_id::text AS id FROM vynvori_ledger.credit_reservations WHERE reservation_id = $1", [s1.reservationId]))["id"]!;
      await asSuperuser(c => c.query("UPDATE vynvori_ledger.credit_reservations SET charge_units = charge_units - 1 WHERE reservation_id = $1", [s1.reservationId]));
      try {
        const got = await added();
        assert.deepEqual(summary(got), want(["AUTHORIZATION_ALLOCATION_MISMATCH", releaseUser, authorizationId]));
        assert.equal(got[0]!.detail["unitDifferences"], "1"); assert.equal(got[0]!.detail["reservations"], "3"); assert.equal(got[0]!.detail["allocations"], "3");
      } finally { await asSuperuser(c => c.query("UPDATE vynvori_ledger.credit_reservations SET charge_units = charge_units + 1 WHERE reservation_id = $1", [s1.reservationId])); }
      await ensureBaseline("allocations restored");
    });

    await t.test("promo uniqueness (one claim per identity, user and operation) and the claim state against its event trail", async () => {
      const constraints = { promo_claims_user_unique: await constraintDef("promo_claims", "promo_claims_user_unique"), promo_claims_identity_unique: await constraintDef("promo_claims", "promo_claims_identity_unique") };
      const duplicate = randomUUID();
      await asSuperuser(async c => {
        for (const name of Object.keys(constraints)) await c.query(`ALTER TABLE vynvori_ledger.promo_claims DROP CONSTRAINT ${name}`);
        await c.query("INSERT INTO vynvori_ledger.promo_claims(claim_id, user_id, issuer, subject, operation_id, state, event_seq) SELECT $1::uuid, user_id, issuer, subject, 'dup-op-' || $1::text, 'eligible', 0 FROM vynvori_ledger.promo_claims WHERE claim_id = $2", [duplicate, promo.claim.claimId]);
      });
      try {
        const got = await added();
        assert.deepEqual(got.map(f => f.invariant), ["PROMO_UNIQUENESS_VIOLATED", "PROMO_UNIQUENESS_VIOLATED"]);
        assert.deepEqual(got.map(f => f.detail["keyKind"]).sort(), ["identity", "user"]);
        for (const f of got) { assert.equal(f.detail["count"], "2"); assert.deepEqual(String(f.detail["claims"]).split(",").sort(), [duplicate, promo.claim.claimId].sort()); }
      } finally {
        await asSuperuser(async c => {
          await c.query("DELETE FROM vynvori_ledger.promo_claims WHERE claim_id = $1", [duplicate]);
          for (const [name, def] of Object.entries(constraints)) await c.query(`ALTER TABLE vynvori_ledger.promo_claims ADD CONSTRAINT ${name} ${def}`);
        });
      }
      await ensureBaseline("duplicate promo claim removed");
      await asSuperuser(c => c.query("UPDATE vynvori_ledger.promo_claims SET state = 'consumed' WHERE claim_id = $1", [promo.claim.claimId]));
      try {
        const got = await added();
        assert.deepEqual(summary(got), want(["PROMO_CLAIM_TRAIL_MISMATCH", promoUser, promo.claim.claimId]));
        assert.deepEqual(got[0]!.detail, { state: "consumed", trailState: "claim_reserved", eventSeq: "1", events: "1" });
      } finally { await asSuperuser(c => c.query("UPDATE vynvori_ledger.promo_claims SET state = 'claim_reserved' WHERE claim_id = $1", [promo.claim.claimId])); }
      await ensureBaseline("promo trail restored");
    });

    await t.test("a flood of findings is capped per invariant and the report says it was truncated", async () => {
      const ids = (await client.query("INSERT INTO vynvori_identity.profiles(id, issuer, subject) SELECT gen_random_uuid(), 'https://synthetic.invalid', 'flood-' || g FROM generate_series(1, 101) g RETURNING id")).rows.map(r => r.id as string);
      await client.query("INSERT INTO vynvori_ledger.wallets(user_id) SELECT unnest($1::uuid[])", [ids]);
      await asSuperuser(c => c.query("UPDATE vynvori_ledger.wallets SET revision = 1 WHERE user_id = ANY($1::uuid[])", [ids]));
      try {
        const report = await checkWalletInvariants(pool);
        assert.equal(report.findings.filter(f => f.invariant === "WALLET_BUCKET_MISMATCH").length, 100);
        assert.deepEqual(report.truncated, ["WALLET_BUCKET_MISMATCH"]);
        assert.equal(report.ok, false);
      } finally { await asSuperuser(c => c.query("UPDATE vynvori_ledger.wallets SET revision = 0 WHERE user_id = ANY($1::uuid[])", [ids])); }
      await ensureBaseline("flood restored");
    });

    await t.test("orphans: each class is reported with the right fields; settled, released and young reservations never are; the cut-off decides", async () => {
      const future = new Date(Date.now() + 60_000);
      const all = await findOrphanedReservations(pool, { olderThan: future });
      assert.equal(all.truncated, false); assert.equal(all.olderThan, future.toISOString());
      const byId = new Map(all.orphans.map(o => [o.reservationId, o]));
      assert.deepEqual([...byId.keys()].sort(), [b1.reservationId, b2.reservationId, s1.reservationId, s2.reservationId].sort(), "settled b0 and released s0 are never orphans");
      const check = (r: Reservation, userId: string, expected: Pick<OrphanedReservation, "orphanClass" | "state" | "dispatched">) => {
        const got = byId.get(r.reservationId)!;
        assert.deepEqual({ orphanClass: got.orphanClass, state: got.state, dispatched: got.dispatched, holdUnits: got.holdUnits, chargeUnits: got.chargeUnits, userId: got.userId, operationId: got.operationId },
          { ...expected, holdUnits: r.holdUnits, chargeUnits: r.chargeUnits, userId, operationId: r.operationId });
        assert.match(got.reservedAt, /^\d{4}-\d\d-\d\dT/);
      };
      check(b1, bundleUser, { orphanClass: "hold_present", state: "reconciliation_hold", dispatched: true });
      check(b2, bundleUser, { orphanClass: "reserved_dispatch_stale", state: "reserved", dispatched: true });
      check(s1, releaseUser, { orphanClass: "reserved_never_dispatched", state: "reserved", dispatched: false });
      check(s2, releaseUser, { orphanClass: "reserved_never_dispatched", state: "reserved", dispatched: false });
      assert.deepEqual(Object.keys(all.orphans[0]!).sort(), ["chargeUnits", "dispatched", "holdUnits", "operationId", "operationKind", "orphanClass", "reservationId", "reservedAt", "state", "userId"], "no workflow reference, evidence or key is ever reported");
      assert.deepEqual((await findOrphanedReservations(pool, { olderThan: new Date(0) })).orphans, [], "nothing is older than the epoch");
      // Age the reservations through the superuser fixture: the reservation's own age for `reserved`, the hold ENTRY's age for a hold.
      const old = new Date(Date.now() - 2 * 3_600_000), cutoff = new Date(Date.now() - 3_600_000);
      await asSuperuser(c => c.query("UPDATE vynvori_ledger.credit_reservations SET created_at = $2 WHERE reservation_id = $1", [s2.reservationId, old]));
      assert.deepEqual((await findOrphanedReservations(pool, { olderThan: cutoff })).orphans.map(o => o.reservationId), [s2.reservationId]);
      await asSuperuser(c => c.query("UPDATE vynvori_ledger.ledger_entries SET created_at = $2 WHERE reservation_id = $1 AND entry_kind = 'hold'", [b1.reservationId, old]));
      assert.deepEqual((await findOrphanedReservations(pool, { olderThan: cutoff })).orphans.map(o => [o.reservationId, o.orphanClass]).sort(), [[b1.reservationId, "hold_present"], [s2.reservationId, "reserved_never_dispatched"]].sort());
      assert.deepEqual((await findOrphanedReservations(pool, { olderThan: old })).orphans, [], "the cut-off is exclusive");
      // A released or settled reservation is not an orphan however old it is.
      await asSuperuser(c => c.query("UPDATE vynvori_ledger.credit_reservations SET created_at = $2 WHERE reservation_id = ANY($1::uuid[])", [[b0.reservationId, s0.reservationId], old]));
      assert.deepEqual((await findOrphanedReservations(pool, { olderThan: cutoff })).orphans.map(o => o.reservationId).sort(), [b1.reservationId, s2.reservationId].sort());
    });

    await t.test("the checks change nothing (row counts and xmin/xmax/ctid fingerprints) and every statement is a SELECT inside one READ ONLY REPEATABLE READ transaction", async () => {
      const fingerprint = async () => {
        const tables = (await client.query("SELECT schemaname || '.' || tablename AS name FROM pg_tables WHERE schemaname IN ('vynvori_ledger', 'vynvori_identity') ORDER BY 1")).rows.map(r => r.name as string);
        const out: Record<string, string> = {};
        for (const name of tables) out[name] = JSON.stringify((await client.query(`SELECT count(*)::int AS n, coalesce(md5(string_agg(xmin::text || ':' || xmax::text || ':' || ctid::text, ',' ORDER BY ctid)), '') AS h FROM ${name}`)).rows[0]);
        return out;
      };
      const before = await fingerprint();
      assert.ok(Object.keys(before).length > 15, "fingerprinted every ledger and identity table");
      const log: string[] = []; const modes: string[] = [];
      const spy = { acquire: async () => ({
        query: async (text: string, values?: unknown[]) => {
          log.push(text.trim());
          const result = await client.query(text, values);
          if (/^BEGIN/.test(text.trim())) modes.push((await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only, (await client.query("SHOW transaction_isolation")).rows[0].transaction_isolation);
          return result as never;
        },
        release: () => undefined,
      }) } as unknown as LedgerDb;
      await checkWalletInvariants(spy);
      const checkLog = log.splice(0);
      await findOrphanedReservations(spy, { olderThan: new Date(Date.now() + 60_000) });
      const orphanLog = log.splice(0);
      assert.deepEqual(modes, ["on", "repeatable read", "on", "repeatable read"], "both checks run READ ONLY at REPEATABLE READ");
      for (const statements of [checkLog, orphanLog]) {
        assert.equal(statements[0], "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); assert.equal(statements.at(-1), "ROLLBACK");
        assert.equal(statements.filter(s => /^(BEGIN|ROLLBACK)/.test(s)).length, 2, "one transaction, never committed");
        for (const s of statements.slice(1, -1)) { assert.match(s, /^(SELECT|WITH)\b/, s.slice(0, 50)); assert.doesNotMatch(s, /\bFOR\s+(UPDATE|SHARE)\b|pg_advisory|\bINSERT\b|\bUPDATE\b|\bDELETE\b/); }
      }
      assert.ok(checkLog.length >= 17 && orphanLog.length === 4, `${checkLog.length} / ${orphanLog.length} statements`);
      assert.deepEqual(await fingerprint(), before, "no row, xmin, xmax or ctid changed");
      // Session settings were transaction-local: the pooled connection is back to its defaults.
      const settings = (await pool.query("SELECT current_setting('statement_timeout') AS st, current_setting('transaction_read_only') AS ro, current_setting('lock_timeout') AS lt")).rows[0];
      assert.deepEqual(settings, { st: "0", ro: "off", lt: "0" });
    });

    await t.test("it is correct under concurrent writers: every snapshot is internally consistent while commands commit", async () => {
      await ensureBaseline("before concurrency");
      const writers: string[] = [];
      for (let i = 0; i < 6; i++) writers.push(await syntheticProfileWithWallet(client)); // the fixture client is not safe for concurrent use
      const runWriter = async (index: number) => {
        const user = writers[index]!;
        const [r0, r1, r2] = three(await authorizeBundle(user));
        for (const r of [r0, r1, r2]) await dispatch(user, r.reservationId);
        await settleReservation(pool, { userId: user, component: "workflow", reservationId: r0.reservationId, evidence: settleEvidence(r0.operationId), idempotencyKey: key("settle") });
        await holdReservation(pool, { userId: user, component: "workflow", reservationId: r1.reservationId, evidence: holdEvidence(r1.operationId), idempotencyKey: key("hold") });
        if (index % 2 === 0) await releaseReservation(pool, { userId: user, component: "workflow", reservationId: r2.reservationId, evidence: releaseEvidence(r2.operationId), idempotencyKey: key("release") });
      };
      let writing = true; const reports: Awaited<ReturnType<typeof checkWalletInvariants>>[] = [];
      const checker = (async () => { while (writing) { reports.push(await checkWalletInvariants(pool)); await findOrphanedReservations(pool, { olderThan: new Date() }); } })();
      try { await Promise.all([0, 1, 2].map(i => runWriter(i).then(() => runWriter(i + 3)))); } finally { writing = false; }
      await checker;
      assert.ok(reports.length >= 2, "the checker ran while the writers committed");
      for (const report of reports) assert.deepEqual(report.findings.filter(f => f.invariant !== "SYNTHETIC_GRANT_SOURCE_REGISTERED"), [], "no false finding from a half-applied command");
      assert.deepEqual((await checkWalletInvariants(pool)).findings.map(f => f.invariant), ["SYNTHETIC_GRANT_SOURCE_REGISTERED"], "and the final state is clean apart from the synthetic source");
    });
  } finally { await pool.end(); await client.end(); await dropLedger("invariants"); }
});
