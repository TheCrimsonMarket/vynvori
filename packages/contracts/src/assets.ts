/**
 * Asset lineage classification and the Neon/Medusa production job state machine.
 * Source: docs/technical/reference-contracts/v1.1/vynvori-v1_1-proposed.ts;
 * docs/technical/04-domain-database-model.md §Suggested states;
 * docs/technical/22-canonical-state-machines.md Plane E.
 */
import { z } from "zod";
import { HashSha256Schema } from "./ids";

export const ImageAssetKindV1Schema = z.enum([
  "customer_original", "provider_original", "derived_preview", "garment_mockup",
  "digital_export", "print_master", "qa_proof",
]);
export type ImageAssetKindV1 = z.infer<typeof ImageAssetKindV1Schema>;

export const AssetLineageV1Schema = z.object({
  assetId: z.string().min(1),
  kind: ImageAssetKindV1Schema,
  sourceHashes: z.array(z.string().min(1)),
  sha256: HashSha256Schema,
  rightsPolicyVersion: z.string().min(1),
  ownerId: z.string().min(1),
  rendererVersion: z.string().min(1).optional(),
  printProfileVersion: z.string().min(1).optional(),
}).strict();
export type AssetLineageV1 = z.infer<typeof AssetLineageV1Schema>;

export const ProductionJobStateV1Schema = z.enum([
  "pending_asset_verification", "preflight_pending", "preflight_blocked", "awaiting_human_qa",
  "needs_customer_reapproval", "approved_for_print", "released_to_partner", "printing",
  "printed", "packed", "awaiting_dispatch", "shipped", "delivered",
  "cancelled_before_release", "production_exception",
]);
export type ProductionJobStateV1 = z.infer<typeof ProductionJobStateV1Schema>;
