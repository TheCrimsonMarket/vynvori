import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { conceptBundleQuoteFixture } from "./fixtures";
import { QuoteViewV3Schema } from "../src/quote";
import * as barrel from "../src/index";
import { findLeakedInternalFields, CustomerErrorCodeSchema } from "../src/errors";
import {
  DEFERRED_CAPABILITIES, GrantSourceKindV1Schema, HoldReasonV1Schema, LEDGER_ERROR_TO_CUSTOMER, LedgerCommandEnvelopeV1Schema, LedgerActorV1Schema, EligibilityDecisionV1Schema, LedgerOperationKindV1Schema,
  LedgerEntryKindV1Schema, LedgerErrorCodeV1Schema, LedgerQuoteRecordV1Schema, QuoteAllocationV1Schema, ReservationStateV1Schema,
  TransitionEvidenceV1Schema, type AuthorizationEligibilityPort, type PricePolicyPort, type ProviderOutcomeEvidencePort,
} from "../src/ledger-internal";

// SYNTHETIC_* numeric fixtures live in tests only and are never exported from src/ (M7 plan constraint 2).
const SYNTHETIC_USER = "aaaaaaaa-1111-4111-8111-bbbbbbbbbbbb";
const SYNTHETIC_HASH = "a".repeat(64);
const envelope = (over: Record<string, unknown> = {}) => ({
  idempotencyScope: `${SYNTHETIC_USER}:authorize`, idempotencyKey: "synthetic-key-0001", requestSha256: SYNTHETIC_HASH,
  userId: SYNTHETIC_USER, commandKind: "authorize", actor: { kind: "customer", userId: SYNTHETIC_USER }, ...over,
});
const SYNTHETIC_QUOTE = (over: Record<string, unknown> = {}, viewOver: Record<string, unknown> = {}) => {
  const view = conceptBundleQuoteFixture(viewOver);
  return {
    quoteVersionId: view.quoteVersionId, quoteId: view.quoteId, versionNo: 1, userId: SYNTHETIC_USER, operationKind: view.offerKind, modelRef: "model-snapshot-1",
    maxChargeUnits: view.maxHoldUnits, creditsQuoted: view.creditsQuoted, issuedAt: view.issuedAt, expiresAt: view.expiresAt, priceVersion: view.pricePolicyVersion,
    capabilitySnapshotId: view.capabilitySnapshotId, consentTextVersion: view.consentTextVersion, contentSha256: SYNTHETIC_HASH, quoteView: view, ...over,
  };
};
const ok = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) => schema.safeParse(value).success;

test("command envelope: scope binds to user + kind, key charset/length enforced, strict", () => {
  assert.ok(ok(LedgerCommandEnvelopeV1Schema, envelope()));
  assert.ok(!ok(LedgerCommandEnvelopeV1Schema, envelope({ idempotencyScope: "other:authorize" })), "scope must be {userId}:{commandKind}");
  assert.ok(!ok(LedgerCommandEnvelopeV1Schema, envelope({ idempotencyScope: `${SYNTHETIC_USER}:settle` })), "scope kind must match commandKind");
  for (const key of ["", "short", "has space in key!!", "x".repeat(129), "émoji-key-0000000", "line\nbreak-0000000"]) assert.ok(!ok(LedgerCommandEnvelopeV1Schema, envelope({ idempotencyKey: key })), key);
  assert.ok(!ok(LedgerCommandEnvelopeV1Schema, envelope({ requestSha256: "ABC" })));
  const upper = SYNTHETIC_USER.toUpperCase();
  assert.ok(!ok(LedgerCommandEnvelopeV1Schema, envelope({ userId: upper, idempotencyScope: `${upper}:authorize`, actor: { kind: "customer", userId: upper } })), "uppercase uuid would fork idempotency scopes");
  assert.ok(!ok(LedgerCommandEnvelopeV1Schema, envelope({ email: "a@b.c" })), "strict: no email or unknown keys");
  assert.ok(!ok(LedgerCommandEnvelopeV1Schema, envelope({ userId: "not-a-uuid", idempotencyScope: "not-a-uuid:authorize" })));
  assert.ok(ok(LedgerCommandEnvelopeV1Schema, envelope({ commandKind: "settle", idempotencyScope: `${SYNTHETIC_USER}:settle`, actor: { kind: "system", component: "m6b-delivery", expectedUserId: SYNTHETIC_USER } })));
  assert.ok(!ok(LedgerCommandEnvelopeV1Schema, envelope({ actor: { kind: "system", component: "" , expectedUserId: SYNTHETIC_USER } })));
  assert.ok(!ok(LedgerCommandEnvelopeV1Schema, envelope({ actor: { kind: "customer", userId: "22222222-2222-4222-8222-222222222222" } })), "customer actor must be the command user");
});

test("enumerations match the plan (D2, D6) and cannot enter operator_remedy via an entry kind", () => {
  assert.deepEqual([...LedgerEntryKindV1Schema.options], ["grant", "reserve", "release", "settle", "hold"]);
  assert.deepEqual([...HoldReasonV1Schema.options], ["outcome_unknown", "persistence_unconfirmed"]);
  assert.deepEqual([...ReservationStateV1Schema.options].sort(), ["authorization_requested", "operator_remedy", "reconciliation_hold", "released", "reserved", "settled"]);
  assert.ok(!(LedgerEntryKindV1Schema.options as readonly string[]).includes("hold_release"));
  assert.deepEqual([...GrantSourceKindV1Schema.options].sort(), ["digital_export_entitlement", "garment_redemption", "medusa_capture_grant", "refund_reversal", "remedy_adjustment"]);
});

test("every ledger error code maps to a CustomerErrorCode or an explicit null, never anything else", () => {
  assert.deepEqual(Object.keys(LEDGER_ERROR_TO_CUSTOMER).sort(), [...LedgerErrorCodeV1Schema.options].sort());
  for (const mapped of Object.values(LEDGER_ERROR_TO_CUSTOMER)) assert.ok(mapped === null || CustomerErrorCodeSchema.safeParse(mapped).success);
  assert.equal(LEDGER_ERROR_TO_CUSTOMER.INSUFFICIENT_CREDITS, "INSUFFICIENT_CREDITS");
  assert.equal(LEDGER_ERROR_TO_CUSTOMER.QUOTE_STALE, "QUOTE_STALE");
  assert.equal(LEDGER_ERROR_TO_CUSTOMER.IDEMPOTENCY_CONFLICT, null);
});

test("quote record and allocation: whole units, charge <= hold, strict", () => {
  assert.ok(ok(LedgerQuoteRecordV1Schema, SYNTHETIC_QUOTE()));
  for (const bad of [{ maxChargeUnits: -1 }, { creditsQuoted: 1.5 }, { maxChargeUnits: Number.MAX_SAFE_INTEGER + 1, creditsQuoted: 1 }, { operationKind: "gift_card" }, { operationKind: "final_premium" }, { versionNo: 0 },
    { expiresAt: "2026-10-18T00:00:00.000Z" }, { expiresAt: "2025-12-31T00:00:00Z" }, { contentSha256: "xyz" }, { extra: 1 }, { quoteView: {} }, { creditsQuoted: 9 }, { maxChargeUnits: 11 }, { quoteId: "other" }, { priceVersion: "other" }, { issuedAt: "2026-10-17T00:00:00.000Z" }])
    assert.ok(!ok(LedgerQuoteRecordV1Schema, SYNTHETIC_QUOTE(bad)), JSON.stringify(bad));
  assert.deepEqual([...LedgerOperationKindV1Schema.options].sort(), ["concept_bundle_3x2", "final_premium", "final_standard", "promo_single_preview"], "must equal the four existing offerKinds");
  for (const kind of ["concept_bundle_3x2", "promo_single_preview", "final_standard", "final_premium"]) assert.ok(QuoteViewV3Schema.options.some(o => o.shape.offerKind.value === kind), kind);
  const allocation = { quoteVersionId: "qv-1", operationIndex: 0, holdUnits: 3, chargeUnits: 2 };
  assert.ok(ok(QuoteAllocationV1Schema, allocation));
  for (const bad of [{ chargeUnits: 4 }, { chargeUnits: 0 }, { holdUnits: 0, chargeUnits: 0 }, { operationIndex: -1 }, { holdUnits: 2.5 }]) assert.ok(!ok(QuoteAllocationV1Schema, { ...allocation, ...bad }), JSON.stringify(bad));
});

test("transition evidence: settle/release/hold variants are exact; a vendor charge is not evidence", () => {
  const base = { operationId: "op-1", evidenceRef: "ref-1" };
  const settle = { ...base, transition: "settle", evidenceKind: "persisted_delivered", hasVerifiedManifestHash: true, ownerAndRightsVerified: true };
  assert.ok(ok(TransitionEvidenceV1Schema, settle));
  assert.ok(!ok(TransitionEvidenceV1Schema, { ...settle, hasVerifiedManifestHash: false }));
  assert.ok(!ok(TransitionEvidenceV1Schema, { ...settle, ownerAndRightsVerified: false }));
  assert.ok(!ok(TransitionEvidenceV1Schema, { ...settle, evidenceKind: "result_received" }));
  assert.ok(!ok(TransitionEvidenceV1Schema, { ...settle, evidenceKind: "vendor_charge" }));
  assert.ok(ok(TransitionEvidenceV1Schema, { ...base, transition: "release", evidenceKind: "verified_zero_charge_failure" }));
  assert.ok(!ok(TransitionEvidenceV1Schema, { ...base, transition: "release", evidenceKind: "outcome_unknown" }), "unknown outcome can never release");
  assert.ok(!ok(TransitionEvidenceV1Schema, { ...base, transition: "release", evidenceKind: "not_dispatched" }), "no pre-dispatch release (Q9)");
  assert.ok(ok(TransitionEvidenceV1Schema, { ...base, transition: "hold", evidenceKind: "outcome_unknown", reason: "outcome_unknown" }));
  assert.ok(ok(TransitionEvidenceV1Schema, { ...base, transition: "hold", evidenceKind: "persistence_failed_under_review", reason: "persistence_unconfirmed" }));
  assert.ok(!ok(TransitionEvidenceV1Schema, { ...base, transition: "hold", evidenceKind: "outcome_unknown", reason: "persistence_unconfirmed" }));
  assert.ok(!ok(TransitionEvidenceV1Schema, { ...base, transition: "settle", evidenceKind: "persisted_delivered", evidenceRef: "" }));
  assert.ok(!ok(TransitionEvidenceV1Schema, { ...settle, privateVendorCostUsd: 1 }), "strict");
});

test("actor and eligibility decisions are strict and exact", () => {
  assert.ok(ok(LedgerActorV1Schema, { kind: "customer", userId: SYNTHETIC_USER }));
  assert.ok(!ok(LedgerActorV1Schema, { kind: "customer", userId: SYNTHETIC_USER.toUpperCase() }));
  assert.ok(!ok(LedgerActorV1Schema, { kind: "system", component: "Bad Name", expectedUserId: SYNTHETIC_USER }));
  assert.ok(!ok(LedgerActorV1Schema, { kind: "admin", userId: SYNTHETIC_USER }));
  assert.ok(ok(EligibilityDecisionV1Schema, { ok: true, cancellationWindowDisclosed: true }));
  assert.ok(!ok(EligibilityDecisionV1Schema, { ok: true, cancellationWindowDisclosed: false }), "undisclosed window can never authorize");
  assert.ok(!ok(EligibilityDecisionV1Schema, { ok: true }));
  assert.ok(ok(EligibilityDecisionV1Schema, { ok: false, code: "RIGHTS_INELIGIBLE" }));
  assert.ok(!ok(EligibilityDecisionV1Schema, { ok: false, code: "INSUFFICIENT_CREDITS" }));
  assert.ok(!ok(TransitionEvidenceV1Schema, { transition: "remedy", operationId: "op-1", evidenceRef: "r", evidenceKind: "persisted_delivered" }), "unknown transition");
});

test("deferred capabilities carry names only: no method shapes, no flags added, no numbers", () => {
  assert.deepEqual(DEFERRED_CAPABILITIES.map(c => c.capability).sort(), ["digital_export_entitlement", "garment_redemption", "medusa_capture_grant", "refund_reversal", "remedy_execution"]);
  for (const entry of DEFERRED_CAPABILITIES) { assert.deepEqual(Object.keys(entry).sort(), ["capability", "governingFlag", "owningMilestone", "status"]); assert.equal(entry.status, "not_implemented"); }
  assert.ok(Object.isFrozen(DEFERRED_CAPABILITIES));
  assert.ok(DEFERRED_CAPABILITIES.every(c => c.governingFlag === null || ["credits.purchasing", "payments.live", "exports.paid"].includes(c.governingFlag)));
});

test("leak scan: the idempotency envelope is detected, public projections stay clean, ports are types only", () => {
  assert.deepEqual(findLeakedInternalFields(envelope()).sort(), ["idempotencyKey", "idempotencyScope"]);
  assert.deepEqual(findLeakedInternalFields({ summary: { wallet: 1 } }), []);
  const src = readFileSync(new URL("../src/ledger-internal.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /\.default\(\s*\d/, "no numeric defaults");
  assert.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""), /\bthrow\b|\bnew Error\b/, "no throwing stubs");
  // compile-time shape check only (types, never implemented here)
  const _types: [PricePolicyPort?, AuthorizationEligibilityPort?, ProviderOutcomeEvidencePort?] = []; void _types;
});

test("ledger-internal is server-only, exported by subpath, and absent from the public barrel", () => {
  const src = readFileSync(new URL("../src/ledger-internal.ts", import.meta.url), "utf8");
  assert.match(src, /^import "server-only";$/m);
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.exports["./ledger-internal"], "./src/ledger-internal.ts");
  assert.ok(!readFileSync(new URL("../src/index.ts", import.meta.url), "utf8").includes("ledger-internal"));
  for (const name of ["LedgerEntryKindV1Schema", "TransitionEvidenceV1Schema", "LedgerCommandEnvelopeV1Schema", "DEFERRED_CAPABILITIES"]) assert.equal((barrel as Record<string, unknown>)[name], undefined, name);
});
