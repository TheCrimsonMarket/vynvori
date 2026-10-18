/**
 * Studio screen inventory ST-00..ST-17, status projection and command/result envelopes.
 * Source: docs/technical/reference-contracts/v1.1/vynvori-v1_1-proposed.ts (StudioScreenV1,
 * StudioStatusV3, StudioCommandV1, StudioCommandResultV1);
 * docs/technical/21-studio-ux-screen-contract.md (screen-by-screen contract).
 */
import { z } from "zod";
import { CustomerErrorCodeSchema, SafeActionV1Schema } from "./errors";
import { DirectionIdSchema, OperationIdSchema, ProjectIdSchema, QuoteIdSchema, ReceiptIdSchema, VersionIdSchema, IsoDateSchema } from "./ids";
import { AvailabilityV1Schema, DirectorPlanProjectionV1Schema, PlanStateV1Schema, SlotStatusSchema } from "./studio-plan";
import { ConceptBundleQuoteV1Schema, FinalPremiumQuoteV1Schema, FinalStandardQuoteV1Schema } from "./quote";
import { CustomerBundleFinancialSummaryV1Schema, PackageStateV1Schema, PublicOperationV3Schema, RefinementSlotV1Schema } from "./operations";
import { StudioRecoveryProjectionV1Schema } from "./recovery";

export const CreativeBriefDisplayV1Schema = z.object({
  briefId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  entryMode: z.enum(["guided", "free"]),
  summary: z.string(),
  exactText: z.array(z.string()),
  referenceCount: z.number().int().nonnegative(),
  rightsAcknowledged: z.boolean(),
}).strict();
export type CreativeBriefDisplayV1 = z.infer<typeof CreativeBriefDisplayV1Schema>;

export const ConceptCardV1Schema = z.object({
  slotNumber: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  directionId: DirectionIdSchema,
  directionTitle: z.string(),
  status: SlotStatusSchema,
  versionId: VersionIdSchema.nullable(),
  safePreviewUrl: z.string().min(1).nullable(),
  accessibleDescription: z.string(),
  operation: PublicOperationV3Schema.nullable(),
  receiptId: ReceiptIdSchema.nullable(),
  sourceRightsSummary: z.string(),
  isSelected: z.boolean(),
}).strict();
export type ConceptCardV1 = z.infer<typeof ConceptCardV1Schema>;
const ThreeConceptCardsSchema = z.tuple([ConceptCardV1Schema, ConceptCardV1Schema, ConceptCardV1Schema]);

export const StudioVersionHistoryItemV1Schema = z.object({
  versionId: VersionIdSchema,
  parentVersionId: VersionIdSchema.nullable(),
  kind: z.enum(["concept", "promo_preview", "refinement", "final"]),
  label: z.string(),
  createdAt: IsoDateSchema,
  saved: z.boolean(),
  rightsSummary: z.string(),
  previewUrl: z.string().min(1).nullable(),
}).strict();
export type StudioVersionHistoryItemV1 = z.infer<typeof StudioVersionHistoryItemV1Schema>;

export const PromoEligibilityViewV1Schema = z.object({
  state: z.enum(["eligible", "already_used", "ineligible", "unavailable", "under_review"]),
  explanatoryText: z.string(),
  chosenDirectionId: DirectionIdSchema.nullable(),
}).strict();
export type PromoEligibilityViewV1 = z.infer<typeof PromoEligibilityViewV1Schema>;

export const SupportCaseViewV1Schema = z.object({
  caseId: z.string().min(1),
  kind: z.enum(["financial_reconciliation", "quality_issue", "lost_capability", "partial_bundle"]),
  state: z.enum(["open", "under_review", "remedy_pending", "resolved"]),
  publicMessage: z.string(),
}).strict();
export type SupportCaseViewV1 = z.infer<typeof SupportCaseViewV1Schema>;

const RefinementPairSchema = z.union([z.tuple([RefinementSlotV1Schema, RefinementSlotV1Schema]), z.tuple([])]);

export const StudioStatusV3Schema = z.object({
  schemaVersion: z.literal("studio-status.v3"),
  projectId: ProjectIdSchema,
  plan: PlanStateV1Schema,
  deliveredConceptCount: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  packageState: PackageStateV1Schema.nullable(),
  promoStatus: z.enum(["eligible", "unavailable", "claimed", "under_review"]),
  customerOperations: z.array(PublicOperationV3Schema),
  bundleFinancials: CustomerBundleFinancialSummaryV1Schema.nullable(),
  capabilities: AvailabilityV1Schema,
  allowedActions: z.array(SafeActionV1Schema),
  currentErrorCode: CustomerErrorCodeSchema.nullable(),
  refinements: RefinementPairSchema,
}).strict();
export type StudioStatusV3 = z.infer<typeof StudioStatusV3Schema>;

export const StudioStageV1Schema = z.enum([
  "entry", "guided_brief", "free_brief", "brief_review", "director_planning", "director_review",
  "offer_choice", "promo_review", "concept_quote", "concepts_running", "concepts_partial",
  "concepts_review", "refinement_1", "refinement_2", "final_quote", "final_unavailable",
  "final_review", "history",
]);
export type StudioStageV1 = z.infer<typeof StudioStageV1Schema>;

const StudioScreenBaseShape = {
  schemaVersion: z.literal("studio-screen.v1"),
  route: z.string().min(1),
  projectId: ProjectIdSchema.nullable(),
  status: StudioStatusV3Schema.nullable(),
  availableActions: z.array(SafeActionV1Schema),
  errorCode: CustomerErrorCodeSchema.nullable(),
  supportCases: z.array(SupportCaseViewV1Schema),
  history: z.array(StudioVersionHistoryItemV1Schema),
  recovery: StudioRecoveryProjectionV1Schema.nullable().optional(),
};

/** Screen/stage mapping must stay bijective — enforced again at runtime in invariants.ts. */
export const StudioScreenV1Schema = z.union([
  z.object({ ...StudioScreenBaseShape, screenId: z.literal("ST-00"), stage: z.literal("entry"), entryModes: z.tuple([z.literal("guide_me"), z.literal("create_freely")]), byoLink: z.literal("/customize") }).strict(),
  z.object({ ...StudioScreenBaseShape, screenId: z.literal("ST-01"), stage: z.literal("guided_brief"), brief: CreativeBriefDisplayV1Schema.nullable() }).strict(),
  z.object({ ...StudioScreenBaseShape, screenId: z.literal("ST-02"), stage: z.literal("free_brief"), brief: CreativeBriefDisplayV1Schema.nullable() }).strict(),
  z.object({ ...StudioScreenBaseShape, screenId: z.literal("ST-03"), stage: z.literal("brief_review"), brief: CreativeBriefDisplayV1Schema, guestClaimStatus: z.enum(["guest", "sign_in_required", "claim_pending", "claimed", "expired", "conflict"]) }).strict(),
  z.object({ ...StudioScreenBaseShape, screenId: z.literal("ST-04"), stage: z.literal("director_planning"), brief: CreativeBriefDisplayV1Schema, plannerJobId: z.string().min(1) }).strict(),
  z.object({ ...StudioScreenBaseShape, screenId: z.literal("ST-05"), stage: z.literal("director_review"), plan: DirectorPlanProjectionV1Schema }).strict(),
  z.object({ ...StudioScreenBaseShape, screenId: z.literal("ST-06"), stage: z.literal("offer_choice"), promo: PromoEligibilityViewV1Schema, offerDisclosures: z.array(z.string()) }).strict(),
  z.object({ ...StudioScreenBaseShape, screenId: z.literal("ST-07"), stage: z.literal("promo_review"), promo: PromoEligibilityViewV1Schema, promoOperation: PublicOperationV3Schema.nullable() }).strict(),
  z.object({ ...StudioScreenBaseShape, screenId: z.literal("ST-08"), stage: z.literal("concept_quote"), quote: ConceptBundleQuoteV1Schema.nullable() }).strict(),
  z.object({ ...StudioScreenBaseShape, screenId: z.literal("ST-09"), stage: z.literal("concepts_running"), conceptCards: ThreeConceptCardsSchema, bundleFinancials: CustomerBundleFinancialSummaryV1Schema }).strict(),
  z.object({ ...StudioScreenBaseShape, screenId: z.literal("ST-10"), stage: z.literal("concepts_partial"), conceptCards: ThreeConceptCardsSchema, bundleFinancials: CustomerBundleFinancialSummaryV1Schema }).strict(),
  z.object({ ...StudioScreenBaseShape, screenId: z.literal("ST-11"), stage: z.literal("concepts_review"), conceptCards: ThreeConceptCardsSchema, bundleFinancials: CustomerBundleFinancialSummaryV1Schema }).strict(),
  z.object({ ...StudioScreenBaseShape, screenId: z.literal("ST-12"), stage: z.literal("refinement_1"), slot: RefinementSlotV1Schema, sourceVersionId: VersionIdSchema }).strict(),
  z.object({ ...StudioScreenBaseShape, screenId: z.literal("ST-13"), stage: z.literal("refinement_2"), slot: RefinementSlotV1Schema, sourceVersionId: VersionIdSchema }).strict(),
  z.object({ ...StudioScreenBaseShape, screenId: z.literal("ST-14"), stage: z.literal("final_quote"), quote: z.union([FinalStandardQuoteV1Schema, FinalPremiumQuoteV1Schema]).nullable() }).strict(),
  z.object({ ...StudioScreenBaseShape, screenId: z.literal("ST-15"), stage: z.literal("final_unavailable"), reasonCodes: z.array(CustomerErrorCodeSchema), savedVersions: z.array(StudioVersionHistoryItemV1Schema) }).strict(),
  z.object({ ...StudioScreenBaseShape, screenId: z.literal("ST-16"), stage: z.literal("final_review"), finalOperation: PublicOperationV3Schema, finalVersionId: VersionIdSchema.nullable() }).strict(),
  z.object({ ...StudioScreenBaseShape, screenId: z.literal("ST-17"), stage: z.literal("history"), savedVersions: z.array(StudioVersionHistoryItemV1Schema) }).strict(),
]).refine(
  // doc 23 §StudioScreenV1 discriminates ST-00..ST-17 with screen-specific presentation data;
  // screenId and stage must never disagree (the pairing a client could otherwise desync on).
  screen => SCREEN_STAGE_MAP[screen.screenId] === screen.stage,
  "screenId and stage must agree with the canonical ST-xx mapping",
);
export type StudioScreenV1 = z.infer<typeof StudioScreenV1Schema>;

export const SCREEN_STAGE_MAP: Record<string, StudioStageV1> = Object.freeze({
  "ST-00": "entry", "ST-01": "guided_brief", "ST-02": "free_brief", "ST-03": "brief_review",
  "ST-04": "director_planning", "ST-05": "director_review", "ST-06": "offer_choice", "ST-07": "promo_review",
  "ST-08": "concept_quote", "ST-09": "concepts_running", "ST-10": "concepts_partial", "ST-11": "concepts_review",
  "ST-12": "refinement_1", "ST-13": "refinement_2", "ST-14": "final_quote", "ST-15": "final_unavailable",
  "ST-16": "final_review", "ST-17": "history",
});

export const StudioCommandV1Schema = z.union([
  z.object({ action: z.literal("inspect_quote"), projectId: ProjectIdSchema }).strict(),
  z.object({
    action: z.literal("authorize_bundle"), projectId: ProjectIdSchema, quoteId: QuoteIdSchema,
    expectedRevision: z.number().int().nonnegative(), consentId: z.string().min(1), idempotencyKey: z.string().min(1),
  }).strict(),
  z.object({
    action: z.literal("use_version"), projectId: ProjectIdSchema, versionId: VersionIdSchema,
    expectedRevision: z.number().int().nonnegative(), idempotencyKey: z.string().min(1),
  }).strict(),
  z.object({
    action: z.literal("report_quality"), projectId: ProjectIdSchema, versionId: VersionIdSchema,
    description: z.string().min(1), idempotencyKey: z.string().min(1),
  }).strict(),
  z.object({ action: z.literal("resume"), projectId: ProjectIdSchema }).strict(),
]);
export type StudioCommandV1 = z.infer<typeof StudioCommandV1Schema>;

export const StudioCommandResultV1Schema = z.union([
  z.object({ kind: z.literal("accepted"), projectRevision: z.number().int().nonnegative(), screen: StudioScreenV1Schema }).strict(),
  z.object({ kind: z.literal("pending"), operationId: OperationIdSchema, screen: StudioScreenV1Schema }).strict(),
  z.object({ kind: z.literal("rejected"), errorCode: CustomerErrorCodeSchema, message: z.string(), currentScreen: StudioScreenV1Schema }).strict(),
]);
export type StudioCommandResultV1 = z.infer<typeof StudioCommandResultV1Schema>;
