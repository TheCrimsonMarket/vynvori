import "server-only";
import { randomUUID } from "node:crypto";
import { canMarkOperationDelivered, canMarkReceiptSettled } from "@vynvori/contracts";
import { IdempotencyKeySchema, TransitionEvidenceV1Schema, type TransitionEvidenceV1 } from "@vynvori/contracts/ledger-internal";
import {
  LedgerBusinessRejection, LedgerError, canonicalRequestHash, runLedgerCommand,
  type LedgerDb, type LedgerQueryable, type LedgerTx,
} from "./ledger-core";
import { getReservation, type ReservationRecord } from "./ledger-reservations";

/**
 * M7 S6 settle and reconciliation hold (ADR-0021 D2, D6, D11; S6 addendum). Library only: nothing under apps/ imports it (static
 * test). Writes only vynvori_ledger.ledger_entries (kinds settle and hold) through runLedgerCommand; the reservation state and the
 * wallet buckets are moved by the 0005/0006 database functions, never from TypeScript. Never touches Medusa and never reads vendor
 * cost: a vendor invoice, usage record or charge message is never evidence for anything here (vendor_cost_evidence is isolated,
 * see ledger-evidence.ts). No price, credit cost or hold duration lives here: a settle consumes exactly the charge_units frozen on
 * the reservation (S3/S5), and there is no timer, sweeper or retry. NOTHING here (or anywhere) leaves reconciliation_hold in W1.
 *
 * Both commands are SYSTEM commands (actor + expectedUserId, D11): a mismatched user is the same NOT_FOUND as an absent one.
 * Evidence is caller-asserted typed data (D6: the authority for Plane B truth is M6b/M8a). The ledger parses it before any SQL,
 * re-checks it with the contract guards, binds its operationId to the reservation's own operation read from the database, and
 * stores its kind and reference on the entry. See the S6 addendum's honest limits for what this cannot prove in W1.
 */
const S = "vynvori_ledger";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COMPONENT = /^[a-z][a-z0-9_-]*$/;
/** Technical bound shared with the database CHECK in the binding trigger; not a business value (private, never exported). */
const MAX_EVIDENCE_REF = 512;

function assertUuid(value: unknown): string { if (typeof value !== "string" || !UUID.test(value)) throw new LedgerError("INVALID_INPUT"); return value; }
function assertComponent(value: unknown): string { if (typeof value !== "string" || !COMPONENT.test(value)) throw new LedgerError("INVALID_INPUT"); return value; }
function assertIdempotencyKey(value: unknown): string { if (!IdempotencyKeySchema.safeParse(value).success) throw new LedgerError("INVALID_INPUT"); return value as string; }
type LedgerJson = Parameters<typeof canonicalRequestHash>[0];
const asLedgerJson = (value: unknown) => value as LedgerJson;

export interface SettleReservationInput {
  /** The user the internal caller expects to own the reservation (expectedUserId, D11). A mismatch is NOT_FOUND. */
  readonly userId: string;
  readonly component: string;
  readonly reservationId: string;
  /** D6: only Plane B `persisted_delivered` evidence (verified manifest hash, owner and rights) for THIS reservation's operation. */
  readonly evidence: unknown;
  readonly idempotencyKey: string;
}
export interface HoldReservationInput {
  readonly userId: string;
  readonly component: string;
  readonly reservationId: string;
  /** D6: only Plane B `outcome_unknown` or `persistence_failed_under_review` evidence for THIS reservation's operation. */
  readonly evidence: unknown;
  readonly idempotencyKey: string;
}

type Row = { operation_id: string; state: string; workflow_ref: string | null; hold_units: string; charge_units: string };
/** Locks one reservation (the wallet is already locked by runLedgerCommand: lock order wallet -> reservation). Absent/foreign => NOT_FOUND. */
async function lockReservation(tx: LedgerTx, reservationId: string): Promise<Row> {
  const row = (await tx.query(`SELECT operation_id, state, workflow_ref, hold_units::text AS hold_units, charge_units::text AS charge_units
    FROM ${S}.credit_reservations WHERE reservation_id = $1 AND user_id = $2 FOR UPDATE`, [reservationId, tx.userId])).rows[0] as Row | undefined;
  if (!row) throw new LedgerError("NOT_FOUND"); // not persisted: an evidence message that arrives before its reservation commits can retry with the same key
  return row;
}

/**
 * Runs the owner-scoped read-back after a command committed, on any LedgerDb shape (same rule as ledger-reservations.ts): the
 * command is durable here, so a failure of this read is TRANSIENT, and a retry with the same idempotency key replays the result.
 */
async function readAfterCommit(db: LedgerDb, userId: string, reservationId: string): Promise<ReservationRecord> {
  try {
    if (typeof (db as Partial<LedgerQueryable>).query === "function") return await getReservation(db as unknown as LedgerQueryable, userId, reservationId);
    type Conn = { query: LedgerQueryable["query"]; release?: (destroy?: boolean) => void; on?: (e: "error", l: () => void) => unknown; off?: (e: "error", l: () => void) => unknown };
    const conn: Conn = typeof (db as { connect?: unknown }).connect === "function" ? await (db as { connect(): Promise<Conn> }).connect() : await (db as { acquire(): Promise<Conn> }).acquire();
    let broken = false; const onError = () => { broken = true; };
    conn.on?.("error", onError);
    try { return await getReservation({ query: (text, values) => conn.query(text, values) }, userId, reservationId); }
    catch (error) { if (!(error instanceof LedgerError)) broken = true; throw error; }
    finally { conn.off?.("error", onError); conn.release?.(broken); }
  } catch (error) {
    if (error instanceof LedgerError) throw error;
    throw new LedgerError("TRANSIENT"); // never surface the driver error
  }
}

/** Parses evidence before any SQL. Anything that is not exactly the expected transition's evidence is EVIDENCE_INVALID. */
function parseEvidence<T extends TransitionEvidenceV1["transition"]>(evidence: unknown, transition: T): Extract<TransitionEvidenceV1, { transition: T }> {
  const parsed = TransitionEvidenceV1Schema.safeParse(evidence);
  if (!parsed.success || parsed.data.transition !== transition || parsed.data.evidenceRef.length > MAX_EVIDENCE_REF) throw new LedgerError("EVIDENCE_INVALID");
  return parsed.data as Extract<TransitionEvidenceV1, { transition: T }>;
}

/**
 * System command `reservation_settle` (ADR-0021 D6). Settles ONLY on Plane B `persisted_delivered` evidence that passes the contract
 * guards (canMarkOperationDelivered: verified manifest hash and owner/rights; canMarkReceiptSettled: never from `outcome_unknown` or a
 * vendor-charge message) and whose operationId equals this reservation's own operation (read from the database). The reservation
 * must be `reserved` and dispatched. One entry consumes exactly the frozen charge_units and returns hold_units - charge_units to
 * `available`; the amount is never taken from the caller, so a settle can never exceed the hold. Replays are safe; a second settle,
 * or a settle of a released or held reservation, is INVALID_TRANSITION and moves nothing.
 */
export async function settleReservation(db: LedgerDb, input: SettleReservationInput): Promise<ReservationRecord> {
  const userId = assertUuid(input.userId), component = assertComponent(input.component), reservationId = assertUuid(input.reservationId);
  const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
  const evidence = parseEvidence(input.evidence, "settle");
  // Defence in depth: the schema already pins these literals; the guards are the canonical statement of invariants 5 and 6.
  if (!canMarkReceiptSettled(evidence.evidenceKind) || !canMarkOperationDelivered({ providerStatus: evidence.evidenceKind, hasVerifiedManifestHash: evidence.hasVerifiedManifestHash, ownerAndRightsVerified: evidence.ownerAndRightsVerified }))
    throw new LedgerError("EVIDENCE_INVALID");
  await runLedgerCommand(db, {
    actor: "system", component, expectedUserId: userId, userId, commandKind: "reservation_settle", idempotencyKey,
    payload: asLedgerJson({ reservationId, evidence }),
  }, async tx => {
    const reservation = await lockReservation(tx, reservationId);
    if (evidence.operationId !== reservation.operation_id) throw new LedgerBusinessRejection("EVIDENCE_INVALID");
    if (reservation.state !== "reserved" || reservation.workflow_ref === null) throw new LedgerBusinessRejection("INVALID_TRANSITION");
    // Units come from the locked row as exact bigint text and are combined in SQL, never added in JavaScript.
    await tx.query(
      `INSERT INTO ${S}.ledger_entries(entry_id, user_id, command_id, entry_kind, delta_available, delta_reserved, delta_held, delta_consumed, delta_external, reservation_id, evidence_kind, evidence_ref, cause_kind, cause_ref)
       VALUES($1,$2,$3,'settle',$4::bigint - $5::bigint,-$4::bigint,0,$5::bigint,0,$6::uuid,'persisted_delivered',$7,'reservation',$6::uuid::text || ':settle')`,
      [randomUUID(), tx.userId, tx.commandId, reservation.hold_units, reservation.charge_units, reservationId, evidence.evidenceRef]);
  });
  return readAfterCommit(db, userId, reservationId);
}

/**
 * System command `reservation_hold` (ADR-0021 D6): an unknown provider outcome (`outcome_unknown`) or an artifact whose persistence is
 * unconfirmed (`persistence_failed_under_review`) moves the FULL hold of exactly this reservation from `reserved` to
 * `held_for_review` (state `reconciliation_hold`). No customer debit is inferred, nothing is retried, and nothing is released: a held
 * reservation stays held until a human resolves it in the remedy milestone (no W1 code path leaves the hold). Siblings are
 * untouched and settle or release independently. The reservation must be `reserved` and dispatched (a component that learns of an
 * unknown outcome records its dispatch marker first; recordWorkflowRef is idempotent). Replays are safe.
 */
export async function holdReservation(db: LedgerDb, input: HoldReservationInput): Promise<ReservationRecord> {
  const userId = assertUuid(input.userId), component = assertComponent(input.component), reservationId = assertUuid(input.reservationId);
  const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
  const evidence = parseEvidence(input.evidence, "hold");
  await runLedgerCommand(db, {
    actor: "system", component, expectedUserId: userId, userId, commandKind: "reservation_hold", idempotencyKey,
    payload: asLedgerJson({ reservationId, evidence }),
  }, async tx => {
    const reservation = await lockReservation(tx, reservationId);
    if (evidence.operationId !== reservation.operation_id) throw new LedgerBusinessRejection("EVIDENCE_INVALID");
    if (reservation.state !== "reserved" || reservation.workflow_ref === null) throw new LedgerBusinessRejection("INVALID_TRANSITION");
    await tx.query(
      `INSERT INTO ${S}.ledger_entries(entry_id, user_id, command_id, entry_kind, delta_available, delta_reserved, delta_held, delta_consumed, delta_external, reservation_id, evidence_kind, evidence_ref, cause_kind, cause_ref)
       VALUES($1,$2,$3,'hold',0,-$4::bigint,$4::bigint,0,0,$5::uuid,$6,$7,'reservation',$5::uuid::text || ':hold')`,
      [randomUUID(), tx.userId, tx.commandId, reservation.hold_units, reservationId, evidence.evidenceKind, evidence.evidenceRef]);
  });
  return readAfterCommit(db, userId, reservationId);
}
