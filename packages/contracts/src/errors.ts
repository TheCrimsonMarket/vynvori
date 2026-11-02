/**
 * Public error codes and enums.
 * Source: docs/technical/23-typed-contracts-runtime-validation.md §Public error codes;
 * docs/technical/reference-contracts/v1.1/vynvori-v1_1-proposed.ts.
 */
import { z } from "zod";

export const CustomerErrorCodeSchema = z.enum([
  "AUTH_REQUIRED", "SSO_BRIDGE_UNAVAILABLE", "PLAN_NOT_APPROVED", "PLAN_STALE",
  "QUOTE_STALE", "QUOTE_EXPIRED", "INSUFFICIENT_CREDITS", "CONCEPT_MODEL_UNQUALIFIED",
  "STANDARD_FINAL_UNQUALIFIED", "DOWNSTREAM_USE_UNAVAILABLE", "RIGHTS_INELIGIBLE",
  "PROMO_ALREADY_USED", "PROVIDER_OUTCOME_UNKNOWN", "ARTIFACT_PERSISTENCE_UNCONFIRMED",
  "PARTIAL_DELIVERY", "QUALITY_CASE_OPEN", "REMEDY_REQUIRED", "PACKAGE_CLOSURE_PENDING",
  "INCLUDED_REFINEMENT_UNAVAILABLE", "DRAFT_EXPIRED", "CLAIM_CONFLICT", "PRINT_PROFILE_UNAPPROVED",
  "TERMS_NOT_APPROVED", "REGION_CHANGED", "RIGHTS_REVOKED", "QUOTE_USE_MISMATCH",
]);
export type CustomerErrorCode = z.infer<typeof CustomerErrorCodeSchema>;

/** Fields that must never appear in a public/customer-facing projection. */
export const FORBIDDEN_PUBLIC_FIELDS = Object.freeze([
  "providerJobId", "privateVendorCostUsd", "vendorCostEvidence", "internalInvoice", "staffNotes",
  "verifiedCaptureId", "authorizingStaffActorId", "staffAuthorizationEvidenceId",
  "privateLedgerAdjustmentId", "medusaRefundId", "idempotencyKey", "idempotencyScope",
] as const);

export const CapabilitySchema = z.enum(["available", "unavailable", "under_review"]);
export type Capability = z.infer<typeof CapabilitySchema>;

export const OfferComponentSchema = z.enum([
  "three_new_concepts", "two_optional_included_refinements", "one_optional_intro_preview",
  "standard_final_render", "premium_final_render", "digital_art_export", "composition_export",
  "personalized_garment", "printing", "shipping",
]);
export type OfferComponent = z.infer<typeof OfferComponentSchema>;

export const SafeActionV1Schema = z.enum([
  "approve_plan", "inspect_quote", "authorize_promo", "authorize_bundle", "view_partial",
  "select_concept", "skip_refinement", "restore_refinement", "authorize_refinement",
  "inspect_final_quote", "authorize_final", "use_version", "save_version",
  "request_quoted_revision", "report_quality", "open_support", "resume",
]);
export type SafeActionV1 = z.infer<typeof SafeActionV1Schema>;

export const PublicActionSchema = z.enum([
  "inspect", "edit_new_version", "freeze", "request_preflight", "quote", "add_to_cart",
  "sign_in", "claim_draft", "view_orders", "view_wallet", "request_download",
  "open_support_case", "go_back",
]);
export type PublicAction = z.infer<typeof PublicActionSchema>;

/** Recursively scans a parsed value for any key in FORBIDDEN_PUBLIC_FIELDS. */
export function findLeakedInternalFields(value: unknown, depth = 0): string[] {
  if (depth > 20 || value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(item => findLeakedInternalFields(item, depth + 1));
  const found: string[] = [];
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if ((FORBIDDEN_PUBLIC_FIELDS as readonly string[]).includes(key)) found.push(key);
    found.push(...findLeakedInternalFields(nested, depth + 1));
  }
  return found;
}
