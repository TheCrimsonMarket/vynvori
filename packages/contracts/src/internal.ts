/**
 * INTERNAL ONLY. Provider execution evidence and remedy authorization/execution commands.
 * Source: docs/technical/reference-contracts/v1.1/vynvori-v1_1-proposed.ts (ProviderExecutionInternalV1);
 * vynvori-phase6e-companion.proposed.ts (InternalRemedyAuthorizationCommandV1, RemedyExecutionInternalV1).
 *
 * `server-only` makes an accidental client-bundle import of this module fail the build, mirroring
 * packages/shared/src/server.ts's existing pattern. Nothing here may be serialized through a public
 * read-model route (see errors.ts FORBIDDEN_PUBLIC_FIELDS / findLeakedInternalFields, and the
 * leak-scan test).
 */
import "server-only";
import { z } from "zod";
import { OperationIdSchema } from "./ids";
import { RemedyKindV1Schema } from "./remedy-public";

export const ProviderExecutionInternalV1Schema = z.union([
  z.object({ status: z.literal("prepared"), operationId: OperationIdSchema, providerJobId: z.null() }).strict(),
  ...(["submitted", "running", "outcome_unknown"] as const).map(status =>
    z.object({
      status: z.literal(status), operationId: OperationIdSchema, providerJobId: z.string().min(1).nullable(),
      vendorCostEvidence: z.enum(["none", "usage", "invoice", "unknown"]),
    }).strict(),
  ),
  ...(["result_received", "artifact_persisting", "persistence_failed_under_review", "persisted_delivered", "verified_zero_charge_failure"] as const).map(status =>
    z.object({
      status: z.literal(status), operationId: OperationIdSchema, providerJobId: z.string().min(1).nullable(),
      vendorCostEvidence: z.enum(["none", "usage", "invoice", "unknown"]),
      privateVendorCostUsd: z.number().nonnegative().optional(),
    }).strict(),
  ),
]);
export type ProviderExecutionInternalV1 = z.infer<typeof ProviderExecutionInternalV1Schema>;

const InternalRemedyAuthorizationCommandBaseShape = {
  commandType: z.literal("authorize_case_remedy"),
  caseId: z.string().min(1),
  originalPackageId: z.string().min(1),
  originalFinalVersionId: z.string().min(1),
  customerId: z.string().min(1),
  remedyDecisionId: z.string().min(1),
  idempotencyScope: z.string().min(1),
  idempotencyKey: z.string().min(1),
  expectedCaseRevision: z.number().int().nonnegative(),
  disposition: z.literal("upheld"),
  authorizingStaffActorId: z.string().min(1),
  staffAuthorizationEvidenceId: z.string().min(1),
  approvedRemedyPolicyVersion: z.string().min(1),
  approvedOperationalTermsVersion: z.string().min(1),
  customerNoticePlanId: z.string().min(1),
  customerConsentId: z.string().min(1).nullable(),
};

export const InternalRemedyAuthorizationCommandV1Schema = z.union([
  z.object({
    ...InternalRemedyAuthorizationCommandBaseShape,
    remedyKind: z.literal("replacement_service"),
    replacementSourceVersionId: z.string().min(1),
    replacementSourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
  z.object({
    ...InternalRemedyAuthorizationCommandBaseShape,
    remedyKind: z.literal("credit_adjustment"),
    creditUnits: z.number().int(),
  }).strict(),
  z.object({
    ...InternalRemedyAuthorizationCommandBaseShape,
    remedyKind: z.literal("monetary_refund"),
    medusaOrderLineId: z.string().min(1),
    refundAmountMinorUnits: z.number().int().nonnegative(),
    refundCurrency: z.string().min(1),
  }).strict(),
]);
export type InternalRemedyAuthorizationCommandV1 = z.infer<typeof InternalRemedyAuthorizationCommandV1Schema>;

const RemedyExecutionInternalBaseShape = {
  caseId: z.string().min(1),
  remedyDecisionId: z.string().min(1),
  authorizationId: z.string().min(1),
  idempotencyScope: z.string().min(1),
  idempotencyKey: z.string().min(1),
  authorizingStaffActorId: z.string().min(1),
  originalPackageId: z.string().min(1),
  originalPackageRemainsClosed: z.literal(true),
};

export const RemedyExecutionInternalV1Schema = z.union([
  z.object({
    ...RemedyExecutionInternalBaseShape,
    status: z.enum(["authorized", "executing", "reconciling"]),
    remedyKind: RemedyKindV1Schema,
    internalAuditRecordId: z.string().min(1),
  }).strict(),
  z.object({
    ...RemedyExecutionInternalBaseShape,
    status: z.literal("completed"), remedyKind: z.literal("replacement_service"),
    replacementEntitlementId: z.string().min(1), internalAuditRecordId: z.string().min(1),
  }).strict(),
  z.object({
    ...RemedyExecutionInternalBaseShape,
    status: z.literal("completed"), remedyKind: z.literal("credit_adjustment"),
    privateLedgerAdjustmentId: z.string().min(1), internalAuditRecordId: z.string().min(1),
  }).strict(),
  z.object({
    ...RemedyExecutionInternalBaseShape,
    status: z.literal("completed"), remedyKind: z.literal("monetary_refund"),
    medusaRefundId: z.string().min(1), internalAuditRecordId: z.string().min(1),
  }).strict(),
]);
export type RemedyExecutionInternalV1 = z.infer<typeof RemedyExecutionInternalV1Schema>;
