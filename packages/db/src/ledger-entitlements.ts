import "server-only";
import { randomUUID } from "node:crypto";
import {
  RefinementSlotV1Schema, canTransitionPlaneCBundle, toCustomerPackageState,
  type BundleReopenContextV1, type PackageStateV1, type PlaneCBundleState, type RefinementSlotV1,
} from "@vynvori/contracts";
import { IdempotencyKeySchema } from "@vynvori/contracts/ledger-internal";
import {
  LedgerBusinessRejection, LedgerError, canonicalRequestHash, runLedgerCommand,
  type LedgerDb, type LedgerQueryable, type LedgerTx,
} from "./ledger-core";

/**
 * M7 S7 refinement slots, bundle-package transitions and closure (ADR-0021 D9, S7 addendum). Library only: nothing under apps/
 * imports it (static test). Writes only vynvori_ledger.ledger_package_events and refinement_slot_events (the two insert-only event
 * tables; package and slot STATE is then written by the 0007 SECURITY DEFINER functions, never from TypeScript) and never touches
 * Medusa, a wallet bucket or a ledger entry: refinements and package transitions create no ledger rows. No price, credit cost,
 * package size, hold duration, expiry or cut-off lives here; there is no clock anywhere in this module. Every function is a ledger
 * COMMAND through runLedgerCommand, so it takes the user's wallet row FOR UPDATE first (A4), then the package, then its slots.
 *
 * The package edges come from root's contract guard (`canTransitionPlaneCBundle`, imported, never edited); the database repeats the
 * edge set in 0007 and a test compares the two for every pair. The ledger stores internal state names (`open_for_refinements`) and
 * maps to the customer vocabulary (`refinements_open`) only in the returned projection, with root's `toCustomerPackageState`.
 *
 * Evidence arguments (durable-artifact count, delivered refinement, outcome-unknown) are typed and CALLER-ASSERTED: an integration
 * seam to M6b / Plane B / Studio persistence, not a working integration. What the ledger can verify from its own rows it verifies
 * (the released final and its release entry, the settled final, the disclosed notice version, slot ownership and state).
 */
const S = "vynvori_ledger";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OPAQUE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const COMPONENT = /^[a-z][a-z0-9_-]*$/;
/** Technical bounds, not business values (private: the package exports no numeric constants). */
const MAX_EVIDENCE_REF = 512, MAX_NOTICE_VERSION = 256;
const BUNDLE_STATES: readonly PlaneCBundleState[] = ["quoted", "authorized", "partial", "delivered_3_of_3", "open_for_refinements", "closure_pending", "closed", "remedy_pending"];
const SLOT_STATES = ["available", "skipped", "pending", "unknown", "used", "forfeited"] as const;
type SlotState = (typeof SLOT_STATES)[number];

function assertUuid(value: unknown): string { if (typeof value !== "string" || !UUID.test(value)) throw new LedgerError("INVALID_INPUT"); return value; }
function assertOpaqueId(value: unknown): string { if (typeof value !== "string" || !OPAQUE_ID.test(value)) throw new LedgerError("INVALID_INPUT"); return value; }
function assertComponent(value: unknown): string { if (typeof value !== "string" || !COMPONENT.test(value)) throw new LedgerError("INVALID_INPUT"); return value; }
function assertIdempotencyKey(value: unknown): string { if (!IdempotencyKeySchema.safeParse(value).success) throw new LedgerError("INVALID_INPUT"); return value as string; }
function assertOrdinal(value: unknown): 1 | 2 { if (value !== 1 && value !== 2) throw new LedgerError("INVALID_INPUT"); return value; }
function assertEvidenceRef(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_EVIDENCE_REF) throw new LedgerError("EVIDENCE_INVALID"); // before any SQL
  return value;
}
function assertNoticeVersion(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_NOTICE_VERSION) throw new LedgerError("INVALID_INPUT"); // forfeiture needs a non-null notice
  return value;
}

type LedgerJson = Parameters<typeof canonicalRequestHash>[0];
const asLedgerJson = (value: unknown) => value as LedgerJson;

export interface RefinementSlotRecord {
  readonly slotId: string;
  /** The slot in the public RefinementSlotV1 shape (strictly re-validated), so a stored row can never project into an invalid contract value. */
  readonly view: RefinementSlotV1;
}
export interface BundleRecord {
  readonly packageId: string; readonly authorizationId: string;
  /** Internal name, e.g. `open_for_refinements`. */
  readonly state: PlaneCBundleState;
  /** Customer vocabulary via root's toCustomerPackageState, e.g. `refinements_open`. */
  readonly customerState: PackageStateV1;
  /** Empty until the package first opens for refinements; then exactly two, ordinal 1 and 2. */
  readonly slots: readonly RefinementSlotRecord[];
}

type PackageRow = { package_id: string; authorization_id: string; state: string };
type SlotRow = {
  slot_id: string; package_id: string; ordinal: number; state: string; source_version_id: string | null; operation_id: string | null;
  delivered_version_id: string | null; closure_cause: string | null; closure_notice_version: string | null;
};
const SLOT_COLUMNS = "slot_id, package_id, ordinal, state, source_version_id, operation_id, delivered_version_id, closure_cause, closure_notice_version";
function toBundleState(value: string): PlaneCBundleState {
  if (!(BUNDLE_STATES as readonly string[]).includes(value)) throw new LedgerError("DATABASE_ERROR");
  return value as PlaneCBundleState;
}
function toSlotState(value: string): SlotState {
  if (!(SLOT_STATES as readonly string[]).includes(value)) throw new LedgerError("DATABASE_ERROR");
  return value as SlotState;
}
function toSlotRecord(row: SlotRow): RefinementSlotRecord {
  const state = toSlotState(row.state);
  const base = { state, ordinal: row.ordinal, packageId: row.package_id };
  const raw = state === "available" || state === "skipped" ? { ...base, sourceVersionId: row.source_version_id }
    : state === "pending" || state === "unknown" ? { ...base, sourceVersionId: row.source_version_id, operationId: row.operation_id }
    : state === "used" ? { ...base, sourceVersionId: row.source_version_id, deliveredVersionId: row.delivered_version_id, operationId: row.operation_id }
    : { ...base, closureCause: row.closure_cause };
  const parsed = RefinementSlotV1Schema.safeParse(raw);
  if (!parsed.success) throw new LedgerError("DATABASE_ERROR"); // a stored row that cannot project is corruption: fail closed, never echo it
  return { slotId: row.slot_id, view: parsed.data };
}

/** Owner-scoped read. An absent and a foreign package are the same NOT_FOUND (D11). */
export async function getBundleState(db: LedgerQueryable, userId: string, packageId: string): Promise<BundleRecord> {
  const uid = assertUuid(userId), pid = assertUuid(packageId);
  const pkg = (await db.query(`SELECT package_id, authorization_id, state FROM ${S}.ledger_packages WHERE package_id = $1 AND user_id = $2`, [pid, uid])).rows[0] as PackageRow | undefined;
  if (!pkg) throw new LedgerError("NOT_FOUND");
  const rows = (await db.query(`SELECT ${SLOT_COLUMNS} FROM ${S}.refinement_slots WHERE package_id = $1 AND user_id = $2 ORDER BY ordinal`, [pid, uid])).rows as unknown as SlotRow[];
  const state = toBundleState(pkg.state);
  return { packageId: pkg.package_id, authorizationId: pkg.authorization_id, state, customerState: toCustomerPackageState(state), slots: rows.map(toSlotRecord) };
}

/**
 * Runs the read-back after a command committed, on any LedgerDb shape (a pool's own query, else one checked-out connection that is
 * always released). The command is already durable here, so a failure of this read is TRANSIENT and never a command failure:
 * retrying with the same idempotency key replays the stored result. A LedgerError raised by the read itself passes through.
 */
async function readAfterCommit<T>(db: LedgerDb, read: (q: LedgerQueryable) => Promise<T>): Promise<T> {
  try {
    if (typeof (db as Partial<LedgerQueryable>).query === "function") return await read(db as unknown as LedgerQueryable);
    type Conn = { query: LedgerQueryable["query"]; release?: (destroy?: boolean) => void; on?: (e: "error", l: () => void) => unknown; off?: (e: "error", l: () => void) => unknown };
    const conn: Conn = typeof (db as { connect?: unknown }).connect === "function" ? await (db as { connect(): Promise<Conn> }).connect() : await (db as { acquire(): Promise<Conn> }).acquire();
    let broken = false; const onError = () => { broken = true; };
    conn.on?.("error", onError);
    try { return await read({ query: (text, values) => conn.query(text, values) }); }
    catch (error) { if (!(error instanceof LedgerError)) broken = true; throw error; }
    finally { conn.off?.("error", onError); conn.release?.(broken); }
  } catch (error) {
    if (error instanceof LedgerError) throw error;
    throw new LedgerError("TRANSIENT"); // never surface the driver error
  }
}

type Actor = { readonly kind: "customer" } | { readonly kind: "system"; readonly component: string };
async function runBundleCommand(db: LedgerDb, input: { userId: string; actor: Actor; commandKind: string; idempotencyKey: string; payload: unknown; packageId: string }, callback: (tx: LedgerTx) => Promise<void>): Promise<BundleRecord> {
  const { userId, packageId } = input;
  await runLedgerCommand(db, input.actor.kind === "system"
    ? { actor: "system", component: input.actor.component, expectedUserId: userId, userId, commandKind: input.commandKind, idempotencyKey: input.idempotencyKey, payload: asLedgerJson(input.payload) }
    : { actor: "customer", userId, commandKind: input.commandKind, idempotencyKey: input.idempotencyKey, payload: asLedgerJson(input.payload) }, callback);
  return readAfterCommit(db, q => getBundleState(q, userId, packageId));
}

/** Locks the package (wallet is already locked by runLedgerCommand: lock order wallet -> package -> slots). Absent/foreign => NOT_FOUND. */
async function lockBundle(tx: LedgerTx, packageId: string): Promise<{ state: PlaneCBundleState; authorizationId: string }> {
  const row = (await tx.query(`SELECT authorization_id, state FROM ${S}.ledger_packages WHERE package_id = $1 AND user_id = $2 FOR UPDATE`, [packageId, tx.userId])).rows[0] as { authorization_id: string; state: string } | undefined;
  if (!row) throw new LedgerError("NOT_FOUND");
  return { state: toBundleState(row.state), authorizationId: row.authorization_id };
}
async function lockSlots(tx: LedgerTx, packageId: string): Promise<SlotRow[]> {
  return (await tx.query(`SELECT ${SLOT_COLUMNS} FROM ${S}.refinement_slots WHERE package_id = $1 AND user_id = $2 ORDER BY ordinal FOR UPDATE`, [packageId, tx.userId])).rows as unknown as SlotRow[];
}
function slotAt(slots: readonly SlotRow[], ordinal: 1 | 2): SlotRow {
  const slot = slots.find(s => s.ordinal === ordinal);
  if (!slot) throw new LedgerBusinessRejection("INVALID_TRANSITION"); // the package has not opened for refinements yet
  return slot;
}

interface SlotEventFields { sourceVersionId?: string; operationId?: string; deliveredVersionId?: string; evidenceRef?: string; closureCause?: string; closureNoticeVersion?: string }
async function insertSlotEvent(tx: LedgerTx, slot: SlotRow, to: SlotState, fields: SlotEventFields = {}): Promise<void> {
  await tx.query(
    `INSERT INTO ${S}.refinement_slot_events(slot_event_id, user_id, slot_id, package_id, command_id, from_state, to_state, source_version_id, operation_id, delivered_version_id, evidence_ref, closure_cause, closure_notice_version)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [randomUUID(), tx.userId, slot.slot_id, slot.package_id, tx.commandId, slot.state, to, fields.sourceVersionId ?? null, fields.operationId ?? null, fields.deliveredVersionId ?? null,
      fields.evidenceRef ?? null, fields.closureCause ?? null, fields.closureNoticeVersion ?? null]);
}
interface PackageEventFields { artifactCount?: number; evidenceRef?: string; beginReason?: string; finalReservationId?: string; closureCause?: string; closureNoticeVersion?: string }
async function insertPackageEvent(tx: LedgerTx, packageId: string, from: PlaneCBundleState, to: PlaneCBundleState, fields: PackageEventFields = {}): Promise<void> {
  await tx.query(
    `INSERT INTO ${S}.ledger_package_events(package_event_id, user_id, package_id, command_id, from_state, to_state, artifact_count, evidence_ref, begin_reason, final_reservation_id, closure_cause, closure_notice_version)
     VALUES($1,$2,$3,$4,$5,$6,$7::smallint,$8,$9,$10,$11,$12)`,
    [randomUUID(), tx.userId, packageId, tx.commandId, from, to, fields.artifactCount ?? null, fields.evidenceRef ?? null, fields.beginReason ?? null,
      fields.finalReservationId ?? null, fields.closureCause ?? null, fields.closureNoticeVersion ?? null]);
}
const requireOpen = (state: PlaneCBundleState) => { if (state !== "open_for_refinements") throw new LedgerBusinessRejection("INVALID_TRANSITION"); };

// ---- slot operations ----------------------------------------------------------------------------------------------------------

export interface CustomerSlotInput { readonly userId: string; readonly packageId: string; readonly ordinal: 1 | 2; readonly idempotencyKey: string }
export interface SystemSlotInput extends CustomerSlotInput { readonly component: string }

/**
 * Customer command `refinement_skip`: an available slot becomes skipped, only while the package is open for refinements. Moves no
 * credits and writes no ledger entry. Skipping is reversible (restore) only while the package stays open.
 */
export async function skipRefinementSlot(db: LedgerDb, input: CustomerSlotInput): Promise<BundleRecord> {
  const userId = assertUuid(input.userId), packageId = assertUuid(input.packageId), ordinal = assertOrdinal(input.ordinal), idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
  return runBundleCommand(db, { userId, packageId, actor: { kind: "customer" }, commandKind: "refinement_skip", idempotencyKey, payload: { packageId, ordinal } }, async tx => {
    const bundle = await lockBundle(tx, packageId); const slot = slotAt(await lockSlots(tx, packageId), ordinal);
    requireOpen(bundle.state);
    if (slot.state !== "available") throw new LedgerBusinessRejection("INVALID_TRANSITION");
    await insertSlotEvent(tx, slot, "skipped");
  });
}

/** Customer command `refinement_restore`: skipped -> available, only while the package is open for refinements (doc 23 invariant 7). */
export async function restoreRefinementSlot(db: LedgerDb, input: CustomerSlotInput): Promise<BundleRecord> {
  const userId = assertUuid(input.userId), packageId = assertUuid(input.packageId), ordinal = assertOrdinal(input.ordinal), idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
  return runBundleCommand(db, { userId, packageId, actor: { kind: "customer" }, commandKind: "refinement_restore", idempotencyKey, payload: { packageId, ordinal } }, async tx => {
    const bundle = await lockBundle(tx, packageId); const slot = slotAt(await lockSlots(tx, packageId), ordinal);
    requireOpen(bundle.state);
    if (slot.state !== "skipped") throw new LedgerBusinessRejection("INVALID_TRANSITION");
    await insertSlotEvent(tx, slot, "available");
  });
}

export interface MarkRefinementPendingInput extends SystemSlotInput {
  /** The chosen source version the refinement binds to (Studio-persistence id; an opaque reference here). Bound once. */
  readonly sourceVersionId: string;
  /** The Studio refinement operation (an opaque reference): serves at most one slot. */
  readonly operationId: string;
}
/** System command `refinement_pending`: an available slot is locked for one refinement operation. */
export async function markRefinementPending(db: LedgerDb, input: MarkRefinementPendingInput): Promise<BundleRecord> {
  const userId = assertUuid(input.userId), component = assertComponent(input.component), packageId = assertUuid(input.packageId), ordinal = assertOrdinal(input.ordinal);
  const sourceVersionId = assertOpaqueId(input.sourceVersionId), operationId = assertOpaqueId(input.operationId), idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
  return runBundleCommand(db, { userId, packageId, actor: { kind: "system", component }, commandKind: "refinement_pending", idempotencyKey, payload: { packageId, ordinal, sourceVersionId, operationId } }, async tx => {
    const bundle = await lockBundle(tx, packageId); const slot = slotAt(await lockSlots(tx, packageId), ordinal);
    requireOpen(bundle.state);
    if (slot.state !== "available" || (slot.source_version_id !== null && slot.source_version_id !== sourceVersionId)) throw new LedgerBusinessRejection("INVALID_TRANSITION");
    if ((await tx.query(`SELECT 1 FROM ${S}.refinement_slots WHERE operation_id = $1 AND user_id = $2`, [operationId, userId])).rows.length) throw new LedgerBusinessRejection("INVALID_TRANSITION"); // one operation, one slot
    await insertSlotEvent(tx, slot, "pending", { sourceVersionId, operationId });
  });
}

export interface RefinementOutcomeInput extends SystemSlotInput {
  /** Must be the slot's own refinement operation (read from the database; a different one is EVIDENCE_INVALID). */
  readonly operationId: string;
  /** Reference to the caller's evidence (Plane B / Studio record). Caller-asserted: an integration seam, not verified here. */
  readonly evidenceRef: string;
}
/** System command `refinement_unknown`: the outcome of a pending refinement is unknown. The slot stays locked; it is never auto-resolved. */
export async function markRefinementUnknown(db: LedgerDb, input: RefinementOutcomeInput): Promise<BundleRecord> {
  const userId = assertUuid(input.userId), component = assertComponent(input.component), packageId = assertUuid(input.packageId), ordinal = assertOrdinal(input.ordinal);
  const operationId = assertOpaqueId(input.operationId), evidenceRef = assertEvidenceRef(input.evidenceRef), idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
  return runBundleCommand(db, { userId, packageId, actor: { kind: "system", component }, commandKind: "refinement_unknown", idempotencyKey, payload: { packageId, ordinal, operationId, evidenceRef } }, async tx => {
    const bundle = await lockBundle(tx, packageId); const slot = slotAt(await lockSlots(tx, packageId), ordinal);
    requireOpen(bundle.state);
    if (slot.state !== "pending") throw new LedgerBusinessRejection("INVALID_TRANSITION");
    if (slot.operation_id !== operationId) throw new LedgerBusinessRejection("EVIDENCE_INVALID");
    await insertSlotEvent(tx, slot, "unknown", { operationId, evidenceRef });
  });
}

export interface ConsumeRefinementInput extends RefinementOutcomeInput {
  /** The delivered refinement version. One delivered version consumes at most one slot of a package. */
  readonly deliveredVersionId: string;
}
/**
 * System command `refinement_consume`: a valid delivered refinement consumes exactly one slot (pending, or unknown once reconciled
 * as delivered). Only while the package is open: closure_pending forbids silent consumption. Writes no ledger entry.
 */
export async function consumeRefinementSlot(db: LedgerDb, input: ConsumeRefinementInput): Promise<BundleRecord> {
  const userId = assertUuid(input.userId), component = assertComponent(input.component), packageId = assertUuid(input.packageId), ordinal = assertOrdinal(input.ordinal);
  const operationId = assertOpaqueId(input.operationId), deliveredVersionId = assertOpaqueId(input.deliveredVersionId), evidenceRef = assertEvidenceRef(input.evidenceRef);
  const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
  return runBundleCommand(db, { userId, packageId, actor: { kind: "system", component }, commandKind: "refinement_consume", idempotencyKey, payload: { packageId, ordinal, operationId, deliveredVersionId, evidenceRef } }, async tx => {
    const bundle = await lockBundle(tx, packageId); const slot = slotAt(await lockSlots(tx, packageId), ordinal);
    requireOpen(bundle.state);
    if (slot.state !== "pending" && slot.state !== "unknown") throw new LedgerBusinessRejection("INVALID_TRANSITION");
    if (slot.operation_id !== operationId) throw new LedgerBusinessRejection("EVIDENCE_INVALID");
    await insertSlotEvent(tx, slot, "used", { operationId, deliveredVersionId, evidenceRef });
  });
}

// ---- package transitions ------------------------------------------------------------------------------------------------------

export interface BundleCommandInput { readonly userId: string; readonly component: string; readonly packageId: string; readonly idempotencyKey: string }
const bundleInput = (input: BundleCommandInput) => ({ userId: assertUuid(input.userId), component: assertComponent(input.component), packageId: assertUuid(input.packageId), idempotencyKey: assertIdempotencyKey(input.idempotencyKey) });
/** Root's contract guard decides every unconditional edge; a refused edge is INVALID_TRANSITION and is persisted under the key. */
function requireEdge(from: PlaneCBundleState, to: PlaneCBundleState, reopen?: BundleReopenContextV1): void {
  if (!canTransitionPlaneCBundle(from, to, reopen)) throw new LedgerBusinessRejection("INVALID_TRANSITION");
}

export interface RecordBundleDeliveryInput extends BundleCommandInput {
  /** Count of durable, rights-permitted artifacts of the bundle (0..3). Caller-asserted (M6b / Plane B seam). */
  readonly artifactCount: number;
  readonly evidenceRef: string;
}
/**
 * System command `bundle_record_delivery`. Exactly 3 durable, rights-permitted artifacts reach `delivered_3_of_3`
 * (from `authorized` or `partial`); 0, 1 or 2 only ever reach `partial` (from `authorized`), never complete automatically.
 */
export async function recordBundleDelivery(db: LedgerDb, input: RecordBundleDeliveryInput): Promise<BundleRecord> {
  const { userId, component, packageId, idempotencyKey } = bundleInput(input);
  if (typeof input.artifactCount !== "number" || !Number.isInteger(input.artifactCount) || input.artifactCount < 0 || input.artifactCount > 3) throw new LedgerError("INVALID_INPUT");
  const artifactCount = input.artifactCount, evidenceRef = assertEvidenceRef(input.evidenceRef);
  return runBundleCommand(db, { userId, packageId, actor: { kind: "system", component }, commandKind: "bundle_record_delivery", idempotencyKey, payload: { packageId, artifactCount, evidenceRef } }, async tx => {
    const bundle = await lockBundle(tx, packageId);
    const target: PlaneCBundleState = artifactCount === 3 ? "delivered_3_of_3" : "partial";
    requireEdge(bundle.state, target);
    await insertPackageEvent(tx, packageId, bundle.state, target, { artifactCount, evidenceRef });
  });
}

/** System command `bundle_open_refinements`: delivered_3_of_3 -> open_for_refinements; creates the two available slots (0007 definer), once. */
export async function openRefinements(db: LedgerDb, input: BundleCommandInput): Promise<BundleRecord> {
  const { userId, component, packageId, idempotencyKey } = bundleInput(input);
  return runBundleCommand(db, { userId, packageId, actor: { kind: "system", component }, commandKind: "bundle_open_refinements", idempotencyKey, payload: { packageId } }, async tx => {
    const bundle = await lockBundle(tx, packageId);
    requireEdge(bundle.state, "open_for_refinements");
    await insertPackageEvent(tx, packageId, bundle.state, "open_for_refinements");
  });
}

export type BeginClosureTrigger =
  | { readonly kind: "explicit_close_request" }
  /** A first final of this package was authorized (reserved) while the package was open. Verified against the stored reservation. */
  | { readonly kind: "final_authorized"; readonly finalReservationId: string };
/**
 * System command `bundle_begin_closure`: open_for_refinements -> closure_pending. Refused while a refinement is pending or unknown.
 * While closure is pending nothing is consumed or forfeited silently; slots stay held until closure completes or the package reopens.
 */
export async function beginBundleClosure(db: LedgerDb, input: BundleCommandInput & { readonly trigger: BeginClosureTrigger }): Promise<BundleRecord> {
  const { userId, component, packageId, idempotencyKey } = bundleInput(input);
  const trigger = input.trigger;
  if (typeof trigger !== "object" || trigger === null || (trigger.kind !== "final_authorized" && trigger.kind !== "explicit_close_request")) throw new LedgerError("INVALID_INPUT");
  const finalReservationId = trigger.kind === "final_authorized" ? assertUuid(trigger.finalReservationId) : null;
  return runBundleCommand(db, { userId, packageId, actor: { kind: "system", component }, commandKind: "bundle_begin_closure", idempotencyKey, payload: { packageId, trigger: finalReservationId === null ? { kind: trigger.kind } : { kind: trigger.kind, finalReservationId } } }, async tx => {
    const bundle = await lockBundle(tx, packageId); const slots = await lockSlots(tx, packageId);
    requireEdge(bundle.state, "closure_pending");
    if (slots.some(s => s.state === "pending" || s.state === "unknown")) throw new LedgerBusinessRejection("INVALID_TRANSITION"); // pending|unknown are locked
    if (finalReservationId !== null) {
      const r = (await tx.query(`SELECT state, pre_attempt_package_state FROM ${S}.credit_reservations WHERE reservation_id = $1 AND user_id = $2 AND original_package_id = $3 AND operation_kind IN ('final_standard', 'final_premium')`, [finalReservationId, userId, packageId])).rows[0] as { state: string; pre_attempt_package_state: string | null } | undefined;
      if (!r) throw new LedgerError("NOT_FOUND");
      if (r.state !== "reserved" || r.pre_attempt_package_state !== "open_for_refinements") throw new LedgerBusinessRejection("INVALID_TRANSITION");
    }
    await insertPackageEvent(tx, packageId, bundle.state, "closure_pending", { beginReason: trigger.kind, ...(finalReservationId === null ? {} : { finalReservationId }) });
  });
}

export type ClosureCause =
  | { readonly kind: "explicit_close" }
  /** A final of this package settled (delivered and persisted). Verified against the stored reservation (S6 settles it). */
  | { readonly kind: "final_delivered"; readonly finalReservationId: string };
export interface CloseBundleInput extends BundleCommandInput {
  readonly cause: ClosureCause;
  /**
   * REQUIRED, non-null: the refinement-closure notice the customer was shown. It must equal the `refinementClosureNoticeVersion` stored in
   * the paid terms of the disclosing quote (the settled final's quote, or the bundle's own quote for an explicit close); a quote without
   * that notice cannot close a package (TERMS_NOT_APPROVED): the feature stays closed. There is no `approved_expiry` cause.
   */
  readonly refinementClosureNoticeVersion: string;
}
/**
 * System command `bundle_close`: closure_pending -> closed, forfeiting every unused (available or skipped) slot in the SAME transaction
 * under the disclosed notice. Refused while a refinement is pending or unknown, while a final of the package is unresolved, and for an
 * explicit close once a final has settled (that closes by delivery). A used slot stays used. Nothing here is clock-based.
 */
export async function closeBundleWithForfeiture(db: LedgerDb, input: CloseBundleInput): Promise<BundleRecord> {
  const { userId, component, packageId, idempotencyKey } = bundleInput(input);
  const noticeVersion = assertNoticeVersion(input.refinementClosureNoticeVersion);
  const cause = input.cause;
  if (typeof cause !== "object" || cause === null || (cause.kind !== "explicit_close" && cause.kind !== "final_delivered")) throw new LedgerError("INVALID_INPUT");
  const finalReservationId = cause.kind === "final_delivered" ? assertUuid(cause.finalReservationId) : null;
  return runBundleCommand(db, { userId, packageId, actor: { kind: "system", component }, commandKind: "bundle_close", idempotencyKey, payload: { packageId, cause: finalReservationId === null ? { kind: cause.kind } : { kind: cause.kind, finalReservationId }, noticeVersion } }, async tx => {
    const bundle = await lockBundle(tx, packageId); const slots = await lockSlots(tx, packageId);
    requireEdge(bundle.state, "closed");
    if (slots.some(s => s.state === "pending" || s.state === "unknown")) throw new LedgerBusinessRejection("INVALID_TRANSITION");
    const finals = (await tx.query(`SELECT reservation_id, state, quote_version_id FROM ${S}.credit_reservations WHERE original_package_id = $1 AND user_id = $2 AND operation_kind IN ('final_standard', 'final_premium')`, [packageId, userId])).rows as { reservation_id: string; state: string; quote_version_id: string }[];
    if (finals.some(f => f.state === "authorization_requested" || f.state === "reserved" || f.state === "reconciliation_hold" || f.state === "operator_remedy")) throw new LedgerBusinessRejection("INVALID_TRANSITION"); // unresolved final: closure stays pending
    let disclosingQuote: string;
    if (finalReservationId !== null) {
      const settled = finals.find(f => f.reservation_id === finalReservationId);
      if (!settled) throw new LedgerError("NOT_FOUND");
      if (settled.state !== "settled") throw new LedgerBusinessRejection("INVALID_TRANSITION");
      disclosingQuote = settled.quote_version_id;
    } else {
      if (finals.some(f => f.state === "settled")) throw new LedgerBusinessRejection("INVALID_TRANSITION");
      const authorization = (await tx.query(`SELECT quote_version_id FROM ${S}.ledger_authorizations WHERE authorization_id = $1 AND user_id = $2`, [bundle.authorizationId, userId])).rows[0] as { quote_version_id: string } | undefined;
      if (!authorization) throw new LedgerError("DATABASE_ERROR"); // a package without its authorization is corruption: fail closed
      disclosingQuote = authorization.quote_version_id;
    }
    const stored = (await tx.query(`SELECT quote_view -> 'paidTerms' ->> 'refinementClosureNoticeVersion' AS notice FROM ${S}.ledger_quotes WHERE quote_version_id = $1 AND user_id = $2`, [disclosingQuote, userId])).rows[0] as { notice: string | null } | undefined;
    if (!stored) throw new LedgerError("DATABASE_ERROR");
    if (stored.notice === null || stored.notice !== noticeVersion) throw new LedgerBusinessRejection("TERMS_NOT_APPROVED");
    for (const slot of slots) if (slot.state === "available" || slot.state === "skipped") await insertSlotEvent(tx, slot, "forfeited", { closureCause: cause.kind, closureNoticeVersion: noticeVersion });
    await insertPackageEvent(tx, packageId, bundle.state, "closed", { closureCause: cause.kind, closureNoticeVersion: noticeVersion, ...(finalReservationId === null ? {} : { finalReservationId }) });
  });
}

export interface ReopenBundleInput extends BundleCommandInput {
  /** The released FIRST final of this package. Its release (S5 `releaseReservation`) must already be committed. */
  readonly finalReservationId: string;
}
/**
 * System command `bundle_reopen` (doc 06 C-02): closure_pending -> open_for_refinements after a verified-uncharged first final. The
 * ledger derives the guard's context from its OWN rows, never from the caller: `first_final` iff the final began on an open package,
 * `verified_uncharged` iff the reservation is released by a verified_zero_charge_failure entry, `releaseReceiptDurable` iff that entry
 * exists. Root's `canTransitionPlaneCBundle` then decides. Unused slots stay exactly as they were (no slot is recreated); a package that
 * is `closed` (a later revision after a delivered final) has no such edge and is rejected by the guard and again by the database.
 */
export async function reopenBundleAfterUnchargedFinal(db: LedgerDb, input: ReopenBundleInput): Promise<BundleRecord> {
  const { userId, component, packageId, idempotencyKey } = bundleInput(input);
  const finalReservationId = assertUuid(input.finalReservationId);
  return runBundleCommand(db, { userId, packageId, actor: { kind: "system", component }, commandKind: "bundle_reopen", idempotencyKey, payload: { packageId, finalReservationId } }, async tx => {
    const bundle = await lockBundle(tx, packageId); await lockSlots(tx, packageId);
    const r = (await tx.query(`SELECT state, pre_attempt_package_state FROM ${S}.credit_reservations WHERE reservation_id = $1 AND user_id = $2 AND original_package_id = $3 AND operation_kind IN ('final_standard', 'final_premium')`, [finalReservationId, userId, packageId])).rows[0] as { state: string; pre_attempt_package_state: string | null } | undefined;
    if (!r) throw new LedgerError("NOT_FOUND");
    const release = (await tx.query(`SELECT 1 FROM ${S}.ledger_entries WHERE reservation_id = $1 AND user_id = $2 AND entry_kind = 'release' AND evidence_kind = 'verified_zero_charge_failure'`, [finalReservationId, userId])).rows.length === 1;
    const context: BundleReopenContextV1 = {
      finalAttempt: r.pre_attempt_package_state === "open_for_refinements" ? "first_final" : "later_revision",
      outcome: r.state === "released" && release ? "verified_uncharged" : r.state === "settled" ? "charged" : "unknown",
      releaseReceiptDurable: release,
    };
    requireEdge(bundle.state, "open_for_refinements", context);
    await insertPackageEvent(tx, packageId, bundle.state, "open_for_refinements", { finalReservationId });
  });
}
