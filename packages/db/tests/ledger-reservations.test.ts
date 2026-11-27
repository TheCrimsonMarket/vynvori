import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client, PoolClient } from "pg";
import { LedgerBusinessRejection, LedgerError, getWalletSummary, type LedgerConn, type LedgerDb } from "../src/ledger-core";
import { renewQuote } from "../src/ledger-quotes";
import { authorizeQuote, getReservation, recordWorkflowRef, releaseReservation, type AuthorizeQuoteInput } from "../src/ledger-reservations";
import { dropLedger, freshLedger, grantSyntheticCredits, ledgerPool, ledgerTarget, registerSyntheticGrantSource, syntheticProfileWithWallet } from "./ledger-fixture";
import {
  SYNTHETIC_BUNDLE_HOLD, SYNTHETIC_CONSENT, SYNTHETIC_FINAL_HOLD, SYNTHETIC_HOLDS, SYNTHETIC_CHARGES, bundleAllocations, bundleView, consent, currentPricePolicy,
  eligibilityPort, issueTestQuote, releaseEvidence, stalePricePolicy,
} from "./ledger-reservation-fixture";

/**
 * ADR-0021 S5 addendum: authorize -> reserve -> dispatch marker -> release, and the 0005 database backstop.
 * Non-concurrency file: pool capped at 5 (D15); declared peak connections = 5 (pool) + 1 (persistent fixture client) = 6.
 * Every unit value is SYNTHETIC (tests/ledger-reservation-fixture.ts); nothing here is a price, cost or package size.
 */
const code = (c: string) => (e: unknown) => e instanceof LedgerError && e.code === c;
const rejection = (c: string) => (e: unknown) => e instanceof LedgerBusinessRejection && e.code === c;
const sqlstate = (c: string, pattern?: RegExp) => (e: unknown) => (e as { code?: string }).code === c && (!pattern || pattern.test((e as Error).message));
let keyCounter = 0;
const key = (label: string) => `${label}-${String(++keyCounter).padStart(6, "0")}-${randomUUID().slice(0, 8)}`;
const qid = (label: string) => `${label}-${randomUUID()}`;

test("authorizeQuote, releaseReservation and recordWorkflowRef reject malformed input before any SQL", async () => {
  const db = { acquire: async () => { throw new Error("no SQL may run"); } } as unknown as LedgerDb;
  const base: AuthorizeQuoteInput = { userId: randomUUID(), quoteVersionId: "q-v1", idempotencyKey: "valid-key-0123456789", consent: consent(), now: new Date(), pricePolicy: currentPricePolicy, eligibility: eligibilityPort() };
  for (const bad of [
    { userId: "not-a-uuid" }, { userId: randomUUID().toUpperCase() }, { quoteVersionId: "bad id!" }, { quoteVersionId: "" }, { idempotencyKey: "short" },
    { now: new Date("nope") }, { now: "2026-01-01" }, { eligibility: undefined }, { eligibility: {} }, { pricePolicy: undefined },
    { consent: undefined }, { consent: { accepted: "yes", consentTextVersion: "x" } }, { consent: { accepted: true, consentTextVersion: "" } },
    { consent: { accepted: true, consentTextVersion: "x".repeat(257) } }, { originalPackageId: "nope" },
  ] as Partial<AuthorizeQuoteInput>[]) await assert.rejects(authorizeQuote(db, { ...base, ...bad } as AuthorizeQuoteInput), code("INVALID_INPUT"), JSON.stringify(Object.keys(bad)));
  const release = { userId: randomUUID(), component: "workflow", reservationId: randomUUID(), evidence: releaseEvidence("op_x"), idempotencyKey: "valid-key-0123456789" };
  for (const evidence of [undefined, null, {}, { ...releaseEvidence("op_x"), transition: "settle" }, { transition: "hold", operationId: "op_x", evidenceKind: "outcome_unknown", evidenceRef: "r", reason: "outcome_unknown" },
    { transition: "settle", operationId: "op_x", evidenceKind: "persisted_delivered", evidenceRef: "r", hasVerifiedManifestHash: true, ownerAndRightsVerified: true },
    { ...releaseEvidence("op_x"), evidenceKind: "outcome_unknown" }, { ...releaseEvidence("op_x"), evidenceRef: "" }, { ...releaseEvidence("op_x"), evidenceRef: "r".repeat(513) },
    { ...releaseEvidence("op_x"), extra: true }, { transition: "release", operationId: "op_x", evidenceKind: "verified_zero_charge_failure" }])
    await assert.rejects(releaseReservation(db, { ...release, evidence }), code("EVIDENCE_INVALID"), JSON.stringify(evidence));
  for (const bad of [{ userId: "x" }, { reservationId: "x" }, { component: "Bad Component" }, { idempotencyKey: "short" }])
    await assert.rejects(releaseReservation(db, { ...release, ...bad }), code("INVALID_INPUT"), JSON.stringify(bad));
  const dispatch = { userId: randomUUID(), component: "workflow", reservationId: randomUUID(), workflowRef: "wf/1", idempotencyKey: "valid-key-0123456789" };
  for (const bad of [{ workflowRef: "" }, { workflowRef: "has space" }, { workflowRef: "x".repeat(257) }, { workflowRef: 5 }, { reservationId: "x" }, { component: "" }])
    await assert.rejects(recordWorkflowRef(db, { ...dispatch, ...bad } as never), code("INVALID_INPUT"), JSON.stringify(bad));
});

test("ledger reservations: authorize, reserve, dispatch and release in disposable PostgreSQL", { skip: ledgerTarget.skip }, async t => {
  assert.ok(ledgerTarget.url, "CI_REQUIRE_PG_TESTS=1 requires M7_TEST_POSTGRES_URL or M2_CREATIVE_DATABASE_URL");
  const client: Client = await freshLedger("reservations");
  const { pool, max } = await ledgerPool("reservations", "standard");
  assert.ok(max <= 5, "D15: non-concurrency files cap their pool at 5");
  try {
    const source = await registerSyntheticGrantSource(client);
    let funds = 0;
    const fund = (userId: string, units: number) => grantSyntheticCredits(pool, { userId, grantSourceId: source, sourceRef: `funds-${++funds}`, units });
    const buckets = async (userId: string) => { const w = await getWalletSummary(client, userId); return { a: w.availableUnits, r: w.reservedUnits, h: w.heldForReviewUnits }; };
    const authorize = (userId: string, quoteVersionId: string, extra: Partial<AuthorizeQuoteInput> = {}) =>
      authorizeQuote(pool, { userId, quoteVersionId, idempotencyKey: key("authorize"), consent: consent(), now: new Date(), pricePolicy: currentPricePolicy, eligibility: eligibilityPort(), ...extra });
    const count = async (table: string, userId: string) => (await client.query(`SELECT count(*)::int AS n FROM vynvori_ledger.${table} WHERE user_id = $1`, [userId])).rows[0].n as number;
    /** A user holding one authorized bundle, i.e. an original package a final can name. */
    const withPackage = async (extraUnits = 0) => {
      const user = await syntheticProfileWithWallet(client);
      await fund(user, SYNTHETIC_BUNDLE_HOLD + extraUnits);
      const bundle = await authorize(user, await issueTestQuote(pool, user, "bundle", qid("pkg")));
      return { user, bundle };
    };
    const dispatch = (userId: string, reservationId: string, workflowRef = "wf/" + randomUUID()) => recordWorkflowRef(pool, { userId, component: "workflow", reservationId, workflowRef, idempotencyKey: key("dispatch") });

    await t.test("bundle: one authorization, one 'authorized' package, one reservation per frozen allocation, each reserved by its own entry", async () => {
      const user = await syntheticProfileWithWallet(client);
      await fund(user, SYNTHETIC_BUNDLE_HOLD + 2);
      const quoteVersionId = await issueTestQuote(pool, user, "bundle", qid("bundle"));
      const port = eligibilityPort();
      const result = await authorize(user, quoteVersionId, { eligibility: port });
      assert.equal(port.calls, 1, "the eligibility port is consulted inline");
      assert.equal(result.replayed, false); assert.equal(result.operationKind, "concept_bundle_3x2"); assert.ok(result.packageId);
      assert.deepEqual(result.reservations.map(r => [r.operationIndex, r.holdUnits, r.chargeUnits, r.state, r.packageId, r.workflowRef]), SYNTHETIC_HOLDS.map((h, i) => [i, h, SYNTHETIC_CHARGES[i], "reserved", result.packageId, null]));
      assert.equal(new Set(result.reservations.map(r => r.operationId)).size, 3, "one ledger-generated operation id per provider operation (D5)");
      assert.deepEqual(await buckets(user), { a: 2, r: SYNTHETIC_BUNDLE_HOLD, h: 0 });
      assert.deepEqual((await client.query("SELECT state FROM vynvori_ledger.ledger_packages WHERE package_id = $1", [result.packageId])).rows, [{ state: "authorized" }]);
      const entries = (await client.query("SELECT entry_kind, delta_available::int a, delta_reserved::int r, evidence_kind, evidence_ref FROM vynvori_ledger.ledger_entries WHERE user_id = $1 AND entry_kind <> 'grant' ORDER BY delta_reserved DESC", [user])).rows;
      assert.deepEqual(entries.map(e => [e.entry_kind, e.a, e.r, e.evidence_kind, e.evidence_ref]), [...SYNTHETIC_HOLDS].sort((a, b) => b - a).map(h => ["reserve", -h, h, "authorization", result.authorizationId]));
      assert.deepEqual(await getReservation(pool, user, result.reservations[1]!.reservationId), result.reservations[1]);
    });

    await t.test("final: needs the caller's original package, records its pre-attempt state, reserves the final's single allocation; bundle and final reject the wrong package argument", async () => {
      const { user, bundle } = await withPackage(SYNTHETIC_FINAL_HOLD);
      const finalVersion = await issueTestQuote(pool, user, "final", qid("final"));
      await assert.rejects(authorize(user, finalVersion), code("INVALID_INPUT"), "a final without its original package");
      const other = await withPackage();
      await assert.rejects(authorize(user, finalVersion, { originalPackageId: other.bundle.packageId! }), code("NOT_FOUND"), "another user's package is never visible");
      await assert.rejects(authorize(user, finalVersion, { originalPackageId: randomUUID() }), code("NOT_FOUND"));
      await assert.rejects(authorize(user, await issueTestQuote(pool, user, "bundle", qid("bundle-with-pkg")), { originalPackageId: bundle.packageId! }), code("INVALID_INPUT"), "a bundle never names an original package");
      const final = await authorize(user, finalVersion, { originalPackageId: bundle.packageId! });
      assert.equal(final.packageId, null, "a final creates no package");
      assert.deepEqual(final.reservations.map(r => [r.operationKind, r.holdUnits, r.originalPackageId, r.preAttemptPackageState, r.packageId]), [["final_standard", SYNTHETIC_FINAL_HOLD, bundle.packageId, "authorized", null]]);
      assert.deepEqual(await buckets(user), { a: 0, r: SYNTHETIC_BUNDLE_HOLD + SYNTHETIC_FINAL_HOLD, h: 0 });
    });

    await t.test("replays: the same key and payload return the same authorization without moving units; a changed payload is IDEMPOTENCY_CONFLICT; a second key for the same lineage is QUOTE_STALE", async () => {
      const user = await syntheticProfileWithWallet(client);
      await fund(user, 3 * SYNTHETIC_BUNDLE_HOLD);
      const quoteVersionId = await issueTestQuote(pool, user, "bundle", qid("replay")), k = key("replay");
      const first = await authorize(user, quoteVersionId, { idempotencyKey: k });
      const port = eligibilityPort();
      const again = await authorize(user, quoteVersionId, { idempotencyKey: k, eligibility: port });
      assert.equal(again.replayed, true); assert.deepEqual({ ...again, replayed: false }, first);
      assert.equal(port.calls, 0, "a replay re-runs nothing");
      await assert.rejects(authorize(user, quoteVersionId, { idempotencyKey: k, consent: { accepted: true, consentTextVersion: "other-ctv" } }), code("IDEMPOTENCY_CONFLICT"));
      await assert.rejects(authorize(user, quoteVersionId), rejection("QUOTE_STALE"), "one authorization per lineage, ever");
      assert.deepEqual(await buckets(user), { a: 2 * SYNTHETIC_BUNDLE_HOLD, r: SYNTHETIC_BUNDLE_HOLD, h: 0 });
      assert.equal(await count("ledger_authorizations", user), 1); assert.equal(await count("credit_reservations", user), 3);
    });

    await t.test("expired, superseded, stale-price and promo quotes are refused and persisted; nothing is reserved", async () => {
      const user = await syntheticProfileWithWallet(client);
      await fund(user, 4 * SYNTHETIC_BUNDLE_HOLD);
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      const expiring = await issueTestQuote(pool, user, "bundle", qid("expiring"), { expiresAt });
      const k = key("expired");
      await assert.rejects(authorize(user, expiring, { idempotencyKey: k, now: new Date(expiresAt) }), rejection("QUOTE_EXPIRED"), "now == expiresAt is expired (injected clock)");
      await assert.rejects(authorize(user, expiring, { idempotencyKey: k, now: new Date(expiresAt) }), rejection("QUOTE_EXPIRED"), "the persisted rejection replays");
      const lineage = qid("superseded"), v1 = await issueTestQuote(pool, user, "bundle", lineage);
      await renewQuote(pool, { userId: user, quoteId: lineage, expectedLatestVersionNo: 1, quoteView: bundleView(lineage, lineage + "-v2"), modelRef: "s5-model", allocations: bundleAllocations, idempotencyKey: key("renew") });
      await assert.rejects(authorize(user, v1), rejection("QUOTE_STALE"), "a superseded version");
      await assert.rejects(authorize(user, await issueTestQuote(pool, user, "bundle", qid("price")), { pricePolicy: stalePricePolicy }), rejection("QUOTE_STALE"), "price version no longer current");
      await assert.rejects(authorize(user, await issueTestQuote(pool, user, "promo", qid("promo"))), rejection("INVALID_TRANSITION"), "a promo is an S4 claim, never a reservation");
      const v2 = await authorize(user, lineage + "-v2");
      assert.equal(v2.quoteVersionId, lineage + "-v2", "the head of the lineage still authorizes");
      assert.deepEqual(await buckets(user), { a: 3 * SYNTHETIC_BUNDLE_HOLD, r: SYNTHETIC_BUNDLE_HOLD, h: 0 });
    });

    await t.test("eligibility: an absent port denies before any SQL; every denial code (incl. an undisclosed cancellation window) is persisted; a malformed answer is never an approval", async () => {
      const user = await syntheticProfileWithWallet(client);
      await fund(user, SYNTHETIC_BUNDLE_HOLD);
      const quoteVersionId = await issueTestQuote(pool, user, "bundle", qid("eligibility"));
      const commandsBefore = await count("ledger_commands", user);
      await assert.rejects(authorize(user, quoteVersionId, { eligibility: undefined as never }), code("INVALID_INPUT"));
      assert.equal(await count("ledger_commands", user), commandsBefore, "nothing was recorded, so the same key can be used once a port exists");
      for (const denial of ["RIGHTS_INELIGIBLE", "DOWNSTREAM_USE_UNAVAILABLE", "CANCELLATION_WINDOW_UNDISCLOSED", "TERMS_NOT_APPROVED"] as const) {
        const k = key("deny");
        await assert.rejects(authorize(user, quoteVersionId, { idempotencyKey: k, eligibility: eligibilityPort({ ok: false, code: denial }) }), rejection(denial), denial);
        await assert.rejects(authorize(user, quoteVersionId, { idempotencyKey: k, eligibility: eligibilityPort() }), rejection(denial), `${denial} replays even when the port would now approve`);
      }
      for (const answer of [{ ok: true }, { ok: true, cancellationWindowDisclosed: false }, { ok: false, code: "NOPE" }, null, "yes", { ok: true, cancellationWindowDisclosed: true, extra: 1 }])
        await assert.rejects(authorize(user, quoteVersionId, { eligibility: eligibilityPort(() => answer) }), code("INVALID_INPUT"), JSON.stringify(answer));
      await assert.rejects(authorize(user, quoteVersionId, { eligibility: eligibilityPort(() => { throw new Error("port down"); }) }), code("DATABASE_ERROR"), "a failing port denies; nothing is recorded");
      assert.deepEqual(await buckets(user), { a: SYNTHETIC_BUNDLE_HOLD, r: 0, h: 0 }, "nothing reserved");
      const port = eligibilityPort();
      await authorize(user, quoteVersionId, { eligibility: port });
      assert.equal(port.calls, 1);
      // An ineligible bundle (no permitted downstream use, unqualified Standard, non-distinct directions) cannot even be issued:
      // QuoteViewV3Schema refuses it, so authorization never sees one; the contract guard in authorizeQuote is defence in depth.
      const quotesBefore = (await client.query("SELECT count(*)::int n FROM vynvori_ledger.ledger_quotes WHERE user_id = $1", [user])).rows[0].n;
      const noUse = { downstreamEligibility: { ...bundleView("x", "x-v1").downstreamEligibility, quotedEligibleUses: [] } };
      for (const [label, overrides] of [["no downstream use", noUse], ["unqualified Standard", { standardFinalQualified: false }], ["non-distinct directions", { directionIds: ["d1", "d1", "d2"] }]] as const)
        await assert.rejects(issueTestQuote(pool, user, "bundle", qid("ineligible"), overrides as Record<string, unknown>), code("INVALID_INPUT"), label);
      assert.equal((await client.query("SELECT count(*)::int n FROM vynvori_ledger.ledger_quotes WHERE user_id = $1", [user])).rows[0].n, quotesBefore);
    });

    await t.test("consent: not accepted, or accepted for a different consent text version, is TERMS_NOT_APPROVED", async () => {
      const user = await syntheticProfileWithWallet(client);
      await fund(user, SYNTHETIC_BUNDLE_HOLD);
      const quoteVersionId = await issueTestQuote(pool, user, "bundle", qid("consent"));
      await assert.rejects(authorize(user, quoteVersionId, { consent: { accepted: false, consentTextVersion: SYNTHETIC_CONSENT } }), rejection("TERMS_NOT_APPROVED"));
      await assert.rejects(authorize(user, quoteVersionId, { consent: { accepted: true, consentTextVersion: SYNTHETIC_CONSENT + "-old" } }), rejection("TERMS_NOT_APPROVED"));
      assert.equal(await count("credit_reservations", user), 0);
    });

    await t.test("funds: below the maximum hold is INSUFFICIENT_CREDITS; a later top-up never turns the old press into an authorization; a new key does", async () => {
      const user = await syntheticProfileWithWallet(client);
      await fund(user, SYNTHETIC_BUNDLE_HOLD - 1);
      const quoteVersionId = await issueTestQuote(pool, user, "bundle", qid("funds")), k = key("funds");
      await assert.rejects(authorize(user, quoteVersionId, { idempotencyKey: k }), rejection("INSUFFICIENT_CREDITS"));
      await fund(user, 1);
      await assert.rejects(authorize(user, quoteVersionId, { idempotencyKey: k }), rejection("INSUFFICIENT_CREDITS"), "the persisted rejection replays after the top-up");
      assert.deepEqual(await buckets(user), { a: SYNTHETIC_BUNDLE_HOLD, r: 0, h: 0 });
      await authorize(user, quoteVersionId);
      assert.deepEqual(await buckets(user), { a: 0, r: SYNTHETIC_BUNDLE_HOLD, h: 0 }, "exactly the available units are reservable");
    });

    await t.test("ownership: another user's quote, reservation or release is NOT_FOUND and never recorded", async () => {
      const alice = await withPackage(), bob = await syntheticProfileWithWallet(client);
      await fund(bob, SYNTHETIC_BUNDLE_HOLD);
      const aliceQuote = await issueTestQuote(pool, alice.user, "bundle", qid("alice"));
      await assert.rejects(authorize(bob, aliceQuote), code("NOT_FOUND"));
      const target = alice.bundle.reservations[0]!;
      await assert.rejects(getReservation(pool, bob, target.reservationId), code("NOT_FOUND"));
      await assert.rejects(dispatch(bob, target.reservationId), code("NOT_FOUND"));
      await dispatch(alice.user, target.reservationId);
      await assert.rejects(releaseReservation(pool, { userId: bob, component: "workflow", reservationId: target.reservationId, evidence: releaseEvidence(target.operationId), idempotencyKey: key("x-release") }), code("NOT_FOUND"));
      assert.equal((await getReservation(pool, alice.user, target.reservationId)).state, "reserved");
      assert.equal(await count("credit_reservations", bob), 0);
    });

    await t.test("dispatch marker: recorded once on a reserved reservation; the same reference again is a no-op; a different one is INVALID_TRANSITION", async () => {
      const { user, bundle } = await withPackage();
      const target = bundle.reservations[0]!;
      assert.equal((await dispatch(user, target.reservationId, "wf/run-1")).workflowRef, "wf/run-1");
      assert.equal((await dispatch(user, target.reservationId, "wf/run-1")).workflowRef, "wf/run-1", "idempotent by value");
      await assert.rejects(dispatch(user, target.reservationId, "wf/run-2"), rejection("INVALID_TRANSITION"));
      assert.deepEqual(await buckets(user), { a: 0, r: SYNTHETIC_BUNDLE_HOLD, h: 0 }, "dispatch moves no units");
    });

    await t.test("release: only verified-zero-charge evidence for THIS operation, only once dispatched; the full hold returns, siblings untouched; replay-safe", async () => {
      const { user, bundle } = await withPackage();
      const [target, sibling] = [bundle.reservations[0]!, bundle.reservations[1]!];
      const release = (reservationId: string, evidence: unknown, idempotencyKey = key("release")) => releaseReservation(pool, { userId: user, component: "workflow", reservationId, evidence, idempotencyKey });
      await assert.rejects(release(target.reservationId, releaseEvidence(target.operationId)), rejection("INVALID_TRANSITION"), "a never-dispatched reservation stays reserved for a human (S8 orphan finder)");
      await dispatch(user, target.reservationId);
      const wrongOp = key("wrong-op");
      await assert.rejects(release(target.reservationId, releaseEvidence(sibling.operationId), wrongOp), rejection("EVIDENCE_INVALID"), "evidence for a sibling's operation");
      await assert.rejects(release(target.reservationId, releaseEvidence(target.operationId), wrongOp), code("IDEMPOTENCY_CONFLICT"), "the rejected key stays bound to its payload");
      await assert.rejects(release(target.reservationId, { transition: "hold", operationId: target.operationId, evidenceKind: "outcome_unknown", evidenceRef: "r", reason: "outcome_unknown" }), code("EVIDENCE_INVALID"), "an unknown outcome never releases");
      await assert.rejects(release(target.reservationId, undefined), code("EVIDENCE_INVALID"), "missing evidence");
      assert.deepEqual(await buckets(user), { a: 0, r: SYNTHETIC_BUNDLE_HOLD, h: 0 });
      const k = key("release-ok");
      const released = await release(target.reservationId, releaseEvidence(target.operationId, "plane-b/ref-1"), k);
      assert.equal(released.state, "released");
      assert.deepEqual(await buckets(user), { a: target.holdUnits, r: SYNTHETIC_BUNDLE_HOLD - target.holdUnits, h: 0 }, "exactly this reservation's hold returns, never netted against a sibling");
      assert.equal((await getReservation(pool, user, sibling.reservationId)).state, "reserved");
      assert.equal((await release(target.reservationId, releaseEvidence(target.operationId, "plane-b/ref-1"), k)).state, "released", "replay");
      await assert.rejects(release(target.reservationId, releaseEvidence(target.operationId, "plane-b/ref-2")), rejection("INVALID_TRANSITION"), "a second release under a new key");
      assert.deepEqual(await buckets(user), { a: target.holdUnits, r: SYNTHETIC_BUNDLE_HOLD - target.holdUnits, h: 0 });
      assert.deepEqual((await client.query("SELECT evidence_kind, evidence_ref, delta_available::int a FROM vynvori_ledger.ledger_entries WHERE reservation_id = $1 AND entry_kind = 'release'", [target.reservationId])).rows, [{ evidence_kind: "verified_zero_charge_failure", evidence_ref: "plane-b/ref-1", a: target.holdUnits }]);
      await assert.rejects(dispatch(user, target.reservationId, "wf/late"), rejection("INVALID_TRANSITION"), "no dispatch marker after release");
    });

    await t.test("renewing an authorized lineage is refused (QUOTE_STALE) by the database", async () => {
      const user = await syntheticProfileWithWallet(client);
      await fund(user, SYNTHETIC_BUNDLE_HOLD);
      const lineage = qid("renew-after");
      await authorize(user, await issueTestQuote(pool, user, "bundle", lineage));
      await assert.rejects(renewQuote(pool, { userId: user, quoteId: lineage, expectedLatestVersionNo: 1, quoteView: bundleView(lineage, lineage + "-v2"), modelRef: "s5-model", allocations: bundleAllocations, idempotencyKey: key("renew-after") }), rejection("QUOTE_STALE"));
      await assert.rejects(client.query(`INSERT INTO vynvori_ledger.ledger_quotes(quote_version_id,quote_id,version_no,user_id,operation_kind,model_ref,max_charge_units,credits_quoted,issued_at,expires_at,price_version,capability_snapshot_id,consent_text_version,quote_view,content_sha256)
        VALUES($1,$2,2,$3,'concept_bundle_3x2','m',1,1,now(),now() + interval '1 hour','pv','cap','ctv','{}'::jsonb,repeat('a',64))`, [lineage + "-raw", lineage, user]), sqlstate("23000", /authorized quote lineage cannot be renewed/), "the raw-SQL backstop");
    });

    /** Runs the real statements but lets a test inject a fault around one of them (as in ledger-core.test.ts). */
    const faulty = (hook: (text: string, conn: PoolClient) => Promise<void>, after?: (text: string) => Promise<void>): LedgerDb => ({
      acquire: async (): Promise<LedgerConn> => {
        const conn = await pool.connect(); conn.on("error", () => undefined);
        return { query: async (text, values) => { await hook(text, conn); const result = await conn.query(text, values); await after?.(text); return result as never; }, release: destroy => conn.release(destroy) };
      },
    });

    await t.test("bundle atomicity: a failure on the 3rd reservation rolls back the authorization, the package and every reservation and entry; the same key then succeeds", async () => {
      const user = await syntheticProfileWithWallet(client);
      await fund(user, SYNTHETIC_BUNDLE_HOLD);
      const quoteVersionId = await issueTestQuote(pool, user, "bundle", qid("atomic")), k = key("atomic");
      let inserts = 0;
      const db = faulty(async (text, conn) => {
        if (!/^INSERT INTO vynvori_ledger\.credit_reservations/.test(text.trim()) || ++inserts !== 3) return;
        await conn.query("SELECT 1 / 0"); // a real server-reported failure in the middle of the bundle
      });
      await assert.rejects(authorizeQuote(db, { userId: user, quoteVersionId, idempotencyKey: k, consent: consent(), now: new Date(), pricePolicy: currentPricePolicy, eligibility: eligibilityPort() }), code("DATABASE_ERROR"));
      assert.equal(inserts, 3);
      for (const table of ["ledger_authorizations", "ledger_packages", "credit_reservations"]) assert.equal(await count(table, user), 0, table);
      assert.equal((await client.query("SELECT count(*)::int n FROM vynvori_ledger.ledger_entries WHERE user_id = $1 AND entry_kind <> 'grant'", [user])).rows[0].n, 0);
      assert.deepEqual(await buckets(user), { a: SYNTHETIC_BUNDLE_HOLD, r: 0, h: 0 });
      const retried = await authorize(user, quoteVersionId, { idempotencyKey: k });
      assert.equal(retried.replayed, false); assert.equal(retried.reservations.length, 3);
    });

    await t.test("commit outcome lost after COMMIT: LEDGER_OUTCOME_UNKNOWN, then the replay converges on the one committed authorization", async () => {
      const user = await syntheticProfileWithWallet(client);
      await fund(user, SYNTHETIC_BUNDLE_HOLD);
      const quoteVersionId = await issueTestQuote(pool, user, "bundle", qid("lost")), k = key("lost");
      const db = faulty(async () => undefined, async text => { if (text === "COMMIT") throw new Error("Connection terminated unexpectedly"); });
      await assert.rejects(authorizeQuote(db, { userId: user, quoteVersionId, idempotencyKey: k, consent: consent(), now: new Date(), pricePolicy: currentPricePolicy, eligibility: eligibilityPort() }), code("LEDGER_OUTCOME_UNKNOWN"));
      assert.equal(await count("ledger_authorizations", user), 1, "the commit had in fact happened");
      const replay = await authorize(user, quoteVersionId, { idempotencyKey: k });
      assert.equal(replay.replayed, true); assert.equal(replay.reservations.length, 3);
      assert.equal(await count("ledger_authorizations", user), 1); assert.deepEqual(await buckets(user), { a: 0, r: SYNTHETIC_BUNDLE_HOLD, h: 0 });
    });

    await t.test("an acquire-only LedgerDb (no query method) gets the committed result back, and every checked-out connection is released", async () => {
      const user = await syntheticProfileWithWallet(client);
      await fund(user, SYNTHETIC_BUNDLE_HOLD);
      const quoteVersionId = await issueTestQuote(pool, user, "bundle", qid("acq-only"));
      let open = 0;
      const base = faulty(async () => undefined) as { acquire(): Promise<LedgerConn> };
      const db: LedgerDb = { acquire: async () => { const conn = await base.acquire(); open += 1; return { query: conn.query, release: destroy => { open -= 1; conn.release?.(destroy); } }; } };
      const authorized = await authorizeQuote(db, { userId: user, quoteVersionId, idempotencyKey: key("acq-only"), consent: consent(), now: new Date(), pricePolicy: currentPricePolicy, eligibility: eligibilityPort() });
      assert.equal(authorized.replayed, false); assert.equal(authorized.reservations.length, 3);
      const target = authorized.reservations[0]!;
      const dispatched = await recordWorkflowRef(db, { userId: user, component: "workflow", reservationId: target.reservationId, workflowRef: "wf:acq-only", idempotencyKey: key("acq-only-wf") });
      assert.equal(dispatched.workflowRef, "wf:acq-only");
      const released = await releaseReservation(db, { userId: user, component: "workflow", reservationId: target.reservationId, evidence: releaseEvidence(target.operationId), idempotencyKey: key("acq-only-rel") });
      assert.equal(released.state, "released");
      assert.equal(open, 0, "no connection is leaked by the read-back");
    });

    // ---- the 0005 backstop, exercised with raw SQL as the fixture superuser (each probe inside a rolled-back transaction) ----
    const rawCommand = async (user: string, kind: string) => {
      const id = randomUUID();
      await client.query("INSERT INTO vynvori_ledger.ledger_commands(command_id,scope,idempotency_key,request_sha256,user_id,command_kind,outcome) VALUES($1,$2,$3,repeat('a',64),$4,$5,'applied')", [id, `${user}:${kind}`, key("raw"), user, kind]);
      return id;
    };
    const rawEntry = (e: { user: string; command: string; kind: "reserve" | "release"; units: number; reservation: string; evidenceKind: string; evidenceRef: string }) => client.query(
      `INSERT INTO vynvori_ledger.ledger_entries(entry_id,user_id,command_id,entry_kind,delta_available,delta_reserved,delta_held,delta_consumed,delta_external,reservation_id,evidence_kind,evidence_ref,cause_kind,cause_ref)
       VALUES($1,$2,$3,$4,$5,$6,0,0,0,$7,$8,$9,'reservation',$7::uuid::text || ':' || $4)`,
      [randomUUID(), e.user, e.command, e.kind, e.kind === "reserve" ? -e.units : e.units, e.kind === "reserve" ? e.units : -e.units, e.reservation, e.evidenceKind, e.evidenceRef]);
    const inRolledBack = async (work: () => Promise<void>) => { await client.query("BEGIN"); try { await work(); } finally { await client.query("ROLLBACK"); } };
    const probe = async (label: string, work: () => Promise<unknown>, pattern: RegExp) => inRolledBack(async () => { await assert.rejects(work(), sqlstate("23000", pattern), label); });

    await t.test("entry binding: wrong units, another user, a command from another transaction or of the wrong kind, wrong evidence, and a double release are all refused (23000)", async () => {
      const alice = await withPackage(), bob = await withPackage();
      const target = alice.bundle.reservations[0]!;
      await dispatch(alice.user, target.reservationId);
      const release = (command: string, over: Partial<Parameters<typeof rawEntry>[0]> = {}) => rawEntry({ user: alice.user, command, kind: "release", units: target.holdUnits, reservation: target.reservationId, evidenceKind: "verified_zero_charge_failure", evidenceRef: "raw-ref", ...over });
      await probe("release of 2x the hold", async () => release(await rawCommand(alice.user, "reservation_release"), { units: 2 * target.holdUnits }), /release entry does not match/);
      await probe("release with hold evidence", async () => release(await rawCommand(alice.user, "reservation_release"), { evidenceKind: "outcome_unknown" }), /release entry does not match/);
      await probe("release by another user", async () => release(await rawCommand(bob.user, "reservation_release"), { user: bob.user }), /not found for this user/);
      await probe("release under a reserve command", async () => release(await rawCommand(alice.user, "reservation_authorize")), /matching kind/);
      await probe("release under a grant command", async () => release(await rawCommand(alice.user, "grant_credits")), /matching kind/);
      const oldCommand = await rawCommand(alice.user, "reservation_release"); // autocommitted: written by an earlier transaction
      await probe("release under a command written by an earlier transaction", () => release(oldCommand), /same transaction/);
      await probe("a second reserve of a reserved reservation", async () => rawEntry({ user: alice.user, command: await rawCommand(alice.user, "reservation_authorize"), kind: "reserve", units: target.holdUnits, reservation: target.reservationId, evidenceKind: "authorization", evidenceRef: alice.bundle.authorizationId }), /reserve entry does not match/);
      await probe("an entry for a reservation that does not exist", async () => release(await rawCommand(alice.user, "reservation_release"), { reservation: randomUUID() }), /not found for this user/);
      const undispatched = alice.bundle.reservations[1]!;
      await probe("release of a never-dispatched reservation", async () => release(await rawCommand(alice.user, "reservation_release"), { reservation: undispatched.reservationId, units: undispatched.holdUnits }), /release entry does not match/);
      await releaseReservation(pool, { userId: alice.user, component: "workflow", reservationId: target.reservationId, evidence: releaseEvidence(target.operationId), idempotencyKey: key("release") });
      await probe("a double release", async () => release(await rawCommand(alice.user, "reservation_release")), /release entry does not match/);
      assert.deepEqual(await buckets(alice.user), { a: target.holdUnits, r: SYNTHETIC_BUNDLE_HOLD - target.holdUnits, h: 0 });
    });

    await t.test("table backstop: an authorization outside its command's transaction, a reservation with other units, and a transaction leaving a reservation unreserved or an authorization incomplete are refused", async () => {
      const { user } = await withPackage(SYNTHETIC_BUNDLE_HOLD);
      const quoteVersionId = await issueTestQuote(pool, user, "bundle", qid("raw"));
      const quoteId = quoteVersionId.replace(/-v1$/, "");
      const insertAuthorization = (command: string, id = randomUUID()) => client.query("INSERT INTO vynvori_ledger.ledger_authorizations(authorization_id,user_id,command_id,quote_version_id,quote_id,operation_kind,consent_text_version) VALUES($1,$2,$3,$4,$5,'concept_bundle_3x2',$6)", [id, user, command, quoteVersionId, quoteId, SYNTHETIC_CONSENT]);
      const oldCommand = await rawCommand(user, "reservation_authorize"); // committed: from an earlier transaction
      await probe("authorization under an earlier transaction's command", () => insertAuthorization(oldCommand), /same transaction/);
      await probe("authorization under a command of another kind", async () => insertAuthorization(await rawCommand(user, "reservation_release")), /reservation_authorize/);
      await inRolledBack(async () => {
        const command = await rawCommand(user, "reservation_authorize"), authorizationId = randomUUID(), packageId = randomUUID();
        await insertAuthorization(command, authorizationId);
        await client.query("INSERT INTO vynvori_ledger.ledger_packages(package_id,user_id,authorization_id,state) VALUES($1,$2,$3,'authorized')", [packageId, user, authorizationId]);
        await client.query("SAVEPOINT s");
        await assert.rejects(client.query("INSERT INTO vynvori_ledger.credit_reservations(reservation_id,user_id,authorization_id,quote_version_id,operation_index,operation_kind,operation_id,hold_units,charge_units,state,package_id) VALUES($1,$2,$3,$4,0,'concept_bundle_3x2',$5,$6,$7,'authorization_requested',$8)",
          [randomUUID(), user, authorizationId, quoteVersionId, "op_" + randomUUID(), SYNTHETIC_HOLDS[0] + 1, SYNTHETIC_CHARGES[0], packageId]), sqlstate("23000", /allocation/), "units other than the frozen allocation");
        await client.query("ROLLBACK TO SAVEPOINT s");
        await assert.rejects(client.query("INSERT INTO vynvori_ledger.credit_reservations(reservation_id,user_id,authorization_id,quote_version_id,operation_index,operation_kind,operation_id,hold_units,charge_units,state,package_id) VALUES($1,$2,$3,$4,0,'concept_bundle_3x2',$5,$6,$7,'reserved',$8)",
          [randomUUID(), user, authorizationId, quoteVersionId, "op_" + randomUUID(), SYNTHETIC_HOLDS[0], SYNTHETIC_CHARGES[0], packageId]), sqlstate("23000"), "a reservation is never born reserved");
        await client.query("ROLLBACK TO SAVEPOINT s");
        await client.query("INSERT INTO vynvori_ledger.credit_reservations(reservation_id,user_id,authorization_id,quote_version_id,operation_index,operation_kind,operation_id,hold_units,charge_units,state,package_id) VALUES($1,$2,$3,$4,0,'concept_bundle_3x2',$5,$6,$7,'authorization_requested',$8)",
          [randomUUID(), user, authorizationId, quoteVersionId, "op_" + randomUUID(), SYNTHETIC_HOLDS[0], SYNTHETIC_CHARGES[0], packageId]);
        await assert.rejects(client.query("SET CONSTRAINTS ALL IMMEDIATE"), sqlstate("23000"), "a reservation left unreserved, and an authorization missing allocations, cannot commit");
      });
      assert.equal(await count("ledger_authorizations", user), 1, "only the fixture's own bundle authorization exists");
    });
  } finally {
    await pool.end().catch(() => undefined);
    await client.end().catch(() => undefined);
    await dropLedger("reservations");
  }
});
