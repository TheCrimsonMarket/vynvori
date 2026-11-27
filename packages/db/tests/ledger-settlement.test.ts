import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client, PoolClient } from "pg";
import { LedgerBusinessRejection, LedgerError, type LedgerConn, type LedgerDb } from "../src/ledger-core";
import { recordVendorCostEvidence, type RecordVendorCostEvidenceInput } from "../src/ledger-evidence";
import { authorizeQuote, getReservation, recordWorkflowRef, releaseReservation } from "../src/ledger-reservations";
import { holdReservation, settleReservation } from "../src/ledger-settlement";
import { dropLedger, freshLedger, grantSyntheticCredits, ledgerPool, ledgerTarget, registerSyntheticGrantSource, syntheticProfileWithWallet } from "./ledger-fixture";
import { SYNTHETIC_BUNDLE_HOLD, SYNTHETIC_CHARGES, SYNTHETIC_HOLDS, consent, currentPricePolicy, eligibilityPort, issueTestQuote, releaseEvidence } from "./ledger-reservation-fixture";

/**
 * ADR-0021 S6 addendum: settle, reconciliation hold, vendor-cost isolation, and the 0006 database backstop.
 * Non-concurrency file: pool capped at 5 (D15); declared peak connections = 5 (pool) + 1 (persistent fixture client) = 6.
 * Every unit and micro-USD value is SYNTHETIC; nothing here is a price, cost, rate or package size.
 */
const code = (c: string) => (e: unknown) => e instanceof LedgerError && e.code === c;
const rejection = (c: string) => (e: unknown) => e instanceof LedgerBusinessRejection && e.code === c;
const sqlstate = (c: string, pattern?: RegExp) => (e: unknown) => (e as { code?: string }).code === c && (!pattern || pattern.test((e as Error).message));
let keyCounter = 0;
const key = (label: string) => `${label}-${String(++keyCounter).padStart(6, "0")}-${randomUUID().slice(0, 8)}`;
const qid = (label: string) => `${label}-${randomUUID()}`;
const settleEvidence = (operationId: string, evidenceRef = "plane-b/delivered-1") => ({ transition: "settle", operationId, evidenceKind: "persisted_delivered", evidenceRef, hasVerifiedManifestHash: true, ownerAndRightsVerified: true });
const holdEvidence = (operationId: string, kind: "outcome_unknown" | "persistence_failed_under_review" = "outcome_unknown", evidenceRef = "plane-b/unknown-1") =>
  ({ transition: "hold", operationId, evidenceKind: kind, evidenceRef, reason: kind === "outcome_unknown" ? "outcome_unknown" : "persistence_unconfirmed" });
const SYNTHETIC_MICROS = 1234567;

test("settleReservation, holdReservation and recordVendorCostEvidence reject malformed input and wrong evidence before any SQL", async () => {
  const db = { acquire: async () => { throw new Error("no SQL may run"); }, query: async () => { throw new Error("no SQL may run"); } } as unknown as LedgerDb & { query: never };
  const base = { userId: randomUUID(), component: "workflow", reservationId: randomUUID(), idempotencyKey: "valid-key-0123456789" };
  for (const bad of [{ userId: "x" }, { userId: randomUUID().toUpperCase() }, { reservationId: "x" }, { component: "Bad Component" }, { component: "" }, { idempotencyKey: "short" }]) {
    await assert.rejects(settleReservation(db, { ...base, evidence: settleEvidence("op_x"), ...bad }), code("INVALID_INPUT"), "settle " + JSON.stringify(bad));
    await assert.rejects(holdReservation(db, { ...base, evidence: holdEvidence("op_x"), ...bad }), code("INVALID_INPUT"), "hold " + JSON.stringify(bad));
  }
  const notSettle = [
    undefined, null, {}, releaseEvidence("op_x"), holdEvidence("op_x"),
    { ...settleEvidence("op_x"), evidenceKind: "vendor_charge" }, // a vendor-charge message is never evidence (doc 06, invariant 5)
    { ...settleEvidence("op_x"), evidenceKind: "result_received" }, { ...settleEvidence("op_x"), evidenceKind: "outcome_unknown" },
    { ...settleEvidence("op_x"), evidenceKind: "verified_zero_charge_failure" }, { ...settleEvidence("op_x"), hasVerifiedManifestHash: false },
    { ...settleEvidence("op_x"), ownerAndRightsVerified: false }, { ...settleEvidence("op_x"), evidenceRef: "" }, { ...settleEvidence("op_x"), evidenceRef: "r".repeat(513) },
    { ...settleEvidence("op_x"), chargeUnits: 1 }, { ...settleEvidence("op_x"), vendorCostUsd: 0.5 }, { transition: "settle", operationId: "op_x", evidenceKind: "persisted_delivered", evidenceRef: "r" },
  ];
  for (const evidence of notSettle) await assert.rejects(settleReservation(db, { ...base, evidence }), code("EVIDENCE_INVALID"), "settle " + JSON.stringify(evidence));
  const notHold = [
    undefined, {}, releaseEvidence("op_x"), settleEvidence("op_x"), { ...holdEvidence("op_x"), reason: "persistence_unconfirmed" },
    { ...holdEvidence("op_x", "persistence_failed_under_review"), reason: "outcome_unknown" }, { ...holdEvidence("op_x"), evidenceKind: "vendor_charge" },
    { ...holdEvidence("op_x"), evidenceKind: "timeout" }, { ...holdEvidence("op_x"), evidenceRef: "r".repeat(513) }, { ...holdEvidence("op_x"), extra: 1 },
  ];
  for (const evidence of notHold) await assert.rejects(holdReservation(db, { ...base, evidence }), code("EVIDENCE_INVALID"), "hold " + JSON.stringify(evidence));
  const vendor: RecordVendorCostEvidenceInput = { component: "reconciler", operationId: "op_x", evidenceKind: "invoice", evidenceRef: "inv-1", amountUsdMicros: SYNTHETIC_MICROS };
  for (const bad of [
    { component: "Bad" }, { operationId: "bad id" }, { operationId: "" }, { reservationId: "x" }, { evidenceKind: "none" }, { evidenceKind: "charge" }, { evidenceRef: "" },
    { evidenceRef: "r".repeat(513) }, { evidenceRef: "a\u0000b" }, { amountUsdMicros: -1 }, { amountUsdMicros: 1.5 }, { amountUsdMicros: 0.000001 }, { amountUsdMicros: Number.MAX_SAFE_INTEGER + 1 },
    { amountUsdMicros: "100" }, { amountUsdMicros: undefined }, { evidenceKind: "unknown", amountUsdMicros: 0 },
  ] as Partial<RecordVendorCostEvidenceInput>[]) await assert.rejects(recordVendorCostEvidence(db, { ...vendor, ...bad } as RecordVendorCostEvidenceInput), code("INVALID_INPUT"), "vendor " + JSON.stringify(bad));
  await assert.rejects(recordVendorCostEvidence(db, null as never), code("INVALID_INPUT"));
});

test("ledger settlement: settle, reconciliation hold and vendor-cost isolation in disposable PostgreSQL", { skip: ledgerTarget.skip }, async t => {
  assert.ok(ledgerTarget.url, "CI_REQUIRE_PG_TESTS=1 requires M7_TEST_POSTGRES_URL or M2_CREATIVE_DATABASE_URL");
  const client: Client = await freshLedger("settlement");
  const { pool, max } = await ledgerPool("settlement", "standard");
  assert.ok(max <= 5, "D15: non-concurrency files cap their pool at 5");
  try {
    const source = await registerSyntheticGrantSource(client);
    let funds = 0;
    const fund = (userId: string, units: number) => grantSyntheticCredits(pool, { userId, grantSourceId: source, sourceRef: `funds-${++funds}`, units });
    const buckets = async (userId: string) => {
      const row = (await client.query("SELECT available_units::int a, reserved_units::int r, held_for_review_units::int h, consumed_units::int c FROM vynvori_ledger.wallets WHERE user_id = $1", [userId])).rows[0];
      return { a: row.a as number, r: row.r as number, h: row.h as number, c: row.c as number };
    };
    const count = async (table: string, userId: string) => (await client.query(`SELECT count(*)::int AS n FROM vynvori_ledger.${table} WHERE user_id = $1`, [userId])).rows[0].n as number;
    const stateOf = async (reservationId: string) => (await client.query("SELECT state FROM vynvori_ledger.credit_reservations WHERE reservation_id = $1", [reservationId])).rows[0].state as string;
    /** A funded user with one authorized bundle (three reservations, holds 4/3/3, charges 3/3/2), every reservation dispatched unless told otherwise. */
    const withBundle = async (options: { dispatch?: boolean; extra?: number } = {}) => {
      const user = await syntheticProfileWithWallet(client);
      await fund(user, SYNTHETIC_BUNDLE_HOLD + (options.extra ?? 0));
      const bundle = await authorizeQuote(pool, { userId: user, quoteVersionId: await issueTestQuote(pool, user, "bundle", qid("bundle")), idempotencyKey: key("authorize"), consent: consent(), now: new Date(), pricePolicy: currentPricePolicy, eligibility: eligibilityPort() });
      if (options.dispatch !== false) for (const r of bundle.reservations) await recordWorkflowRef(pool, { userId: user, component: "workflow", reservationId: r.reservationId, workflowRef: "wf/" + randomUUID(), idempotencyKey: key("dispatch") });
      return { user, bundle, r: bundle.reservations };
    };
    const settle = (userId: string, reservationId: string, evidence: unknown, idempotencyKey = key("settle")) => settleReservation(pool, { userId, component: "workflow", reservationId, evidence, idempotencyKey });
    const hold = (userId: string, reservationId: string, evidence: unknown, idempotencyKey = key("hold")) => holdReservation(pool, { userId, component: "workflow", reservationId, evidence, idempotencyKey });
    const release = (userId: string, reservationId: string, evidence: unknown, idempotencyKey = key("release")) => releaseReservation(pool, { userId, component: "workflow", reservationId, evidence, idempotencyKey });

    await t.test("settle: persisted-delivered evidence for THIS operation consumes exactly the frozen charge and returns the rest of the hold in ONE entry; replay-safe", async () => {
      const { user, r } = await withBundle();
      const target = r[0]!, k = key("settle-ok");
      const settled = await settle(user, target.reservationId, settleEvidence(target.operationId, "plane-b/manifest-1"), k);
      assert.equal(settled.state, "settled");
      assert.deepEqual(await buckets(user), { a: SYNTHETIC_HOLDS[0] - SYNTHETIC_CHARGES[0], r: SYNTHETIC_BUNDLE_HOLD - SYNTHETIC_HOLDS[0], h: 0, c: SYNTHETIC_CHARGES[0] });
      const entries = (await client.query("SELECT entry_kind, delta_available::int a, delta_reserved::int r, delta_held::int h, delta_consumed::int c, delta_external::int e, evidence_kind, evidence_ref, cause_ref FROM vynvori_ledger.ledger_entries WHERE reservation_id = $1 AND entry_kind = 'settle'", [target.reservationId])).rows;
      assert.deepEqual(entries, [{ entry_kind: "settle", a: SYNTHETIC_HOLDS[0] - SYNTHETIC_CHARGES[0], r: -SYNTHETIC_HOLDS[0], h: 0, c: SYNTHETIC_CHARGES[0], e: 0, evidence_kind: "persisted_delivered", evidence_ref: "plane-b/manifest-1", cause_ref: `${target.reservationId}:settle` }]);
      const port = eligibilityPort();
      assert.deepEqual(await settle(user, target.reservationId, settleEvidence(target.operationId, "plane-b/manifest-1"), k), settled, "replay returns the same reservation");
      assert.equal(port.calls, 0);
      await assert.rejects(settle(user, target.reservationId, settleEvidence(target.operationId, "plane-b/manifest-2"), k), code("IDEMPOTENCY_CONFLICT"), "same key, different evidence");
      await assert.rejects(settle(user, target.reservationId, settleEvidence(target.operationId, "plane-b/manifest-2")), rejection("INVALID_TRANSITION"), "a second settle under a new key");
      assert.deepEqual(await buckets(user), { a: SYNTHETIC_HOLDS[0] - SYNTHETIC_CHARGES[0], r: SYNTHETIC_BUNDLE_HOLD - SYNTHETIC_HOLDS[0], h: 0, c: SYNTHETIC_CHARGES[0] }, "nothing moved twice");
      assert.equal((await client.query("SELECT count(*)::int n FROM vynvori_ledger.ledger_entries WHERE reservation_id = $1 AND entry_kind = 'settle'", [target.reservationId])).rows[0].n, 1);
    });

    await t.test("settle where the charge equals the hold returns nothing to available (delta_available = 0) and never exceeds the hold", async () => {
      const user = await syntheticProfileWithWallet(client);
      await fund(user, SYNTHETIC_BUNDLE_HOLD);
      // A final whose single allocation charges its whole hold: a synthetic edge case of the frozen vector, not a pricing rule.
      const { bundle } = await (async () => ({ bundle: await authorizeQuote(pool, { userId: user, quoteVersionId: await issueTestQuote(pool, user, "bundle", qid("edge")), idempotencyKey: key("authorize"), consent: consent(), now: new Date(), pricePolicy: currentPricePolicy, eligibility: eligibilityPort() }) }))();
      const target = bundle.reservations[1]!; // hold 3, charge 3
      assert.equal(target.holdUnits, target.chargeUnits);
      await recordWorkflowRef(pool, { userId: user, component: "workflow", reservationId: target.reservationId, workflowRef: "wf/edge", idempotencyKey: key("dispatch") });
      await settle(user, target.reservationId, settleEvidence(target.operationId));
      assert.deepEqual(await buckets(user), { a: 0, r: SYNTHETIC_BUNDLE_HOLD - target.holdUnits, h: 0, c: target.chargeUnits });
      assert.equal((await client.query("SELECT delta_available::int a FROM vynvori_ledger.ledger_entries WHERE reservation_id = $1 AND entry_kind = 'settle'", [target.reservationId])).rows[0].a, 0);
    });

    await t.test("settle refuses: evidence for a sibling's operation (EVIDENCE_INVALID, persisted), a never-dispatched reservation (INVALID_TRANSITION), another user (NOT_FOUND, nothing recorded)", async () => {
      const { user, r } = await withBundle({ dispatch: false });
      const [target, sibling] = [r[0]!, r[1]!];
      await assert.rejects(settle(user, target.reservationId, settleEvidence(target.operationId)), rejection("INVALID_TRANSITION"), "never dispatched: stays reserved for a human (S8)");
      await recordWorkflowRef(pool, { userId: user, component: "workflow", reservationId: target.reservationId, workflowRef: "wf/x", idempotencyKey: key("dispatch") });
      const wrong = key("wrong-op");
      await assert.rejects(settle(user, target.reservationId, settleEvidence(sibling.operationId), wrong), rejection("EVIDENCE_INVALID"));
      await assert.rejects(settle(user, target.reservationId, settleEvidence(sibling.operationId), wrong), rejection("EVIDENCE_INVALID"), "the persisted rejection replays");
      await assert.rejects(settle(user, target.reservationId, settleEvidence(target.operationId), wrong), code("IDEMPOTENCY_CONFLICT"), "the rejected key stays bound to its payload");
      const other = await syntheticProfileWithWallet(client);
      const before = await count("ledger_commands", other);
      await assert.rejects(settle(other, target.reservationId, settleEvidence(target.operationId)), code("NOT_FOUND"));
      await assert.rejects(hold(other, target.reservationId, holdEvidence(target.operationId)), code("NOT_FOUND"));
      assert.equal(await count("ledger_commands", other), before, "a foreign caller records nothing");
      assert.deepEqual(await buckets(user), { a: 0, r: SYNTHETIC_BUNDLE_HOLD, h: 0, c: 0 });
      assert.equal(await stateOf(target.reservationId), "reserved");
    });

    await t.test("hold: an unknown outcome (and an unconfirmed persistence) moves exactly this reservation's full hold to held_for_review; no debit, no release; replay-safe", async () => {
      const { user, r } = await withBundle();
      const k = key("hold-ok");
      const held = await hold(user, r[0]!.reservationId, holdEvidence(r[0]!.operationId, "outcome_unknown", "plane-b/timeout-after-billing"), k);
      assert.equal(held.state, "reconciliation_hold");
      assert.deepEqual(await buckets(user), { a: 0, r: SYNTHETIC_BUNDLE_HOLD - SYNTHETIC_HOLDS[0], h: SYNTHETIC_HOLDS[0], c: 0 }, "no customer debit is inferred");
      assert.deepEqual(await hold(user, r[0]!.reservationId, holdEvidence(r[0]!.operationId, "outcome_unknown", "plane-b/timeout-after-billing"), k), held, "replay");
      const persisted = await hold(user, r[1]!.reservationId, holdEvidence(r[1]!.operationId, "persistence_failed_under_review", "plane-b/db-write-failed"));
      assert.equal(persisted.state, "reconciliation_hold");
      assert.deepEqual(await buckets(user), { a: 0, r: SYNTHETIC_HOLDS[2], h: SYNTHETIC_HOLDS[0] + SYNTHETIC_HOLDS[1], c: 0 });
      assert.deepEqual((await client.query("SELECT evidence_kind, evidence_ref, delta_held::int h FROM vynvori_ledger.ledger_entries WHERE reservation_id = ANY($1::uuid[]) AND entry_kind = 'hold' ORDER BY delta_held DESC", [[r[0]!.reservationId, r[1]!.reservationId]])).rows,
        [{ evidence_kind: "outcome_unknown", evidence_ref: "plane-b/timeout-after-billing", h: SYNTHETIC_HOLDS[0] }, { evidence_kind: "persistence_failed_under_review", evidence_ref: "plane-b/db-write-failed", h: SYNTHETIC_HOLDS[1] }]);
      await assert.rejects(hold(user, r[2]!.reservationId, holdEvidence(r[0]!.operationId)), rejection("EVIDENCE_INVALID"), "evidence of a sibling's operation");
      assert.equal(await stateOf(r[2]!.reservationId), "reserved");
    });

    await t.test("one hold among three siblings leaves the others settleable and releasable; nothing is netted", async () => {
      const { user, r } = await withBundle();
      await hold(user, r[0]!.reservationId, holdEvidence(r[0]!.operationId));
      await settle(user, r[1]!.reservationId, settleEvidence(r[1]!.operationId));
      await release(user, r[2]!.reservationId, releaseEvidence(r[2]!.operationId));
      assert.deepEqual([await stateOf(r[0]!.reservationId), await stateOf(r[1]!.reservationId), await stateOf(r[2]!.reservationId)], ["reconciliation_hold", "settled", "released"]);
      assert.deepEqual(await buckets(user), { a: (SYNTHETIC_HOLDS[1] - SYNTHETIC_CHARGES[1]) + SYNTHETIC_HOLDS[2], r: 0, h: SYNTHETIC_HOLDS[0], c: SYNTHETIC_CHARGES[1] });
    });

    await t.test("illegal edges: settle->release, settle->hold, release->settle, release->hold, hold->release, hold->settle, hold->hold are INVALID_TRANSITION with balances unchanged; nothing leaves reconciliation_hold", async () => {
      const { user, r } = await withBundle();
      const [s, rel, h] = r as [typeof r[0], typeof r[0], typeof r[0]];
      await settle(user, s.reservationId, settleEvidence(s.operationId));
      await release(user, rel.reservationId, releaseEvidence(rel.operationId));
      await hold(user, h.reservationId, holdEvidence(h.operationId));
      const before = await buckets(user), entriesBefore = await count("ledger_entries", user);
      const attempts: [string, () => Promise<unknown>][] = [
        ["settle->release", () => release(user, s.reservationId, releaseEvidence(s.operationId))], ["settle->hold", () => hold(user, s.reservationId, holdEvidence(s.operationId))],
        ["release->settle", () => settle(user, rel.reservationId, settleEvidence(rel.operationId))], ["release->hold", () => hold(user, rel.reservationId, holdEvidence(rel.operationId))],
        ["hold->release", () => release(user, h.reservationId, releaseEvidence(h.operationId))], ["hold->settle", () => settle(user, h.reservationId, settleEvidence(h.operationId))],
        ["hold->hold", () => hold(user, h.reservationId, holdEvidence(h.operationId, "persistence_failed_under_review"))],
      ];
      for (const [label, attempt] of attempts) await assert.rejects(attempt(), rejection("INVALID_TRANSITION"), label);
      assert.deepEqual(await buckets(user), before); assert.equal(await count("ledger_entries", user), entriesBefore);
      assert.equal(await stateOf(h.reservationId), "reconciliation_hold", "the hold stays until a human resolves it (remedy milestone)");
    });

    await t.test("out of order: evidence for a reservation that does not exist (yet) is NOT_FOUND and records nothing, so the same key works once the reservation exists; evidence before the dispatch marker is INVALID_TRANSITION", async () => {
      const { user, r } = await withBundle({ dispatch: false });
      const k = key("early"), commands = await count("ledger_commands", user);
      await assert.rejects(settle(user, randomUUID(), settleEvidence(r[0]!.operationId), k), code("NOT_FOUND"));
      await assert.rejects(hold(user, randomUUID(), holdEvidence(r[0]!.operationId), key("early-hold")), code("NOT_FOUND"));
      assert.equal(await count("ledger_commands", user), commands, "NOT_FOUND is never persisted under the key");
      await assert.rejects(hold(user, r[1]!.reservationId, holdEvidence(r[1]!.operationId)), rejection("INVALID_TRANSITION"), "before dispatch is recorded");
      await recordWorkflowRef(pool, { userId: user, component: "workflow", reservationId: r[0]!.reservationId, workflowRef: "wf/late", idempotencyKey: key("dispatch") });
      assert.equal((await settle(user, r[0]!.reservationId, settleEvidence(r[0]!.operationId), k)).state, "settled", "the key that met NOT_FOUND is still free");
    });

    /** Runs the real statements but lets a test inject a fault after one of them (as in ledger-reservations.test.ts). */
    const faulty = (after: (text: string) => Promise<void>): LedgerDb => ({
      acquire: async (): Promise<LedgerConn> => {
        const conn: PoolClient = await pool.connect(); conn.on("error", () => undefined);
        return { query: async (text, values) => { const result = await conn.query(text, values); await after(text); return result as never; }, release: destroy => conn.release(destroy) };
      },
    });
    await t.test("commit outcome lost after COMMIT: LEDGER_OUTCOME_UNKNOWN, then the replay converges on the one committed settle (and hold)", async () => {
      const { user, r } = await withBundle();
      const lost = faulty(async text => { if (text === "COMMIT") throw new Error("Connection terminated unexpectedly"); });
      const k = key("lost");
      await assert.rejects(settleReservation(lost, { userId: user, component: "workflow", reservationId: r[0]!.reservationId, evidence: settleEvidence(r[0]!.operationId), idempotencyKey: k }), code("LEDGER_OUTCOME_UNKNOWN"));
      assert.equal(await stateOf(r[0]!.reservationId), "settled", "the commit had in fact happened");
      assert.equal((await settle(user, r[0]!.reservationId, settleEvidence(r[0]!.operationId), k)).state, "settled");
      const kh = key("lost-hold");
      await assert.rejects(holdReservation(lost, { userId: user, component: "workflow", reservationId: r[1]!.reservationId, evidence: holdEvidence(r[1]!.operationId), idempotencyKey: kh }), code("LEDGER_OUTCOME_UNKNOWN"));
      assert.equal((await hold(user, r[1]!.reservationId, holdEvidence(r[1]!.operationId), kh)).state, "reconciliation_hold");
      assert.deepEqual(await buckets(user), { a: SYNTHETIC_HOLDS[0] - SYNTHETIC_CHARGES[0], r: SYNTHETIC_HOLDS[2], h: SYNTHETIC_HOLDS[1], c: SYNTHETIC_CHARGES[0] }, "each moved exactly once");
      const acquireOnly: LedgerDb = { acquire: async () => { const conn = await pool.connect(); return { query: (text, values) => conn.query(text, values) as never, release: destroy => conn.release(destroy) }; } };
      assert.equal((await releaseReservation(acquireOnly, { userId: user, component: "workflow", reservationId: r[2]!.reservationId, evidence: releaseEvidence(r[2]!.operationId), idempotencyKey: key("acq") })).state, "released");
      assert.equal((await settleReservation(acquireOnly, { userId: user, component: "workflow", reservationId: r[0]!.reservationId, evidence: settleEvidence(r[0]!.operationId), idempotencyKey: k })).state, "settled", "an acquire-only LedgerDb gets the result back");
    });

    // ---- vendor-cost isolation ---------------------------------------------------------------------------------------------
    /** Full content fingerprint of every ledger table a vendor charge must never touch. */
    const ledgerFingerprint = async () => (await client.query(`SELECT
      (SELECT md5(coalesce(string_agg(w::text, ',' ORDER BY w.user_id), '')) FROM vynvori_ledger.wallets w) AS wallets,
      (SELECT md5(coalesce(string_agg(e::text, ',' ORDER BY e.entry_id), '')) FROM vynvori_ledger.ledger_entries e) AS entries,
      (SELECT md5(coalesce(string_agg(r::text, ',' ORDER BY r.reservation_id), '')) FROM vynvori_ledger.credit_reservations r) AS reservations,
      (SELECT md5(coalesce(string_agg(c::text, ',' ORDER BY c.command_id), '')) FROM vynvori_ledger.ledger_commands c) AS commands,
      (SELECT md5(coalesce(string_agg(a::text, ',' ORDER BY a.authorization_id), '')) FROM vynvori_ledger.ledger_authorizations a) AS authorizations`)).rows[0];

    await t.test("vendor-cost isolation: usage, invoice and unknown evidence for reserved, held and settled operations change ZERO rows in wallets, ledger_entries, credit_reservations, ledger_commands and authorizations", async () => {
      const { user, r } = await withBundle();
      await hold(user, r[1]!.reservationId, holdEvidence(r[1]!.operationId));
      await settle(user, r[2]!.reservationId, settleEvidence(r[2]!.operationId));
      const before = await ledgerFingerprint(), walletBefore = await buckets(user);
      const written = [];
      for (const [i, target] of r.entries()) {
        written.push(await recordVendorCostEvidence(pool, { component: "reconciler", operationId: target.operationId, reservationId: target.reservationId, evidenceKind: "usage", evidenceRef: `usage-${i}`, amountUsdMicros: SYNTHETIC_MICROS }));
        written.push(await recordVendorCostEvidence(pool, { component: "reconciler", operationId: target.operationId, evidenceKind: "invoice", evidenceRef: `inv-${i}`, amountUsdMicros: SYNTHETIC_MICROS * 1000 }));
        written.push(await recordVendorCostEvidence(pool, { component: "reconciler", operationId: target.operationId, evidenceKind: "unknown", evidenceRef: `unk-${i}`, amountUsdMicros: null }));
      }
      // A vendor record may even name an operation the ledger has never seen, or a reservation id that does not exist: it is a hint only.
      written.push(await recordVendorCostEvidence(pool, { component: "reconciler", operationId: "op_unseen", reservationId: randomUUID(), evidenceKind: "invoice", evidenceRef: "inv-unseen", amountUsdMicros: 0 }));
      assert.ok(written.every(w => !w.replayed));
      assert.deepEqual(await ledgerFingerprint(), before, "not one ledger row changed");
      assert.deepEqual(await buckets(user), walletBefore);
      assert.deepEqual([await stateOf(r[0]!.reservationId), await stateOf(r[1]!.reservationId), await stateOf(r[2]!.reservationId)], ["reserved", "reconciliation_hold", "settled"], "an invoice never settles, releases or resolves a hold");
      await assert.rejects(settle(user, r[1]!.reservationId, settleEvidence(r[1]!.operationId)), rejection("INVALID_TRANSITION"), "a billed held operation still cannot be settled");
      assert.equal((await client.query("SELECT count(*)::int n FROM vynvori_ledger.vendor_cost_evidence WHERE operation_id = ANY($1::text[])", [r.map(x => x.operationId)])).rows[0].n, 9);
    });

    await t.test("vendor-cost evidence is idempotent on its natural key, conflicts on a changed amount or hint, and is append-only even for the superuser", async () => {
      const operationId = "op_" + randomUUID();
      const input: RecordVendorCostEvidenceInput = { component: "reconciler", operationId, evidenceKind: "invoice", evidenceRef: "inv-a", amountUsdMicros: SYNTHETIC_MICROS };
      const first = await recordVendorCostEvidence(pool, input);
      assert.deepEqual({ ...first, evidenceId: "x" }, { evidenceId: "x", operationId, reservationId: null, evidenceKind: "invoice", evidenceRef: "inv-a", amountUsdMicros: SYNTHETIC_MICROS, recordedBy: "reconciler", replayed: false });
      assert.deepEqual(await recordVendorCostEvidence(pool, input), { ...first, replayed: true });
      assert.deepEqual(await recordVendorCostEvidence(pool, { ...input, component: "another-worker" }), { ...first, replayed: true }, "provenance is not content");
      await assert.rejects(recordVendorCostEvidence(pool, { ...input, amountUsdMicros: SYNTHETIC_MICROS + 1 }), code("IDEMPOTENCY_CONFLICT"));
      await assert.rejects(recordVendorCostEvidence(pool, { ...input, amountUsdMicros: null }), code("IDEMPOTENCY_CONFLICT"));
      await assert.rejects(recordVendorCostEvidence(pool, { ...input, reservationId: randomUUID() }), code("IDEMPOTENCY_CONFLICT"));
      const concurrent = await Promise.all(Array.from({ length: 5 }, () => recordVendorCostEvidence(pool, { ...input, evidenceRef: "inv-race" })));
      assert.equal(new Set(concurrent.map(c => c.evidenceId)).size, 1); assert.equal(concurrent.filter(c => !c.replayed).length, 1);
      await recordVendorCostEvidence(pool, { ...input, evidenceKind: "usage" });
      assert.equal((await client.query("SELECT count(*)::int n FROM vynvori_ledger.vendor_cost_evidence WHERE operation_id = $1", [operationId])).rows[0].n, 3);
      for (const sql of ["UPDATE vynvori_ledger.vendor_cost_evidence SET amount_usd_micros = 0", "DELETE FROM vynvori_ledger.vendor_cost_evidence"])
        await assert.rejects(client.query(sql), sqlstate("23000", /append-only/), sql);
      await assert.rejects(client.query("TRUNCATE vynvori_ledger.vendor_cost_evidence"), sqlstate("23000", /append-only/));
      const raw = (over: Record<string, unknown>) => client.query("INSERT INTO vynvori_ledger.vendor_cost_evidence(evidence_id,operation_id,reservation_id,evidence_kind,evidence_ref,amount_usd_micros,recorded_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [randomUUID(), over.op ?? "op_raw", over.res ?? null, over.kind ?? "invoice", over.ref ?? randomUUID(), over.amount === undefined ? 1 : over.amount, over.by ?? "reconciler"]);
      for (const [label, over] of [["unknown with an amount", { kind: "unknown", amount: 1 }], ["negative amount", { amount: -1 }], ["over the safe-integer bound", { amount: "9007199254740992" }], ["kind none", { kind: "none" }],
        ["kind charge", { kind: "charge" }], ["empty ref", { ref: "" }], ["operation id shape", { op: "bad op" }], ["component shape", { by: "Bad" }]] as const)
        await assert.rejects(raw(over), sqlstate("23514"), label);
    });

    await t.test("catalog: vendor_cost_evidence has no FK and is referenced by none; its triggers only reject mutation; no ledger function reads it", async () => {
      assert.equal((await client.query("SELECT count(*)::int n FROM pg_constraint WHERE contype = 'f' AND (conrelid = 'vynvori_ledger.vendor_cost_evidence'::regclass OR confrelid = 'vynvori_ledger.vendor_cost_evidence'::regclass)")).rows[0].n, 0);
      assert.deepEqual((await client.query("SELECT t.tgname, p.proname FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid WHERE t.tgrelid = 'vynvori_ledger.vendor_cost_evidence'::regclass AND NOT t.tgisinternal ORDER BY 1")).rows,
        [{ tgname: "vendor_cost_evidence_immutable", proname: "reject_mutation" }, { tgname: "vendor_cost_evidence_no_truncate", proname: "reject_mutation" }]);
      assert.deepEqual((await client.query("SELECT p.proname FROM pg_proc p WHERE p.pronamespace = 'vynvori_ledger'::regnamespace AND p.prosrc ~ 'vendor_cost'")).rows, [], "no ledger function mentions vendor cost");
      assert.equal((await client.query("SELECT count(*)::int n FROM pg_depend d WHERE d.refobjid = 'vynvori_ledger.vendor_cost_evidence'::regclass AND d.classid = 'pg_rewrite'::regclass")).rows[0].n, 0, "no view or rule reads it");
    });

    // ---- the 0006 backstop, exercised with raw SQL as the fixture superuser (each probe inside a rolled-back transaction) ----
    const rawCommand = async (user: string, kind: string) => {
      const id = randomUUID();
      await client.query("INSERT INTO vynvori_ledger.ledger_commands(command_id,scope,idempotency_key,request_sha256,user_id,command_kind,outcome) VALUES($1,$2,$3,repeat('a',64),$4,$5,'applied')", [id, `${user}:${kind}`, key("raw"), user, kind]);
      return id;
    };
    type Raw = { user: string; command: string; kind: "settle" | "hold" | "release"; reservation: string; da: number; dr: number; dh: number; dc: number; evidenceKind: string; evidenceRef?: string };
    const rawEntry = (e: Raw) => client.query(
      `INSERT INTO vynvori_ledger.ledger_entries(entry_id,user_id,command_id,entry_kind,delta_available,delta_reserved,delta_held,delta_consumed,delta_external,reservation_id,evidence_kind,evidence_ref,cause_kind,cause_ref)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,0,$9,$10,$11,'reservation',$9::uuid::text || ':' || $4)`,
      [randomUUID(), e.user, e.command, e.kind, e.da, e.dr, e.dh, e.dc, e.reservation, e.evidenceKind, e.evidenceRef ?? "raw-ref"]);
    const inRolledBack = async (work: () => Promise<void>) => { await client.query("BEGIN"); try { await work(); } finally { await client.query("ROLLBACK"); } };
    const probe = async (label: string, work: () => Promise<unknown>, pattern: RegExp, states = ["23000"]) => inRolledBack(async () => {
      await assert.rejects(work(), (e: unknown) => states.includes((e as { code?: string }).code ?? "") && pattern.test((e as Error).message), label);
    });

    await t.test("entry binding for settle and hold: wrong units, above the hold, wrong evidence, wrong or earlier command, another user, undispatched, double terminal and anything out of a hold are refused at the database", async () => {
      const alice = await withBundle(), bob = await withBundle();
      const target = alice.r[0]!, h = target.holdUnits, c = target.chargeUnits;
      const settleRaw = (command: string, over: Partial<Raw> = {}) => rawEntry({ user: alice.user, command, kind: "settle", reservation: target.reservationId, da: h - c, dr: -h, dh: 0, dc: c, evidenceKind: "persisted_delivered", ...over });
      const holdRaw = (command: string, over: Partial<Raw> = {}) => rawEntry({ user: alice.user, command, kind: "hold", reservation: target.reservationId, da: 0, dr: -h, dh: h, dc: 0, evidenceKind: "outcome_unknown", ...over });
      const cmd = (kind: string) => rawCommand(alice.user, kind);
      await probe("control: the raw settle passes inside the probe", async () => { await settleRaw(await cmd("reservation_settle")); throw Object.assign(new Error("control-ok"), { code: "23000" }); }, /control-ok/);
      await probe("settle consuming one more than the charge", async () => settleRaw(await cmd("reservation_settle"), { da: h - c - 1, dc: c + 1 }), /settle entry does not match/);
      await probe("settle consuming one less than the charge", async () => settleRaw(await cmd("reservation_settle"), { da: h - c + 1, dc: c - 1 }), /settle entry does not match/);
      await probe("settle above the hold", async () => settleRaw(await cmd("reservation_settle"), { da: -1, dr: -h, dc: h + 1 }), /settle entry does not match|ledger_entries_sign_shape/, ["23000", "23514"]);
      await probe("settle releasing twice the hold", async () => settleRaw(await cmd("reservation_settle"), { da: 2 * h - c, dr: -2 * h }), /settle entry does not match/);
      await probe("settle with a vendor-charge evidence kind", async () => settleRaw(await cmd("reservation_settle"), { evidenceKind: "vendor_charge" }), /settle entry does not match/);
      await probe("settle with unknown-outcome evidence", async () => settleRaw(await cmd("reservation_settle"), { evidenceKind: "outcome_unknown" }), /settle entry does not match/);
      await probe("settle with an over-long evidence reference", async () => settleRaw(await cmd("reservation_settle"), { evidenceRef: "r".repeat(513) }), /settle entry does not match/);
      await probe("settle under a release command", async () => settleRaw(await cmd("reservation_release")), /matching kind/);
      await probe("settle under a hold command", async () => settleRaw(await cmd("reservation_hold")), /matching kind/);
      await probe("hold under a settle command", async () => holdRaw(await cmd("reservation_settle")), /matching kind/);
      const oldSettle = await cmd("reservation_settle"); // autocommitted: written by an earlier transaction
      await probe("settle under a command written by an earlier transaction", () => settleRaw(oldSettle), /same transaction/);
      await probe("settle by another user", async () => settleRaw(await rawCommand(bob.user, "reservation_settle"), { user: bob.user }), /not found for this user/);
      await probe("hold of other units", async () => holdRaw(await cmd("reservation_hold"), { dr: -(h - 1), dh: h - 1 }), /hold entry does not match/);
      await probe("hold with settle evidence", async () => holdRaw(await cmd("reservation_hold"), { evidenceKind: "persisted_delivered" }), /hold entry does not match/);
      await probe("hold with a timeout as evidence", async () => holdRaw(await cmd("reservation_hold"), { evidenceKind: "timeout" }), /hold entry does not match/);
      const undispatched = await withBundle({ dispatch: false });
      const u = undispatched.r[0]!;
      await probe("settle of a never-dispatched reservation", async () => rawEntry({ user: undispatched.user, command: await rawCommand(undispatched.user, "reservation_settle"), kind: "settle", reservation: u.reservationId, da: u.holdUnits - u.chargeUnits, dr: -u.holdUnits, dh: 0, dc: u.chargeUnits, evidenceKind: "persisted_delivered" }), /settle entry does not match/);
      await probe("hold of a never-dispatched reservation", async () => rawEntry({ user: undispatched.user, command: await rawCommand(undispatched.user, "reservation_hold"), kind: "hold", reservation: u.reservationId, da: 0, dr: -u.holdUnits, dh: u.holdUnits, dc: 0, evidenceKind: "outcome_unknown" }), /hold entry does not match/);
      await hold(alice.user, target.reservationId, holdEvidence(target.operationId));
      await probe("settle out of a hold", async () => settleRaw(await cmd("reservation_settle")), /settle entry does not match/);
      await probe("release out of a hold", async () => rawEntry({ user: alice.user, command: await cmd("reservation_release"), kind: "release", reservation: target.reservationId, da: h, dr: -h, dh: 0, dc: 0, evidenceKind: "verified_zero_charge_failure" }), /release entry does not match/);
      await probe("a second hold", async () => holdRaw(await cmd("reservation_hold")), /hold entry does not match/);
      await probe("direct state change out of a hold (depth 1)", () => client.query("UPDATE vynvori_ledger.credit_reservations SET state = 'released' WHERE reservation_id = $1", [target.reservationId]), /only through ledger entries/);
      await probe("direct state change into operator_remedy (depth 1)", () => client.query("UPDATE vynvori_ledger.credit_reservations SET state = 'operator_remedy' WHERE reservation_id = $1", [target.reservationId]), /only through ledger entries/);
      // Even the definer path itself has no edge out of the hold: with the binding trigger disabled (rolled back), the guard still refuses.
      await probe("the guard has no edge out of reconciliation_hold even for the definer path", async () => {
        await client.query("ALTER TABLE vynvori_ledger.ledger_entries DISABLE TRIGGER ledger_entries_bind_reservation");
        await rawEntry({ user: alice.user, command: await cmd("reservation_release"), kind: "release", reservation: target.reservationId, da: h, dr: -h, dh: 0, dc: 0, evidenceKind: "verified_zero_charge_failure" });
      }, /reservation transition did not apply|illegal reservation transition|one_terminal_per_reservation/, ["23000", "23505"]);
      assert.equal(await stateOf(target.reservationId), "reconciliation_hold");
      assert.deepEqual(await buckets(alice.user), { a: 0, r: SYNTHETIC_BUNDLE_HOLD - h, h, c: 0 });
    });
  } finally {
    await pool.end().catch(() => undefined);
    await client.end().catch(() => undefined);
    await dropLedger("settlement");
  }
});
