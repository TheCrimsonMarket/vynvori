/**
 * Customer-safe recovery projections for Director quota, concept-route loss, promo
 * persistence uncertainty and final-render reconciliation.
 * Source: docs/technical/reference-contracts/v1.1/vynvori-phase6e-companion.proposed.ts
 * (StudioRecoveryProjectionV1); docs/technical/22-canonical-state-machines.md Plane B §C-02.
 */
import { z } from "zod";
import { OperationIdSchema, ProjectIdSchema, QuoteIdSchema, ReceiptIdSchema, VersionIdSchema } from "./ids";
import { PublicOperationV3Schema } from "./operations";

const DirectorQuotaReachedSchema = z.object({
  kind: z.literal("director_quota_reached"),
  projectId: ProjectIdSchema,
  savedBriefVersionId: VersionIdSchema,
  canStartDirector: z.literal(false),
  retryEligibleAtIso: z.string().nullable(),
  customerMessage: z.string(),
}).strict();

const ConceptRouteUnavailableSchema = z.object({
  kind: z.literal("concept_route_unavailable"),
  projectId: ProjectIdSchema,
  packageId: z.string().min(1).nullable(),
  phase: z.enum(["before_authorization", "after_authorization"]),
  supportCaseId: z.string().min(1).nullable(),
  mayStartPaidConcepts: z.literal(false),
  customerMessage: z.string(),
}).strict();

const PromoArtifactPersistenceUnderReviewSchema = z.object({
  kind: z.literal("promo_artifact_persistence_under_review"),
  projectId: ProjectIdSchema,
  operationId: OperationIdSchema,
  claimState: z.literal("held_for_reconciliation"),
  supportCaseId: z.string().min(1).nullable(),
  canClaimAnotherPromo: z.literal(false),
  customerMessage: z.string(),
}).strict();

/**
 * C-02: `initial_final_before_original_closure` requires the original package to have been
 * `open` before the attempt and project `open` again after a verified no-charge release;
 * `separately_purchased_revision_after_original_closure` requires it `closed` before and after.
 * A prior successful final must never be erased by a failed revision.
 */
const FinalVerifiedUnchargedFailureInitialSchema = z.object({
  kind: z.literal("final_verified_uncharged_failure"),
  attemptKind: z.literal("initial_final_before_original_closure"),
  projectId: ProjectIdSchema,
  originalPackageId: z.string().min(1),
  preAttemptOriginalPackageClosure: z.literal("open"),
  originalPackageClosure: z.literal("open"),
  operationId: OperationIdSchema,
  originalQuoteId: QuoteIdSchema,
  releaseReceiptId: ReceiptIdSchema,
  previouslyDeliveredFinalVersionId: z.null(),
  unusedOriginalRefinements: z.literal("preserve_pre_attempt_eligibility"),
  retryRequiresNewAuthorization: z.literal(true),
  customerMessage: z.string(),
}).strict();

const FinalVerifiedUnchargedFailureRevisionSchema = z.object({
  kind: z.literal("final_verified_uncharged_failure"),
  attemptKind: z.literal("separately_purchased_revision_after_original_closure"),
  projectId: ProjectIdSchema,
  originalPackageId: z.string().min(1),
  preAttemptOriginalPackageClosure: z.literal("closed"),
  originalPackageClosure: z.literal("closed"),
  operationId: OperationIdSchema,
  originalQuoteId: QuoteIdSchema,
  releaseReceiptId: ReceiptIdSchema,
  previouslyDeliveredFinalVersionId: VersionIdSchema,
  unusedOriginalRefinements: z.literal("remain_closed_no_restoration"),
  retryRequiresNewAuthorization: z.literal(true),
  customerMessage: z.string(),
}).strict();

const FinalUnresolvedOpenSchema = z.object({
  kind: z.literal("final_unresolved"),
  projectId: ProjectIdSchema,
  originalPackageId: z.string().min(1),
  operation: PublicOperationV3Schema,
  customerMessage: z.string(),
  preAttemptOriginalPackageClosure: z.literal("open"),
  closureState: z.literal("pending"),
  previouslyDeliveredFinalVersionId: z.null(),
}).strict();

const FinalUnresolvedClosedSchema = z.object({
  kind: z.literal("final_unresolved"),
  projectId: ProjectIdSchema,
  originalPackageId: z.string().min(1),
  operation: PublicOperationV3Schema,
  customerMessage: z.string(),
  preAttemptOriginalPackageClosure: z.literal("closed"),
  closureState: z.literal("closed"),
  previouslyDeliveredFinalVersionId: VersionIdSchema,
}).strict();

export const StudioRecoveryProjectionV1Schema = z.union([
  DirectorQuotaReachedSchema,
  ConceptRouteUnavailableSchema,
  PromoArtifactPersistenceUnderReviewSchema,
  FinalVerifiedUnchargedFailureInitialSchema,
  FinalVerifiedUnchargedFailureRevisionSchema,
  FinalUnresolvedOpenSchema,
  FinalUnresolvedClosedSchema,
]);
export type StudioRecoveryProjectionV1 = z.infer<typeof StudioRecoveryProjectionV1Schema>;
