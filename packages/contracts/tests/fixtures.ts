/** Shared synthetic fixtures for packages/contracts tests. Not itself a test file. */
import { ConceptBundleQuoteV1Schema, PromoSinglePreviewQuoteV1Schema } from "../src/quote";
import { AvailabilityV1Schema } from "../src/studio-plan";

export const SYNTHETIC_HASH_A = "a".repeat(64);
export const SYNTHETIC_HASH_B = "b".repeat(64);

export const availabilityFixture = AvailabilityV1Schema.parse({
  atIso: "2026-10-18T00:00:00.000Z",
  capabilitySnapshotId: "cap-1",
  region: "US",
  concept: "available",
  director: "available",
  promo: "available",
  qualifiedStandardFinal: "available",
  qualifiedPremiumFinal: "unavailable",
  digitalArtExportLicensed: "available",
  garmentProductionQualified: "available",
  rightsSummary: "synthetic rights summary",
  customerRestrictions: [],
});

function downstreamEligibilityFixture(overrides: { quotedEligibleUses?: readonly ("digital_art_export" | "personalized_garment")[] } = {}) {
  return {
    region: "US",
    evaluatedAt: "2026-10-18T00:00:00.000Z",
    uses: [
      {
        kind: "digital_art_export", status: "eligible", region: "US",
        rightsDecision: "commercial_use_permitted", rightsPolicyVersion: "rights-1",
        restrictions: [], exclusionReasonCodes: [], humanSummary: "synthetic",
      },
      {
        kind: "personalized_garment", status: "under_review", region: "US",
        rightsDecision: "unverified", rightsPolicyVersion: null,
        restrictions: [], exclusionReasonCodes: ["RIGHTS_INELIGIBLE"], humanSummary: "synthetic",
      },
    ],
    quotedEligibleUses: overrides.quotedEligibleUses ?? ["digital_art_export"],
    rightsNoticeVersion: "rights-notice-1",
  };
}

export function conceptBundleQuoteFixture(overrides: Record<string, unknown> = {}) {
  return ConceptBundleQuoteV1Schema.parse({
    quoteId: "quote-bundle-1", quoteVersionId: "qv-1",
    issuedAt: "2026-10-18T00:00:00.000Z", expiresAt: "2026-10-18T01:00:00.000Z",
    pricePolicyVersion: "price-1", capabilitySnapshotId: "cap-1",
    creditsQuoted: 10, maxHoldUnits: 10,
    wallet: { unit: "credits", availableUnits: 10, reservedUnits: 0, heldForReviewUnits: 0, snapshotAt: "2026-10-18T00:00:00.000Z", walletRevision: "rev-1" },
    consentTextVersion: "consent-1",
    included: ["three_new_concepts"], excluded: ["printing", "shipping"],
    authorizationHint: { quoteId: "quote-bundle-1", checkedAt: "2026-10-18T00:00:00.000Z", canAuthorize: true, reasonCodes: [], quoteVersionId: "qv-1" },
    offerKind: "concept_bundle_3x2", projectId: "project-1", approvedPlanVersionId: "plan-v-1",
    directionIds: ["direction-1", "direction-2", "direction-3"],
    includedRefinements: 2, finalRenderIncludedInThisPurchase: false, physicalGarmentIncluded: false,
    downstreamEligibility: downstreamEligibilityFixture(),
    standardFinalQualified: true, promoOffsetCredits: 0,
    paidTerms: {
      customerConsentTermsVersion: "terms-1", expiryTermsVersion: "terms-1",
      partialRemedyTermsVersion: "terms-1", rightsNoticeVersion: "terms-1",
      qualityRemedyTermsVersion: "terms-1", refinementClosureNoticeVersion: "terms-1",
    },
    ...overrides,
  });
}

export function promoSinglePreviewQuoteFixture(overrides: Record<string, unknown> = {}) {
  return PromoSinglePreviewQuoteV1Schema.parse({
    quoteId: "quote-promo-1", quoteVersionId: "qv-1",
    issuedAt: "2026-10-18T00:00:00.000Z", expiresAt: "2026-10-18T01:00:00.000Z",
    pricePolicyVersion: "price-1", capabilitySnapshotId: "cap-1",
    creditsQuoted: 0, maxHoldUnits: 0,
    wallet: { unit: "credits", availableUnits: 10, reservedUnits: 0, heldForReviewUnits: 0, snapshotAt: "2026-10-18T00:00:00.000Z", walletRevision: "rev-1" },
    consentTextVersion: "consent-1",
    included: ["one_optional_intro_preview"], excluded: ["three_new_concepts"],
    authorizationHint: { quoteId: "quote-promo-1", checkedAt: "2026-10-18T00:00:00.000Z", canAuthorize: true, reasonCodes: [], quoteVersionId: "qv-1" },
    offerKind: "promo_single_preview", directionId: "direction-1",
    finalRenderIncludedInThisPurchase: false, physicalGarmentIncluded: false,
    ...overrides,
  });
}
