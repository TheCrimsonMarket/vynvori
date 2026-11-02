/**
 * Account wallet/export entitlements and the authoritative Medusa cart/checkout projection.
 * Source: docs/technical/reference-contracts/v1.1/vynvori-phase6e-companion.proposed.ts
 * (AccountScreenV1, CommerceScreenV1, DigitalExportEntitlementV1, CustomerDigitalExportEntitlementV1).
 * Payment-capture evidence (`verifiedCaptureId`) stays on the internal entitlement type only —
 * it must never reach `CustomerSafeExportViewV1` (see `internal.ts` and `findLeakedInternalFields`).
 */
import { z } from "zod";
import { CustomerErrorCodeSchema, PublicActionSchema } from "./errors";
import { HashSha256Schema, QuoteIdSchema, ReceiptIdSchema, VersionIdSchema } from "./ids";
import { CreditWalletSummaryV1Schema } from "./quote";
import { CompositionIdentityV1Schema } from "./editor";

export const DigitalExportKindV1Schema = z.enum(["artwork_export", "composition_export"]);
export type DigitalExportKindV1 = z.infer<typeof DigitalExportKindV1Schema>;

/** INTERNAL — carries `verifiedCaptureId`. Never serialize through a public read-model route. */
export const DigitalExportEntitlementV1Schema = z.union([
  z.object({
    status: z.enum(["paid_pending_artifact", "under_review", "revoked", "refunded"]),
    entitlementId: z.string().min(1), ownerId: z.string().min(1), kind: DigitalExportKindV1Schema,
    sourceVersionId: VersionIdSchema, sourceVersionSha256: HashSha256Schema,
    medusaOrderLineId: z.string().min(1), verifiedCaptureId: z.string().min(1),
    rightsPolicyVersion: z.string().min(1), termsVersion: z.string().min(1),
    artifactId: z.null(), artifactSha256: z.null(), exportProfileVersion: z.string().min(1),
  }).strict(),
  z.object({
    status: z.literal("ready"),
    entitlementId: z.string().min(1), ownerId: z.string().min(1), kind: DigitalExportKindV1Schema,
    sourceVersionId: VersionIdSchema, sourceVersionSha256: HashSha256Schema,
    medusaOrderLineId: z.string().min(1), verifiedCaptureId: z.string().min(1),
    rightsPolicyVersion: z.string().min(1), termsVersion: z.string().min(1),
    artifactId: z.string().min(1), artifactSha256: HashSha256Schema, exportProfileVersion: z.string().min(1),
  }).strict(),
]);
export type DigitalExportEntitlementV1 = z.infer<typeof DigitalExportEntitlementV1Schema>;

/** PUBLIC allowlist: identical to DigitalExportEntitlementV1 minus `verifiedCaptureId`. */
export const CustomerDigitalExportEntitlementV1Schema = z.union([
  z.object({
    status: z.enum(["paid_pending_artifact", "under_review", "revoked", "refunded"]),
    entitlementId: z.string().min(1), ownerId: z.string().min(1), kind: DigitalExportKindV1Schema,
    sourceVersionId: VersionIdSchema, sourceVersionSha256: HashSha256Schema,
    medusaOrderLineId: z.string().min(1),
    rightsPolicyVersion: z.string().min(1), termsVersion: z.string().min(1),
    artifactId: z.null(), artifactSha256: z.null(), exportProfileVersion: z.string().min(1),
  }).strict(),
  z.object({
    status: z.literal("ready"),
    entitlementId: z.string().min(1), ownerId: z.string().min(1), kind: DigitalExportKindV1Schema,
    sourceVersionId: VersionIdSchema, sourceVersionSha256: HashSha256Schema,
    medusaOrderLineId: z.string().min(1),
    rightsPolicyVersion: z.string().min(1), termsVersion: z.string().min(1),
    artifactId: z.string().min(1), artifactSha256: HashSha256Schema, exportProfileVersion: z.string().min(1),
  }).strict(),
]);
export type CustomerDigitalExportEntitlementV1 = z.infer<typeof CustomerDigitalExportEntitlementV1Schema>;

/** Strips `verifiedCaptureId` from an internal entitlement for public serialization. */
export function toCustomerDigitalExportEntitlement(entitlement: DigitalExportEntitlementV1): CustomerDigitalExportEntitlementV1 {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- deliberately dropping the internal-only field
  const { verifiedCaptureId, ...publicFields } = entitlement;
  return publicFields as CustomerDigitalExportEntitlementV1;
}

export const CustomerSafeExportViewV1Schema = z.object({
  entitlement: CustomerDigitalExportEntitlementV1Schema,
  downloadEligibility: z.enum(["available", "temporarily_unavailable", "not_permitted"]),
  downloadRoute: z.string().min(1).nullable(),
  reasonCodes: z.array(CustomerErrorCodeSchema),
}).strict();
export type CustomerSafeExportViewV1 = z.infer<typeof CustomerSafeExportViewV1Schema>;

export const AccountScreenV1Schema = z.union([
  z.object({
    schemaVersion: z.literal("account-screen.v1"), screenId: z.literal("AC-01"), view: z.literal("exports"),
    ownerId: z.string().min(1), exports: z.array(CustomerSafeExportViewV1Schema),
    actions: z.array(PublicActionSchema),
  }).strict(),
  z.object({
    schemaVersion: z.literal("account-screen.v1"), screenId: z.literal("AC-01"), view: z.literal("credits"),
    wallet: CreditWalletSummaryV1Schema, receiptIds: z.array(ReceiptIdSchema),
    supportCaseIds: z.array(z.string()), actions: z.array(PublicActionSchema),
  }).strict(),
  z.object({
    schemaVersion: z.literal("account-screen.v1"), screenId: z.literal("AC-01"), view: z.literal("projects"),
    ownerId: z.string().min(1), recordRefs: z.array(z.string()), actions: z.array(PublicActionSchema),
  }).strict(),
  z.object({
    schemaVersion: z.literal("account-screen.v1"), screenId: z.literal("AC-01"), view: z.literal("orders"),
    ownerId: z.string().min(1), recordRefs: z.array(z.string()), actions: z.array(PublicActionSchema),
  }).strict(),
]);
export type AccountScreenV1 = z.infer<typeof AccountScreenV1Schema>;

export const PersonalizedMedusaLineViewV1Schema = CompositionIdentityV1Schema.extend({
  medusaLineId: z.string().min(1), quantity: z.number().int().positive(), quoteId: QuoteIdSchema,
  preflightValidationId: z.string().min(1), sourceProofArtifactId: z.string().min(1),
  lineTotalMinorUnits: z.number().int().nonnegative(), currency: z.string().min(1),
}).strict();
export type PersonalizedMedusaLineViewV1 = z.infer<typeof PersonalizedMedusaLineViewV1Schema>;

export const CommerceScreenV1Schema = z.union([
  z.object({
    schemaVersion: z.literal("commerce-screen.v1"), screenId: z.literal("CO-01"), state: z.literal("empty"),
    route: z.literal("/cart"), lines: z.tuple([]), actions: z.array(PublicActionSchema),
  }).strict(),
  z.object({
    schemaVersion: z.literal("commerce-screen.v1"), screenId: z.literal("CO-01"),
    state: z.enum(["cart_review", "checkout_blocked", "checkout_ready", "payment_pending", "payment_under_review"]),
    route: z.enum(["/cart", "/checkout"]), medusaCartId: z.string().min(1),
    lines: z.array(PersonalizedMedusaLineViewV1Schema),
    verifiedRegion: z.string().min(1).nullable(), shippingStatus: z.enum(["not_quoted", "verified", "not_serviceable"]),
    paymentStatus: z.enum(["uninitiated", "pending", "captured", "failed", "under_review"]),
    errorCodes: z.array(z.string()), actions: z.array(PublicActionSchema),
  }).strict(),
]);
export type CommerceScreenV1 = z.infer<typeof CommerceScreenV1Schema>;
