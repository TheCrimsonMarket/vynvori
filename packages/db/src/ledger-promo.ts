import "server-only";
import { randomUUID } from "node:crypto";
import {
  PLANE_C_PROMO_GRAPH, canMarkOperationDelivered, canMarkReceiptSettled, canTransitionPlaneCPromo, type PlaneCPromoState,
} from "@vynvori/contracts";
import {
  LedgerBusinessRejection, LedgerError, canonicalRequestHash, ensureWallet, runLedgerCommand,
  type LedgerDb, type LedgerQueryable,
} from "./ledger-core";

/**
 * M7 S4 promo-claim uniqueness (ADR-0021 D8, S4 addendum). Library only: nothing under apps/ imports it (static test). It writes
 * vynvori_ledger.promo_claims and promo_claim_events and nothing else: a promo claim is an ENTITLEMENT, never a wallet debit, so no
 * function here reads or writes a wallet balance, a ledger entry, a quote or a reservation, and none registers a grant source (D12).
 * It never touches Medusa. No price, credit amount or duration lives here.
 *
 * One claim row per verified identity (issuer + subject), ever. The claim state changes only by inserting an event row; the database
 * enforces the PLANE_C_PROMO_GRAPH edges and the evidence matrix. Both commands are SYSTEM-actor commands run through
 * runLedgerCommand, so they are idempotent, serialize on the claimant's wallet row (D10) and persist terminal business rejections.
 */
const S = "vynvori_ledger";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN_128 = /^[A-Za-z0-9._:-]{1,128}$/;
const TOKEN_255 = /^[A-Za-z0-9._:-]{1,255}$/;

function assertUuid(value: unknown): string { if (typeof value !== "string" || !UUID.test(value)) throw new LedgerError("INVALID_INPUT"); return value; }
function assertToken(value: unknown, pattern: RegExp): string { if (typeof value !== "string" || !pattern.test(value)) throw new LedgerError("INVALID_INPUT"); return value; }

/** The payload type `runLedgerCommand`/`canonicalRequestHash` expect (private in ledger-core; extracted structurally). */
type LedgerJson = Parameters<typeof canonicalRequestHash>[0];

export type PromoClaimState = PlaneCPromoState;
export type PromoOutcome = "consumed" | "verified_uncharged_failure" | "claim_unknown";
/** The evidence kinds the database accepts (the CHECK matrix in 0004). First-hand kinds apply to claim_reserved; reconciled_* only to claim_unknown. */
export type PromoEvidenceKind =
  | "persisted_delivered" | "verified_zero_charge_failure" | "outcome_unknown" | "persistence_failed_under_review"
  | "reconciled_delivered" | "reconciled_uncharged_failure";

export interface PromoClaimRecord {
  readonly claimId: string;
  readonly userId: string;
  readonly operationId: string;
  readonly state: PromoClaimState;
  /** Number of recorded events: 0 = eligible, 1 = claim_reserved, and so on. */
  readonly eventSeq: number;
}
export interface PromoClaimResult { readonly claim: PromoClaimRecord; readonly replayed: boolean }

export interface ClaimPromoInput {
  /** The verified profile (issuer + subject owner). A guest has no profile and therefore cannot claim. */
  readonly userId: string;
  /** The server-allocated studio operation that the free preview will run under. Unique across all claims. */
  readonly operationId: string;
  readonly idempotencyKey: string;
}

/**
 * Caller-asserted typed evidence, recorded and re-validated here like D6 (it is NOT proof: the authority for provider truth is
 * M6b/M8a). A vendor-charge message is never evidence. claim_unknown can be resolved only with the two reconciled_* kinds.
 */
export interface MarkPromoOutcomeInput {
  readonly userId: string;
  readonly claimId: string;
  readonly idempotencyKey: string;
  readonly outcome: PromoOutcome;
  readonly evidence: {
    readonly operationId: string;
    readonly evidenceRef: string;
    readonly evidenceKind: PromoEvidenceKind;
    /** Both must be true for a delivery (consumed). Ignored for the other outcomes. */
    readonly hasVerifiedManifestHash?: boolean;
    readonly ownerAndRightsVerified?: boolean;
  };
}

const EVIDENCE_KINDS: readonly PromoEvidenceKind[] = ["persisted_delivered", "verified_zero_charge_failure", "outcome_unknown", "persistence_failed_under_review", "reconciled_delivered", "reconciled_uncharged_failure"];
const OUTCOMES: readonly PromoOutcome[] = ["consumed", "verified_uncharged_failure", "claim_unknown"];
const CLAIM_STATES: readonly string[] = [...PLANE_C_PROMO_GRAPH.keys()];

/** Evidence kinds allowed per (current state, outcome). Mirrors the 0004 CHECK matrix; the database is the backstop. */
function allowedEvidence(from: PromoClaimState, outcome: PromoOutcome): readonly PromoEvidenceKind[] {
  if (from === "claim_reserved") {
    if (outcome === "consumed") return ["persisted_delivered"];
    if (outcome === "verified_uncharged_failure") return ["verified_zero_charge_failure"];
    return ["outcome_unknown", "persistence_failed_under_review"];
  }
  if (from === "claim_unknown") return outcome === "consumed" ? ["reconciled_delivered"] : outcome === "verified_uncharged_failure" ? ["reconciled_uncharged_failure"] : [];
  return [];
}

type ClaimRow = { claim_id: string; user_id: string; operation_id: string; state: string; event_seq: number };
const CLAIM_COLUMNS = "claim_id, user_id, operation_id, state, event_seq";
function toClaim(row: ClaimRow): PromoClaimRecord {
  if (!CLAIM_STATES.includes(row.state)) throw new LedgerError("DATABASE_ERROR"); // a stored state outside the graph is corruption, never a caller mistake
  return { claimId: row.claim_id, userId: row.user_id, operationId: row.operation_id, state: row.state as PromoClaimState, eventSeq: row.event_seq };
}
const asQueryable = (db: LedgerDb) => db as unknown as LedgerQueryable;

/** Owner-scoped read of the identity's single promo claim. Absent (including a guest) and foreign are the same NOT_FOUND. */
export async function getPromoClaim(db: LedgerQueryable, userId: string): Promise<PromoClaimRecord> {
  const uid = assertUuid(userId);
  const row = (await db.query(`SELECT ${CLAIM_COLUMNS} FROM ${S}.promo_claims WHERE user_id = $1`, [uid])).rows[0] as ClaimRow | undefined;
  if (!row) throw new LedgerError("NOT_FOUND");
  return toClaim(row);
}

/** Replay-safe reconstruction: the committed event of this command names the claim. Returns the claim's CURRENT state. */
async function claimOfCommand(db: LedgerQueryable, commandId: string, userId: string): Promise<PromoClaimRecord> {
  const row = (await db.query(
    `SELECT c.claim_id, c.user_id, c.operation_id, c.state, c.event_seq FROM ${S}.promo_claim_events e
       JOIN ${S}.promo_claims c ON c.claim_id = e.claim_id AND c.user_id = e.user_id WHERE e.command_id = $1 AND e.user_id = $2`, [commandId, userId])).rows[0] as ClaimRow | undefined;
  if (!row) throw new LedgerError("DATABASE_ERROR"); // a committed command with no event is impossible by the same-transaction insert: fail closed
  return toClaim(row);
}

/**
 * Claims the identity's one promo preview. A SYSTEM-actor command: the server allocates operationId; a customer never chooses it.
 *   - First claim for an identity: inserts the claim and its eligible -> claim_reserved event in one transaction.
 *   - Same key + same operationId again: replays (same claim, replayed = true). A different payload under the key is IDEMPOTENCY_CONFLICT.
 *   - Any other key once the identity has a claim, in ANY state (including claim_unknown and verified_uncharged_failure): the persisted
 *     business rejection PROMO_ALREADY_USED. A promo is never re-offered (founder ruling Q2).
 *   - A guest (no profile) or an unknown user: NOT_FOUND. No wallet balance is read or changed. If the profile has no wallet row yet, the
 *     empty all-zero wallet is created first because runLedgerCommand locks it (D10); that is not a balance change (D3).
 */
export async function claimPromo(db: LedgerDb, input: ClaimPromoInput): Promise<PromoClaimResult> {
  const userId = assertUuid(input.userId), operationId = assertToken(input.operationId, TOKEN_128);
  await ensureWallet(asQueryable(db), userId);
  const result = await runLedgerCommand(db, {
    actor: "system", component: "promo", expectedUserId: userId, userId, commandKind: "promo_claim",
    idempotencyKey: input.idempotencyKey, payload: { operationId } as LedgerJson,
  }, async tx => {
    const identity = (await tx.query(`SELECT issuer, subject FROM vynvori_identity.profiles WHERE id = $1`, [userId])).rows[0] as { issuer: string; subject: string } | undefined;
    if (!identity) throw new LedgerError("NOT_FOUND");
    const claimId = randomUUID();
    let inserted: { rows: Record<string, unknown>[] };
    try {
      inserted = await tx.query(
        `INSERT INTO ${S}.promo_claims(claim_id, user_id, issuer, subject, operation_id, state, event_seq) VALUES($1,$2,$3,$4,$5,'eligible',0)
         ON CONFLICT ON CONSTRAINT promo_claims_identity_unique DO NOTHING RETURNING claim_id`, [claimId, userId, identity.issuer, identity.subject, operationId]);
    } catch (error) {
      // The operation id is already bound to another claim: a server bug or a replayed operation, never a customer-visible state.
      if ((error as { code?: string; constraint?: string }).code === "23505" && (error as { constraint?: string }).constraint === "promo_claims_operation_unique") throw new LedgerError("DUPLICATE_CAUSE", "23505", "promo_claims_operation_unique");
      throw error;
    }
    if (inserted.rows.length !== 1) throw new LedgerBusinessRejection("PROMO_ALREADY_USED"); // the identity's unique index resolved the race: this caller lost
    await tx.query(
      `INSERT INTO ${S}.promo_claim_events(event_id, claim_id, user_id, operation_id, seq, from_state, to_state, evidence_kind, evidence_ref, command_id)
       VALUES($1,$2,$3,$4,1,'eligible','claim_reserved','claim_requested',$5,$6)`, [randomUUID(), claimId, userId, operationId, "claim:" + operationId, tx.commandId]);
  });
  return { claim: await claimOfCommand(asQueryable(db), result.commandId, userId), replayed: result.replayed };
}

/**
 * Records the outcome of the promo preview operation: consumed, verified_uncharged_failure or claim_unknown. A SYSTEM-actor command.
 * Evidence-gated like D6 and re-validated here with the existing contract guards; the database enforces the same matrix.
 *   - Illegal edge for the claim's current state (including any move out of a terminal state): persisted INVALID_TRANSITION.
 *   - Wrong evidence kind for that edge, an operation id that is not the claim's, or a delivery without a verified manifest hash and
 *     verified owner/rights: persisted EVIDENCE_INVALID. claim_unknown resolves only through the reconciled_* kinds.
 *   - Absent or foreign claim: NOT_FOUND (same answer for both). A malformed shape is INVALID_INPUT before any SQL.
 * Nothing here retries a provider call, releases anything automatically or touches a wallet.
 */
export async function markPromoOutcome(db: LedgerDb, input: MarkPromoOutcomeInput): Promise<PromoClaimResult> {
  const userId = assertUuid(input.userId), claimId = assertUuid(input.claimId);
  if (!(OUTCOMES as readonly string[]).includes(input.outcome) || typeof input.evidence !== "object" || input.evidence === null) throw new LedgerError("INVALID_INPUT");
  const evidence = {
    operationId: assertToken(input.evidence.operationId, TOKEN_128),
    evidenceRef: assertToken(input.evidence.evidenceRef, TOKEN_255),
    evidenceKind: input.evidence.evidenceKind,
    hasVerifiedManifestHash: input.evidence.hasVerifiedManifestHash === true,
    ownerAndRightsVerified: input.evidence.ownerAndRightsVerified === true,
  };
  if (!(EVIDENCE_KINDS as readonly string[]).includes(evidence.evidenceKind)) throw new LedgerError("INVALID_INPUT");
  const outcome = input.outcome;
  const result = await runLedgerCommand(db, {
    actor: "system", component: "promo", expectedUserId: userId, userId, commandKind: "promo_outcome",
    idempotencyKey: input.idempotencyKey, payload: { claimId, outcome, evidence } as LedgerJson,
  }, async tx => {
    const claim = (await tx.query(`SELECT ${CLAIM_COLUMNS} FROM ${S}.promo_claims WHERE claim_id = $1 AND user_id = $2 FOR UPDATE`, [claimId, userId])).rows[0] as ClaimRow | undefined;
    if (!claim) throw new LedgerError("NOT_FOUND"); // absent and foreign are the same answer, and are never persisted
    const from = toClaim(claim).state;
    if (!canTransitionPlaneCPromo(from, outcome)) throw new LedgerBusinessRejection("INVALID_TRANSITION");
    if (evidence.operationId !== claim.operation_id || !allowedEvidence(from, outcome).includes(evidence.evidenceKind)) throw new LedgerBusinessRejection("EVIDENCE_INVALID");
    if (outcome === "consumed") {
      const delivered = evidence.evidenceKind === "persisted_delivered"
        ? canMarkOperationDelivered({ providerStatus: "persisted_delivered", hasVerifiedManifestHash: evidence.hasVerifiedManifestHash, ownerAndRightsVerified: evidence.ownerAndRightsVerified })
        : canMarkReceiptSettled("reconciled_delivered") && evidence.hasVerifiedManifestHash && evidence.ownerAndRightsVerified;
      if (!delivered) throw new LedgerBusinessRejection("EVIDENCE_INVALID");
    }
    await tx.query(
      `INSERT INTO ${S}.promo_claim_events(event_id, claim_id, user_id, operation_id, seq, from_state, to_state, evidence_kind, evidence_ref, command_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [randomUUID(), claimId, userId, claim.operation_id, claim.event_seq + 1, from, outcome, evidence.evidenceKind, evidence.evidenceRef, tx.commandId]);
  });
  return { claim: await claimOfCommand(asQueryable(db), result.commandId, userId), replayed: result.replayed };
}
