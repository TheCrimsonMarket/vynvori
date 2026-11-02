/**
 * Independent BYO garment editor: composition identity/proof binding and layer geometry.
 * Source: docs/technical/reference-contracts/v1.1/vynvori-phase6e-companion.proposed.ts;
 * docs/technical/21-studio-ux-screen-contract.md ED-01/ED-02/ED-03;
 * docs/technical/22-canonical-state-machines.md Plane D.
 */
import { z } from "zod";
import { PublicActionSchema } from "./errors";
import { HashSha256Schema, QuoteIdSchema, VersionIdSchema, IsoDateSchema } from "./ids";

export const CompositionIdentityV1Schema = z.object({
  compositionId: z.string().min(1),
  compositionVersionId: VersionIdSchema,
  sceneHashSha256: HashSha256Schema,
  variantId: z.string().min(1),
  printProfileVersion: z.string().min(1),
}).strict();
export type CompositionIdentityV1 = z.infer<typeof CompositionIdentityV1Schema>;

export const ScopedArtifactV1Schema = z.object({
  artifactId: z.string().min(1),
  artifactSha256: HashSha256Schema,
  sourceCompositionVersionId: VersionIdSchema,
  sourceSceneSha256: HashSha256Schema,
  status: z.enum(["pending", "ready", "under_review", "unavailable"]),
}).strict();
export type ScopedArtifactV1 = z.infer<typeof ScopedArtifactV1Schema>;

export const SnapshotValidationV1Schema = z.object({
  validationId: z.string().min(1),
  sourceCompositionVersionId: VersionIdSchema,
  sourceSceneSha256: HashSha256Schema,
  state: z.enum(["preview_only", "blocked", "passed_pending_human_qa"]),
  issueCodes: z.array(z.string()),
  rightsSnapshotId: z.string().min(1),
  printProfileVersion: z.string().min(1),
}).strict();
export type SnapshotValidationV1 = z.infer<typeof SnapshotValidationV1Schema>;

export const GarmentCartQuoteV1Schema = CompositionIdentityV1Schema.extend({
  quoteId: QuoteIdSchema,
  quoteVersion: z.string().min(1),
  expiresAt: IsoDateSchema,
  currency: z.string().min(1),
  totalMinorUnits: z.number().int().nonnegative(),
  rightsSnapshotId: z.string().min(1),
  preflightValidationId: z.string().min(1),
  shippingDisclosureStatus: z.enum(["unverified", "verified_for_region", "unavailable"]),
  eligibleForCart: z.boolean(),
}).strict();
export type GarmentCartQuoteV1 = z.infer<typeof GarmentCartQuoteV1Schema>;

/**
 * doc 21 ED-03 / doc 23 "proof/preflight/quote hash match": the displayed proof, validation and
 * cart quote must all reference the SAME immutable compositionVersionId + sceneHashSha256 as
 * `identity`. A draft edit invalidates the freeze and must requote, never redisplay stale proof
 * under a mismatched identity.
 */
export const CompositionReviewProjectionV1Schema = z.object({
  screenId: z.literal("ED-03"),
  identity: CompositionIdentityV1Schema,
  displayedProof: ScopedArtifactV1Schema.nullable(),
  validation: SnapshotValidationV1Schema.nullable(),
  cartQuote: GarmentCartQuoteV1Schema.nullable(),
  newUnfrozenEditsExist: z.boolean(),
  allowedActions: z.array(PublicActionSchema),
}).strict().refine(
  review => (review.displayedProof === null || review.displayedProof.sourceCompositionVersionId === review.identity.compositionVersionId)
    && (review.validation === null || review.validation.sourceCompositionVersionId === review.identity.compositionVersionId)
    && (review.cartQuote === null || review.cartQuote.compositionVersionId === review.identity.compositionVersionId),
  "proof, validation and cart quote must all reference the same frozen composition version as identity",
);
export type CompositionReviewProjectionV1 = z.infer<typeof CompositionReviewProjectionV1Schema>;

export const PhysicalLayerGeometryV1Schema = z.object({
  xMm: z.number(), yMm: z.number(), widthMm: z.number().positive(), heightMm: z.number().positive(),
  rotationDeg: z.number(), zIndex: z.number().int(), visible: z.boolean(),
}).strict();
export type PhysicalLayerGeometryV1 = z.infer<typeof PhysicalLayerGeometryV1Schema>;

export const EditorLayerV1Schema = z.union([
  PhysicalLayerGeometryV1Schema.extend({
    kind: z.literal("image"), layerId: z.string().min(1),
    sourceAssetId: z.string().min(1), sourceAssetSha256: HashSha256Schema,
  }).strict(),
  PhysicalLayerGeometryV1Schema.extend({
    kind: z.literal("text"), layerId: z.string().min(1), text: z.string(),
    fontAssetId: z.string().min(1), fontFileSha256: HashSha256Schema, fontLicenseVersion: z.string().min(1),
    fontSizePt: z.number().positive(), color: z.string().min(1),
  }).strict(),
]);
export type EditorLayerV1 = z.infer<typeof EditorLayerV1Schema>;

export const EditorPageV1Schema = z.object({
  zoneId: z.string().min(1),
  layers: z.array(EditorLayerV1Schema),
}).strict();
export type EditorPageV1 = z.infer<typeof EditorPageV1Schema>;

export const EditorDraftProjectionV1Schema = z.object({
  schemaVersion: z.literal("editor-draft.v1"),
  compositionId: z.string().min(1),
  draftRevision: z.number().int().nonnegative(),
  ownerKind: z.enum(["guest_capability", "authenticated_owner"]),
  pages: z.array(EditorPageV1Schema),
  selectedZoneId: z.string().min(1),
  hasUnfrozenChanges: z.boolean(),
  canPersistToAccount: z.boolean(),
}).strict();
export type EditorDraftProjectionV1 = z.infer<typeof EditorDraftProjectionV1Schema>;

export const EditorScreenV1Schema = z.union([
  z.object({
    schemaVersion: z.literal("editor-screen.v1"), screenId: z.literal("ED-01"), route: z.literal("/customize"),
    guestPermitted: z.literal(true), entrySource: z.enum(["direct_byo", "studio_transfer"]),
    draft: EditorDraftProjectionV1Schema.nullable(), actions: z.array(PublicActionSchema),
  }).strict(),
  z.object({
    schemaVersion: z.literal("editor-screen.v1"), screenId: z.literal("ED-02"), route: z.string().min(1),
    draft: EditorDraftProjectionV1Schema, frozenVersions: z.array(CompositionIdentityV1Schema),
    autosave: z.enum(["idle", "pending", "conflict", "failed"]), actions: z.array(PublicActionSchema),
  }).strict(),
  CompositionReviewProjectionV1Schema.and(z.object({ schemaVersion: z.literal("editor-screen.v1"), route: z.string().min(1) }).strict()),
]);
export type EditorScreenV1 = z.infer<typeof EditorScreenV1Schema>;
