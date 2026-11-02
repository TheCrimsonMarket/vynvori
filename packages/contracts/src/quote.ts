/**
 * Downstream-use eligibility, wallet summary and the QuoteViewV3 discriminated union.
 * Source: docs/technical/reference-contracts/v1.1/vynvori-v1_1-proposed.ts;
 * docs/technical/23-typed-contracts-runtime-validation.md §Contract owner and versioning,
 * §Key invariants 2-4; docs/technical/21-studio-ux-screen-contract.md ST-06/ST-08/ST-14.
 */
import { z } from "zod";
import { CustomerErrorCodeSchema } from "./errors";
import { DirectionIdSchema, ProjectIdSchema, QuoteIdSchema, VersionIdSchema, IsoDateSchema, NaturalNumberSchema } from "./ids";

export const DownstreamKindSchema = z.enum(["digital_art_export", "personalized_garment"]);
export type DownstreamKind = z.infer<typeof DownstreamKindSchema>;

export const RightsDecisionSchema = z.enum([
  "commercial_use_permitted", "preview_only", "not_permitted", "unverified",
]);
export type RightsDecision = z.infer<typeof RightsDecisionSchema>;

export const DownstreamUseEligibilityV2Schema = z.object({
  kind: DownstreamKindSchema,
  status: z.enum(["eligible", "ineligible", "under_review"]),
  region: z.string().min(1),
  rightsDecision: RightsDecisionSchema,
  rightsPolicyVersion: z.string().min(1).nullable(),
  restrictions: z.array(z.string()),
  exclusionReasonCodes: z.array(CustomerErrorCodeSchema),
  humanSummary: z.string(),
}).strict();
export type DownstreamUseEligibilityV2 = z.infer<typeof DownstreamUseEligibilityV2Schema>;

export const DownstreamEligibilityV2Schema = z.object({
  region: z.string().min(1),
  evaluatedAt: IsoDateSchema,
  uses: z.tuple([
    DownstreamUseEligibilityV2Schema.extend({ kind: z.literal("digital_art_export") }).strict(),
    DownstreamUseEligibilityV2Schema.extend({ kind: z.literal("personalized_garment") }).strict(),
  ]),
  quotedEligibleUses: z.array(DownstreamKindSchema),
  rightsNoticeVersion: z.string().min(1),
}).strict()
  // doc 23 invariant: at least one quoted eligible use must itself be eligible + commercial_use_permitted.
  .refine(
    projection => projection.quotedEligibleUses.length === 0 || projection.quotedEligibleUses.every(kind =>
      projection.uses.some(use => use.kind === kind && use.status === "eligible" && use.rightsDecision === "commercial_use_permitted"),
    ),
    "a quotedEligibleUse must itself be eligible and commercial_use_permitted",
  );
export type DownstreamEligibilityV2 = z.infer<typeof DownstreamEligibilityV2Schema>;

export const CreditWalletSummaryV1Schema = z.object({
  unit: z.literal("credits"),
  availableUnits: NaturalNumberSchema,
  reservedUnits: NaturalNumberSchema,
  heldForReviewUnits: NaturalNumberSchema,
  snapshotAt: IsoDateSchema,
  walletRevision: z.string().min(1),
}).strict();
export type CreditWalletSummaryV1 = z.infer<typeof CreditWalletSummaryV1Schema>;

export const PaidDisclosureTermsV1Schema = z.object({
  customerConsentTermsVersion: z.string().min(1),
  expiryTermsVersion: z.string().min(1),
  partialRemedyTermsVersion: z.string().min(1),
  rightsNoticeVersion: z.string().min(1),
  qualityRemedyTermsVersion: z.string().min(1),
  refinementClosureNoticeVersion: z.string().min(1).nullable(),
}).strict();
export type PaidDisclosureTermsV1 = z.infer<typeof PaidDisclosureTermsV1Schema>;

/** BFF display guidance only (doc 23 Phase 6C UX-C03) — never itself an authorization grant. */
export const ServerAuthorizationHintV1Schema = z.object({
  quoteId: QuoteIdSchema,
  checkedAt: IsoDateSchema,
  canAuthorize: z.boolean(),
  reasonCodes: z.array(CustomerErrorCodeSchema),
  quoteVersionId: z.string().min(1),
}).strict();
export type ServerAuthorizationHintV1 = z.infer<typeof ServerAuthorizationHintV1Schema>;

const QuoteBaseV3Shape = {
  quoteId: QuoteIdSchema,
  quoteVersionId: z.string().min(1),
  issuedAt: IsoDateSchema,
  expiresAt: IsoDateSchema,
  pricePolicyVersion: z.string().min(1),
  capabilitySnapshotId: z.string().min(1),
  creditsQuoted: NaturalNumberSchema,
  maxHoldUnits: NaturalNumberSchema,
  wallet: CreditWalletSummaryV1Schema,
  consentTextVersion: z.string().min(1),
  included: z.array(z.string()),
  excluded: z.array(z.string()),
  authorizationHint: ServerAuthorizationHintV1Schema,
};

function quoteBaseRefinements<Shape extends z.ZodRawShape>(shape: Shape) {
  return z.object(shape).strict().refine(
    quote => (quote as { quoteId: string; authorizationHint: { quoteId: string } }).authorizationHint.quoteId
      === (quote as { quoteId: string }).quoteId,
    "authorizationHint.quoteId must match quoteId",
  ).refine(
    quote => Date.parse((quote as { issuedAt: string }).issuedAt) < Date.parse((quote as { expiresAt: string }).expiresAt),
    "expiresAt must be after issuedAt",
  );
}

/**
 * doc 23 invariant 2: concept_bundle_3x2 => three mapped directions and current qualified Standard
 * plus at least one permitted downstream use, or authorization is disabled.
 * doc 23 invariant 3: final_standard|final_premium => one selected source version + model qualification.
 */
export const ConceptBundleQuoteV1Schema = quoteBaseRefinements({
  ...QuoteBaseV3Shape,
  offerKind: z.literal("concept_bundle_3x2"),
  projectId: ProjectIdSchema,
  approvedPlanVersionId: z.string().min(1),
  directionIds: z.tuple([DirectionIdSchema, DirectionIdSchema, DirectionIdSchema])
    .refine(ids => new Set(ids).size === 3, "exactly three distinct direction IDs are required"),
  includedRefinements: z.literal(2),
  finalRenderIncludedInThisPurchase: z.literal(false),
  physicalGarmentIncluded: z.literal(false),
  downstreamEligibility: DownstreamEligibilityV2Schema,
  standardFinalQualified: z.literal(true),
  promoOffsetCredits: z.literal(0),
  paidTerms: PaidDisclosureTermsV1Schema,
}).refine(
  quote => quote.standardFinalQualified === true
    && quote.downstreamEligibility.quotedEligibleUses.length >= 1,
  "a disabled-authorization quote must not assert concept_bundle_3x2 eligibility",
);

export const PromoSinglePreviewQuoteV1Schema = quoteBaseRefinements({
  ...QuoteBaseV3Shape,
  offerKind: z.literal("promo_single_preview"),
  directionId: DirectionIdSchema,
  finalRenderIncludedInThisPurchase: z.literal(false),
  physicalGarmentIncluded: z.literal(false),
  creditsQuoted: z.literal(0),
  maxHoldUnits: z.literal(0),
});

function finalQuoteShape(offerKind: "final_standard" | "final_premium") {
  return quoteBaseRefinements({
    ...QuoteBaseV3Shape,
    offerKind: z.literal(offerKind),
    sourceVersionId: VersionIdSchema,
    modelQualificationSnapshotId: z.string().min(1),
    finalRenderIncludedInThisPurchase: z.literal(true),
    physicalGarmentIncluded: z.literal(false),
    paidTerms: PaidDisclosureTermsV1Schema,
  });
}
export const FinalStandardQuoteV1Schema = finalQuoteShape("final_standard");
export const FinalPremiumQuoteV1Schema = finalQuoteShape("final_premium");

export const QuoteViewV3Schema = z.union([
  ConceptBundleQuoteV1Schema,
  PromoSinglePreviewQuoteV1Schema,
  FinalStandardQuoteV1Schema,
  FinalPremiumQuoteV1Schema,
]);
export type QuoteViewV3 = z.infer<typeof QuoteViewV3Schema>;
