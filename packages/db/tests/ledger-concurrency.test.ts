import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { grantSyntheticCredits, databaseFor, dropLedger, freshLedger, ledgerPool, ledgerTarget, registerSyntheticGrantSource, syntheticProfileWithWallet } from "./ledger-fixture";
import { getWalletSummary } from "../src/ledger-core";
import { assessQuoteForAuthorization, issueQuote, renewQuote } from "../src/ledger-quotes";
import { authorizeQuote, recordWorkflowRef, releaseReservation } from "../src/ledger-reservations";
import { SYNTHETIC_BUNDLE_HOLD, bundleAllocations, bundleView, consent, currentPricePolicy, eligibilityPort, issueTestQuote, releaseEvidence } from "./ledger-reservation-fixture";

/**
 * The ONLY ledger test file allowed more than 5 pool connections (ADR-0021 D15): up to 110 over one disposable database.
 * Later M7 steps add their 100-way scenarios here. Under CI_REQUIRE_PG_TESTS=1 a degraded pool FAILS the file; locally a
 * degraded pool skips it and the 100-connection row stays NOT_RUN.
 */
const IN_FLIGHT = 100;
// SYNTHETIC_* values: test-only, never exported from src/.
const SYNTHETIC_UNITS = 3;

/** ADR-0021 S3 addendum: a price policy that always reports the version current (no business value, a fixed test double). */
const alwaysCurrentPricePolicy = { isPriceVersionCurrent: async () => true, allocationsFor: async () => { throw new Error("not used by assessQuoteForAuthorization"); } };
/** A minimal valid promo_single_preview QuoteViewV3: 0/0, no allocations, the cheapest shape to race on. */
function syntheticPromoView(quoteId: string, quoteVersionId: string) {
  const issuedAt = new Date().toISOString(), expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  return {
    quoteId, quoteVersionId, issuedAt, expiresAt, pricePolicyVersion: "concurrency-pv", capabilitySnapshotId: "concurrency-cap",
    creditsQuoted: 0, maxHoldUnits: 0,
    wallet: { unit: "credits", availableUnits: 0, reservedUnits: 0, heldForReviewUnits: 0, snapshotAt: issuedAt, walletRevision: "0" },
    consentTextVersion: "concurrency-ctv", included: [] as string[], excluded: [] as string[],
    authorizationHint: { quoteId, checkedAt: issuedAt, canAuthorize: false, reasonCodes: [] as string[], quoteVersionId },
    offerKind: "promo_single_preview" as const, directionId: "concurrency-direction", finalRenderIncludedInThisPurchase: false, physicalGarmentIncluded: false,
  };
}

test("100-way concurrent grants in disposable PostgreSQL", { skip: ledgerTarget.skip }, async t => {
  assert.ok(ledgerTarget.url, "CI_REQUIRE_PG_TESTS=1 requires M7_TEST_POSTGRES_URL or M2_CREATIVE_DATABASE_URL");
  const client = await freshLedger("concurrency");
  let pool!: Awaited<ReturnType<typeof ledgerPool>>["pool"];
  try {
    const sized = await ledgerPool("concurrency", "concurrency"); pool = sized.pool;
    if (sized.degraded) {
      if (ledgerTarget.required) assert.fail(`pool degraded: server allows ${sized.serverMax} connections, ${IN_FLIGHT}-way test needs more (set max_connections)`);
      t.skip("degraded pool: 100-connection row is NOT_RUN"); return;
    }
    assert.ok(sized.max >= IN_FLIGHT && sized.max <= 110, `pool max ${sized.max}`);
    const source = await registerSyntheticGrantSource(client);

    await t.test("100 identical grant commands in flight -> exactly one entry; every caller sees the same command", async () => {
      const user = await syntheticProfileWithWallet(client), idempotencyKey = "concurrent-identical-grant";
      const results = await Promise.all(Array.from({ length: IN_FLIGHT }, () => grantSyntheticCredits(pool, { userId: user, grantSourceId: source, sourceRef: "same-ref", units: SYNTHETIC_UNITS, idempotencyKey })));
      assert.equal(new Set(results.map(r => r.commandId)).size, 1);
      assert.equal(results.filter(r => !r.replayed).length, 1, "exactly one execution; the rest replayed");
      assert.ok(results.every(r => r.entries.length === 1 && r.entries[0]!.entryId === results[0]!.entries[0]!.entryId));
      assert.equal((await client.query("SELECT count(*)::int n FROM vynvori_ledger.ledger_entries WHERE user_id=$1", [user])).rows[0].n, 1);
      assert.equal((await client.query("SELECT count(*)::int n FROM vynvori_ledger.ledger_commands WHERE user_id=$1", [user])).rows[0].n, 1);
      const summary = await getWalletSummary(client, user);
      assert.equal(summary.availableUnits, SYNTHETIC_UNITS); assert.equal(summary.walletRevision, "1");
    });

    await t.test("100 distinct grants in flight -> exact total, 100 revisions, no lost update", async () => {
      const user = await syntheticProfileWithWallet(client);
      const units = Array.from({ length: IN_FLIGHT }, (_, i) => i + 1);
      await Promise.all(units.map(n => grantSyntheticCredits(pool, { userId: user, grantSourceId: source, sourceRef: "distinct-" + n, units: n })));
      const total = units.reduce((a, b) => a + b, 0);
      const summary = await getWalletSummary(client, user);
      assert.equal(summary.availableUnits, total); assert.equal(summary.walletRevision, String(IN_FLIGHT));
      const row = (await client.query("SELECT count(*)::int n, sum(delta_available)::text s, sum(delta_external)::text e FROM vynvori_ledger.ledger_entries WHERE user_id=$1", [user])).rows[0];
      assert.deepEqual({ n: row.n, s: row.s, e: row.e }, { n: IN_FLIGHT, s: String(total), e: String(-total) });
    });

    await t.test("100 same-source_ref grants under distinct keys -> exactly one wins; the rest are DUPLICATE_CAUSE", async () => {
      const user = await syntheticProfileWithWallet(client);
      const settled = await Promise.allSettled(Array.from({ length: IN_FLIGHT }, (_, i) => grantSyntheticCredits(pool, { userId: user, grantSourceId: source, sourceRef: "one-cause", units: SYNTHETIC_UNITS, idempotencyKey: "distinct-key-number-" + i })));
      assert.equal(settled.filter(r => r.status === "fulfilled").length, 1);
      assert.ok(settled.filter(r => r.status === "rejected").every(r => (r as PromiseRejectedResult).reason?.code === "DUPLICATE_CAUSE"));
      assert.equal((await getWalletSummary(client, user)).availableUnits, SYNTHETIC_UNITS);
    });

    // ADR-0021 S3 addendum A1/A3: renewQuote is compare-and-swap, serialized by the quote owner's wallet lock.
    await t.test("A3(a): 100 concurrent renewQuote calls with distinct keys and the same expectedLatestVersionNo -> exactly one succeeds, the rest QUOTE_STALE", async () => {
      const userId = await syntheticProfileWithWallet(client);
      const quoteId = "concurrency-quote-a";
      await issueQuote(pool, { userId, quoteView: syntheticPromoView(quoteId, quoteId + "-v1"), modelRef: "concurrency-model", allocations: [], idempotencyKey: "concurrency-issue-a" });
      const attempts = await Promise.allSettled(Array.from({ length: IN_FLIGHT }, (_, i) =>
        renewQuote(pool, { userId, quoteId, expectedLatestVersionNo: 1, quoteView: syntheticPromoView(quoteId, `${quoteId}-v2-${i}`), modelRef: "concurrency-model", allocations: [], idempotencyKey: `concurrency-renew-a-${i}` })));
      const fulfilled = attempts.filter(r => r.status === "fulfilled");
      assert.equal(fulfilled.length, 1, "exactly one renewal succeeds");
      const rejected = attempts.filter(r => r.status === "rejected").map(r => (r as PromiseRejectedResult).reason as { code?: string });
      assert.equal(rejected.length, IN_FLIGHT - 1);
      assert.ok(rejected.every(e => e.code === "QUOTE_STALE"), "every other renewal is QUOTE_STALE");
      const row = (await client.query("SELECT count(*)::int n FROM vynvori_ledger.ledger_quotes WHERE quote_id = $1", [quoteId])).rows[0];
      assert.equal(row.n, 2, "the table gains exactly one new version row");
      // (d): a superseded version can never be the target of an authorization.
      const stale = await assessQuoteForAuthorization(client, { userId, quoteVersionId: quoteId + "-v1", now: new Date(), pricePolicy: alwaysCurrentPricePolicy });
      assert.deepEqual(stale, { ok: false, code: "QUOTE_STALE" });
    });

    await t.test("A3(b): 100 concurrent renewQuote calls with the same key -> exactly one new version, the identical result for every caller", async () => {
      const userId = await syntheticProfileWithWallet(client);
      const quoteId = "concurrency-quote-b";
      await issueQuote(pool, { userId, quoteView: syntheticPromoView(quoteId, quoteId + "-v1"), modelRef: "concurrency-model", allocations: [], idempotencyKey: "concurrency-issue-b" });
      const view = syntheticPromoView(quoteId, quoteId + "-v2");
      const results = await Promise.all(Array.from({ length: IN_FLIGHT }, () =>
        renewQuote(pool, { userId, quoteId, expectedLatestVersionNo: 1, quoteView: view, modelRef: "concurrency-model", allocations: [], idempotencyKey: "concurrency-renew-b" })));
      assert.ok(results.every(r => r.record.quoteVersionId === quoteId + "-v2" && r.record.versionNo === 2), "every caller sees the identical result");
      const row = (await client.query("SELECT count(*)::int n FROM vynvori_ledger.ledger_quotes WHERE quote_id = $1", [quoteId])).rows[0];
      assert.equal(row.n, 2, "exactly one new version row");
    });

    await t.test("A3(c): a sequential chain of renewQuote calls (each naming the version it just received) produces contiguous versions", async () => {
      const userId = await syntheticProfileWithWallet(client);
      const quoteId = "concurrency-quote-c";
      let latest = await issueQuote(pool, { userId, quoteView: syntheticPromoView(quoteId, quoteId + "-v1"), modelRef: "concurrency-model", allocations: [], idempotencyKey: "concurrency-issue-c" });
      for (let n = 2; n <= 6; n++) {
        latest = await renewQuote(pool, { userId, quoteId, expectedLatestVersionNo: latest.record.versionNo, quoteView: syntheticPromoView(quoteId, `${quoteId}-v${n}`), modelRef: "concurrency-model", allocations: [], idempotencyKey: `concurrency-renew-c-${n}` });
        assert.equal(latest.record.versionNo, n);
      }
      const rows = (await client.query("SELECT version_no FROM vynvori_ledger.ledger_quotes WHERE quote_id = $1 ORDER BY version_no", [quoteId])).rows.map(r => r.version_no as number);
      assert.deepEqual(rows, [1, 2, 3, 4, 5, 6]);
    });


    // ---- S5 (ADR-0021 S5 addendum): authorizations and releases race only through the owner's wallet lock ----------------------
    const authorizeIn = (userId: string, quoteVersionId: string, idempotencyKey: string) =>
      authorizeQuote(pool, { userId, quoteVersionId, idempotencyKey, consent: consent(), now: new Date(), pricePolicy: currentPricePolicy, eligibility: eligibilityPort() });
    const reservedSum = async (userId: string) => Number((await client.query("SELECT coalesce(sum(hold_units), 0)::text s FROM vynvori_ledger.credit_reservations WHERE user_id = $1 AND state = 'reserved'", [userId])).rows[0].s);
    for (const funded of [1, 7]) {
      await t.test(`S5: 100 authorizations of 100 distinct quotes against a wallet funding exactly ${funded} -> exactly ${funded} succeed, the rest INSUFFICIENT_CREDITS; reserved = the sum of reserved holds`, async () => {
        const userId = await syntheticProfileWithWallet(client);
        await grantSyntheticCredits(pool, { userId, grantSourceId: source, sourceRef: `s5-funds-${funded}`, units: funded * SYNTHETIC_BUNDLE_HOLD });
        const versions = await Promise.all(Array.from({ length: IN_FLIGHT }, (_, i) => issueTestQuote(pool, userId, "bundle", `s5-race-${funded}-${i}`)));
        const settled = await Promise.allSettled(versions.map((v, i) => authorizeIn(userId, v, `s5-race-key-${funded}-${String(i).padStart(4, "0")}`)));
        assert.equal(settled.filter(r => r.status === "fulfilled").length, funded);
        assert.ok(settled.filter(r => r.status === "rejected").every(r => (r as PromiseRejectedResult).reason?.code === "INSUFFICIENT_CREDITS"), "every loser is INSUFFICIENT_CREDITS");
        const summary = await getWalletSummary(client, userId);
        assert.deepEqual({ a: summary.availableUnits, r: summary.reservedUnits }, { a: 0, r: funded * SYNTHETIC_BUNDLE_HOLD }, "no bucket went negative; nothing over-reserved");
        assert.equal(await reservedSum(userId), summary.reservedUnits, "wallet reserved == sum of reserved reservation holds");
        assert.equal((await client.query("SELECT count(*)::int n FROM vynvori_ledger.ledger_authorizations WHERE user_id = $1", [userId])).rows[0].n, funded);
      });
    }

    await t.test("S5: 100 identical authorizations (same key) in flight -> exactly one authorization; every caller sees it", async () => {
      const userId = await syntheticProfileWithWallet(client);
      await grantSyntheticCredits(pool, { userId, grantSourceId: source, sourceRef: "s5-same-key", units: 2 * SYNTHETIC_BUNDLE_HOLD });
      const quoteVersionId = await issueTestQuote(pool, userId, "bundle", "s5-same-key-quote");
      const results = await Promise.all(Array.from({ length: IN_FLIGHT }, () => authorizeIn(userId, quoteVersionId, "s5-same-authorize-key")));
      assert.equal(new Set(results.map(r => r.authorizationId)).size, 1);
      assert.equal(results.filter(r => !r.replayed).length, 1, "exactly one execution; the rest replayed");
      const summary = await getWalletSummary(client, userId);
      assert.deepEqual({ a: summary.availableUnits, r: summary.reservedUnits }, { a: SYNTHETIC_BUNDLE_HOLD, r: SYNTHETIC_BUNDLE_HOLD });
      assert.equal((await client.query("SELECT count(*)::int n FROM vynvori_ledger.credit_reservations WHERE user_id = $1", [userId])).rows[0].n, bundleAllocations.length);
    });

    await t.test("S5: 50 renewals and 50 authorizations of version 1 race -> exactly one of them succeeds; at most one authorization per lineage, never one of a superseded version", async () => {
      const userId = await syntheticProfileWithWallet(client);
      await grantSyntheticCredits(pool, { userId, grantSourceId: source, sourceRef: "s5-renew-race", units: 2 * SYNTHETIC_BUNDLE_HOLD });
      const quoteId = "s5-renew-race-quote", v1 = await issueTestQuote(pool, userId, "bundle", quoteId);
      const half = IN_FLIGHT / 2;
      const settled = await Promise.allSettled(Array.from({ length: IN_FLIGHT }, (_, i) => i % 2 === 0
        ? renewQuote(pool, { userId, quoteId, expectedLatestVersionNo: 1, quoteView: bundleView(quoteId, `${quoteId}-v2-${i}`), modelRef: "s5-model", allocations: bundleAllocations, idempotencyKey: `s5-renew-race-renew-${i}` })
        : authorizeIn(userId, v1, `s5-renew-race-auth-${String(i).padStart(4, "0")}`)));
      assert.equal(settled.length, 2 * half);
      assert.equal(settled.filter(r => r.status === "fulfilled").length, 1, "exactly one winner");
      assert.ok(settled.filter(r => r.status === "rejected").every(r => (r as PromiseRejectedResult).reason?.code === "QUOTE_STALE"), "every loser is QUOTE_STALE");
      const authorizations = (await client.query("SELECT quote_version_id FROM vynvori_ledger.ledger_authorizations WHERE quote_id = $1", [quoteId])).rows;
      const versions = (await client.query("SELECT max(version_no)::int v FROM vynvori_ledger.ledger_quotes WHERE quote_id = $1", [quoteId])).rows[0].v as number;
      assert.ok((authorizations.length === 1 && versions === 1) || (authorizations.length === 0 && versions === 2), `either v1 was authorized and never renewed, or it was renewed and never authorized (auth ${authorizations.length}, latest v${versions})`);
      assert.equal(await reservedSum(userId), (await getWalletSummary(client, userId)).reservedUnits);
    });

    await t.test("S5: 100 releases of one dispatched reservation under distinct keys -> exactly one release, the rest INVALID_TRANSITION; the hold returns once", async () => {
      const userId = await syntheticProfileWithWallet(client);
      await grantSyntheticCredits(pool, { userId, grantSourceId: source, sourceRef: "s5-release-race", units: SYNTHETIC_BUNDLE_HOLD });
      const auth = await authorizeIn(userId, await issueTestQuote(pool, userId, "bundle", "s5-release-race-quote"), "s5-release-race-authorize");
      const target = auth.reservations[0]!;
      await recordWorkflowRef(pool, { userId, component: "workflow", reservationId: target.reservationId, workflowRef: "wf/race-1", idempotencyKey: "s5-release-race-dispatch" });
      const settled = await Promise.allSettled(Array.from({ length: IN_FLIGHT }, (_, i) =>
        releaseReservation(pool, { userId, component: "workflow", reservationId: target.reservationId, evidence: releaseEvidence(target.operationId, `plane-b/${i}`), idempotencyKey: `s5-release-race-${String(i).padStart(4, "0")}` })));
      assert.equal(settled.filter(r => r.status === "fulfilled").length, 1);
      assert.ok(settled.filter(r => r.status === "rejected").every(r => (r as PromiseRejectedResult).reason?.code === "INVALID_TRANSITION"));
      const summary = await getWalletSummary(client, userId);
      assert.deepEqual({ a: summary.availableUnits, r: summary.reservedUnits }, { a: target.holdUnits, r: SYNTHETIC_BUNDLE_HOLD - target.holdUnits });
      assert.equal((await client.query("SELECT count(*)::int n FROM vynvori_ledger.ledger_entries WHERE reservation_id = $1 AND entry_kind = 'release'", [target.reservationId])).rows[0].n, 1);
    });

    await t.test("A2 fail-safe: two raw connections (no runLedgerCommand, no wallet lock) race to insert version k+1 directly -> exactly one succeeds, never a duplicate, never a gap", async () => {
      const userId = await syntheticProfileWithWallet(client);
      const quoteId = "concurrency-quote-a2";
      await issueQuote(pool, { userId, quoteView: syntheticPromoView(quoteId, quoteId + "-v1"), modelRef: "concurrency-model", allocations: [], idempotencyKey: "concurrency-issue-a2" });
      const secondUrl = new URL(ledgerTarget.url!); secondUrl.pathname = "/" + databaseFor("concurrency");
      const second = new Client({ connectionString: secondUrl.toString() });
      await second.connect();
      try {
        const insertRaw = (conn: Client, quoteVersionId: string) => conn.query(
          `INSERT INTO vynvori_ledger.ledger_quotes(quote_version_id,quote_id,version_no,user_id,operation_kind,model_ref,max_charge_units,credits_quoted,issued_at,expires_at,price_version,capability_snapshot_id,consent_text_version,quote_view,content_sha256)
           VALUES($1,$2,2,$3,'promo_single_preview','concurrency-model',0,0,now(),now() + interval '1 hour','concurrency-pv','concurrency-cap','concurrency-ctv','{}'::jsonb,repeat('a',64))`,
          [quoteVersionId, quoteId, userId]);
        const settled = await Promise.allSettled([insertRaw(client, `${quoteId}-a2-x`), insertRaw(second, `${quoteId}-a2-y`)]);
        assert.equal(settled.filter(r => r.status === "fulfilled").length, 1, "exactly one of the two raw inserts succeeds");
        const rejection = settled.find(r => r.status === "rejected") as PromiseRejectedResult;
        const code = (rejection.reason as { code?: string }).code;
        assert.ok(code === "23505" || code === "23000", `unexpected SQLSTATE ${code}`);
        const rows = (await client.query("SELECT version_no FROM vynvori_ledger.ledger_quotes WHERE quote_id = $1 ORDER BY version_no", [quoteId])).rows.map(r => r.version_no as number);
        assert.deepEqual(rows, [1, 2], "no duplicate, no gap");
      } finally { await second.end().catch(() => undefined); }
    });
  } finally { await pool?.end().catch(() => undefined); await client.end().catch(() => undefined); await dropLedger("concurrency"); }
});
