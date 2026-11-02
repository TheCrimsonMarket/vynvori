/**
 * Customer-safe ledger receipts, operation status and refinement slots.
 * Source: docs/technical/reference-contracts/v1.1/vynvori-v1_1-proposed.ts;
 * docs/technical/22-canonical-state-machines.md Plane B/C;
 * docs/technical/23-typed-contracts-runtime-validation.md invariants 5-7.
 */
import { z } from "zod";
import { OperationIdSchema, QuoteIdSchema, ReceiptIdSchema, VersionIdSchema, NaturalNumberSchema, IsoDateSchema } from "./ids";
import type { PlaneCBundleState } from "./state-machines";

export const CustomerLedgerReceiptV1Schema = z.union([
  z.object({ kind: z.literal("not_authorized"), quoteId: QuoteIdSchema.optional() }).strict(),
  z.object({
    kind: z.literal("reserved"), quoteId: QuoteIdSchema, operationId: OperationIdSchema,
    receiptId: ReceiptIdSchema, heldUnits: NaturalNumberSchema, settledUnits: z.literal(0),
  }).strict(),
  z.object({
    kind: z.literal("settled"), quoteId: QuoteIdSchema, operationId: OperationIdSchema,
    receiptId: ReceiptIdSchema, heldUnits: z.literal(0), settledUnits: NaturalNumberSchema,
  }).strict(),
  z.object({
    kind: z.literal("released"), quoteId: QuoteIdSchema, operationId: OperationIdSchema,
    receiptId: ReceiptIdSchema, releasedUnits: NaturalNumberSchema, heldUnits: z.literal(0),
  }).strict(),
  z.object({
    kind: z.literal("under_review"), quoteId: QuoteIdSchema, operationId: OperationIdSchema,
    receiptId: ReceiptIdSchema, heldUnits: NaturalNumberSchema, caseId: z.string().min(1),
  }).strict(),
]);
export type CustomerLedgerReceiptV1 = z.infer<typeof CustomerLedgerReceiptV1Schema>;

/**
 * doc 23 invariant 5: outcome_unknown cannot become `settled` by a vendor-charge message alone —
 * enforced structurally: only Plane B's authoritative `result_received -> artifact_persisting ->
 * persisted_delivered` path (see state-machines.ts) may produce a `delivered` PublicOperationV3 with
 * a `settled` receipt; this schema alone cannot and does not assert settlement from `running`/`queued`.
 */
export const PublicOperationV3Schema = z.union([
  z.object({ state: z.literal("queued"), operationId: OperationIdSchema, receipt: CustomerLedgerReceiptV1Schema }).strict(),
  z.object({ state: z.literal("running"), operationId: OperationIdSchema, receipt: CustomerLedgerReceiptV1Schema }).strict(),
  z.object({ state: z.literal("artifact_persisting"), operationId: OperationIdSchema, receipt: CustomerLedgerReceiptV1Schema }).strict(),
  z.object({
    state: z.literal("delivered"), operationId: OperationIdSchema,
    persistedVersionId: VersionIdSchema, receipt: CustomerLedgerReceiptV1Schema,
  }).strict(),
  z.object({
    state: z.literal("under_review"), operationId: OperationIdSchema,
    caseId: z.string().min(1), receipt: CustomerLedgerReceiptV1Schema,
  }).strict(),
  z.object({
    state: z.literal("remedy_required"), operationId: OperationIdSchema,
    caseId: z.string().min(1), receipt: CustomerLedgerReceiptV1Schema,
  }).strict(),
  z.object({
    state: z.literal("verified_uncharged_failure"), operationId: OperationIdSchema,
    receipt: CustomerLedgerReceiptV1Schema,
  }).strict(),
]).refine(
  // doc 23 invariant 6: `delivered` requires the receipt lineage of a verified persisted artifact,
  // never a bare `result_received` acknowledgement masquerading as delivery.
  operation => operation.state !== "delivered" || operation.receipt.kind !== "not_authorized",
  "a delivered operation must carry an authorized receipt",
);
export type PublicOperationV3 = z.infer<typeof PublicOperationV3Schema>;

export const CustomerBundleFinancialSummaryV1Schema = z.object({
  packageId: z.string().min(1),
  quoteId: QuoteIdSchema,
  quotedTotalUnits: NaturalNumberSchema,
  maximumAuthorizedHoldUnits: NaturalNumberSchema,
  currentlyReservedUnits: NaturalNumberSchema,
  currentlyHeldForReviewUnits: NaturalNumberSchema,
  cumulativelySettledUnits: NaturalNumberSchema,
  cumulativelyReleasedUnits: NaturalNumberSchema,
  receiptIds: z.array(ReceiptIdSchema),
  supportCaseIds: z.array(z.string()),
  recordedAt: IsoDateSchema,
}).strict();
export type CustomerBundleFinancialSummaryV1 = z.infer<typeof CustomerBundleFinancialSummaryV1Schema>;

/**
 * doc 23 invariant 7: `skipped` may return to `available` only while the package is open;
 * `closure_pending` forbids silent consumption/forfeiture. This schema validates shape only —
 * the open/closed transition legality itself lives in state-machines.ts (Plane C).
 */
export const RefinementSlotV1Schema = z.union([
  z.object({
    state: z.literal("available"), ordinal: z.union([z.literal(1), z.literal(2)]),
    packageId: z.string().min(1), sourceVersionId: VersionIdSchema.nullable(),
  }).strict(),
  z.object({
    state: z.literal("skipped"), ordinal: z.union([z.literal(1), z.literal(2)]),
    packageId: z.string().min(1), sourceVersionId: VersionIdSchema.nullable(),
  }).strict(),
  z.object({
    state: z.literal("pending"), ordinal: z.union([z.literal(1), z.literal(2)]),
    packageId: z.string().min(1), sourceVersionId: VersionIdSchema, operationId: OperationIdSchema,
  }).strict(),
  z.object({
    state: z.literal("unknown"), ordinal: z.union([z.literal(1), z.literal(2)]),
    packageId: z.string().min(1), sourceVersionId: VersionIdSchema, operationId: OperationIdSchema,
  }).strict(),
  z.object({
    state: z.literal("used"), ordinal: z.union([z.literal(1), z.literal(2)]),
    packageId: z.string().min(1), sourceVersionId: VersionIdSchema,
    deliveredVersionId: VersionIdSchema, operationId: OperationIdSchema,
  }).strict(),
  z.object({
    state: z.literal("forfeited"), ordinal: z.union([z.literal(1), z.literal(2)]),
    packageId: z.string().min(1), closureCause: z.enum(["final_delivered", "explicit_close", "approved_expiry"]),
  }).strict(),
]);
export type RefinementSlotV1 = z.infer<typeof RefinementSlotV1Schema>;

export const PackageStateV1Schema = z.enum([
  "quoted", "authorized", "partial", "delivered_3_of_3", "refinements_open",
  "closure_pending", "closed", "remedy_pending",
]);
export type PackageStateV1 = z.infer<typeof PackageStateV1Schema>;

/**
 * Internal bundle state (doc 04 `studio_packages.state`, doc 22 bundle line: `open_for_refinements`) projected to the
 * customer-facing v1.1 reference contract name (`PackageStateV1`: `refinements_open`). Two layers, two names: both
 * canonical sources are kept byte-for-byte, and this exhaustive mapping is the only bridge between them.
 */
const CUSTOMER_PACKAGE_STATE: { readonly [K in PlaneCBundleState]: PackageStateV1 } = {
  quoted: "quoted", authorized: "authorized", partial: "partial", delivered_3_of_3: "delivered_3_of_3",
  open_for_refinements: "refinements_open", closure_pending: "closure_pending", closed: "closed", remedy_pending: "remedy_pending",
};
export function toCustomerPackageState(state: PlaneCBundleState): PackageStateV1 {
  return CUSTOMER_PACKAGE_STATE[state];
}
