import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Client } from "pg";
import { canTransitionPlaneCBundle, type PlaneCBundleState } from "@vynvori/contracts";
import { LedgerBusinessRejection, LedgerError, getWalletSummary, type LedgerConn, type LedgerDb } from "../src/ledger-core";
import {
  beginBundleClosure, closeBundleWithForfeiture, consumeRefinementSlot, getBundleState, markRefinementPending, markRefinementUnknown, openRefinements,
  recordBundleDelivery, reopenBundleAfterUnchargedFinal, restoreRefinementSlot, skipRefinementSlot, type BundleRecord,
} from "../src/ledger-entitlements";
import { authorizeQuote, recordWorkflowRef, releaseReservation } from "../src/ledger-reservations";
import { dropLedger, freshLedger, grantSyntheticCredits, ledgerPool, ledgerTarget, registerSyntheticGrantSource, syntheticProfileWithWallet } from "./ledger-fixture";
import { SYNTHETIC_BUNDLE_HOLD, SYNTHETIC_FINAL_HOLD, consent, currentPricePolicy, eligibilityPort, issueTestQuote, releaseEvidence } from "./ledger-reservation-fixture";

/**
 * ADR-0021 S7 addendum: package transitions, the two refinement slots and closure, and the 0007 database backstop.
 * Non-concurrency file: pool capped at 5 (D15); declared peak connections = 5 (pool) + 1 (persistent fixture client) = 6.
 * Every unit value is SYNTHETIC. Nothing here is a price, a credit cost, a package size, a hold duration or an expiry.
 * Settlement belongs to S6: where a test needs a SETTLED final it forces that state as the fixture superuser (trigger disabled
 * inside the test only), which is a fixture shortcut and says nothing about S6.
 */
const code = (c: string) => (e: unknown) => e instanceof LedgerError && e.code === c;
const rejection = (c: string) => (e: unknown) => e instanceof LedgerBusinessRejection && e.code === c;
const sqlstate = (c: string, pattern?: RegExp) => (e: unknown) => (e as { code?: string }).code === c && (!pattern || pattern.test((e as Error).message));
let keyCounter = 0;
const key = (label: string) => `${label}-${String(++keyCounter).padStart(6, "0")}-${randomUUID().slice(0, 8)}`;
const qid = (label: string) => `${label}-${randomUUID()}`;
const NOTICE = "rcn-1";
const STATES: readonly PlaneCBundleState[] = ["quoted", "authorized", "partial", "delivered_3_of_3", "open_for_refinements", "closure_pending", "closed", "remedy_pending"];
const terms = (notice: string | null) => ({ customerConsentTermsVersion: "cc-1", expiryTermsVersion: "ex-1", partialRemedyTermsVersion: "pr-1", rightsNoticeVersion: "rn-1", qualityRemedyTermsVersion: "qr-1", refinementClosureNoticeVersion: notice });

test("every S7 function rejects malformed input before any SQL", async () => {
  const db = { acquire: async () => { throw new Error("no SQL may run"); } } as unknown as LedgerDb;
  const ids = { userId: randomUUID(), packageId: randomUUID(), idempotencyKey: "valid-key-0123456789" };
  const slot = { ...ids, ordinal: 1 as const };
  const sys = { ...ids, component: "studio" };
  const slotBad = [{ userId: "x" }, { userId: randomUUID().toUpperCase() }, { packageId: "x" }, { ordinal: 3 }, { ordinal: 0 }, { ordinal: "1" }, { idempotencyKey: "short" }] as Record<string, unknown>[];
  for (const bad of slotBad) {
    await assert.rejects(skipRefinementSlot(db, { ...slot, ...bad } as never), code("INVALID_INPUT"), JSON.stringify(bad));
    await assert.rejects(restoreRefinementSlot(db, { ...slot, ...bad } as never), code("INVALID_INPUT"), JSON.stringify(bad));
  }
  const pending = { ...slot, component: "studio", sourceVersionId: "src-1", operationId: "op-1" };
  for (const bad of [...slotBad, { component: "Bad Component" }, { sourceVersionId: "bad id" }, { operationId: "" }, { operationId: "x".repeat(129) }] as Record<string, unknown>[])
    await assert.rejects(markRefinementPending(db, { ...pending, ...bad } as never), code("INVALID_INPUT"), JSON.stringify(bad));
  const outcome = { ...slot, component: "studio", operationId: "op-1", evidenceRef: "ev-1" };
  for (const bad of [{ evidenceRef: "" }, { evidenceRef: "r".repeat(513) }, { evidenceRef: 5 }, { evidenceRef: undefined }, { evidenceRef: "a\nb" }, { evidenceRef: "a\u0000b" }, { evidenceRef: "tab\there" }, { evidenceRef: "caf\u00e9" }] as Record<string, unknown>[]) {
    await assert.rejects(markRefinementUnknown(db, { ...outcome, ...bad } as never), code("EVIDENCE_INVALID"), JSON.stringify(bad));
    await assert.rejects(consumeRefinementSlot(db, { ...outcome, deliveredVersionId: "v-1", ...bad } as never), code("EVIDENCE_INVALID"), JSON.stringify(bad));
  }
  for (const bad of [{ operationId: "bad id" }, { ordinal: 5 }]) await assert.rejects(markRefinementUnknown(db, { ...outcome, ...bad } as never), code("INVALID_INPUT"), JSON.stringify(bad));
  for (const bad of [{ deliveredVersionId: "bad id" }, { deliveredVersionId: undefined }]) await assert.rejects(consumeRefinementSlot(db, { ...outcome, ...bad } as never), code("INVALID_INPUT"), JSON.stringify(bad));
  for (const bad of [{ userId: "x" }, { component: "" }, { packageId: "x" }, { idempotencyKey: "short" }] as Record<string, unknown>[]) {
    await assert.rejects(openRefinements(db, { ...sys, ...bad }), code("INVALID_INPUT"), JSON.stringify(bad));
    await assert.rejects(recordBundleDelivery(db, { ...sys, artifactCount: 3, evidenceRef: "e", ...bad }), code("INVALID_INPUT"), JSON.stringify(bad));
  }
  for (const artifactCount of [-1, 4, 1.5, Number.NaN, "3", null]) await assert.rejects(recordBundleDelivery(db, { ...sys, artifactCount, evidenceRef: "e" } as never), code("INVALID_INPUT"), String(artifactCount));
  for (const evidenceRef of ["", "r".repeat(513), undefined, "a\r\nb", "a\u0000b", "bell\u0007"]) await assert.rejects(recordBundleDelivery(db, { ...sys, artifactCount: 3, evidenceRef } as never), code("EVIDENCE_INVALID"));
  for (const trigger of [undefined, null, {}, { kind: "approved_expiry" }, { kind: "final_authorized" }, { kind: "final_authorized", finalReservationId: "x" }])
    await assert.rejects(beginBundleClosure(db, { ...sys, trigger } as never), code("INVALID_INPUT"), JSON.stringify(trigger));
  for (const cause of [undefined, null, {}, { kind: "approved_expiry" }, { kind: "final_delivered" }, { kind: "final_delivered", finalReservationId: "x" }])
    await assert.rejects(closeBundleWithForfeiture(db, { ...sys, cause, refinementClosureNoticeVersion: NOTICE } as never), code("INVALID_INPUT"), JSON.stringify(cause));
  for (const notice of ["", null, undefined, 5, "n".repeat(257), "a\nb", "a\u0000b", "caf\u00e9"]) await assert.rejects(closeBundleWithForfeiture(db, { ...sys, cause: { kind: "explicit_close" }, refinementClosureNoticeVersion: notice } as never), code("INVALID_INPUT"), String(notice));
  await assert.rejects(reopenBundleAfterUnchargedFinal(db, { ...sys, finalReservationId: "x" }), code("INVALID_INPUT"));
  await assert.rejects(getBundleState(db as never, "x", randomUUID()), code("INVALID_INPUT"));
  // a driver failure while reading never surfaces: it is a TRANSIENT LedgerError
  await assert.rejects(getBundleState({ query: async () => { throw Object.assign(new Error("boom: relation vynvori_ledger.x"), { code: "42P01" }); } } as never, randomUUID(), randomUUID()), (e: unknown) => (e as { code?: string }).code === "TRANSIENT" && !/boom|42P01/.test((e as Error).message));
});

test("static: no clock, no expiry cause and no numeric business constant in the S7 module or migration", () => {
  const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map(line => line.replace(/(^|\s)--.*$/, "").replace(/(^|[^:])\/\/.*$/, "$1")).join("\n");
  const lib = strip(readFileSync(new URL("../src/ledger-entitlements.ts", import.meta.url), "utf8"));
  assert.doesNotMatch(lib, /Date\.now|new Date|setTimeout|setInterval|performance\.now|expir|\.now\(/i, "no clock in the module");
  assert.doesNotMatch(lib, /\bprice\b|\brate\b/i);
  const sql = strip(readFileSync(new URL("../ledger-migrations/0007_refinement_slots.sql", import.meta.url), "utf8"));
  assert.doesNotMatch(sql, /approved_expiry|clock_timestamp|statement_timestamp|transaction_timestamp|interval\s+'/i, "no expiry cause and no clock arithmetic");
  assert.deepEqual([...sql.matchAll(/\bnow\(\)/gi)].length, 3, "only the three created_at defaults read a clock");
  assert.doesNotMatch(sql, /\bGRANT\b|CREATE ROLE|ALTER ROLE|OWNER TO/i);
});

test("package edge set: the database function equals root's guard for all 64 pairs, except the declared differences", { skip: ledgerTarget.skip }, async () => {
  assert.ok(ledgerTarget.url, "CI_REQUIRE_PG_TESTS=1 requires M7_TEST_POSTGRES_URL or M2_CREATIVE_DATABASE_URL");
  const client: Client = await freshLedger("entitlements");
  try {
    const differences: string[] = [];
    for (const from of STATES) for (const to of STATES) {
      const db = (await client.query("SELECT vynvori_ledger.ledger_package_edge_allowed($1, $2) AS ok", [from, to])).rows[0].ok as boolean;
      if (db !== canTransitionPlaneCBundle(from, to)) differences.push(`${from}>${to}:${db ? "db-only" : "root-only"}`);
    }
    // db-only: the C-02 reopen (root allows it only with a reopen context, the 0007 binding trigger demands that context).
    // root-only: edges whose execution is deferred (quoted>authorized is S5's own insert path; remedy edges belong to a later milestone).
    assert.deepEqual(differences.sort(), ["closure_pending>open_for_refinements:db-only", "closure_pending>remedy_pending:root-only", "quoted>authorized:root-only", "remedy_pending>closed:root-only"].sort());
    const slotEdges = (await client.query("SELECT a, b FROM unnest($1::text[]) a CROSS JOIN unnest($1::text[]) b WHERE vynvori_ledger.refinement_slot_edge_allowed(a, b) ORDER BY a, b", [["available", "skipped", "pending", "unknown", "used", "forfeited"]])).rows.map(r => `${r.a}>${r.b}`);
    assert.deepEqual(slotEdges, ["available>forfeited", "available>pending", "available>skipped", "pending>unknown", "pending>used", "skipped>available", "skipped>forfeited", "unknown>used"]);
  } finally { await client.end().catch(() => undefined); await dropLedger("entitlements"); }
});

test("ledger entitlements: package transitions, refinement slots and closure in disposable PostgreSQL", { skip: ledgerTarget.skip }, async t => {
  assert.ok(ledgerTarget.url, "CI_REQUIRE_PG_TESTS=1 requires M7_TEST_POSTGRES_URL or M2_CREATIVE_DATABASE_URL");
  const client: Client = await freshLedger("entitlements");
  const { pool, max } = await ledgerPool("entitlements", "standard");
  assert.ok(max <= 5, "D15: non-concurrency files cap their pool at 5");
  try {
    const source = await registerSyntheticGrantSource(client);
    let funds = 0;
    const fund = (userId: string, units: number) => grantSyntheticCredits(pool, { userId, grantSourceId: source, sourceRef: `funds-${++funds}`, units });
    const buckets = async (userId: string) => { const w = await getWalletSummary(client, userId); return { a: w.availableUnits, r: w.reservedUnits, h: w.heldForReviewUnits }; };
    const entryCount = async (userId: string) => (await client.query("SELECT count(*)::int n FROM vynvori_ledger.ledger_entries WHERE user_id = $1", [userId])).rows[0].n as number;
    const count = async (table: string, userId: string) => (await client.query(`SELECT count(*)::int n FROM vynvori_ledger.${table} WHERE user_id = $1`, [userId])).rows[0].n as number;

    type B = { user: string; packageId: string; reservations: readonly { reservationId: string; operationId: string }[]; authorizationId: string };
    /** A user holding one authorized bundle whose disclosing quote carries `notice` (null = the quote discloses no closure notice). */
    const withBundle = async (notice: string | null = NOTICE): Promise<B> => {
      const user = await syntheticProfileWithWallet(client);
      await fund(user, SYNTHETIC_BUNDLE_HOLD + 3 * SYNTHETIC_FINAL_HOLD);
      const quoteVersionId = await issueTestQuote(pool, user, "bundle", qid("ent"), { paidTerms: terms(notice) });
      const a = await authorizeQuote(pool, { userId: user, quoteVersionId, idempotencyKey: key("authorize"), consent: consent(), now: new Date(), pricePolicy: currentPricePolicy, eligibility: eligibilityPort() });
      return { user, packageId: a.packageId!, reservations: a.reservations, authorizationId: a.authorizationId };
    };
    const sys = (b: B, extra: Record<string, unknown> = {}) => ({ userId: b.user, component: "studio", packageId: b.packageId, idempotencyKey: key("s"), ...extra });
    const cust = (b: B, ordinal: 1 | 2, extra: Record<string, unknown> = {}) => ({ userId: b.user, packageId: b.packageId, ordinal, idempotencyKey: key("c"), ...extra });
    const delivered = async (b: B) => recordBundleDelivery(pool, sys(b, { artifactCount: 3, evidenceRef: "plane-b/delivery-1" }) as never);
    const opened = async (notice: string | null = NOTICE) => { const b = await withBundle(notice); await delivered(b); await openRefinements(pool, sys(b) as never); return b; };
    const pend = (b: B, ordinal: 1 | 2, operationId: string, sourceVersionId = "src-v1") => markRefinementPending(pool, sys(b, { ordinal, sourceVersionId, operationId }) as never);
    const consume = (b: B, ordinal: 1 | 2, operationId: string, deliveredVersionId: string) => consumeRefinementSlot(pool, sys(b, { ordinal, operationId, deliveredVersionId, evidenceRef: "studio/ev-1" }) as never);
    const closeExplicit = (b: B, notice = NOTICE) => closeBundleWithForfeiture(pool, sys(b, { cause: { kind: "explicit_close" }, refinementClosureNoticeVersion: notice }) as never);
    const beginExplicit = (b: B) => beginBundleClosure(pool, sys(b, { trigger: { kind: "explicit_close_request" } }) as never);
    /** Authorizes a first final of the package (reserves its hold) with its own quote, carrying `notice`. */
    const authorizeFinal = async (b: B, notice: string | null = NOTICE) => {
      const quoteVersionId = await issueTestQuote(pool, b.user, "final", qid("final"), { paidTerms: terms(notice) });
      const a = await authorizeQuote(pool, { userId: b.user, quoteVersionId, idempotencyKey: key("final"), consent: consent(), now: new Date(), pricePolicy: currentPricePolicy, eligibility: eligibilityPort(), originalPackageId: b.packageId });
      return a.reservations[0]!;
    };
    const releaseFinal = async (b: B, r: { reservationId: string; operationId: string }) => {
      await recordWorkflowRef(pool, { userId: b.user, component: "workflow", reservationId: r.reservationId, workflowRef: "wf/" + randomUUID(), idempotencyKey: key("dispatch") });
      await releaseReservation(pool, { userId: b.user, component: "workflow", reservationId: r.reservationId, evidence: releaseEvidence(r.operationId), idempotencyKey: key("release") });
    };
    /** Fixture-only shortcut for S6's settlement (the update guard is disabled inside this call alone). */
    const forceSettled = async (reservationId: string) => {
      await client.query("ALTER TABLE vynvori_ledger.credit_reservations DISABLE TRIGGER credit_reservations_update_guard");
      try { await client.query("UPDATE vynvori_ledger.credit_reservations SET state = 'settled' WHERE reservation_id = $1", [reservationId]); }
      finally { await client.query("ALTER TABLE vynvori_ledger.credit_reservations ENABLE TRIGGER credit_reservations_update_guard"); }
    };
    const states = (r: BundleRecord) => r.slots.map(s => s.view.state);

    await t.test("lifecycle: delivery (3 of 3), open, skip/restore, pending, unknown, consume, close; wallet and ledger entries never move", async () => {
      const b = await withBundle();
      const before = { buckets: await buckets(b.user), entries: await entryCount(b.user) };
      assert.deepEqual(await getBundleState(pool, b.user, b.packageId).then(r => [r.state, r.customerState, r.slots.length]), ["authorized", "authorized", 0], "no slot before the package opens");
      await assert.rejects(skipRefinementSlot(pool, cust(b, 1) as never), rejection("INVALID_TRANSITION"), "no slot yet");
      const d = await delivered(b); assert.equal(d.state, "delivered_3_of_3"); assert.equal(d.slots.length, 0);
      const o = await openRefinements(pool, sys(b) as never);
      assert.deepEqual([o.state, o.customerState], ["open_for_refinements", "refinements_open"], "internal name stored, customer vocabulary projected");
      assert.deepEqual(o.slots.map(s => [s.view.ordinal, s.view.state, s.view.packageId]), [[1, "available", b.packageId], [2, "available", b.packageId]]);
      assert.equal(states(await skipRefinementSlot(pool, cust(b, 1) as never))[0], "skipped");
      assert.equal(states(await restoreRefinementSlot(pool, cust(b, 1) as never))[0], "available");
      const p = await pend(b, 1, "op-1"); assert.equal(states(p)[0], "pending");
      await assert.rejects(skipRefinementSlot(pool, cust(b, 1) as never), rejection("INVALID_TRANSITION"), "pending is locked");
      await assert.rejects(restoreRefinementSlot(pool, cust(b, 1) as never), rejection("INVALID_TRANSITION"));
      const u = await markRefinementUnknown(pool, sys(b, { ordinal: 1, operationId: "op-1", evidenceRef: "studio/unknown-1" }) as never); assert.equal(states(u)[0], "unknown");
      await assert.rejects(skipRefinementSlot(pool, cust(b, 1) as never), rejection("INVALID_TRANSITION"), "unknown is locked");
      const used = await consume(b, 1, "op-1", "v-out-1");
      assert.deepEqual(used.slots[0]!.view, { state: "used", ordinal: 1, packageId: b.packageId, sourceVersionId: "src-v1", deliveredVersionId: "v-out-1", operationId: "op-1" });
      await assert.rejects(consume(b, 1, "op-1", "v-out-2"), rejection("INVALID_TRANSITION"), "a used slot is never consumed twice");
      assert.equal((await beginExplicit(b)).state, "closure_pending");
      const closed = await closeExplicit(b);
      assert.deepEqual([closed.state, closed.customerState], ["closed", "closed"]);
      assert.deepEqual(closed.slots.map(s => s.view.state), ["used", "forfeited"]);
      assert.deepEqual(closed.slots[1]!.view, { state: "forfeited", ordinal: 2, packageId: b.packageId, closureCause: "explicit_close" });
      assert.deepEqual({ buckets: await buckets(b.user), entries: await entryCount(b.user) }, before, "refinements and package transitions never touch a bucket or write a ledger entry");
    });

    await t.test("delivery evidence: 0, 1 or 2 artifacts only ever reach partial; only exactly 3 completes; a bundle is opened once, from delivered_3_of_3 only", async () => {
      for (const n of [0, 1, 2]) {
        const b = await withBundle();
        assert.equal((await recordBundleDelivery(pool, sys(b, { artifactCount: n, evidenceRef: "e" }) as never)).state, "partial", `${n}/3`);
        await assert.rejects(openRefinements(pool, sys(b) as never), rejection("INVALID_TRANSITION"), "a partial bundle cannot open refinements");
        await assert.rejects(recordBundleDelivery(pool, sys(b, { artifactCount: n, evidenceRef: "e" }) as never), rejection("INVALID_TRANSITION"), "partial -> partial is not an edge");
        assert.equal((await recordBundleDelivery(pool, sys(b, { artifactCount: 3, evidenceRef: "e2" }) as never)).state, "delivered_3_of_3", "a later 3/3 completes it");
      }
      const b = await opened();
      await assert.rejects(openRefinements(pool, sys(b) as never), rejection("INVALID_TRANSITION"), "opened once");
      await assert.rejects(delivered(b), rejection("INVALID_TRANSITION"));
      assert.equal(await count("refinement_slots", b.user), 2, "slots are never recreated");
    });

    await t.test("closure_pending blocks restore, skip, pending and consume; nothing is forfeited or consumed silently; begin is refused while a refinement is pending or unknown", async () => {
      const b = await opened();
      await pend(b, 1, "op-a");
      await assert.rejects(beginExplicit(b), rejection("INVALID_TRANSITION"), "pending is locked");
      await markRefinementUnknown(pool, sys(b, { ordinal: 1, operationId: "op-a", evidenceRef: "ev" }) as never);
      await assert.rejects(beginExplicit(b), rejection("INVALID_TRANSITION"), "unknown is locked");
      await consume(b, 1, "op-a", "v-a");
      await skipRefinementSlot(pool, cust(b, 2) as never);
      assert.equal((await beginExplicit(b)).state, "closure_pending");
      await assert.rejects(restoreRefinementSlot(pool, cust(b, 2) as never), rejection("INVALID_TRANSITION"));
      await assert.rejects(skipRefinementSlot(pool, cust(b, 1) as never), rejection("INVALID_TRANSITION"));
      await assert.rejects(pend(b, 2, "op-b"), rejection("INVALID_TRANSITION"));
      await assert.rejects(consume(b, 2, "op-b", "v-b"), rejection("INVALID_TRANSITION"));
      assert.deepEqual(states(await getBundleState(pool, b.user, b.packageId)), ["used", "skipped"], "slots are held exactly as they were");
      // raw SQL: a slot cannot be forfeited silently under a pending closure either (needs the closing package event of the same command)
      await client.query("BEGIN");
      try {
        const command = randomUUID();
        await client.query("INSERT INTO vynvori_ledger.ledger_commands(command_id,scope,idempotency_key,request_sha256,user_id,command_kind,outcome) VALUES($1,$2,$3,repeat('a',64),$4,'bundle_close','applied')", [command, `${b.user}:bundle_close`, key("raw"), b.user]);
        const slot = (await client.query("SELECT slot_id FROM vynvori_ledger.refinement_slots WHERE package_id = $1 AND ordinal = 2", [b.packageId])).rows[0].slot_id as string;
        await client.query("INSERT INTO vynvori_ledger.refinement_slot_events(slot_event_id,user_id,slot_id,package_id,command_id,from_state,to_state,closure_cause,closure_notice_version) VALUES($1,$2,$3,$4,$5,'skipped','forfeited','explicit_close',$6)", [randomUUID(), b.user, slot, b.packageId, command, NOTICE]);
        await assert.rejects(client.query("SET CONSTRAINTS ALL IMMEDIATE"), sqlstate("23000"), "a lone forfeit cannot commit");
      } finally { await client.query("ROLLBACK"); }
      assert.deepEqual(states(await getBundleState(pool, b.user, b.packageId)), ["used", "skipped"]);
    });

    await t.test("closing: forfeits only available/skipped slots in the same transaction, under the disclosed notice; a used slot stays used; a closed package accepts no slot command", async () => {
      const b = await opened();
      await skipRefinementSlot(pool, cust(b, 2) as never);
      await beginExplicit(b);
      const k = key("close"), input = sys(b, { idempotencyKey: k, cause: { kind: "explicit_close" }, refinementClosureNoticeVersion: NOTICE }) as never;
      const closed = await closeBundleWithForfeiture(pool, input);
      assert.deepEqual(states(closed), ["forfeited", "forfeited"]);
      assert.deepEqual((await closeBundleWithForfeiture(pool, input)).slots.map(s => s.view.state), ["forfeited", "forfeited"], "replay");
      const rows = (await client.query("SELECT ordinal, closure_cause, closure_notice_version FROM vynvori_ledger.refinement_slots WHERE package_id = $1 ORDER BY ordinal", [b.packageId])).rows;
      assert.deepEqual(rows, [1, 2].map(ordinal => ({ ordinal, closure_cause: "explicit_close", closure_notice_version: NOTICE })));
      await assert.rejects(skipRefinementSlot(pool, cust(b, 1) as never), rejection("INVALID_TRANSITION"));
      await assert.rejects(restoreRefinementSlot(pool, cust(b, 2) as never), rejection("INVALID_TRANSITION"));
      await assert.rejects(pend(b, 1, "op-late"), rejection("INVALID_TRANSITION"));
      await assert.rejects(beginExplicit(b), rejection("INVALID_TRANSITION"));
      await assert.rejects(closeExplicit(b), rejection("INVALID_TRANSITION"), "closed is terminal here");
      await assert.rejects(reopenBundleAfterUnchargedFinal(pool, sys(b, { finalReservationId: randomUUID() }) as never), code("NOT_FOUND"));
    });

    await t.test("notice rules: the notice must equal the disclosing quote's stored notice; a quote without one can never close a package; close needs closure_pending first", async () => {
      const b = await opened();
      await assert.rejects(closeExplicit(b), rejection("INVALID_TRANSITION"), "open -> closed is not an edge");
      await beginExplicit(b);
      await assert.rejects(closeExplicit(b, "rcn-other"), rejection("TERMS_NOT_APPROVED"), "a notice the customer was not shown");
      assert.equal((await getBundleState(pool, b.user, b.packageId)).state, "closure_pending");
      assert.equal((await closeExplicit(b, NOTICE)).state, "closed");
      const none = await opened(null);
      await beginExplicit(none);
      await assert.rejects(closeExplicit(none, NOTICE), rejection("TERMS_NOT_APPROVED"), "no disclosed notice: the feature stays closed");
      await assert.rejects(closeBundleWithForfeiture(pool, sys(none, { cause: { kind: "approved_expiry" }, refinementClosureNoticeVersion: NOTICE }) as never), code("INVALID_INPUT"), "approved_expiry is not a cause");
      assert.equal((await getBundleState(pool, none.user, none.packageId)).state, "closure_pending");
    });

    await t.test("final authorized -> closure_pending; an unresolved final blocks closing; a settled final closes by delivery (and an explicit close is then refused)", async () => {
      const b = await opened();
      const final = await authorizeFinal(b);
      assert.equal(final.preAttemptPackageState, "open_for_refinements");
      await assert.rejects(beginBundleClosure(pool, sys(b, { trigger: { kind: "final_authorized", finalReservationId: randomUUID() } }) as never), code("NOT_FOUND"), "a reservation that is not this package's final");
      const closing = await beginBundleClosure(pool, sys(b, { trigger: { kind: "final_authorized", finalReservationId: final.reservationId } }) as never);
      assert.equal(closing.state, "closure_pending");
      await assert.rejects(closeExplicit(b), rejection("INVALID_TRANSITION"), "the final is still reserved: closure stays pending");
      await assert.rejects(closeBundleWithForfeiture(pool, sys(b, { cause: { kind: "final_delivered", finalReservationId: final.reservationId }, refinementClosureNoticeVersion: NOTICE }) as never), rejection("INVALID_TRANSITION"));
      await forceSettled(final.reservationId);
      await assert.rejects(closeExplicit(b), rejection("INVALID_TRANSITION"), "a settled final closes by delivery, never by an explicit close");
      await assert.rejects(closeBundleWithForfeiture(pool, sys(b, { cause: { kind: "final_delivered", finalReservationId: final.reservationId }, refinementClosureNoticeVersion: "rcn-other" }) as never), rejection("TERMS_NOT_APPROVED"));
      const closed = await closeBundleWithForfeiture(pool, sys(b, { cause: { kind: "final_delivered", finalReservationId: final.reservationId }, refinementClosureNoticeVersion: NOTICE }) as never);
      assert.deepEqual([closed.state, ...states(closed)], ["closed", "forfeited", "forfeited"]);
      assert.equal(closed.slots[0]!.view.state === "forfeited" && closed.slots[0]!.view.closureCause, "final_delivered");
      // the other trigger kind is verified against the stored reservation too
      const c = await opened(); const wrongState = await authorizeFinal(c);
      await forceSettled(wrongState.reservationId);
      await assert.rejects(beginBundleClosure(pool, sys(c, { trigger: { kind: "final_authorized", finalReservationId: wrongState.reservationId } }) as never), rejection("INVALID_TRANSITION"), "a settled final is no longer a freshly authorized one");
    });

    await t.test("C-02 reopen: a released FIRST final on an open package reopens it, slots exactly as they were; unreleased, settled and later-revision finals do not", async () => {
      const b = await opened();
      await skipRefinementSlot(pool, cust(b, 2) as never);
      await pend(b, 1, "op-r"); await consume(b, 1, "op-r", "v-r");
      const final = await authorizeFinal(b);
      await beginBundleClosure(pool, sys(b, { trigger: { kind: "final_authorized", finalReservationId: final.reservationId } }) as never);
      await assert.rejects(reopenBundleAfterUnchargedFinal(pool, sys(b, { finalReservationId: final.reservationId }) as never), rejection("INVALID_TRANSITION"), "still reserved: not uncharged");
      await releaseFinal(b, final);
      const slotsBefore = (await client.query("SELECT slot_id, state FROM vynvori_ledger.refinement_slots WHERE package_id = $1 ORDER BY ordinal", [b.packageId])).rows;
      await assert.rejects(reopenBundleAfterUnchargedFinal(pool, sys(b, { finalReservationId: randomUUID() }) as never), code("NOT_FOUND"));
      const reopened = await reopenBundleAfterUnchargedFinal(pool, sys(b, { finalReservationId: final.reservationId }) as never);
      assert.deepEqual([reopened.state, reopened.customerState, ...states(reopened)], ["open_for_refinements", "refinements_open", "used", "skipped"]);
      assert.deepEqual((await client.query("SELECT slot_id, state FROM vynvori_ledger.refinement_slots WHERE package_id = $1 ORDER BY ordinal", [b.packageId])).rows, slotsBefore, "no slot is recreated or changed");
      assert.equal(await count("refinement_slots", b.user), 2);
      await assert.rejects(reopenBundleAfterUnchargedFinal(pool, sys(b, { finalReservationId: final.reservationId }) as never), rejection("INVALID_TRANSITION"), "already open");
      // a later revision on a CLOSED package never reopens
      const c = await opened();
      const first = await authorizeFinal(c);
      await beginBundleClosure(pool, sys(c, { trigger: { kind: "final_authorized", finalReservationId: first.reservationId } }) as never);
      await forceSettled(first.reservationId);
      await closeBundleWithForfeiture(pool, sys(c, { cause: { kind: "final_delivered", finalReservationId: first.reservationId }, refinementClosureNoticeVersion: NOTICE }) as never);
      const revision = await authorizeFinal(c);
      assert.equal(revision.preAttemptPackageState, "closed");
      await recordWorkflowRef(pool, { userId: c.user, component: "workflow", reservationId: revision.reservationId, workflowRef: "wf/rev", idempotencyKey: key("dispatch") });
      await releaseReservation(pool, { userId: c.user, component: "workflow", reservationId: revision.reservationId, evidence: releaseEvidence(revision.operationId), idempotencyKey: key("release") });
      await assert.rejects(reopenBundleAfterUnchargedFinal(pool, sys(c, { finalReservationId: revision.reservationId }) as never), rejection("INVALID_TRANSITION"), "closed has no reopen edge");
      await assert.rejects(reopenBundleAfterUnchargedFinal(pool, sys(c, { finalReservationId: first.reservationId }) as never), rejection("INVALID_TRANSITION"));
      assert.deepEqual([(await getBundleState(pool, c.user, c.packageId)).state, await count("refinement_slots", c.user)], ["closed", 2]);
      // a settled (charged) first final of an unclosed package never reopens either
      const d = await opened(); const charged = await authorizeFinal(d);
      await beginBundleClosure(pool, sys(d, { trigger: { kind: "final_authorized", finalReservationId: charged.reservationId } }) as never);
      await forceSettled(charged.reservationId);
      await assert.rejects(reopenBundleAfterUnchargedFinal(pool, sys(d, { finalReservationId: charged.reservationId }) as never), rejection("INVALID_TRANSITION"), "charged");
    });

    await t.test("ownership: another user's package or slot is NOT_FOUND for every command and read, and nothing is recorded", async () => {
      const alice = await opened(), bob = await withBundle();
      const as = (b: B) => ({ userId: b.user, packageId: alice.packageId });
      await assert.rejects(getBundleState(pool, bob.user, alice.packageId), code("NOT_FOUND"));
      await assert.rejects(skipRefinementSlot(pool, { ...as(bob), ordinal: 1, idempotencyKey: key("x") }), code("NOT_FOUND"));
      await assert.rejects(restoreRefinementSlot(pool, { ...as(bob), ordinal: 1, idempotencyKey: key("x") }), code("NOT_FOUND"));
      await assert.rejects(markRefinementPending(pool, { ...as(bob), component: "studio", ordinal: 1, sourceVersionId: "s", operationId: "o", idempotencyKey: key("x") }), code("NOT_FOUND"));
      await assert.rejects(markRefinementUnknown(pool, { ...as(bob), component: "studio", ordinal: 1, operationId: "o", evidenceRef: "e", idempotencyKey: key("x") }), code("NOT_FOUND"));
      await assert.rejects(consumeRefinementSlot(pool, { ...as(bob), component: "studio", ordinal: 1, operationId: "o", deliveredVersionId: "v", evidenceRef: "e", idempotencyKey: key("x") }), code("NOT_FOUND"));
      await assert.rejects(recordBundleDelivery(pool, { ...as(bob), component: "studio", artifactCount: 3, evidenceRef: "e", idempotencyKey: key("x") }), code("NOT_FOUND"));
      await assert.rejects(openRefinements(pool, { ...as(bob), component: "studio", idempotencyKey: key("x") }), code("NOT_FOUND"));
      await assert.rejects(beginBundleClosure(pool, { ...as(bob), component: "studio", trigger: { kind: "explicit_close_request" }, idempotencyKey: key("x") }), code("NOT_FOUND"));
      await assert.rejects(closeBundleWithForfeiture(pool, { ...as(bob), component: "studio", cause: { kind: "explicit_close" }, refinementClosureNoticeVersion: NOTICE, idempotencyKey: key("x") }), code("NOT_FOUND"));
      await assert.rejects(reopenBundleAfterUnchargedFinal(pool, { ...as(bob), component: "studio", finalReservationId: randomUUID(), idempotencyKey: key("x") }), code("NOT_FOUND"));
      assert.deepEqual(states(await getBundleState(pool, alice.user, alice.packageId)), ["available", "available"]);
      // a final reservation of ANOTHER package is not this package's final
      const final = await authorizeFinal(alice);
      await beginBundleClosure(pool, sys(bob, { trigger: { kind: "final_authorized", finalReservationId: final.reservationId } }) as never).then(() => assert.fail("must reject"), e => assert.ok(code("NOT_FOUND")(e) || rejection("INVALID_TRANSITION")(e)));
    });

    await t.test("slot bindings: a wrong operation is EVIDENCE_INVALID; one operation serves one slot; the source binds once; a delivered version consumes one slot of a package", async () => {
      const b = await opened(); const op1 = "op-" + randomUUID(), op2 = "op-" + randomUUID();
      await pend(b, 1, op1, "src-A");
      await assert.rejects(pend(b, 2, op1, "src-A"), rejection("INVALID_TRANSITION"), "one operation, one slot");
      await assert.rejects(markRefinementUnknown(pool, sys(b, { ordinal: 1, operationId: "op-other", evidenceRef: "e" }) as never), rejection("EVIDENCE_INVALID"));
      await assert.rejects(consume(b, 1, "op-other", "v-1"), rejection("EVIDENCE_INVALID"));
      await consume(b, 1, op1, "v-1");
      const other = await opened();
      await assert.rejects(pend(other, 1, op1), rejection("INVALID_TRANSITION"), "an operation id serves one slot system-wide, never another user's either");
      await pend(b, 2, op2, "src-B");
      await assert.rejects(consume(b, 2, op2, "v-1"), rejection("INVALID_TRANSITION"), "a delivered version consumes at most one slot of a package");
      assert.deepEqual(states(await getBundleState(pool, b.user, b.packageId)), ["used", "pending"]);
      assert.equal(states(await consume(b, 2, op2, "v-2"))[1], "used");
    });

    await t.test("idempotency and concurrency: the same key replays; a changed payload conflicts; racing commands on one slot produce exactly one transition", async () => {
      const b = await opened();
      const k = key("skip"), input = cust(b, 1, { idempotencyKey: k }) as never;
      const first = await skipRefinementSlot(pool, input);
      assert.deepEqual(await skipRefinementSlot(pool, input), first, "replay returns the stored result without a second event");
      await assert.rejects(skipRefinementSlot(pool, cust(b, 2, { idempotencyKey: k }) as never), code("IDEMPOTENCY_CONFLICT"));
      assert.equal(await count("refinement_slot_events", b.user), 1);
      const racing = await opened();
      const results = await Promise.allSettled([1, 2, 3, 4, 5, 6].map(() => skipRefinementSlot(pool, cust(racing, 1) as never)));
      assert.equal(results.filter(r => r.status === "fulfilled").length, 1, "exactly one skip wins");
      assert.ok(results.filter(r => r.status === "rejected").every(r => rejection("INVALID_TRANSITION")((r as PromiseRejectedResult).reason)));
      assert.equal(await count("refinement_slot_events", racing.user), 1);
      const twins = await opened(); const tk = key("twin");
      const [x, y] = await Promise.all([1, 2].map(() => skipRefinementSlot(pool, cust(twins, 2, { idempotencyKey: tk }) as never)));
      assert.deepEqual(x, y); assert.equal(await count("refinement_slot_events", twins.user), 1);
      // consume vs begin-closure race: never both a consumed slot and a closed package with a consumed-while-closing slot
      const race = await opened(); await pend(race, 1, "op-race");
      const [consumed, began] = await Promise.allSettled([consume(race, 1, "op-race", "v-race"), beginExplicit(race)]);
      const final = await getBundleState(pool, race.user, race.packageId);
      // The two serialize on the wallet row: consume first, then begin succeeds on a used slot; or begin first, which is refused while the slot is pending.
      assert.equal(consumed.status, "fulfilled", "a pending refinement is always consumable: closure can never begin around it");
      assert.equal(final.slots[0]!.view.state, "used");
      if (began.status === "fulfilled") assert.equal(final.state, "closure_pending");
      else { assert.ok(rejection("INVALID_TRANSITION")(began.reason)); assert.equal(final.state, "open_for_refinements"); }
    });

    await t.test("lock order: every S7 command locks the wallet FIRST, then the package, then its slots", async () => {
      const b = await opened();
      const spy = async (run: (db: LedgerDb) => Promise<unknown>, locksSlots = true) => {
        const log: string[] = [];
        const db: LedgerDb = { acquire: async (): Promise<LedgerConn> => { const conn = await pool.connect(); conn.on("error", () => undefined); return { query: async (text, values) => { log.push(text.replace(/\s+/g, " ").trim()); return conn.query(text, values) as never; }, release: d => conn.release(d) }; } };
        await run(db);
        const at = (re: RegExp) => log.findIndex(q => re.test(q));
        const wallet = at(/wallets WHERE user_id = \$1 FOR UPDATE/), pkg = at(/ledger_packages WHERE .*FOR UPDATE/), slots = at(/refinement_slots WHERE .*FOR UPDATE/);
        assert.ok(wallet >= 0 && pkg > wallet && (locksSlots ? slots > pkg : slots === -1), JSON.stringify({ wallet, pkg, slots }));
      };
      await spy(db => skipRefinementSlot(db, cust(b, 1) as never));
      await spy(db => restoreRefinementSlot(db, cust(b, 1) as never));
      await spy(db => markRefinementPending(db, sys(b, { ordinal: 2, sourceVersionId: "s", operationId: "op-lock" }) as never));
      await spy(db => markRefinementUnknown(db, sys(b, { ordinal: 2, operationId: "op-lock", evidenceRef: "e" }) as never));
      await spy(db => consumeRefinementSlot(db, sys(b, { ordinal: 2, operationId: "op-lock", deliveredVersionId: "v-lock", evidenceRef: "e" }) as never));
      await spy(db => beginBundleClosure(db, sys(b, { trigger: { kind: "explicit_close_request" } }) as never));
      await spy(db => closeBundleWithForfeiture(db, sys(b, { cause: { kind: "explicit_close" }, refinementClosureNoticeVersion: NOTICE }) as never));
      const fresh = await withBundle();
      await spy(db => recordBundleDelivery(db, sys(fresh, { artifactCount: 3, evidenceRef: "e" }) as never), false);
      await spy(db => openRefinements(db, sys(fresh) as never), false);
    });

    // ---- the 0007 backstop, with raw SQL as the fixture superuser (each probe inside a rolled-back transaction) ----
    const rawCommand = async (user: string, kind: string) => {
      const id = randomUUID();
      await client.query("INSERT INTO vynvori_ledger.ledger_commands(command_id,scope,idempotency_key,request_sha256,user_id,command_kind,outcome) VALUES($1,$2,$3,repeat('a',64),$4,$5,'applied')", [id, `${user}:${kind}`, key("raw"), user, kind]);
      return id;
    };
    const inRolledBack = async (work: () => Promise<void>) => { await client.query("BEGIN"); try { await work(); } finally { await client.query("ROLLBACK"); } };
    /** Any integrity-constraint failure (class 23: a trigger's 23000, a CHECK's 23514, a FK's 23503) is a refusal; the transaction is rolled back. */
    const probe = (label: string, work: () => Promise<unknown>, pattern?: RegExp) => inRolledBack(async () => {
      await assert.rejects(work(), (e: unknown) => /^23/.test((e as { code?: string }).code ?? "") && (!pattern || pattern.test((e as Error).message)), label);
    });
    const packageEvent = (e: { user: string; packageId: string; command: string; from: string; to: string; extra?: Record<string, unknown> }) => client.query(
      "INSERT INTO vynvori_ledger.ledger_package_events(package_event_id,user_id,package_id,command_id,from_state,to_state,artifact_count,evidence_ref) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [randomUUID(), e.user, e.packageId, e.command, e.from, e.to, e.extra?.artifactCount ?? null, e.extra?.evidenceRef ?? null]);
    const slotEvent = (e: { user: string; slot: string; packageId: string; command: string; from: string; to: string }) => client.query(
      "INSERT INTO vynvori_ledger.refinement_slot_events(slot_event_id,user_id,slot_id,package_id,command_id,from_state,to_state) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [randomUUID(), e.user, e.slot, e.packageId, e.command, e.from, e.to]);

    await t.test("backstop: package and slot state cannot be written directly, and an event needs its own applied command of the right kind written in the same transaction", async () => {
      const b = await opened();
      const slot = (await client.query("SELECT slot_id FROM vynvori_ledger.refinement_slots WHERE package_id = $1 AND ordinal = 1", [b.packageId])).rows[0].slot_id as string;
      await probe("UPDATE ledger_packages", () => client.query("UPDATE vynvori_ledger.ledger_packages SET state = 'closed' WHERE package_id = $1", [b.packageId]));
      await probe("DELETE ledger_packages", () => client.query("DELETE FROM vynvori_ledger.ledger_packages WHERE package_id = $1", [b.packageId]));
      await probe("UPDATE refinement_slots", () => client.query("UPDATE vynvori_ledger.refinement_slots SET state = 'skipped' WHERE slot_id = $1", [slot]));
      await probe("DELETE refinement_slots", () => client.query("DELETE FROM vynvori_ledger.refinement_slots WHERE slot_id = $1", [slot]));
      await probe("INSERT refinement_slots directly", () => client.query("INSERT INTO vynvori_ledger.refinement_slots(slot_id,user_id,package_id,ordinal,state) VALUES($1,$2,$3,1,'available')", [randomUUID(), b.user, randomUUID()]));
      await probe("UPDATE ledger_package_events", () => client.query("UPDATE vynvori_ledger.ledger_package_events SET evidence_ref = 'x'"));
      await probe("DELETE refinement_slot_events", () => client.query("DELETE FROM vynvori_ledger.refinement_slot_events"));
      await probe("TRUNCATE refinement_slots", () => client.query("TRUNCATE vynvori_ledger.refinement_slots, vynvori_ledger.refinement_slot_events"));
      await probe("TRUNCATE ledger_package_events", () => client.query("TRUNCATE vynvori_ledger.ledger_package_events"));
      await probe("slot event under a command of the wrong kind", async () => slotEvent({ user: b.user, slot, packageId: b.packageId, command: await rawCommand(b.user, "refinement_restore"), from: "available", to: "skipped" }), /command/i);
      await probe("slot event under a grant command", async () => slotEvent({ user: b.user, slot, packageId: b.packageId, command: await rawCommand(b.user, "grant_credits"), from: "available", to: "skipped" }), /command/i);
      const old = await rawCommand(b.user, "refinement_skip"); // committed by an earlier transaction
      await probe("slot event under an earlier transaction's command", () => slotEvent({ user: b.user, slot, packageId: b.packageId, command: old, from: "available", to: "skipped" }), /transaction/i);
      await probe("slot event with a from_state that is not the slot's", async () => slotEvent({ user: b.user, slot, packageId: b.packageId, command: await rawCommand(b.user, "refinement_restore"), from: "skipped", to: "available" }));
      const stranger = await withBundle();
      await probe("slot event for another user's command", async () => slotEvent({ user: b.user, slot, packageId: b.packageId, command: await rawCommand(stranger.user, "refinement_skip"), from: "available", to: "skipped" }));
      await probe("package event under a command of the wrong kind", async () => packageEvent({ user: b.user, packageId: b.packageId, command: await rawCommand(b.user, "bundle_open_refinements"), from: "open_for_refinements", to: "closure_pending" }));
      await probe("package event with an edge that does not exist (open -> closed)", async () => packageEvent({ user: b.user, packageId: b.packageId, command: await rawCommand(b.user, "bundle_close"), from: "open_for_refinements", to: "closed" }));
      await probe("package event under an earlier transaction's command", () => packageEvent({ user: b.user, packageId: b.packageId, command: old, from: "open_for_refinements", to: "closure_pending" }));
      await probe("3 durable artifacts claimed with count 2", async () => packageEvent({ user: b.user, packageId: b.packageId, command: await rawCommand(b.user, "bundle_record_delivery"), from: "open_for_refinements", to: "delivered_3_of_3", extra: { artifactCount: 2, evidenceRef: "e" } }));
      const fresh = await withBundle();
      await probe("delivered_3_of_3 with count 2", async () => packageEvent({ user: fresh.user, packageId: fresh.packageId, command: await rawCommand(fresh.user, "bundle_record_delivery"), from: "authorized", to: "delivered_3_of_3", extra: { artifactCount: 2, evidenceRef: "e" } }));
      await probe("closing a package that is not closure_pending", async () => packageEvent({ user: b.user, packageId: b.packageId, command: await rawCommand(b.user, "bundle_close"), from: "closure_pending", to: "closed" }));
      assert.deepEqual([(await getBundleState(pool, b.user, b.packageId)).state, await count("ledger_package_events", b.user), await count("refinement_slots", b.user)], ["open_for_refinements", 2, 2]);
    });

    await t.test("backstop: a closing event that leaves a slot unresolved, or an opening event without exactly two slots, cannot commit; refinements never create ledger entries", async () => {
      const b = await opened();
      await beginExplicit(b);
      await inRolledBack(async () => {
        const command = await rawCommand(b.user, "bundle_close");
        await client.query("INSERT INTO vynvori_ledger.ledger_package_events(package_event_id,user_id,package_id,command_id,from_state,to_state,closure_cause,closure_notice_version) VALUES($1,$2,$3,$4,'closure_pending','closed','explicit_close',$5)", [randomUUID(), b.user, b.packageId, command, NOTICE]);
        await assert.rejects(client.query("SET CONSTRAINTS ALL IMMEDIATE"), sqlstate("23000"), "closed with two unforfeited slots");
      });
      assert.equal((await getBundleState(pool, b.user, b.packageId)).state, "closure_pending");
      assert.equal(await entryCount(b.user), 1 + 3, "one grant plus the bundle's three reserve entries; nothing from S7");
    });

    // ---- each business precondition is also enforced by the database on its own (raw SQL, so the library's pre-checks cannot answer first) ----
    const pkgEv = (e: { user: string; packageId: string; command: string; from: string; to: string; begin?: string; final?: string; cause?: string; notice?: string }) => client.query(
      "INSERT INTO vynvori_ledger.ledger_package_events(package_event_id,user_id,package_id,command_id,from_state,to_state,begin_reason,final_reservation_id,closure_cause,closure_notice_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [randomUUID(), e.user, e.packageId, e.command, e.from, e.to, e.begin ?? null, e.final ?? null, e.cause ?? null, e.notice ?? null]);
    const slotEv = (e: { user: string; slot: string; packageId: string; command: string; from: string; to: string; source?: string; operation?: string; delivered?: string; evidence?: string; cause?: string; notice?: string }) => client.query(
      "INSERT INTO vynvori_ledger.refinement_slot_events(slot_event_id,user_id,slot_id,package_id,command_id,from_state,to_state,source_version_id,operation_id,delivered_version_id,evidence_ref,closure_cause,closure_notice_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
      [randomUUID(), e.user, e.slot, e.packageId, e.command, e.from, e.to, e.source ?? null, e.operation ?? null, e.delivered ?? null, e.evidence ?? null, e.cause ?? null, e.notice ?? null]);
    const slotOf = async (b: B, ordinal: number) => (await client.query("SELECT slot_id FROM vynvori_ledger.refinement_slots WHERE package_id = $1 AND ordinal = $2", [b.packageId, ordinal])).rows[0].slot_id as string;

    await t.test("backstop: the database refuses each business precondition on its own, without the library's pre-checks", async () => {
      // an earlier transaction's command of the RIGHT kind cannot authorize a package event
      const a = await opened();
      const oldBegin = await rawCommand(a.user, "bundle_begin_closure");
      await probe("package event under an earlier transaction's command of the right kind", () => pkgEv({ user: a.user, packageId: a.packageId, command: oldBegin, from: "open_for_refinements", to: "closure_pending", begin: "explicit_close_request" }), /same transaction/);
      // closure cannot begin while a refinement is pending or unknown
      const p = await opened();
      await pend(p, 1, "op-db-pending");
      const begin = async (b: B) => pkgEv({ user: b.user, packageId: b.packageId, command: await rawCommand(b.user, "bundle_begin_closure"), from: "open_for_refinements", to: "closure_pending", begin: "explicit_close_request" });
      await probe("begin closure with a pending refinement", () => begin(p), /pending or unknown/);
      await markRefinementUnknown(pool, sys(p, { ordinal: 1, operationId: "op-db-pending", evidenceRef: "e" }) as never);
      await probe("begin closure with an unknown refinement", () => begin(p), /pending or unknown/);
      // the closing notice must be the disclosed one; a quote without a notice can never close
      const c = await opened(); await beginExplicit(c);
      const close = async (b: B, notice: string, cause = "explicit_close", final?: string) => pkgEv({ user: b.user, packageId: b.packageId, command: await rawCommand(b.user, "bundle_close"), from: "closure_pending", to: "closed", cause, notice, final });
      await probe("close under a notice the customer was not shown", () => close(c, "rcn-other"), /closure notice/);
      const none = await opened(null); await beginExplicit(none);
      await probe("close a package whose quote disclosed no notice", () => close(none, NOTICE), /closure notice/);
      // an unresolved final blocks the close
      const u = await opened(); await authorizeFinal(u); await beginExplicit(u);
      await probe("close while a final is reserved", () => close(u, NOTICE), /unresolved/);
      // a package with a settled final closes by delivery, never by an explicit close
      const s = await opened(); const settled = await authorizeFinal(s);
      await beginBundleClosure(pool, sys(s, { trigger: { kind: "final_authorized", finalReservationId: settled.reservationId } }) as never);
      await forceSettled(settled.reservationId);
      await probe("explicit close after a settled final", () => close(s, NOTICE), /final delivery, not explicit close/);
      // slot events: forfeiture only while closure is pending, every other change only while open, and the slot's own operation
      const o = await opened();
      await probe("forfeit a slot of an open package", async () => slotEv({ user: o.user, slot: await slotOf(o, 1), packageId: o.packageId, command: await rawCommand(o.user, "bundle_close"), from: "available", to: "forfeited", cause: "explicit_close", notice: NOTICE }), /forfeited only while closure is pending/);
      await probe("skip a slot of a closure_pending package", async () => slotEv({ user: c.user, slot: await slotOf(c, 1), packageId: c.packageId, command: await rawCommand(c.user, "refinement_skip"), from: "available", to: "skipped" }), /only while the package is open/);
      const m = await opened();
      await pend(m, 1, "op-db-own");
      await probe("consume a slot under another operation", async () => slotEv({ user: m.user, slot: await slotOf(m, 1), packageId: m.packageId, command: await rawCommand(m.user, "refinement_consume"), from: "pending", to: "used", operation: "op-db-other", delivered: "v-db-1", evidence: "e" }), /own refinement operation/);
      await probe("mark a slot unknown under another operation", async () => slotEv({ user: m.user, slot: await slotOf(m, 1), packageId: m.packageId, command: await rawCommand(m.user, "refinement_unknown"), from: "pending", to: "unknown", operation: "op-db-other", evidence: "e" }), /own refinement operation/);
      // one delivered version consumes one slot of a package
      const x = await opened();
      await pend(x, 1, "op-db-x1"); await consume(x, 1, "op-db-x1", "v-db-dup"); await pend(x, 2, "op-db-x2");
      await probe("two slots of one package consume the same delivered version", async () => slotEv({ user: x.user, slot: await slotOf(x, 2), packageId: x.packageId, command: await rawCommand(x.user, "refinement_consume"), from: "pending", to: "used", operation: "op-db-x2", delivered: "v-db-dup", evidence: "e" }), /refinement_slots_delivered_unique/);
    });

    await t.test("C-02 reopen binding: a closure that began by the customer's explicit request is never reversed by a released final; free text is printable ASCII only", async () => {
      const b = await opened();
      const final = await authorizeFinal(b);
      await beginExplicit(b);
      await releaseFinal(b, final);
      await assert.rejects(reopenBundleAfterUnchargedFinal(pool, sys(b, { finalReservationId: final.reservationId }) as never), rejection("INVALID_TRANSITION"), "closure began by explicit request");
      assert.equal((await getBundleState(pool, b.user, b.packageId)).state, "closure_pending");
      await probe("raw reopen event for a closure that did not begin because of this final", async () => client.query(
        "INSERT INTO vynvori_ledger.ledger_package_events(package_event_id,user_id,package_id,command_id,from_state,to_state,final_reservation_id) VALUES($1,$2,$3,$4,'closure_pending','open_for_refinements',$5)",
        [randomUUID(), b.user, b.packageId, await rawCommand(b.user, "bundle_reopen"), final.reservationId]), /closure to have begun/);
      // a sibling final that is still unresolved blocks the reopen even when closure began because of the released one
      const c = await opened();
      const first = await authorizeFinal(c);
      await beginBundleClosure(pool, sys(c, { trigger: { kind: "final_authorized", finalReservationId: first.reservationId } }) as never);
      await releaseFinal(c, first);
      await authorizeFinal(c);
      await assert.rejects(reopenBundleAfterUnchargedFinal(pool, sys(c, { finalReservationId: first.reservationId }) as never), rejection("INVALID_TRANSITION"), "a sibling final is unresolved");
      assert.equal((await getBundleState(pool, c.user, c.packageId)).state, "closure_pending");
      // free text: control characters and non-ASCII are refused by the table's own CHECK as well as by the library
      const fresh = await withBundle();
      for (const bad of ["a\nb", "a\tb", "café"])
        await probe(`evidence_ref ${JSON.stringify(bad)}`, async () => packageEvent({ user: fresh.user, packageId: fresh.packageId, command: await rawCommand(fresh.user, "bundle_record_delivery"), from: "authorized", to: "delivered_3_of_3", extra: { artifactCount: 3, evidenceRef: bad } }), /ledger_package_events_evidence_ref/);
      await assert.rejects(recordBundleDelivery(pool, sys(fresh, { artifactCount: 3, evidenceRef: "line1\nline2" }) as never), code("EVIDENCE_INVALID"));
      assert.equal((await getBundleState(pool, fresh.user, fresh.packageId)).state, "authorized");
    });
  } finally {
    await pool.end().catch(() => undefined);
    await client.end().catch(() => undefined);
    await dropLedger("entitlements");
  }
});
