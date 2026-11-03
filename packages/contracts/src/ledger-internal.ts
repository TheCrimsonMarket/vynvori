/**
 * INTERNAL ONLY. M7 credit-ledger command, quote, evidence and port contracts (ADR-0021; docs/implementation/M7-Plan.md D2-D7).
 * Additive foundation: types and schemas only. No behaviour, no stubs that throw, no numeric defaults, no prices or limits.
 *
 * `server-only` makes an accidental client-bundle import fail the build (mirrors ./internal). This module is exported by
 * subpath (`@vynvori/contracts/ledger-internal`) and is deliberately NOT re-exported from the public barrel. The idempotency
 * fields below are in FORBIDDEN_PUBLIC_FIELDS (errors.ts) and must never reach a customer projection.
 */
import "server-only";
import { z } from "zod";
import type { CustomerErrorCode } from "./errors";
import { HashSha256Schema, IsoDateSchema, OperationIdSchema } from "./ids";
import { QuoteViewV3Schema } from "./quote";

/** Whole-number credit units that round-trip exactly through a Postgres bigint (D2). */
const UnitsSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const PositiveUnitsSchema = UnitsSchema.min(1);
/** Lowercase canonical form only: scopes are compared as text, so case variants must not create distinct idempotency scopes. */
const UserIdSchema = z.guid().refine(value => value === value.toLowerCase(), "uuid must be lowercase");

export const LedgerEntryKindV1Schema = z.enum(["grant", "reserve", "release", "settle", "hold"]);
export type LedgerEntryKindV1 = z.infer<typeof LedgerEntryKindV1Schema>;

/** Reservation states mirror Plane C command states. No W1 entry kind enters or leaves `operator_remedy` (D2). */
export const ReservationStateV1Schema = z.enum(["authorization_requested", "reserved", "settled", "released", "reconciliation_hold", "operator_remedy"]);
export type ReservationStateV1 = z.infer<typeof ReservationStateV1Schema>;

export const HoldReasonV1Schema = z.enum(["outcome_unknown", "persistence_unconfirmed"]);
export type HoldReasonV1 = z.infer<typeof HoldReasonV1Schema>;

/** Reserved names only (D12). Registering a source and any behaviour behind it belong to later, separately approved work. */
export const GrantSourceKindV1Schema = z.enum(["medusa_capture_grant", "refund_reversal", "digital_export_entitlement", "garment_redemption", "remedy_adjustment"]);
export type GrantSourceKindV1 = z.infer<typeof GrantSourceKindV1Schema>;

export const LedgerErrorCodeV1Schema = z.enum([
  "IDEMPOTENCY_CONFLICT", "INSUFFICIENT_CREDITS", "QUOTE_EXPIRED", "QUOTE_STALE", "ALLOCATION_INVALID", "TERMS_NOT_APPROVED",
  "CANCELLATION_WINDOW_UNDISCLOSED", "RIGHTS_INELIGIBLE", "DOWNSTREAM_USE_UNAVAILABLE", "PROMO_ALREADY_USED",
  "EVIDENCE_INVALID", "INVALID_TRANSITION", "NOT_FOUND", "LEDGER_OUTCOME_UNKNOWN",
]);
export type LedgerErrorCodeV1 = z.infer<typeof LedgerErrorCodeV1Schema>;

/** Internal-only codes map to null: the route layer answers them with the uniform NOT_FOUND / a generic failure. */
export const LEDGER_ERROR_TO_CUSTOMER: Readonly<Record<LedgerErrorCodeV1, CustomerErrorCode | null>> = Object.freeze({
  IDEMPOTENCY_CONFLICT: null, INSUFFICIENT_CREDITS: "INSUFFICIENT_CREDITS", QUOTE_EXPIRED: "QUOTE_EXPIRED", QUOTE_STALE: "QUOTE_STALE",
  ALLOCATION_INVALID: null, TERMS_NOT_APPROVED: "TERMS_NOT_APPROVED", CANCELLATION_WINDOW_UNDISCLOSED: "TERMS_NOT_APPROVED",
  RIGHTS_INELIGIBLE: "RIGHTS_INELIGIBLE", DOWNSTREAM_USE_UNAVAILABLE: "DOWNSTREAM_USE_UNAVAILABLE", PROMO_ALREADY_USED: "PROMO_ALREADY_USED",
  EVIDENCE_INVALID: null, INVALID_TRANSITION: null, NOT_FOUND: null, LEDGER_OUTCOME_UNKNOWN: null,
});

/** Internal transitions carry a component and the user they expect to own the row. There is deliberately NO customer actor shape. */
export const LedgerSystemActorV1Schema = z.object({ kind: z.literal("system"), component: z.string().regex(/^[a-z][a-z0-9_-]*$/), expectedUserId: UserIdSchema }).strict();

/** Idempotency key: URL-safe token characters only. The bounds are a format limit, not a business value. */
export const IdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._:-]{16,128}$/);
const CommandKindSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const commandFields = {
  idempotencyScope: z.string(), idempotencyKey: IdempotencyKeySchema, requestSha256: HashSha256Schema,
  userId: UserIdSchema, commandKind: CommandKindSchema,
};
const scopeMatches = (value: { idempotencyScope: string; userId: string; commandKind: string }, ctx: z.RefinementCtx) => {
  if (value.idempotencyScope !== `${value.userId}:${value.commandKind}`) ctx.addIssue({ code: "custom", path: ["idempotencyScope"], message: "scope must be {userId}:{commandKind}" });
};

/**
 * D4: scope = `{userId}:{commandKind}`. No email, no Medusa customer id. Customer-facing command: carries NO actor field — the
 * caller derives the actor from the authenticated session, and `userId` is set from that session, never from a request body.
 * `requestSha256` is likewise recomputed by the ledger from the canonical request (S2 must not trust a caller-supplied hash).
 */
export const LedgerCustomerCommandV1Schema = z.object(commandFields).strict().superRefine(scopeMatches);
export type LedgerCustomerCommandV1 = z.infer<typeof LedgerCustomerCommandV1Schema>;

/** Internal (server-to-server) command: only a `system` actor is representable, and it must name the user it expects. */
export const LedgerInternalCommandV1Schema = z.object({ ...commandFields, actor: LedgerSystemActorV1Schema }).strict().superRefine((value, ctx) => {
  scopeMatches(value, ctx);
  if (value.actor.expectedUserId !== value.userId) ctx.addIssue({ code: "custom", path: ["actor"], message: "actor must match the command user" });
});
export type LedgerInternalCommandV1 = z.infer<typeof LedgerInternalCommandV1Schema>;

export const LedgerOperationKindV1Schema = z.enum(["concept_bundle_3x2", "promo_single_preview", "final_standard", "final_premium"]);

/** D7. Column mapping: maxChargeUnits=maxHoldUnits, creditsQuoted=creditsQuoted, priceVersion=pricePolicyVersion, operationKind=offerKind. */
export const LedgerQuoteRecordV1Schema = z.object({
  quoteVersionId: z.string().min(1), quoteId: z.string().min(1), versionNo: z.number().int().min(1), userId: UserIdSchema,
  operationKind: LedgerOperationKindV1Schema, modelRef: z.string().min(1),
  maxChargeUnits: UnitsSchema, creditsQuoted: UnitsSchema, issuedAt: IsoDateSchema, expiresAt: IsoDateSchema,
  priceVersion: z.string().min(1), capabilitySnapshotId: z.string().min(1), consentTextVersion: z.string().min(1),
  contentSha256: HashSha256Schema, quoteView: QuoteViewV3Schema,
}).strict().refine(q => q.creditsQuoted <= q.maxChargeUnits, { path: ["creditsQuoted"], message: "credits quoted cannot exceed the maximum hold" })
  .refine(q => Date.parse(q.expiresAt) > Date.parse(q.issuedAt), { path: ["expiresAt"], message: "quote must expire after it is issued" })
  // The row is a projection of the persisted view: every shared field must agree, so a record can never contradict its re-parseable view.
  .refine(q => q.operationKind === q.quoteView.offerKind && q.maxChargeUnits === q.quoteView.maxHoldUnits && q.creditsQuoted === q.quoteView.creditsQuoted
    && q.quoteId === q.quoteView.quoteId && q.quoteVersionId === q.quoteView.quoteVersionId && q.priceVersion === q.quoteView.pricePolicyVersion
    && q.consentTextVersion === q.quoteView.consentTextVersion && q.capabilitySnapshotId === q.quoteView.capabilitySnapshotId
    && Date.parse(q.issuedAt) === Date.parse(q.quoteView.issuedAt) && Date.parse(q.expiresAt) === Date.parse(q.quoteView.expiresAt),
  { path: ["quoteView"], message: "record fields must match the persisted quote view" });
export type LedgerQuoteRecordV1 = z.infer<typeof LedgerQuoteRecordV1Schema>;

/** D5. The policy supplies the vector; the ledger verifies it and never computes a split. */
export const QuoteAllocationV1Schema = z.object({
  quoteVersionId: z.string().min(1), operationIndex: z.number().int().nonnegative(), holdUnits: PositiveUnitsSchema, chargeUnits: PositiveUnitsSchema,
}).strict().refine(a => a.chargeUnits <= a.holdUnits, { path: ["chargeUnits"], message: "charge cannot exceed hold" });
export type QuoteAllocationV1 = z.infer<typeof QuoteAllocationV1Schema>;

const evidenceBase = { operationId: OperationIdSchema, evidenceRef: z.string().min(1) };
/**
 * D6. Caller-asserted typed evidence, recorded and re-validated by the ledger. A vendor-charge message is never evidence.
 * Parsing this schema successfully is NOT authorization: S5/S6 must bind it to persisted state (reservation owner, operation,
 * verified manifest hash) read by the ledger itself, and only internal `system` actors may submit it.
 */
export const TransitionEvidenceV1Schema = z.discriminatedUnion("transition", [
  z.object({ transition: z.literal("settle"), ...evidenceBase, evidenceKind: z.literal("persisted_delivered"), hasVerifiedManifestHash: z.literal(true), ownerAndRightsVerified: z.literal(true) }).strict(),
  z.object({ transition: z.literal("release"), ...evidenceBase, evidenceKind: z.literal("verified_zero_charge_failure") }).strict(),
  z.object({ transition: z.literal("hold"), ...evidenceBase, evidenceKind: z.enum(["outcome_unknown", "persistence_failed_under_review"]), reason: HoldReasonV1Schema }).strict()
    .refine(h => (h.evidenceKind === "outcome_unknown") === (h.reason === "outcome_unknown"), { path: ["reason"], message: "reason must match the evidence kind" }),
]);
export type TransitionEvidenceV1 = z.infer<typeof TransitionEvidenceV1Schema>;

export const EligibilityDecisionV1Schema = z.union([
  z.object({ ok: z.literal(true), cancellationWindowDisclosed: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), code: z.enum(["TERMS_NOT_APPROVED", "CANCELLATION_WINDOW_UNDISCLOSED", "RIGHTS_INELIGIBLE", "DOWNSTREAM_USE_UNAVAILABLE"]) }).strict(),
]);
export type EligibilityDecisionV1 = z.infer<typeof EligibilityDecisionV1Schema>;

/** Ports for W1 logic only: types, no implementations. Production wiring and values arrive with their owning milestones. */
export interface PricePolicyPort {
  isPriceVersionCurrent(priceVersion: string): Promise<boolean>;
  allocationsFor(quote: LedgerQuoteRecordV1): Promise<readonly QuoteAllocationV1[]>;
}
export interface AuthorizationEligibilityPort {
  check(input: { readonly userId: string; readonly quote: LedgerQuoteRecordV1; readonly now: string }): Promise<EligibilityDecisionV1>;
}
export interface ProviderOutcomeEvidencePort {
  evidenceFor(operationId: string): Promise<TransitionEvidenceV1 | null>;
}

export interface DeferredCapabilityV1 {
  readonly capability: "medusa_capture_grant" | "refund_reversal" | "digital_export_entitlement" | "garment_redemption" | "remedy_execution";
  readonly governingFlag: "credits.purchasing" | "payments.live" | "exports.paid" | null;
  readonly owningMilestone: string;
  readonly status: "not_implemented";
}
/** Names only: method shapes would be invented ahead of M4 decisions. */
export const DEFERRED_CAPABILITIES: readonly DeferredCapabilityV1[] = Object.freeze([
  Object.freeze({ capability: "medusa_capture_grant", governingFlag: "credits.purchasing", owningMilestone: "M4", status: "not_implemented" } as const),
  Object.freeze({ capability: "refund_reversal", governingFlag: "payments.live", owningMilestone: "M4", status: "not_implemented" } as const),
  Object.freeze({ capability: "digital_export_entitlement", governingFlag: "exports.paid", owningMilestone: "M4", status: "not_implemented" } as const),
  Object.freeze({ capability: "garment_redemption", governingFlag: null, owningMilestone: "M4", status: "not_implemented" } as const),
  Object.freeze({ capability: "remedy_execution", governingFlag: null, owningMilestone: "remedy milestone (blocked per doc 06)", status: "not_implemented" } as const),
]);
