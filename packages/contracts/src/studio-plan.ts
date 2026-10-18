/**
 * Capability snapshot, Director plan directions and plan state projections.
 * Source: docs/technical/reference-contracts/v1.1/vynvori-v1_1-proposed.ts
 * (AvailabilityV1, PlanDirectionV1, ConceptSlotV1, PlanStateV1, DirectorPlanProjectionV1);
 * docs/technical/21-studio-ux-screen-contract.md ST-04/ST-05.
 */
import { z } from "zod";
import { CapabilitySchema } from "./errors";
import { DirectionIdSchema, OperationIdSchema, VersionIdSchema, IsoDateSchema } from "./ids";

export const AvailabilityV1Schema = z.object({
  atIso: IsoDateSchema,
  capabilitySnapshotId: z.string().min(1),
  region: z.string().min(1),
  concept: CapabilitySchema,
  director: CapabilitySchema,
  promo: CapabilitySchema,
  qualifiedStandardFinal: CapabilitySchema,
  qualifiedPremiumFinal: CapabilitySchema,
  digitalArtExportLicensed: CapabilitySchema,
  garmentProductionQualified: CapabilitySchema,
  rightsSummary: z.string(),
  customerRestrictions: z.array(z.string()),
}).strict();
export type AvailabilityV1 = z.infer<typeof AvailabilityV1Schema>;

export const PlanDirectionV1Schema = z.object({
  directionId: DirectionIdSchema,
  title: z.string().min(1),
  rationale: z.string(),
  visualIntent: z.string(),
  risks: z.array(z.string()),
}).strict();
export type PlanDirectionV1 = z.infer<typeof PlanDirectionV1Schema>;

/** Exactly three distinct direction IDs — the one invariant every plan/bundle type must hold (doc 23 invariant 1). */
export const ThreeDirectionsSchema = z.tuple([PlanDirectionV1Schema, PlanDirectionV1Schema, PlanDirectionV1Schema])
  .refine(
    directions => new Set(directions.map(direction => direction.directionId)).size === 3,
    "exactly three distinct direction IDs are required",
  );

export const SlotStatusSchema = z.enum([
  "waiting", "submitted", "running", "artifact_persisting", "delivered",
  "verified_uncharged_failure", "under_review", "remedy_required",
]);
export type SlotStatus = z.infer<typeof SlotStatusSchema>;

export const ConceptSlotV1Schema = z.object({
  slotNumber: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  directionId: DirectionIdSchema,
  status: SlotStatusSchema,
  operationId: OperationIdSchema.nullable(),
  persistedVersionId: VersionIdSchema.nullable(),
  publicReceiptId: z.string().min(1).nullable(),
}).strict();
export type ConceptSlotV1 = z.infer<typeof ConceptSlotV1Schema>;

const EmptyConceptSlotsSchema = z.tuple([]);
const ThreeConceptSlotsSchema = z.tuple([ConceptSlotV1Schema, ConceptSlotV1Schema, ConceptSlotV1Schema]);

/**
 * Authoritative plan state. Invariant: unapproved/approved => conceptSlots.length===0;
 * bundle_authorized => exactly three slots bijectively mapped to the three approved directions
 * (doc 23 invariant 1).
 */
export const PlanStateV1Schema = z.union([
  z.object({
    kind: z.literal("unapproved"),
    draftPlanId: z.string().min(1).optional(),
    conceptSlots: EmptyConceptSlotsSchema,
  }).strict(),
  z.object({
    kind: z.literal("approved"),
    planVersionId: z.string().min(1),
    approvalHash: HashLikeSchema(),
    directions: ThreeDirectionsSchema,
    conceptSlots: EmptyConceptSlotsSchema,
  }).strict(),
  z.object({
    kind: z.literal("bundle_authorized"),
    planVersionId: z.string().min(1),
    approvalHash: HashLikeSchema(),
    directions: ThreeDirectionsSchema,
    conceptSlots: ThreeConceptSlotsSchema,
  }).strict().refine(
    plan => new Set(plan.conceptSlots.map(slot => slot.directionId))
      .size === new Set(plan.directions.map(direction => direction.directionId)).size
      && plan.conceptSlots.every(slot => plan.directions.some(direction => direction.directionId === slot.directionId)),
    "concept slots must map bijectively onto the approved directions",
  ),
]);
export type PlanStateV1 = z.infer<typeof PlanStateV1Schema>;

/** Approval hashes are opaque content hashes, not necessarily SHA-256 hex; kept permissive but non-empty. */
function HashLikeSchema() {
  return z.string().min(1);
}

/**
 * PUBLIC ST-05 plan presentation, independent of authoritative PlanStateV1 (doc 21 ST-05, doc 23).
 * `draft` has no planVersionId/approvalHash/approvedAt; `approved` requires all three, immutable.
 */
export const DirectorPlanProjectionV1Schema = z.union([
  z.object({
    kind: z.literal("draft"),
    draftPlanId: z.string().min(1),
    planRevision: z.number().int().nonnegative(),
    briefVersionId: VersionIdSchema,
    directions: ThreeDirectionsSchema,
    conceptSlots: EmptyConceptSlotsSchema,
  }).strict(),
  z.object({
    kind: z.literal("approved"),
    planVersionId: z.string().min(1),
    approvedPlanRevision: z.number().int().nonnegative(),
    briefVersionId: VersionIdSchema,
    approvalHash: HashLikeSchema(),
    approvedAt: IsoDateSchema,
    directions: ThreeDirectionsSchema,
    conceptSlots: EmptyConceptSlotsSchema,
  }).strict(),
]);
export type DirectorPlanProjectionV1 = z.infer<typeof DirectorPlanProjectionV1Schema>;
