/**
 * Runtime-validated branded identifiers.
 * Source: docs/technical/reference-contracts/v1.1/vynvori-v1_1-proposed.ts (Brand<T, Tag>).
 * These are proposed public contracts (doc 23) — no deployed API, DB schema or
 * authorization grant is implied by validating against them.
 */
import { z } from "zod";

function brandedString<Tag extends string>() {
  return z.string().min(1).brand<Tag>();
}

export const ProjectIdSchema = brandedString<"ProjectId">();
export const DirectionIdSchema = brandedString<"DirectionId">();
export const VersionIdSchema = brandedString<"VersionId">();
export const OperationIdSchema = brandedString<"OperationId">();
export const QuoteIdSchema = brandedString<"QuoteId">();
export const ReceiptIdSchema = brandedString<"ReceiptId">();

export type ProjectId = z.infer<typeof ProjectIdSchema>;
export type DirectionId = z.infer<typeof DirectionIdSchema>;
export type VersionId = z.infer<typeof VersionIdSchema>;
export type OperationId = z.infer<typeof OperationIdSchema>;
export type QuoteId = z.infer<typeof QuoteIdSchema>;
export type ReceiptId = z.infer<typeof ReceiptIdSchema>;

/** 64 lowercase-hex SHA-256, per doc 23's content-hash requirements. */
export const HashSha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "expected 64 lowercase hex characters");
export type HashSha256 = z.infer<typeof HashSha256Schema>;

/** ISO 8601 timestamp used for issuedAt/expiresAt/approvedAt/etc. */
export const IsoDateSchema = z.string().refine(value => !Number.isNaN(Date.parse(value)), "expected ISO 8601 timestamp");
export type IsoDate = z.infer<typeof IsoDateSchema>;

/** Non-negative integer unit count (credits, slots, counts) — never a float, never negative. */
export const NaturalNumberSchema = z.number().int().nonnegative();
