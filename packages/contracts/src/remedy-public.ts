/**
 * Public-safe post-closure remedy status. F-R04 Option A is founder-approved POLICY only —
 * live remedy issuance remains BLOCKED pending operational SLAs (doc 22 §Post-closure remedy
 * authority). This module never carries actor IDs, idempotency keys or ledger/Medusa refund
 * identifiers — those stay on the internal types in `internal.ts`.
 */
import { z } from "zod";

export const RemedyKindV1Schema = z.enum(["replacement_service", "credit_adjustment", "monetary_refund"]);
export type RemedyKindV1 = z.infer<typeof RemedyKindV1Schema>;

export const CustomerRemedyStatusV1Schema = z.union([
  z.object({
    schemaVersion: z.literal("customer-remedy-status.v1"),
    caseReference: z.string().min(1),
    state: z.enum(["case_open", "under_review", "awaiting_customer_consent", "not_upheld"]),
    remedyKind: z.null(),
    publicRemedyReference: z.null(),
    originalPackageRemainsClosed: z.literal(true),
    explanation: z.string(),
    customerNoticeStatus: z.enum(["not_sent", "sent", "delivery_pending"]),
  }).strict(),
  z.object({
    schemaVersion: z.literal("customer-remedy-status.v1"),
    caseReference: z.string().min(1),
    state: z.enum(["approved", "in_progress", "completed", "remedy_under_reconciliation"]),
    remedyKind: RemedyKindV1Schema,
    publicRemedyReference: z.string().min(1).nullable(),
    originalPackageRemainsClosed: z.literal(true),
    explanation: z.string(),
    customerNoticeStatus: z.enum(["not_sent", "sent", "delivery_pending"]),
  }).strict(),
]);
export type CustomerRemedyStatusV1 = z.infer<typeof CustomerRemedyStatusV1Schema>;
