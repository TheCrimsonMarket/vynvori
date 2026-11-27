import "server-only";
import { randomUUID } from "node:crypto";
import { LedgerError, type LedgerQueryable } from "./ledger-core";

/**
 * M7 S6 vendor-cost evidence (ADR-0021 D6; S6 addendum). INTERNAL ONLY: a business-internal record of what a provider reported it
 * cost (usage, invoice) or that its cost is unknown, for a provider operation. Library only: nothing under apps/ imports it (static
 * test), and nothing here may reach a customer projection (FORBIDDEN_PUBLIC_FIELDS lists privateVendorCostUsd and
 * vendorCostEvidence).
 *
 * ISOLATION (the plan's "isolation of unknown provider cost"): this module writes ONLY vynvori_ledger.vendor_cost_evidence, in one
 * autocommitted statement. It takes no wallet lock, writes no ledger command and reads no ledger table; the table has no foreign key
 * to and no trigger interaction with the ledger, and no ledger function reads it (tested). A vendor charge therefore never settles,
 * releases, holds or debits anything, and no customer debit is ever inferred from it. `reservationId` is an optional reconciliation
 * hint and is deliberately NOT checked against credit_reservations.
 *
 * Amounts are exact integer micro-USD (millionths of a dollar) or null. The ledger never converts a float into micros (that needs a
 * rounding rule nobody has approved) and never converts USD into credits (no rate card exists). `internal.ts`'s
 * `privateVendorCostUsd: number` maps as amountUsdMicros / 1e6 for display only.
 */
const S = "vynvori_ledger";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPERATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const COMPONENT = /^[a-z][a-z0-9_-]{0,63}$/;
/** Technical bound mirrored by the table CHECK; not a business value (private, never exported). */
const MAX_EVIDENCE_REF = 512;

export type VendorCostEvidenceKind = "usage" | "invoice" | "unknown";
export interface RecordVendorCostEvidenceInput {
  /** The internal component recording it (e.g. a reconciliation worker). There is no customer actor for this table. */
  readonly component: string;
  readonly operationId: string;
  /** Optional reconciliation hint. Never validated against, and never linked to, a ledger reservation. */
  readonly reservationId?: string | null;
  readonly evidenceKind: VendorCostEvidenceKind;
  /** The vendor's own reference for this record (invoice line, usage record id). Part of the idempotent natural key. */
  readonly evidenceRef: string;
  /** Exact integer micro-USD, or null when the vendor reported no amount. Must be null for `unknown`. */
  readonly amountUsdMicros: number | null;
}
export interface VendorCostEvidenceRecord {
  readonly evidenceId: string; readonly operationId: string; readonly reservationId: string | null; readonly evidenceKind: VendorCostEvidenceKind;
  readonly evidenceRef: string; readonly amountUsdMicros: number | null; readonly recordedBy: string; readonly replayed: boolean;
}

type Row = { evidence_id: string; operation_id: string; reservation_id: string | null; evidence_kind: VendorCostEvidenceKind; evidence_ref: string; amount: string | null; recorded_by: string };
const COLUMNS = "evidence_id, operation_id, reservation_id, evidence_kind, evidence_ref, amount_usd_micros::text AS amount, recorded_by";
function toRecord(row: Row, replayed: boolean): VendorCostEvidenceRecord {
  let amountUsdMicros: number | null = null;
  if (row.amount !== null) {
    if (!/^(0|[1-9][0-9]{0,15})$/.test(row.amount) || !Number.isSafeInteger(Number(row.amount))) throw new LedgerError("DATABASE_ERROR");
    amountUsdMicros = Number(row.amount);
  }
  return { evidenceId: row.evidence_id, operationId: row.operation_id, reservationId: row.reservation_id, evidenceKind: row.evidence_kind, evidenceRef: row.evidence_ref, amountUsdMicros, recordedBy: row.recorded_by, replayed };
}

/**
 * Records one piece of vendor-cost evidence, idempotently on (operationId, evidenceKind, evidenceRef): the same record delivered
 * again returns the stored row (`replayed: true`); the same natural key with a different amount or reservation hint is
 * IDEMPOTENCY_CONFLICT and changes nothing. Invalid input is rejected before any SQL. Writes nothing else, anywhere.
 */
export async function recordVendorCostEvidence(db: LedgerQueryable, input: RecordVendorCostEvidenceInput): Promise<VendorCostEvidenceRecord> {
  if (typeof input !== "object" || input === null) throw new LedgerError("INVALID_INPUT");
  const { component, operationId, evidenceKind, evidenceRef, amountUsdMicros } = input;
  const reservationId = input.reservationId ?? null;
  if (typeof component !== "string" || !COMPONENT.test(component)) throw new LedgerError("INVALID_INPUT");
  if (typeof operationId !== "string" || !OPERATION_ID.test(operationId)) throw new LedgerError("INVALID_INPUT");
  if (reservationId !== null && (typeof reservationId !== "string" || !UUID.test(reservationId))) throw new LedgerError("INVALID_INPUT");
  if (evidenceKind !== "usage" && evidenceKind !== "invoice" && evidenceKind !== "unknown") throw new LedgerError("INVALID_INPUT");
  if (typeof evidenceRef !== "string" || evidenceRef.length < 1 || evidenceRef.length > MAX_EVIDENCE_REF || evidenceRef.includes("\u0000")) throw new LedgerError("INVALID_INPUT");
  if (amountUsdMicros !== null && (typeof amountUsdMicros !== "number" || !Number.isSafeInteger(amountUsdMicros) || amountUsdMicros < 0)) throw new LedgerError("INVALID_INPUT");
  if (evidenceKind === "unknown" && amountUsdMicros !== null) throw new LedgerError("INVALID_INPUT");

  let rows: Row[];
  try {
    rows = (await db.query(
      `INSERT INTO ${S}.vendor_cost_evidence(evidence_id, operation_id, reservation_id, evidence_kind, evidence_ref, amount_usd_micros, recorded_by)
       VALUES($1,$2,$3::uuid,$4,$5,$6::bigint,$7) ON CONFLICT (operation_id, evidence_kind, evidence_ref) DO NOTHING RETURNING ${COLUMNS}`,
      [randomUUID(), operationId, reservationId, evidenceKind, evidenceRef, amountUsdMicros === null ? null : String(amountUsdMicros), component])).rows as unknown as Row[];
    if (rows.length === 1) return toRecord(rows[0]!, false);
    rows = (await db.query(`SELECT ${COLUMNS} FROM ${S}.vendor_cost_evidence WHERE operation_id = $1 AND evidence_kind = $2 AND evidence_ref = $3`, [operationId, evidenceKind, evidenceRef])).rows as unknown as Row[];
  } catch (error) {
    if (error instanceof LedgerError) throw error;
    // Never surface the driver error (same mapping as ledger-core). No SQLSTATE (connection loss) is TRANSIENT: the statement is
    // idempotent on its natural key, so retrying the same record converges whether or not the lost INSERT committed.
    const sqlstate = typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : undefined;
    if (sqlstate === undefined || ["40001", "40P01", "55P03", "57014"].includes(sqlstate)) throw new LedgerError("TRANSIENT");
    throw new LedgerError(sqlstate.startsWith("23") ? "DATABASE_REJECTED" : "DATABASE_ERROR", sqlstate);
  }
  const prior = rows[0];
  if (!prior) throw new LedgerError("TRANSIENT"); // the conflicting row must exist; retry the same record
  // recorded_by is provenance, not content: the same vendor record delivered by another component is the same record.
  const same = prior.reservation_id === reservationId
    && (prior.amount === null ? amountUsdMicros === null : amountUsdMicros !== null && prior.amount === String(amountUsdMicros));
  if (!same) throw new LedgerError("IDEMPOTENCY_CONFLICT");
  return toRecord(prior, true);
}
