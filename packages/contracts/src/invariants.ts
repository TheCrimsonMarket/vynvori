/**
 * The 8 key schema invariants named in docs/technical/23-typed-contracts-runtime-validation.md
 * §Key invariants for schema tests, as pure, independently testable functions. Several are
 * already enforced structurally by the Zod schemas in this package (noted per-function); this
 * module exists so tests — and future BFF code — have one semantic-level place to assert them,
 * including the cross-object cases a single schema's `.refine` cannot see.
 */
import type { PlanStateV1 } from "./studio-plan";
import type { QuoteViewV3 } from "./quote";
import type { PlaneBStatus, PlaneCBundleState } from "./state-machines";
import { canRestoreSkippedRefinement } from "./state-machines";

/** Invariant 1 — also enforced structurally by PlanStateV1Schema's refine. */
export function planHasValidConceptSlotMapping(plan: PlanStateV1): boolean {
  if (plan.kind !== "bundle_authorized") return plan.conceptSlots.length === 0;
  const directionIds = new Set(plan.directions.map(direction => direction.directionId));
  const slotDirectionIds = plan.conceptSlots.map(slot => slot.directionId);
  return slotDirectionIds.length === 3
    && new Set(slotDirectionIds).size === 3
    && slotDirectionIds.every(id => directionIds.has(id));
}

/** Invariant 2 — also enforced structurally by ConceptBundleQuoteV1Schema's refine. */
export function quoteGrantsEligibleBundleAuthorization(quote: QuoteViewV3): boolean {
  if (quote.offerKind !== "concept_bundle_3x2") return false;
  return quote.standardFinalQualified === true
    && quote.directionIds.length === 3
    && new Set(quote.directionIds).size === 3
    && quote.downstreamEligibility.quotedEligibleUses.length >= 1;
}

/** Invariant 3 — a qualified final quote needs one source version, a current model snapshot and explicit consent text. */
export function finalQuoteHasRequiredConsent(quote: QuoteViewV3): boolean {
  if (quote.offerKind !== "final_standard" && quote.offerKind !== "final_premium") return false;
  return quote.sourceVersionId.length > 0
    && quote.modelQualificationSnapshotId.length > 0
    && quote.consentTextVersion.length > 0;
}

/**
 * Invariant 4 — a promo's free output must never offset or double-count toward the paid 3+2 bundle.
 * Structurally, PromoSinglePreviewQuoteV1Schema fixes creditsQuoted/maxHoldUnits at 0 and
 * ConceptBundleQuoteV1Schema fixes promoOffsetCredits at 0; this cross-checks both quotes together.
 */
export function promoNeverOffsetsBundle(promoQuote: QuoteViewV3, bundleQuote: QuoteViewV3): boolean {
  if (promoQuote.offerKind !== "promo_single_preview" || bundleQuote.offerKind !== "concept_bundle_3x2") return false;
  return promoQuote.creditsQuoted === 0 && bundleQuote.promoOffsetCredits === 0;
}

/** Invariant 5 — `outcome_unknown` can never be marked `settled` from a vendor-charge message alone. */
export function canMarkReceiptSettled(providerStatus: PlaneBStatus): boolean {
  return providerStatus === "persisted_delivered" || providerStatus === "reconciled_delivered";
}

/** Invariant 6 — `result_received` alone is insufficient; delivery requires a verified persisted manifest, owner and rights. */
export interface DeliveryEvidence {
  readonly providerStatus: PlaneBStatus;
  readonly hasVerifiedManifestHash: boolean;
  readonly ownerAndRightsVerified: boolean;
}
export function canMarkOperationDelivered(evidence: DeliveryEvidence): boolean {
  return evidence.providerStatus === "persisted_delivered"
    && evidence.hasVerifiedManifestHash
    && evidence.ownerAndRightsVerified;
}

/** Invariant 7 — delegates to the Plane C bundle-state guard; re-exported here for discoverability. */
export function refinementMayReturnToAvailable(packageState: PlaneCBundleState): boolean {
  return canRestoreSkippedRefinement(packageState);
}

/**
 * Invariant 8 — a qualified provider final render is NOT print approval. Human QA plus a
 * supplier-approved print profile plus a verified Medusa order are all required; a true
 * `providerFinalQualified` is deliberately irrelevant to this guard.
 */
export interface PrintApprovalEvidence {
  readonly printProfileApprovedBySupplier: boolean;
  readonly medusaOrderPaymentVerified: boolean;
  readonly humanQaDecision: "approved" | "rejected" | "pending";
}
export function canApproveForPrint(evidence: PrintApprovalEvidence): boolean {
  return evidence.printProfileApprovedBySupplier
    && evidence.medusaOrderPaymentVerified
    && evidence.humanQaDecision === "approved";
}
