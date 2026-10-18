import assert from "node:assert/strict";
import { test } from "node:test";
import { PlanStateV1Schema } from "../src/studio-plan";
import {
  canApproveForPrint, canMarkOperationDelivered, canMarkReceiptSettled,
  finalQuoteHasRequiredConsent, planHasValidConceptSlotMapping,
  promoNeverOffsetsBundle, quoteGrantsEligibleBundleAuthorization, refinementMayReturnToAvailable,
} from "../src/invariants";
import { conceptBundleQuoteFixture, promoSinglePreviewQuoteFixture } from "./fixtures";

const directions = [
  { directionId: "d1", title: "A", rationale: "r", visualIntent: "v", risks: [] },
  { directionId: "d2", title: "B", rationale: "r", visualIntent: "v", risks: [] },
  { directionId: "d3", title: "C", rationale: "r", visualIntent: "v", risks: [] },
];
const slot = (directionId: string, slotNumber: 1 | 2 | 3) => ({ slotNumber, directionId, status: "waiting" as const, operationId: null, persistedVersionId: null, publicReceiptId: null });

test("invariant 1 — unapproved/approved have no concept slots; bundle_authorized maps bijectively", () => {
  const unapproved = PlanStateV1Schema.parse({ kind: "unapproved", conceptSlots: [] });
  assert.equal(planHasValidConceptSlotMapping(unapproved), true);

  const bundle = PlanStateV1Schema.parse({
    kind: "bundle_authorized", planVersionId: "pv-1", approvalHash: "hash-1", directions,
    conceptSlots: [slot("d1", 1), slot("d2", 2), slot("d3", 3)],
  });
  assert.equal(planHasValidConceptSlotMapping(bundle), true);
});

test("invariant 2 — concept_bundle_3x2 authorization requires qualified Standard and at least one eligible use", () => {
  const eligible = conceptBundleQuoteFixture();
  assert.equal(quoteGrantsEligibleBundleAuthorization(eligible), true);

  // The pure function is checked independently of whatever Zod would itself reject upstream,
  // so a hand-built object with zero quoted eligible uses must also compute false.
  const noEligibleUse = { ...eligible, downstreamEligibility: { ...eligible.downstreamEligibility, quotedEligibleUses: [] } };
  assert.equal(quoteGrantsEligibleBundleAuthorization(noEligibleUse), false);

  const promo = promoSinglePreviewQuoteFixture();
  assert.equal(quoteGrantsEligibleBundleAuthorization(promo), false);
});

test("invariant 3 — final quotes require a source version, model snapshot and consent text", () => {
  const promo = promoSinglePreviewQuoteFixture();
  assert.equal(finalQuoteHasRequiredConsent(promo), false);
});

test("invariant 4 — promo never offsets the paid bundle", () => {
  const promo = promoSinglePreviewQuoteFixture();
  const bundle = conceptBundleQuoteFixture();
  assert.equal(promoNeverOffsetsBundle(promo, bundle), true);
  assert.equal(promoNeverOffsetsBundle(bundle, promo), false); // swapped arguments must fail, not pass by accident
});

test("invariant 5 — outcome_unknown can never be marked settled", () => {
  assert.equal(canMarkReceiptSettled("outcome_unknown"), false);
  assert.equal(canMarkReceiptSettled("persisted_delivered"), true);
  assert.equal(canMarkReceiptSettled("reconciled_delivered"), true);
  assert.equal(canMarkReceiptSettled("submitted"), false);
});

test("invariant 6 — result_received alone is insufficient for delivery", () => {
  assert.equal(canMarkOperationDelivered({ providerStatus: "result_received", hasVerifiedManifestHash: true, ownerAndRightsVerified: true }), false);
  assert.equal(canMarkOperationDelivered({ providerStatus: "persisted_delivered", hasVerifiedManifestHash: false, ownerAndRightsVerified: true }), false);
  assert.equal(canMarkOperationDelivered({ providerStatus: "persisted_delivered", hasVerifiedManifestHash: true, ownerAndRightsVerified: true }), true);
});

test("invariant 7 — refinement slots may return to available only while the package is open_for_refinements", () => {
  assert.equal(refinementMayReturnToAvailable("open_for_refinements"), true);
  assert.equal(refinementMayReturnToAvailable("closure_pending"), false);
  assert.equal(refinementMayReturnToAvailable("closed"), false);
});

test("invariant 8 — print approval needs a supplier-approved profile and a verified Medusa order, never provider qualification alone", () => {
  assert.equal(canApproveForPrint({ printProfileApprovedBySupplier: true, medusaOrderPaymentVerified: true, humanQaDecision: "approved" }), true);
  assert.equal(canApproveForPrint({ printProfileApprovedBySupplier: false, medusaOrderPaymentVerified: true, humanQaDecision: "approved" }), false);
  assert.equal(canApproveForPrint({ printProfileApprovedBySupplier: true, medusaOrderPaymentVerified: false, humanQaDecision: "approved" }), false);
  assert.equal(canApproveForPrint({ printProfileApprovedBySupplier: true, medusaOrderPaymentVerified: true, humanQaDecision: "pending" }), false);
});
