import type { AuthorizationEligibilityPort, EligibilityDecisionV1, PricePolicyPort } from "@vynvori/contracts/ledger-internal";
import type { LedgerDb } from "../src/ledger-core";
import { issueQuote } from "../src/ledger-quotes";

/**
 * S5 test helpers (tests/ only; nothing under src/ imports this). Every number here is a SYNTHETIC test value, never a price,
 * credit cost, package size or hold duration: the ledger reserves whatever allocation vector the quote froze.
 */
export const SYNTHETIC_HOLDS = [4, 3, 3] as const;
export const SYNTHETIC_CHARGES = [3, 3, 2] as const;
export const SYNTHETIC_BUNDLE_HOLD = SYNTHETIC_HOLDS.reduce((a, b) => a + b, 0);
export const SYNTHETIC_BUNDLE_CHARGE = SYNTHETIC_CHARGES.reduce((a, b) => a + b, 0);
export const SYNTHETIC_FINAL_HOLD = 5, SYNTHETIC_FINAL_CHARGE = 4;
export const SYNTHETIC_CONSENT = "s5-ctv";

export const bundleAllocations = SYNTHETIC_HOLDS.map((holdUnits, operationIndex) => ({ operationIndex, holdUnits, chargeUnits: SYNTHETIC_CHARGES[operationIndex]! }));
export const finalAllocations = [{ operationIndex: 0, holdUnits: SYNTHETIC_FINAL_HOLD, chargeUnits: SYNTHETIC_FINAL_CHARGE }];

const paidTerms = { customerConsentTermsVersion: "cc-1", expiryTermsVersion: "ex-1", partialRemedyTermsVersion: "pr-1", rightsNoticeVersion: "rn-1", qualityRemedyTermsVersion: "qr-1", refinementClosureNoticeVersion: null };
function base(quoteId: string, quoteVersionId: string, credits: number, hold: number, overrides: Record<string, unknown>) {
  const issuedAt = (overrides.issuedAt as string) ?? new Date().toISOString();
  const expiresAt = (overrides.expiresAt as string) ?? new Date(Date.parse(issuedAt) + 3_600_000).toISOString();
  return {
    quoteId, quoteVersionId, issuedAt, expiresAt, pricePolicyVersion: "s5-pv", capabilitySnapshotId: "s5-cap",
    creditsQuoted: credits, maxHoldUnits: hold,
    wallet: { unit: "credits", availableUnits: 0, reservedUnits: 0, heldForReviewUnits: 0, snapshotAt: issuedAt, walletRevision: "0" },
    consentTextVersion: SYNTHETIC_CONSENT, included: [] as string[], excluded: [] as string[],
    authorizationHint: { quoteId, checkedAt: issuedAt, canAuthorize: false, reasonCodes: [] as string[], quoteVersionId },
  };
}
/** A valid concept_bundle_3x2 QuoteViewV3 whose totals match bundleAllocations. */
export function bundleView(quoteId: string, quoteVersionId: string, overrides: Record<string, unknown> = {}) {
  const head = base(quoteId, quoteVersionId, SYNTHETIC_BUNDLE_CHARGE, SYNTHETIC_BUNDLE_HOLD, overrides);
  return {
    ...head, offerKind: "concept_bundle_3x2" as const, projectId: "s5-project", approvedPlanVersionId: "s5-plan-v1", directionIds: ["d1", "d2", "d3"] as const,
    includedRefinements: 2 as const, finalRenderIncludedInThisPurchase: false as const, physicalGarmentIncluded: false as const,
    downstreamEligibility: {
      region: "US", evaluatedAt: head.issuedAt,
      uses: [{ kind: "digital_art_export", status: "eligible", region: "US", rightsDecision: "commercial_use_permitted", rightsPolicyVersion: "rp-1", restrictions: [] as string[], exclusionReasonCodes: [] as string[], humanSummary: "ok" },
        { kind: "personalized_garment", status: "ineligible", region: "US", rightsDecision: "not_permitted", rightsPolicyVersion: null, restrictions: [] as string[], exclusionReasonCodes: [] as string[], humanSummary: "no" }],
      quotedEligibleUses: ["digital_art_export"] as const, rightsNoticeVersion: "rn-1",
    },
    standardFinalQualified: true as const, promoOffsetCredits: 0 as const, paidTerms, ...overrides,
  };
}
/** A valid final_standard QuoteViewV3 whose totals match finalAllocations. */
export function finalView(quoteId: string, quoteVersionId: string, overrides: Record<string, unknown> = {}) {
  return {
    ...base(quoteId, quoteVersionId, SYNTHETIC_FINAL_CHARGE, SYNTHETIC_FINAL_HOLD, overrides), offerKind: "final_standard" as const,
    sourceVersionId: "s5-source-version", modelQualificationSnapshotId: "s5-model-snapshot", finalRenderIncludedInThisPurchase: true as const,
    physicalGarmentIncluded: false as const, paidTerms, ...overrides,
  };
}
/** A valid promo_single_preview QuoteViewV3 (0/0, no allocations). */
export function promoView(quoteId: string, quoteVersionId: string) {
  return { ...base(quoteId, quoteVersionId, 0, 0, {}), offerKind: "promo_single_preview" as const, directionId: "s5-direction", finalRenderIncludedInThisPurchase: false as const, physicalGarmentIncluded: false as const };
}

export const currentPricePolicy: PricePolicyPort = { isPriceVersionCurrent: async () => true, allocationsFor: async () => { throw new Error("not used by S5"); } };
export const stalePricePolicy: PricePolicyPort = { isPriceVersionCurrent: async () => false, allocationsFor: async () => { throw new Error("not used by S5"); } };
/** Counts its calls, so tests can prove the port is consulted inline on every authorization and never cached. */
export function eligibilityPort(decision: EligibilityDecisionV1 | (() => unknown) = { ok: true, cancellationWindowDisclosed: true }) {
  const port = { calls: 0, check: async () => { port.calls += 1; return (typeof decision === "function" ? decision() : decision) as EligibilityDecisionV1; } };
  return port satisfies AuthorizationEligibilityPort & { calls: number };
}
export const consent = (consentTextVersion = SYNTHETIC_CONSENT) => ({ accepted: true, consentTextVersion });
export const releaseEvidence = (operationId: string, evidenceRef = "plane-b-evidence-1") => ({ transition: "release", operationId, evidenceKind: "verified_zero_charge_failure", evidenceRef });

/** Issues a quote through the ordinary S3 path and returns its version id. */
export async function issueTestQuote(db: LedgerDb, userId: string, kind: "bundle" | "final" | "promo", quoteId: string, overrides: Record<string, unknown> = {}) {
  const quoteVersionId = quoteId + "-v1";
  const quoteView = kind === "bundle" ? bundleView(quoteId, quoteVersionId, overrides) : kind === "final" ? finalView(quoteId, quoteVersionId, overrides) : promoView(quoteId, quoteVersionId);
  const allocations = kind === "bundle" ? bundleAllocations : kind === "final" ? finalAllocations : [];
  await issueQuote(db, { userId, quoteView, modelRef: kind === "final" ? (quoteView as { modelQualificationSnapshotId: string }).modelQualificationSnapshotId : "s5-model", allocations, idempotencyKey: "issue-" + quoteId.padEnd(16, "x") });
  return quoteVersionId;
}
