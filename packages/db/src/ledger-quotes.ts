import "server-only";
import { z } from "zod";
import { QuoteViewV3Schema, type QuoteViewV3 } from "@vynvori/contracts";
import { LedgerQuoteRecordV1Schema, type LedgerQuoteRecordV1, type PricePolicyPort } from "@vynvori/contracts/ledger-internal";
import {
  LedgerBusinessRejection, LedgerError, assertPositiveUnits, canonicalRequestHash, ensureWallet, parseSafeUnits, runLedgerCommand,
  type LedgerDb, type LedgerQueryable,
} from "./ledger-core";

/**
 * M7 S3 ledger quotes (ADR-0021 D5 allocation rules, D7 storage, S3 addendum). Library only: nothing under apps/ imports it
 * (static test). Writes only vynvori_ledger.ledger_quote_lineages / ledger_quotes / ledger_quote_allocations and never
 * touches Medusa. No price, credit cost or duration value lives here: the ledger verifies a caller-supplied priced view and
 * allocation vector, it never computes one (D5). issueQuote and renewQuote are SYSTEM-actor commands: the priced values come
 * from the server's pricing service, never from the customer's own request.
 */
const S = "vynvori_ledger";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const QUOTE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const QUOTE_VERSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
/** Technical bounds, not business values: the package exports no numeric constants. */
const MAX_MODEL_REF_LENGTH = 4096, MAX_ALLOCATIONS = 1000;

function assertUuid(value: unknown): string { if (typeof value !== "string" || !UUID.test(value)) throw new LedgerError("INVALID_INPUT"); return value; }
function assertQuoteId(value: unknown): string { if (typeof value !== "string" || !QUOTE_ID.test(value)) throw new LedgerError("INVALID_INPUT"); return value; }
function assertQuoteVersionId(value: unknown): string { if (typeof value !== "string" || !QUOTE_VERSION_ID.test(value)) throw new LedgerError("INVALID_INPUT"); return value; }
function assertModelRef(value: unknown): string { if (typeof value !== "string" || value.length < 1 || value.length > MAX_MODEL_REF_LENGTH) throw new LedgerError("INVALID_INPUT"); return value; }

/** The payload type `runLedgerCommand`/`canonicalRequestHash` expect (private in ledger-core; extracted structurally). */
type LedgerJson = Parameters<typeof canonicalRequestHash>[0];
const asLedgerJson = (value: unknown) => value as LedgerJson;

/** D5 allocation input shape: QuoteAllocationV1 without the quoteVersionId, which is not yet known to the caller. */
const AllocationInputSchema = z.object({
  operationIndex: z.number().int().nonnegative(),
  holdUnits: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  chargeUnits: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
}).strict().refine(a => a.chargeUnits <= a.holdUnits, { path: ["chargeUnits"], message: "charge cannot exceed hold" });
export type AllocationInputV1 = z.infer<typeof AllocationInputSchema>;

function parseAllocations(raw: unknown): AllocationInputV1[] {
  if (!Array.isArray(raw) || raw.length > MAX_ALLOCATIONS) throw new LedgerError("INVALID_INPUT");
  return raw.map(item => { const parsed = AllocationInputSchema.safeParse(item); if (!parsed.success) throw new LedgerError("INVALID_INPUT"); return parsed.data; });
}

/** Parses the caller's priced view. A parse failure is malformed input, not a business rejection. */
function parseView(raw: unknown): QuoteViewV3 {
  const parsed = QuoteViewV3Schema.safeParse(raw);
  if (!parsed.success) throw new LedgerError("INVALID_INPUT");
  return parsed.data;
}
/** Re-parses a STORED view. A stored row that no longer parses is corruption, never a caller mistake: fail closed. */
function parseStoredView(raw: unknown): QuoteViewV3 {
  const parsed = QuoteViewV3Schema.safeParse(raw);
  if (!parsed.success) throw new LedgerError("DATABASE_ERROR");
  return parsed.data;
}

/**
 * Code-side validation, before any SQL (the DB constraints below are the backstop, not the first line). For final_* quotes
 * the caller's modelRef must equal the view's own model qualification snapshot; every other kind needs no separate model
 * check. Promo quotes carry no allocations; every other kind's allocations must be contiguous from 0 and sum exactly to the
 * view's maxHoldUnits / creditsQuoted. Any violation is ALLOCATION_INVALID -- persisted under the idempotency key, never a
 * caller-visible crash.
 */
function validateAllocationShape(view: QuoteViewV3, modelRef: string, allocations: readonly AllocationInputV1[]): void {
  if ((view.offerKind === "final_standard" || view.offerKind === "final_premium") && modelRef !== view.modelQualificationSnapshotId) {
    throw new LedgerBusinessRejection("ALLOCATION_INVALID");
  }
  if (view.offerKind === "promo_single_preview") {
    if (allocations.length !== 0) throw new LedgerBusinessRejection("ALLOCATION_INVALID");
    return;
  }
  if (allocations.length === 0) throw new LedgerBusinessRejection("ALLOCATION_INVALID");
  const indices = allocations.map(a => a.operationIndex).slice().sort((a, b) => a - b);
  if (indices.some((index, position) => index !== position)) throw new LedgerBusinessRejection("ALLOCATION_INVALID");
  let holdSum = 0, chargeSum = 0;
  for (const allocation of allocations) { holdSum += allocation.holdUnits; chargeSum += allocation.chargeUnits; }
  if (holdSum !== view.maxHoldUnits || chargeSum !== view.creditsQuoted) throw new LedgerBusinessRejection("ALLOCATION_INVALID");
}

/** The ledger computes its own content hash; a caller-supplied hash is never trusted (ADR-0021 D10). */
function contentPayload(view: QuoteViewV3, modelRef: string, allocations: readonly AllocationInputV1[]) {
  const ordered = [...allocations].sort((a, b) => a.operationIndex - b.operationIndex)
    .map(a => ({ operationIndex: a.operationIndex, holdUnits: a.holdUnits, chargeUnits: a.chargeUnits }));
  return { quoteView: view, modelRef, allocations: ordered };
}
function computeContentSha256(view: QuoteViewV3, modelRef: string, allocations: readonly AllocationInputV1[]): string {
  return canonicalRequestHash(asLedgerJson(contentPayload(view, modelRef, allocations)));
}

export interface IssueQuoteInput {
  readonly userId: string;
  readonly quoteView: unknown;
  readonly modelRef: string;
  readonly allocations: readonly AllocationInputV1[];
  readonly idempotencyKey: string;
}
export interface RenewQuoteInput extends IssueQuoteInput {
  readonly quoteId: string;
  readonly expectedLatestVersionNo: number;
}
export interface QuoteAllocationRecord { readonly quoteVersionId: string; readonly operationIndex: number; readonly holdUnits: number; readonly chargeUnits: number }
export interface QuoteWithAllocations { readonly record: LedgerQuoteRecordV1; readonly allocations: readonly QuoteAllocationRecord[] }
export type QuoteAuthorizationAssessmentCode = "QUOTE_STALE" | "QUOTE_EXPIRED" | "ALLOCATION_INVALID" | "NOT_FOUND" | "DATABASE_ERROR";
export type QuoteAuthorizationAssessment = { readonly ok: true } | { readonly ok: false; readonly code: QuoteAuthorizationAssessmentCode };
export interface AssessQuoteInput { readonly userId: string; readonly quoteVersionId: string; readonly now: Date; readonly pricePolicy: PricePolicyPort }

type QuoteRow = {
  quote_version_id: string; quote_id: string; version_no: number; user_id: string; operation_kind: string; model_ref: string;
  max_charge_units: string; credits_quoted: string; issued_at: Date; expires_at: Date; price_version: string;
  capability_snapshot_id: string; consent_text_version: string; quote_view: unknown; content_sha256: string;
};
const QUOTE_COLUMNS = `quote_version_id, quote_id, version_no, user_id, operation_kind, model_ref,
  max_charge_units::text AS max_charge_units, credits_quoted::text AS credits_quoted, issued_at, expires_at,
  price_version, capability_snapshot_id, consent_text_version, quote_view, content_sha256`;

/** Reconstructs the public record from a stored row. The row's own view is re-parsed, never trusted blindly. */
function toRecord(row: QuoteRow, allocationRows: readonly { operation_index: number; hold_units: string; charge_units: string }[]): QuoteWithAllocations {
  const view = parseStoredView(row.quote_view);
  const candidate = {
    quoteVersionId: row.quote_version_id, quoteId: row.quote_id, versionNo: row.version_no, userId: row.user_id,
    operationKind: row.operation_kind, modelRef: row.model_ref,
    maxChargeUnits: parseSafeUnits(row.max_charge_units), creditsQuoted: parseSafeUnits(row.credits_quoted),
    issuedAt: row.issued_at.toISOString(), expiresAt: row.expires_at.toISOString(),
    priceVersion: row.price_version, capabilitySnapshotId: row.capability_snapshot_id, consentTextVersion: row.consent_text_version,
    contentSha256: row.content_sha256, quoteView: view,
  };
  const parsed = LedgerQuoteRecordV1Schema.safeParse(candidate);
  if (!parsed.success) throw new LedgerError("DATABASE_ERROR");
  const allocations = allocationRows.map(a => ({ quoteVersionId: row.quote_version_id, operationIndex: a.operation_index, holdUnits: parseSafeUnits(a.hold_units), chargeUnits: parseSafeUnits(a.charge_units) }));
  return { record: parsed.data, allocations };
}

async function fetchAllocations(db: LedgerQueryable, quoteVersionId: string) {
  return (await db.query(`SELECT operation_index, hold_units::text AS hold_units, charge_units::text AS charge_units FROM ${S}.ledger_quote_allocations WHERE quote_version_id = $1 ORDER BY operation_index`, [quoteVersionId])).rows as unknown as { operation_index: number; hold_units: string; charge_units: string }[];
}

/** Owner-scoped read. Absent and foreign quote versions are the same NOT_FOUND. */
export async function getQuote(db: LedgerQueryable, userId: string, quoteVersionId: string): Promise<QuoteWithAllocations> {
  const uid = assertUuid(userId), qvid = assertQuoteVersionId(quoteVersionId);
  const row = (await db.query(`SELECT ${QUOTE_COLUMNS} FROM ${S}.ledger_quotes WHERE quote_version_id = $1 AND user_id = $2`, [qvid, uid])).rows[0] as QuoteRow | undefined;
  if (!row) throw new LedgerError("NOT_FOUND");
  return toRecord(row, await fetchAllocations(db, qvid));
}

/** Owner-scoped read of the latest (derived) version of a lineage. Absent and foreign quote ids are the same NOT_FOUND. */
export async function getLatestQuoteVersion(db: LedgerQueryable, userId: string, quoteId: string): Promise<QuoteWithAllocations> {
  const uid = assertUuid(userId), qid = assertQuoteId(quoteId);
  const row = (await db.query(`SELECT ${QUOTE_COLUMNS} FROM ${S}.ledger_quotes WHERE quote_id = $1 AND user_id = $2 ORDER BY version_no DESC LIMIT 1`, [qid, uid])).rows[0] as QuoteRow | undefined;
  if (!row) throw new LedgerError("NOT_FOUND");
  return toRecord(row, await fetchAllocations(db, row.quote_version_id));
}

async function assertLineageOwner(tx: LedgerQueryable, quoteId: string, userId: string): Promise<void> {
  const row = (await tx.query(`SELECT user_id FROM ${S}.ledger_quote_lineages WHERE quote_id = $1`, [quoteId])).rows[0] as { user_id?: string } | undefined;
  if (!row || row.user_id !== userId) throw new LedgerError("NOT_FOUND");
}
async function latestVersionNo(tx: LedgerQueryable, quoteId: string): Promise<number> {
  const row = (await tx.query(`SELECT coalesce(max(version_no), 0)::int AS v FROM ${S}.ledger_quotes WHERE quote_id = $1`, [quoteId])).rows[0] as { v: number };
  return row.v;
}

async function insertLineage(tx: LedgerQueryable, quoteId: string, userId: string): Promise<void> {
  try {
    await tx.query(`INSERT INTO ${S}.ledger_quote_lineages(quote_id, user_id) VALUES($1, $2)`, [quoteId, userId]);
  } catch (error) {
    // The quote_id already has a lineage -- own or foreign, no probing: both report the same QUOTE_STALE.
    if ((error as { code?: string }).code === "23505") throw new LedgerBusinessRejection("QUOTE_STALE");
    throw error;
  }
}

async function insertQuoteVersion(tx: LedgerQueryable, row: {
  quoteVersionId: string; quoteId: string; versionNo: number; userId: string; operationKind: string; modelRef: string;
  maxChargeUnits: number; creditsQuoted: number; issuedAt: string; expiresAt: string; priceVersion: string;
  capabilitySnapshotId: string; consentTextVersion: string; quoteView: unknown; contentSha256: string;
}): Promise<void> {
  try {
    await tx.query(
      `INSERT INTO ${S}.ledger_quotes(quote_version_id, quote_id, version_no, user_id, operation_kind, model_ref, max_charge_units, credits_quoted, issued_at, expires_at, price_version, capability_snapshot_id, consent_text_version, quote_view, content_sha256)
       VALUES($1,$2,$3,$4,$5,$6,$7::bigint,$8::bigint,$9,$10,$11,$12,$13,$14::jsonb,$15)`,
      [row.quoteVersionId, row.quoteId, row.versionNo, row.userId, row.operationKind, row.modelRef, String(row.maxChargeUnits), String(row.creditsQuoted),
        row.issuedAt, row.expiresAt, row.priceVersion, row.capabilitySnapshotId, row.consentTextVersion, JSON.stringify(row.quoteView), row.contentSha256],
    );
  } catch (error) {
    const code = (error as { code?: string }).code;
    // 23505: the exact version_no already exists (a bypassed-lock race lost to a concurrent winner, ADR-0021 S3 addendum A2).
    // 23000: the contiguity/operation_kind trigger rejected this insert. Either way the caller's view of "latest" was stale.
    if (code === "23505" || code === "23000") throw new LedgerBusinessRejection("QUOTE_STALE");
    throw error;
  }
}
async function insertAllocations(tx: LedgerQueryable, quoteVersionId: string, allocations: readonly AllocationInputV1[]): Promise<void> {
  for (const allocation of allocations) {
    await tx.query(
      `INSERT INTO ${S}.ledger_quote_allocations(quote_version_id, operation_index, hold_units, charge_units) VALUES($1,$2::smallint,$3::bigint,$4::bigint)`,
      [quoteVersionId, allocation.operationIndex, String(allocation.holdUnits), String(allocation.chargeUnits)],
    );
  }
}

/** ensureWallet needs a direct query(); every LedgerDb used here in practice (a real Pool, or a test double that also implements query for this reason) provides one. */
const asQueryable = (db: LedgerDb) => db as unknown as LedgerQueryable;

/**
 * Issues version 1 of a new quote lineage. A SYSTEM-actor command (ADR-0021 S3 addendum): the priced view, model reference
 * and allocation vector come from the server's pricing service, never from the customer's own request. Rejects an existing
 * quote_id (own or foreign) with QUOTE_STALE, with no distinguishing probe response.
 */
export async function issueQuote(db: LedgerDb, input: IssueQuoteInput): Promise<QuoteWithAllocations> {
  const userId = assertUuid(input.userId);
  const view = parseView(input.quoteView);
  const modelRef = assertModelRef(input.modelRef);
  const allocations = parseAllocations(input.allocations);
  const contentSha256 = computeContentSha256(view, modelRef, allocations);
  const quoteId = assertQuoteId(view.quoteId);
  const quoteVersionId = assertQuoteVersionId(view.quoteVersionId);

  await ensureWallet(asQueryable(db), userId);
  await runLedgerCommand(db, {
    actor: "system", component: "quotes", expectedUserId: userId, userId, commandKind: "quote_issue",
    idempotencyKey: input.idempotencyKey,
    payload: asLedgerJson({ quoteView: view, modelRef, allocations }),
  }, async tx => {
    // Business validation runs inside the command, after the wallet lock: a rejection here is persisted under the
    // key (runLedgerCommand's savepoint mechanism) and replays identically, never re-running this callback.
    validateAllocationShape(view, modelRef, allocations);
    await insertLineage(tx, quoteId, userId);
    await insertQuoteVersion(tx, {
      quoteVersionId, quoteId, versionNo: 1, userId, operationKind: view.offerKind, modelRef,
      maxChargeUnits: view.maxHoldUnits, creditsQuoted: view.creditsQuoted, issuedAt: view.issuedAt, expiresAt: view.expiresAt,
      priceVersion: view.pricePolicyVersion, capabilitySnapshotId: view.capabilitySnapshotId, consentTextVersion: view.consentTextVersion,
      quoteView: view, contentSha256,
    });
    await insertAllocations(tx, quoteVersionId, allocations);
  });
  return getQuote(asQueryable(db), userId, quoteVersionId);
}

/**
 * Compare-and-swap renewal: inserts version n+1 only if the latest version_no under the wallet lock equals
 * `expectedLatestVersionNo` exactly (ADR-0021 S3 addendum A1); otherwise QUOTE_STALE. Absent or foreign lineage is NOT_FOUND
 * (same response either way). A SYSTEM-actor command, like issueQuote.
 */
export async function renewQuote(db: LedgerDb, input: RenewQuoteInput): Promise<QuoteWithAllocations> {
  const userId = assertUuid(input.userId);
  const quoteId = assertQuoteId(input.quoteId);
  const expectedLatestVersionNo = assertPositiveUnits(input.expectedLatestVersionNo);
  const view = parseView(input.quoteView);
  if (view.quoteId !== quoteId) throw new LedgerError("INVALID_INPUT");
  const modelRef = assertModelRef(input.modelRef);
  const allocations = parseAllocations(input.allocations);
  const contentSha256 = computeContentSha256(view, modelRef, allocations);
  const quoteVersionId = assertQuoteVersionId(view.quoteVersionId);

  await ensureWallet(asQueryable(db), userId);
  await runLedgerCommand(db, {
    actor: "system", component: "quotes", expectedUserId: userId, userId, commandKind: "quote_renew",
    idempotencyKey: input.idempotencyKey,
    payload: asLedgerJson({ quoteId, expectedLatestVersionNo, quoteView: view, modelRef, allocations }),
  }, async tx => {
    await assertLineageOwner(tx, quoteId, userId);
    const latest = await latestVersionNo(tx, quoteId);
    if (latest !== expectedLatestVersionNo) throw new LedgerBusinessRejection("QUOTE_STALE");
    // Business validation runs inside the command, after the CAS check: a rejection here is persisted under the
    // key and replays identically, never re-running this callback.
    validateAllocationShape(view, modelRef, allocations);
    await insertQuoteVersion(tx, {
      quoteVersionId, quoteId, versionNo: latest + 1, userId, operationKind: view.offerKind, modelRef,
      maxChargeUnits: view.maxHoldUnits, creditsQuoted: view.creditsQuoted, issuedAt: view.issuedAt, expiresAt: view.expiresAt,
      priceVersion: view.pricePolicyVersion, capabilitySnapshotId: view.capabilitySnapshotId, consentTextVersion: view.consentTextVersion,
      quoteView: view, contentSha256,
    });
    await insertAllocations(tx, quoteVersionId, allocations);
  });
  return getQuote(asQueryable(db), userId, quoteVersionId);
}

/**
 * READ-ONLY (runnable inside a caller-supplied READ ONLY transaction): is this quote version still authorizable? Order
 * (ADR-0021 S3 addendum): latest version (else QUOTE_STALE) -> not expired, now == expiresAt counts as expired (else
 * QUOTE_EXPIRED) -> price_version still current (else QUOTE_STALE) -> integrity (the stored view re-parses and its
 * recomputed hash matches; a mismatch is DATABASE_ERROR and fail-closed, never authorizable) -> allocations re-verified from
 * the rows actually stored (else ALLOCATION_INVALID). The clock is the injected `now`; the database's own now() is never
 * used. Authorized-lineage refusal and authorization-time re-assessment of eligibility arrive in S5.
 */
export async function assessQuoteForAuthorization(db: LedgerQueryable, input: AssessQuoteInput): Promise<QuoteAuthorizationAssessment> {
  const userId = assertUuid(input.userId), quoteVersionId = assertQuoteVersionId(input.quoteVersionId);
  const row = (await db.query(`SELECT ${QUOTE_COLUMNS} FROM ${S}.ledger_quotes WHERE quote_version_id = $1 AND user_id = $2`, [quoteVersionId, userId])).rows[0] as QuoteRow | undefined;
  if (!row) return { ok: false, code: "NOT_FOUND" };
  const latest = await latestVersionNo(db, row.quote_id);
  if (latest !== row.version_no) return { ok: false, code: "QUOTE_STALE" };
  if (input.now.getTime() >= row.expires_at.getTime()) return { ok: false, code: "QUOTE_EXPIRED" };
  if (!(await input.pricePolicy.isPriceVersionCurrent(row.price_version))) return { ok: false, code: "QUOTE_STALE" };

  let view: QuoteViewV3;
  try { view = parseStoredView(row.quote_view); } catch { return { ok: false, code: "DATABASE_ERROR" }; }
  const allocationRows = await fetchAllocations(db, quoteVersionId);
  const allocations = allocationRows.map(a => ({ operationIndex: a.operation_index, holdUnits: parseSafeUnits(a.hold_units), chargeUnits: parseSafeUnits(a.charge_units) }));
  const recomputed = computeContentSha256(view, row.model_ref, allocations);
  if (recomputed !== row.content_sha256) return { ok: false, code: "DATABASE_ERROR" };
  try { validateAllocationShape(view, row.model_ref, allocations); } catch (error) {
    if (error instanceof LedgerBusinessRejection) return { ok: false, code: "ALLOCATION_INVALID" };
    throw error;
  }
  return { ok: true };
}
