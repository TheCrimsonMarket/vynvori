import test from "node:test";
import assert from "node:assert/strict";
import { QuoteViewV3Schema } from "@vynvori/contracts";
import { LedgerQuoteRecordV1Schema } from "@vynvori/contracts/ledger-internal";
import { LedgerBusinessRejection, LedgerError } from "../src/ledger-core";
import { assessQuoteForAuthorization, getLatestQuoteVersion, getQuote, issueQuote, renewQuote } from "../src/ledger-quotes";
import { dropLedger, freshLedger, ledgerPool, ledgerTarget, syntheticProfileWithWallet } from "./ledger-fixture";

/**
 * ADR-0021 S3 addendum: ledger_quote_lineages / ledger_quotes / ledger_quote_allocations DDL + store behaviour.
 * Non-concurrency file: pool capped at 5 (D15); declared peak connections = 5 (pool) + 1 (persistent fixture client) = 6.
 * SYNTHETIC_* values below are test-only, never exported from src/.
 */
const SYNTHETIC_MAX_HOLD = 10, SYNTHETIC_CREDITS = 8;
const alwaysCurrentPricePolicy = { isPriceVersionCurrent: async () => true, allocationsFor: async () => { throw new Error("not used by assessQuoteForAuthorization"); } };
const neverCurrentPricePolicy = { isPriceVersionCurrent: async () => false, allocationsFor: async () => { throw new Error("not used by assessQuoteForAuthorization"); } };
const code = (c: string) => (e: unknown) => e instanceof LedgerError && e.code === c;
const rejection = (c: string) => (e: unknown) => e instanceof LedgerBusinessRejection && e.code === c;
const sqlCode = (c: string) => (e: unknown) => (e as { code?: string }).code === c;

/** A minimal valid promo_single_preview QuoteViewV3: 0/0, no allocations. */
function promoView(quoteId: string, quoteVersionId: string, overrides: Record<string, unknown> = {}) {
  const issuedAt = (overrides.issuedAt as string) ?? new Date().toISOString();
  const expiresAt = (overrides.expiresAt as string) ?? new Date(Date.parse(issuedAt) + 3_600_000).toISOString();
  return {
    quoteId, quoteVersionId, issuedAt, expiresAt, pricePolicyVersion: "quotes-pv", capabilitySnapshotId: "quotes-cap",
    creditsQuoted: 0, maxHoldUnits: 0,
    wallet: { unit: "credits", availableUnits: 0, reservedUnits: 0, heldForReviewUnits: 0, snapshotAt: issuedAt, walletRevision: "0" },
    consentTextVersion: "quotes-ctv", included: [] as string[], excluded: [] as string[],
    authorizationHint: { quoteId, checkedAt: issuedAt, canAuthorize: false, reasonCodes: [] as string[], quoteVersionId },
    offerKind: "promo_single_preview" as const, directionId: "quotes-direction", finalRenderIncludedInThisPurchase: false as const, physicalGarmentIncluded: false as const,
    ...overrides,
  };
}

/** A minimal valid concept_bundle_3x2 QuoteViewV3 that needs allocations (SYNTHETIC_MAX_HOLD / SYNTHETIC_CREDITS). */
function bundleView(quoteId: string, quoteVersionId: string, overrides: Record<string, unknown> = {}) {
  const issuedAt = (overrides.issuedAt as string) ?? new Date().toISOString();
  const expiresAt = (overrides.expiresAt as string) ?? new Date(Date.parse(issuedAt) + 3_600_000).toISOString();
  return {
    quoteId, quoteVersionId, issuedAt, expiresAt, pricePolicyVersion: "quotes-pv", capabilitySnapshotId: "quotes-cap",
    creditsQuoted: SYNTHETIC_CREDITS, maxHoldUnits: SYNTHETIC_MAX_HOLD,
    wallet: { unit: "credits", availableUnits: 0, reservedUnits: 0, heldForReviewUnits: 0, snapshotAt: issuedAt, walletRevision: "0" },
    consentTextVersion: "quotes-ctv", included: [] as string[], excluded: [] as string[],
    authorizationHint: { quoteId, checkedAt: issuedAt, canAuthorize: false, reasonCodes: [] as string[], quoteVersionId },
    offerKind: "concept_bundle_3x2" as const,
    projectId: "proj-1", approvedPlanVersionId: "plan-v1",
    directionIds: ["d1", "d2", "d3"] as const,
    includedRefinements: 2 as const, finalRenderIncludedInThisPurchase: false as const, physicalGarmentIncluded: false as const,
    downstreamEligibility: {
      region: "US", evaluatedAt: issuedAt,
      uses: [
        { kind: "digital_art_export", status: "eligible", region: "US", rightsDecision: "commercial_use_permitted", rightsPolicyVersion: "rp-1", restrictions: [] as string[], exclusionReasonCodes: [] as string[], humanSummary: "ok" },
        { kind: "personalized_garment", status: "ineligible", region: "US", rightsDecision: "not_permitted", rightsPolicyVersion: null, restrictions: [] as string[], exclusionReasonCodes: [] as string[], humanSummary: "no" },
      ],
      quotedEligibleUses: ["digital_art_export"] as const, rightsNoticeVersion: "rn-1",
    },
    standardFinalQualified: true as const, promoOffsetCredits: 0 as const,
    paidTerms: { customerConsentTermsVersion: "cc-1", expiryTermsVersion: "ex-1", partialRemedyTermsVersion: "pr-1", rightsNoticeVersion: "rn-1", qualityRemedyTermsVersion: "qr-1", refinementClosureNoticeVersion: null },
    ...overrides,
  };
}
const bundleAllocations = [{ operationIndex: 0, holdUnits: SYNTHETIC_MAX_HOLD, chargeUnits: SYNTHETIC_CREDITS }];

test("ledger quotes: DDL + store behaviour in disposable PostgreSQL", { skip: ledgerTarget.skip }, async t => {
  assert.ok(ledgerTarget.url, "CI_REQUIRE_PG_TESTS=1 requires M7_TEST_POSTGRES_URL or M2_CREATIVE_DATABASE_URL");
  const client = await freshLedger("quotes");
  const { pool } = await ledgerPool("quotes", "standard");
  const insertedAt = () => new Date();

  /** Raw-SQL seeds, bypassing ledger-quotes.ts entirely (used to exercise the DB backstop, not the TS validation). */
  const rawLineage = (quoteId: string, userId: string) => client.query(`INSERT INTO vynvori_ledger.ledger_quote_lineages(quote_id,user_id) VALUES($1,$2)`, [quoteId, userId]);
  const rawQuote = (row: { quoteVersionId: string; quoteId: string; versionNo: number; userId: string; operationKind: string; maxChargeUnits: number; creditsQuoted: number }) => client.query(
    `INSERT INTO vynvori_ledger.ledger_quotes(quote_version_id,quote_id,version_no,user_id,operation_kind,model_ref,max_charge_units,credits_quoted,issued_at,expires_at,price_version,capability_snapshot_id,consent_text_version,quote_view,content_sha256)
     VALUES($1,$2,$3,$4,$5,'raw-model',$6,$7,now(),now() + interval '1 hour','raw-pv','raw-cap','raw-ctv','{}'::jsonb,repeat('a',64))`,
    [row.quoteVersionId, row.quoteId, row.versionNo, row.userId, row.operationKind, row.maxChargeUnits, row.creditsQuoted]);
  const rawAllocation = (quoteVersionId: string, operationIndex: number, holdUnits: number, chargeUnits: number) => client.query(
    `INSERT INTO vynvori_ledger.ledger_quote_allocations(quote_version_id,operation_index,hold_units,charge_units) VALUES($1,$2,$3,$4)`, [quoteVersionId, operationIndex, holdUnits, chargeUnits]);

  try {
    await t.test("immutability: UPDATE/DELETE/TRUNCATE on all three tables are rejected append-only (23000), including TRUNCATE profiles CASCADE", async () => {
      const userId = await syntheticProfileWithWallet(client);
      const quoteId = "immutable-quote";
      await issueQuote(pool, { userId, quoteView: promoView(quoteId, quoteId + "-v1"), modelRef: "m", allocations: [], idempotencyKey: "immutable-issue-1" });

      await assert.rejects(client.query("UPDATE vynvori_ledger.ledger_quote_lineages SET created_at = created_at"), sqlCode("23000"));
      await assert.rejects(client.query("DELETE FROM vynvori_ledger.ledger_quote_lineages"), sqlCode("23000"));
      // CASCADE: ledger_quotes has rows referencing this table, so a plain TRUNCATE hits Postgres's own FK-reference
      // check (0A000) before any trigger runs; CASCADE reaches the dependents too, where the append-only guard fires.
      await assert.rejects(client.query("TRUNCATE vynvori_ledger.ledger_quote_lineages CASCADE"), sqlCode("23000"));
      await assert.rejects(client.query("UPDATE vynvori_ledger.ledger_quotes SET model_ref = model_ref"), sqlCode("23000"));
      await assert.rejects(client.query("DELETE FROM vynvori_ledger.ledger_quotes"), sqlCode("23000"));
      await assert.rejects(client.query("TRUNCATE vynvori_ledger.ledger_quotes CASCADE"), sqlCode("23000"));

      const bundleUser = await syntheticProfileWithWallet(client);
      const bundleId = "immutable-bundle";
      await issueQuote(pool, { userId: bundleUser, quoteView: bundleView(bundleId, bundleId + "-v1"), modelRef: "m", allocations: bundleAllocations, idempotencyKey: "immutable-issue-2" });
      await assert.rejects(client.query("UPDATE vynvori_ledger.ledger_quote_allocations SET hold_units = hold_units"), sqlCode("23000"));
      await assert.rejects(client.query("DELETE FROM vynvori_ledger.ledger_quote_allocations"), sqlCode("23000"));
      await assert.rejects(client.query("TRUNCATE vynvori_ledger.ledger_quote_allocations"), sqlCode("23000"));

      // TRUNCATE ... CASCADE on the identity table must still reach the live append-only triggers rather than succeed silently.
      await assert.rejects(client.query("TRUNCATE vynvori_identity.profiles CASCADE"), sqlCode("23000"));
      assert.equal((await client.query("SELECT count(*)::int n FROM vynvori_ledger.ledger_quotes")).rows[0].n, 2, "nothing was removed");
    });

    await t.test("lineage isolation: a second user cannot add a version under another user's quote_id (23503)", async () => {
      const owner = await syntheticProfileWithWallet(client);
      const stranger = await syntheticProfileWithWallet(client);
      const quoteId = "isolated-quote";
      await issueQuote(pool, { userId: owner, quoteView: promoView(quoteId, quoteId + "-v1"), modelRef: "m", allocations: [], idempotencyKey: "isolated-issue-key" });
      await assert.rejects(rawLineage(quoteId, stranger), sqlCode("23505"), "the lineage PK itself forbids a second owner");
      await assert.rejects(rawQuote({ quoteVersionId: quoteId + "-v2", quoteId, versionNo: 2, userId: stranger, operationKind: "promo_single_preview", maxChargeUnits: 0, creditsQuoted: 0 }), sqlCode("23503"), "a foreign user_id fails the composite lineage FK");
      await assert.rejects(renewQuote(pool, { userId: stranger, quoteId, expectedLatestVersionNo: 1, quoteView: promoView(quoteId, quoteId + "-v2"), modelRef: "m", allocations: [], idempotencyKey: "isolated-renew-key" }), code("NOT_FOUND"));
    });

    await t.test("version_no must be contiguous: a gap or reuse is rejected (23000)", async () => {
      const userId = await syntheticProfileWithWallet(client);
      const quoteId = "contiguity-quote";
      await rawLineage(quoteId, userId);
      await rawQuote({ quoteVersionId: quoteId + "-v1", quoteId, versionNo: 1, userId, operationKind: "promo_single_preview", maxChargeUnits: 0, creditsQuoted: 0 });
      await assert.rejects(rawQuote({ quoteVersionId: quoteId + "-v3", quoteId, versionNo: 3, userId, operationKind: "promo_single_preview", maxChargeUnits: 0, creditsQuoted: 0 }), sqlCode("23000"), "gap");
      await assert.rejects(rawQuote({ quoteVersionId: quoteId + "-v1b", quoteId, versionNo: 1, userId, operationKind: "promo_single_preview", maxChargeUnits: 0, creditsQuoted: 0 }), sqlCode("23000"), "reuse (trigger first)");
      await rawQuote({ quoteVersionId: quoteId + "-v2", quoteId, versionNo: 2, userId, operationKind: "promo_single_preview", maxChargeUnits: 0, creditsQuoted: 0 });
      assert.deepEqual((await client.query("SELECT version_no FROM vynvori_ledger.ledger_quotes WHERE quote_id = $1 ORDER BY version_no", [quoteId])).rows.map(r => r.version_no), [1, 2]);
    });

    await t.test("operation_kind cannot change across versions (23000)", async () => {
      const userId = await syntheticProfileWithWallet(client);
      const quoteId = "operation-kind-quote";
      await rawLineage(quoteId, userId);
      await rawQuote({ quoteVersionId: quoteId + "-v1", quoteId, versionNo: 1, userId, operationKind: "promo_single_preview", maxChargeUnits: 0, creditsQuoted: 0 });
      // Isolated from the allocation-sum trigger: v2 carries a matching allocation, so only the kind-consistency
      // check (a synchronous BEFORE INSERT trigger) can reject this -- the deferred sum check would otherwise pass.
      await client.query("BEGIN");
      try {
        await assert.rejects((async () => {
          await rawQuote({ quoteVersionId: quoteId + "-v2", quoteId, versionNo: 2, userId, operationKind: "final_standard", maxChargeUnits: 1, creditsQuoted: 1 });
          await rawAllocation(quoteId + "-v2", 0, 1, 1);
          await client.query("COMMIT");
        })(), sqlCode("23000"));
      } finally { await client.query("ROLLBACK").catch(() => undefined); }
    });

    await t.test("promo must be 0/0 with zero allocations; non-promo requires allocations summing exactly, contiguous from 0; a zero-unit allocation is a CHECK violation", async () => {
      const userId = await syntheticProfileWithWallet(client);

      // missing allocations for a non-promo quote: the COMMIT fails (deferred trigger), not the INSERT itself.
      await client.query("BEGIN");
      try {
        const quoteId = "missing-alloc-quote";
        await rawLineage(quoteId, userId);
        await rawQuote({ quoteVersionId: quoteId + "-v1", quoteId, versionNo: 1, userId, operationKind: "concept_bundle_3x2", maxChargeUnits: SYNTHETIC_MAX_HOLD, creditsQuoted: SYNTHETIC_CREDITS });
        await assert.rejects(client.query("COMMIT"), sqlCode("23000"));
      } finally { await client.query("ROLLBACK").catch(() => undefined); }

      // sums off by one, either direction.
      for (const [label, hold, charge] of [["hold-plus-1", SYNTHETIC_MAX_HOLD + 1, SYNTHETIC_CREDITS], ["hold-minus-1", SYNTHETIC_MAX_HOLD - 1, SYNTHETIC_CREDITS], ["charge-plus-1", SYNTHETIC_MAX_HOLD, SYNTHETIC_CREDITS + 1], ["charge-minus-1", SYNTHETIC_MAX_HOLD, SYNTHETIC_CREDITS - 1]] as const) {
        await client.query("BEGIN");
        try {
          const quoteId = "off-by-one-" + label;
          await rawLineage(quoteId, userId);
          await rawQuote({ quoteVersionId: quoteId + "-v1", quoteId, versionNo: 1, userId, operationKind: "concept_bundle_3x2", maxChargeUnits: SYNTHETIC_MAX_HOLD, creditsQuoted: SYNTHETIC_CREDITS });
          await rawAllocation(quoteId + "-v1", 0, hold, charge); // deliberately off by one from the quote's own totals
          await assert.rejects(client.query("COMMIT"), sqlCode("23000"), label);
        } finally { await client.query("ROLLBACK").catch(() => undefined); }
      }

      // non-contiguous operation_index.
      await client.query("BEGIN");
      try {
        const quoteId = "non-contiguous-quote";
        await rawLineage(quoteId, userId);
        await rawQuote({ quoteVersionId: quoteId + "-v1", quoteId, versionNo: 1, userId, operationKind: "concept_bundle_3x2", maxChargeUnits: 2, creditsQuoted: 2 });
        await rawAllocation(quoteId + "-v1", 0, 1, 1);
        await rawAllocation(quoteId + "-v1", 2, 1, 1); // index 1 skipped
        await assert.rejects(client.query("COMMIT"), sqlCode("23000"));
      } finally { await client.query("ROLLBACK").catch(() => undefined); }

      // promo with a stray allocation row: the COMMIT fails.
      await client.query("BEGIN");
      try {
        const quoteId = "promo-with-alloc-quote";
        await rawLineage(quoteId, userId);
        await rawQuote({ quoteVersionId: quoteId + "-v1", quoteId, versionNo: 1, userId, operationKind: "promo_single_preview", maxChargeUnits: 0, creditsQuoted: 0 });
        await rawAllocation(quoteId + "-v1", 0, 1, 1);
        await assert.rejects(client.query("COMMIT"), sqlCode("23000"));
      } finally { await client.query("ROLLBACK").catch(() => undefined); }

      // a zero-unit allocation is a plain CHECK violation (23514), independent of the deferred sum check. Each
      // attempt gets its own transaction: a failed statement aborts the rest of an open transaction in Postgres.
      for (const [label, hold, charge] of [["hold-zero", 0, 1], ["charge-zero", 1, 0]] as const) {
        await client.query("BEGIN");
        try {
          const quoteId = "zero-unit-quote-" + label;
          await rawLineage(quoteId, userId);
          await rawQuote({ quoteVersionId: quoteId + "-v1", quoteId, versionNo: 1, userId, operationKind: "concept_bundle_3x2", maxChargeUnits: 1, creditsQuoted: 1 });
          await assert.rejects(rawAllocation(quoteId + "-v1", 0, hold, charge), sqlCode("23514"), label);
        } finally { await client.query("ROLLBACK").catch(() => undefined); }
      }

      // the real store, via issueQuote, surfaces the SAME shape rules as a persisted ALLOCATION_INVALID business rejection.
      const bundleId = "code-level-alloc-invalid";
      await assert.rejects(
        issueQuote(pool, { userId, quoteView: bundleView(bundleId, bundleId + "-v1"), modelRef: "m", allocations: [{ operationIndex: 0, holdUnits: SYNTHETIC_MAX_HOLD, chargeUnits: SYNTHETIC_CREDITS - 1 }], idempotencyKey: "code-level-alloc-invalid-key" }),
        rejection("ALLOCATION_INVALID"),
      );
    });

    await t.test("a late allocation inserted in a separate transaction is rejected (breaks the sum at that transaction's own commit)", async () => {
      const userId = await syntheticProfileWithWallet(client);
      const quoteId = "late-alloc-quote";
      await issueQuote(pool, { userId, quoteView: bundleView(quoteId, quoteId + "-v1"), modelRef: "m", allocations: bundleAllocations, idempotencyKey: "late-alloc-issue" });
      await assert.rejects(rawAllocation(quoteId + "-v1", 1, 1, 1), sqlCode("23000"));
      assert.equal((await client.query("SELECT count(*)::int n FROM vynvori_ledger.ledger_quote_allocations WHERE quote_version_id = $1", [quoteId + "-v1"])).rows[0].n, 1, "only the original allocation remains");
    });

    await t.test("expires_at <= issued_at, credits_quoted > max_charge_units, and over-bound numbers are all rejected (23514)", async () => {
      const userId = await syntheticProfileWithWallet(client);
      const SAFE_MAX = 9007199254740991;

      // Contract-level: QuoteViewV3Schema itself refines expiresAt > issuedAt, so an invalid view never reaches SQL via issueQuote.
      await assert.rejects(issueQuote(pool, { userId, quoteView: promoView("bounds-expires-before-issued", "bounds-expires-before-issued-v1", { issuedAt: new Date(Date.now() + 10_000).toISOString(), expiresAt: new Date().toISOString() }), modelRef: "m", allocations: [], idempotencyKey: "bounds-issue-key-expires-before" }), (e: unknown) => e instanceof LedgerError, "expires before issued");

      // DB-level backstop: a direct insert bypassing the contract still hits the CHECK constraint.
      const expiresQuoteId = "bounds-expires-equal-raw";
      await rawLineage(expiresQuoteId, userId);
      await assert.rejects(client.query(
        `INSERT INTO vynvori_ledger.ledger_quotes(quote_version_id,quote_id,version_no,user_id,operation_kind,model_ref,max_charge_units,credits_quoted,issued_at,expires_at,price_version,capability_snapshot_id,consent_text_version,quote_view,content_sha256)
         VALUES($1,$2,1,$3,'promo_single_preview','raw-model',0,0,now(),now(),'raw-pv','raw-cap','raw-ctv','{}'::jsonb,repeat('a',64))`,
        [expiresQuoteId + "-v1", expiresQuoteId, userId],
      ), sqlCode("23514"), "expires_at == issued_at");

      const quoteId = "bounds-credits-over-max";
      await rawLineage(quoteId, userId);
      await assert.rejects(rawQuote({ quoteVersionId: quoteId + "-v1", quoteId, versionNo: 1, userId, operationKind: "concept_bundle_3x2", maxChargeUnits: 5, creditsQuoted: 6 }), sqlCode("23514"), "credits_quoted > max_charge_units");
      const overQuoteId = "bounds-over-safe-max";
      await rawLineage(overQuoteId, userId);
      await assert.rejects(rawQuote({ quoteVersionId: overQuoteId + "-v1", quoteId: overQuoteId, versionNo: 1, userId, operationKind: "concept_bundle_3x2", maxChargeUnits: SAFE_MAX + 1, creditsQuoted: 1 }), sqlCode("23514"), "max_charge_units over the safe-integer bound");
    });

    await t.test("the stored view re-parses with QuoteViewV3Schema and LedgerQuoteRecordV1Schema, and the hash matches", async () => {
      const userId = await syntheticProfileWithWallet(client);
      const quoteId = "reparse-quote";
      const issued = await issueQuote(pool, { userId, quoteView: bundleView(quoteId, quoteId + "-v1"), modelRef: "m", allocations: bundleAllocations, idempotencyKey: "reparse-issue-key" });
      assert.doesNotThrow(() => QuoteViewV3Schema.parse(issued.record.quoteView));
      assert.doesNotThrow(() => LedgerQuoteRecordV1Schema.parse(issued.record));
      const row = (await client.query("SELECT content_sha256 FROM vynvori_ledger.ledger_quotes WHERE quote_version_id = $1", [quoteId + "-v1"])).rows[0];
      assert.equal(row.content_sha256, issued.record.contentSha256);
      assert.match(row.content_sha256, /^[0-9a-f]{64}$/);
    });

    await t.test("a tampered row is detected by assess and fails closed (DATABASE_ERROR), never authorizable", async () => {
      const userId = await syntheticProfileWithWallet(client);
      const quoteId = "tampered-quote";
      await issueQuote(pool, { userId, quoteView: bundleView(quoteId, quoteId + "-v1"), modelRef: "m", allocations: bundleAllocations, idempotencyKey: "tampered-issue-key" });
      // The table is append-only even to a superuser; corrupting it for this test needs the same audited break-glass
      // path as the rest of the ledger (ALTER TABLE ... DISABLE TRIGGER), on a disposable database only.
      await client.query("ALTER TABLE vynvori_ledger.ledger_quotes DISABLE TRIGGER ledger_quotes_immutable");
      try {
        await client.query("UPDATE vynvori_ledger.ledger_quotes SET content_sha256 = repeat('b', 64) WHERE quote_version_id = $1", [quoteId + "-v1"]);
      } finally { await client.query("ALTER TABLE vynvori_ledger.ledger_quotes ENABLE TRIGGER ledger_quotes_immutable"); }
      const assessment = await assessQuoteForAuthorization(client, { userId, quoteVersionId: quoteId + "-v1", now: insertedAt(), pricePolicy: alwaysCurrentPricePolicy });
      assert.deepEqual(assessment, { ok: false, code: "DATABASE_ERROR" });
    });

    await t.test("superseded -> QUOTE_STALE; expiry boundary (now == expiresAt is expired, 1ms earlier is ok); price_version mismatch -> QUOTE_STALE; check order (superseded AND expired reports QUOTE_STALE)", async () => {
      const userId = await syntheticProfileWithWallet(client);
      const quoteId = "assess-order-quote";
      const v1 = await issueQuote(pool, { userId, quoteView: promoView(quoteId, quoteId + "-v1"), modelRef: "m", allocations: [], idempotencyKey: "assess-order-issue" });
      await renewQuote(pool, { userId, quoteId, expectedLatestVersionNo: 1, quoteView: promoView(quoteId, quoteId + "-v2"), modelRef: "m", allocations: [], idempotencyKey: "assess-order-renew" });

      assert.deepEqual(await assessQuoteForAuthorization(client, { userId, quoteVersionId: v1.record.quoteVersionId, now: insertedAt(), pricePolicy: alwaysCurrentPricePolicy }), { ok: false, code: "QUOTE_STALE" }, "superseded");

      const boundaryId = "assess-expiry-boundary";
      const issuedAt = new Date().toISOString(), expiresAt = new Date(Date.now() + 60_000).toISOString();
      const boundary = await issueQuote(pool, { userId, quoteView: promoView(boundaryId, boundaryId + "-v1", { issuedAt, expiresAt }), modelRef: "m", allocations: [], idempotencyKey: "assess-expiry-issue" });
      assert.deepEqual(await assessQuoteForAuthorization(client, { userId, quoteVersionId: boundary.record.quoteVersionId, now: new Date(Date.parse(expiresAt)), pricePolicy: alwaysCurrentPricePolicy }), { ok: false, code: "QUOTE_EXPIRED" }, "now == expiresAt is expired");
      assert.deepEqual(await assessQuoteForAuthorization(client, { userId, quoteVersionId: boundary.record.quoteVersionId, now: new Date(Date.parse(expiresAt) - 1), pricePolicy: alwaysCurrentPricePolicy }), { ok: true }, "1ms earlier is ok");

      const priceId = "assess-price-mismatch";
      const priced = await issueQuote(pool, { userId, quoteView: promoView(priceId, priceId + "-v1"), modelRef: "m", allocations: [], idempotencyKey: "assess-price-issue" });
      assert.deepEqual(await assessQuoteForAuthorization(client, { userId, quoteVersionId: priced.record.quoteVersionId, now: insertedAt(), pricePolicy: neverCurrentPricePolicy }), { ok: false, code: "QUOTE_STALE" });

      // superseded AND expired reports QUOTE_STALE (the staleness check comes first).
      const expiredId = "assess-superseded-and-expired";
      const expiredIssuedAt = new Date(Date.now() - 7_200_000).toISOString(), expiredExpiresAt = new Date(Date.now() - 3_600_000).toISOString();
      const expired = await issueQuote(pool, { userId, quoteView: promoView(expiredId, expiredId + "-v1", { issuedAt: expiredIssuedAt, expiresAt: expiredExpiresAt }), modelRef: "m", allocations: [], idempotencyKey: "assess-superseded-issue" });
      await renewQuote(pool, { userId, quoteId: expiredId, expectedLatestVersionNo: 1, quoteView: promoView(expiredId, expiredId + "-v2", { issuedAt: expiredIssuedAt, expiresAt: expiredExpiresAt }), modelRef: "m", allocations: [], idempotencyKey: "assess-superseded-renew" });
      assert.deepEqual(await assessQuoteForAuthorization(client, { userId, quoteVersionId: expired.record.quoteVersionId, now: insertedAt(), pricePolicy: alwaysCurrentPricePolicy }), { ok: false, code: "QUOTE_STALE" });
    });

    await t.test("owner-scoped reads: a foreign quote and an absent quote are the identical NOT_FOUND", async () => {
      const owner = await syntheticProfileWithWallet(client);
      const stranger = await syntheticProfileWithWallet(client);
      const quoteId = "owner-scoped-quote";
      const issued = await issueQuote(pool, { userId: owner, quoteView: promoView(quoteId, quoteId + "-v1"), modelRef: "m", allocations: [], idempotencyKey: "owner-scoped-issue" });
      await assert.rejects(getQuote(client, stranger, issued.record.quoteVersionId), code("NOT_FOUND"));
      await assert.rejects(getQuote(client, owner, "no-such-quote-version"), code("NOT_FOUND"));
      await assert.rejects(getLatestQuoteVersion(client, stranger, quoteId), code("NOT_FOUND"));
      await assert.rejects(getLatestQuoteVersion(client, owner, "no-such-quote"), code("NOT_FOUND"));
    });

    await t.test("idempotency: same key + same payload replays the same quote without a new version; same key + different payload is IDEMPOTENCY_CONFLICT", async () => {
      const userId = await syntheticProfileWithWallet(client);
      const quoteId = "idempotent-issue-quote";
      const view = promoView(quoteId, quoteId + "-v1");
      const first = await issueQuote(pool, { userId, quoteView: view, modelRef: "m", allocations: [], idempotencyKey: "idempotent-issue-key" });
      const replay = await issueQuote(pool, { userId, quoteView: view, modelRef: "m", allocations: [], idempotencyKey: "idempotent-issue-key" });
      assert.deepEqual(replay.record, first.record);
      assert.equal((await client.query("SELECT count(*)::int n FROM vynvori_ledger.ledger_quotes WHERE quote_id = $1", [quoteId])).rows[0].n, 1);
      await assert.rejects(issueQuote(pool, { userId, quoteView: promoView(quoteId + "-other", quoteId + "-other-v1"), modelRef: "m", allocations: [], idempotencyKey: "idempotent-issue-key" }), code("IDEMPOTENCY_CONFLICT"));

      const renewQuoteId = "idempotent-renew-quote";
      await issueQuote(pool, { userId, quoteView: promoView(renewQuoteId, renewQuoteId + "-v1"), modelRef: "m", allocations: [], idempotencyKey: "idempotent-renew-issue" });
      const renewView = promoView(renewQuoteId, renewQuoteId + "-v2");
      const firstRenew = await renewQuote(pool, { userId, quoteId: renewQuoteId, expectedLatestVersionNo: 1, quoteView: renewView, modelRef: "m", allocations: [], idempotencyKey: "idempotent-renew-key" });
      const replayRenew = await renewQuote(pool, { userId, quoteId: renewQuoteId, expectedLatestVersionNo: 1, quoteView: renewView, modelRef: "m", allocations: [], idempotencyKey: "idempotent-renew-key" });
      assert.deepEqual(replayRenew.record, firstRenew.record);
      assert.equal((await client.query("SELECT count(*)::int n FROM vynvori_ledger.ledger_quotes WHERE quote_id = $1", [renewQuoteId])).rows[0].n, 2);
    });

    await t.test("a persisted ALLOCATION_INVALID rejection replays identically and never re-runs the callback; errors never contain the idempotency key", async () => {
      const userId = await syntheticProfileWithWallet(client);
      const quoteId = "persisted-rejection-quote";
      const invalidView = bundleView(quoteId, quoteId + "-v1");
      const badAllocations = [{ operationIndex: 0, holdUnits: SYNTHETIC_MAX_HOLD, chargeUnits: SYNTHETIC_CREDITS - 1 }];
      const key = "persisted-rejection-key";
      const first = await issueQuote(pool, { userId, quoteView: invalidView, modelRef: "m", allocations: badAllocations, idempotencyKey: key }).catch(e => e);
      assert.ok(first instanceof LedgerBusinessRejection && first.code === "ALLOCATION_INVALID");
      const replay = await issueQuote(pool, { userId, quoteView: invalidView, modelRef: "m", allocations: badAllocations, idempotencyKey: key }).catch(e => e);
      assert.ok(replay instanceof LedgerBusinessRejection && replay.code === "ALLOCATION_INVALID" && (replay as LedgerBusinessRejection).replayed === true);
      assert.equal((await client.query("SELECT count(*)::int n FROM vynvori_ledger.ledger_quotes WHERE quote_id = $1", [quoteId])).rows[0].n, 0, "the callback never ran: no quote row exists");
      assert.equal((await client.query("SELECT count(*)::int n FROM vynvori_ledger.ledger_commands WHERE idempotency_key = $1", [key])).rows[0].n, 1, "exactly one rejected command row, not one per attempt");

      for (const error of [first, replay]) {
        const message = JSON.stringify(error, Object.getOwnPropertyNames(error));
        assert.doesNotMatch(message, new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      }
    });
  } finally { await pool.end().catch(() => undefined); await client.end().catch(() => undefined); await dropLedger("quotes"); }
});
