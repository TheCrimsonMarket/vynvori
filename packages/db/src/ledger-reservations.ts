import "server-only";
import { randomUUID } from "node:crypto";
import { finalQuoteHasRequiredConsent, quoteGrantsEligibleBundleAuthorization } from "@vynvori/contracts";
import {
  EligibilityDecisionV1Schema, IdempotencyKeySchema, TransitionEvidenceV1Schema,
  type AuthorizationEligibilityPort, type PricePolicyPort, type ReservationStateV1,
} from "@vynvori/contracts/ledger-internal";
import {
  LedgerBusinessRejection, LedgerError, canonicalRequestHash, parseSafeUnits, runLedgerCommand,
  type LedgerCommandResult, type LedgerDb, type LedgerQueryable, type LedgerTx,
} from "./ledger-core";
import { assessQuoteForAuthorization, getQuote } from "./ledger-quotes";

/**
 * M7 S5 authorize -> reserve -> release (ADR-0021 D3 binding, D5, D6 release, D7 authorization, D11; S5 addendum). Library only:
 * nothing under apps/ imports it (static test). Writes only vynvori_ledger.ledger_authorizations / ledger_packages /
 * credit_reservations / ledger_entries (reserve, release) and never touches Medusa. No price, credit cost, package size, hold
 * duration or cut-off lives here: the ledger reserves exactly the allocation vector frozen in the persisted quote (S3) and never
 * computes a split. Every function is a ledger COMMAND through runLedgerCommand, so it takes the user's wallet row FOR UPDATE
 * first (A4), then reservations. The database is the backstop for every rule below (0005 triggers), not the first line.
 */
const S = "vynvori_ledger";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const QUOTE_VERSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const WORKFLOW_REF = /^[A-Za-z0-9._:/-]{1,256}$/;
const COMPONENT = /^[a-z][a-z0-9_-]*$/;
/** Technical bounds, not business values (private: the package exports no numeric constants). */
const MAX_CONSENT_TEXT_VERSION = 256, MAX_EVIDENCE_REF = 512;

function assertUuid(value: unknown): string { if (typeof value !== "string" || !UUID.test(value)) throw new LedgerError("INVALID_INPUT"); return value; }
function assertQuoteVersionId(value: unknown): string { if (typeof value !== "string" || !QUOTE_VERSION_ID.test(value)) throw new LedgerError("INVALID_INPUT"); return value; }
function assertComponent(value: unknown): string { if (typeof value !== "string" || !COMPONENT.test(value)) throw new LedgerError("INVALID_INPUT"); return value; }
function assertIdempotencyKey(value: unknown): string { if (!IdempotencyKeySchema.safeParse(value).success) throw new LedgerError("INVALID_INPUT"); return value as string; }

type LedgerJson = Parameters<typeof canonicalRequestHash>[0];
const asLedgerJson = (value: unknown) => value as LedgerJson;
type PackageState = "quoted" | "authorized" | "partial" | "delivered_3_of_3" | "open_for_refinements" | "closure_pending" | "closed" | "remedy_pending";
type ReservationKind = "concept_bundle_3x2" | "final_standard" | "final_premium";

export interface ReservationRecord {
  readonly reservationId: string; readonly authorizationId: string; readonly quoteVersionId: string; readonly operationIndex: number;
  readonly operationKind: ReservationKind; readonly operationId: string;
  readonly holdUnits: number; readonly chargeUnits: number; readonly state: ReservationStateV1;
  readonly packageId: string | null; readonly originalPackageId: string | null; readonly preAttemptPackageState: PackageState | null;
  readonly workflowRef: string | null;
}
export interface AuthorizationResult {
  readonly authorizationId: string; readonly quoteId: string; readonly quoteVersionId: string; readonly operationKind: ReservationKind;
  /** The bundle package created with this authorization (internal state names, e.g. `authorized`); null for a final. */
  readonly packageId: string | null;
  readonly reservations: readonly ReservationRecord[]; readonly replayed: boolean;
}
export interface AuthorizeQuoteInput {
  /** The AUTHENTICATED user (from the session, never from a request body). Every predicate below carries it (D11). */
  readonly userId: string;
  readonly quoteVersionId: string;
  readonly idempotencyKey: string;
  /** The customer's explicit consent to exactly this consent text version (D7). */
  readonly consent: { readonly accepted: boolean; readonly consentTextVersion: string };
  /** Required for final_* quotes, forbidden for bundles: the caller's original bundle package (doc 06 C-02). */
  readonly originalPackageId?: string;
  /** Injected clock: the database's own now() is never used for expiry (D7). Not part of the idempotency hash. */
  readonly now: Date;
  readonly pricePolicy: PricePolicyPort;
  /** REQUIRED. The repository ships no implementation, so production cannot authorize in W1 (D7: absent => deny). */
  readonly eligibility: AuthorizationEligibilityPort;
}
export interface ReleaseReservationInput {
  /** The user the internal caller expects to own the reservation (expectedUserId, D11). A mismatch is NOT_FOUND. */
  readonly userId: string;
  readonly component: string;
  readonly reservationId: string;
  /** D6: only Plane B `verified_zero_charge_failure` evidence for THIS reservation's operation releases. */
  readonly evidence: unknown;
  readonly idempotencyKey: string;
}
export interface RecordWorkflowRefInput {
  readonly userId: string; readonly component: string; readonly reservationId: string; readonly workflowRef: string; readonly idempotencyKey: string;
}

type ReservationRow = {
  reservation_id: string; authorization_id: string; quote_version_id: string; operation_index: number; operation_kind: ReservationKind;
  operation_id: string; hold_units: string; charge_units: string; state: ReservationStateV1; package_id: string | null; original_package_id: string | null;
  pre_attempt_package_state: PackageState | null; workflow_ref: string | null;
};
const RESERVATION_COLUMNS = `reservation_id, authorization_id, quote_version_id, operation_index, operation_kind, operation_id,
  hold_units::text AS hold_units, charge_units::text AS charge_units, state, package_id, original_package_id, pre_attempt_package_state, workflow_ref`;
function toReservation(row: ReservationRow): ReservationRecord {
  return {
    reservationId: row.reservation_id, authorizationId: row.authorization_id, quoteVersionId: row.quote_version_id, operationIndex: row.operation_index,
    operationKind: row.operation_kind, operationId: row.operation_id, holdUnits: parseSafeUnits(row.hold_units), chargeUnits: parseSafeUnits(row.charge_units),
    state: row.state, packageId: row.package_id, originalPackageId: row.original_package_id, preAttemptPackageState: row.pre_attempt_package_state,
    workflowRef: row.workflow_ref,
  };
}

/** Owner-scoped read. Absent and foreign reservations are the same NOT_FOUND. */
export async function getReservation(db: LedgerQueryable, userId: string, reservationId: string): Promise<ReservationRecord> {
  const uid = assertUuid(userId), rid = assertUuid(reservationId);
  const row = (await db.query(`SELECT ${RESERVATION_COLUMNS} FROM ${S}.credit_reservations WHERE reservation_id = $1 AND user_id = $2`, [rid, uid])).rows[0] as ReservationRow | undefined;
  if (!row) throw new LedgerError("NOT_FOUND");
  return toReservation(row);
}

/** Reconstructs the result of an authorization command from the database (original run and replay alike). */
async function authorizationOfCommand(db: LedgerQueryable, userId: string, result: LedgerCommandResult): Promise<AuthorizationResult> {
  const auth = (await db.query(`SELECT a.authorization_id, a.quote_id, a.quote_version_id, a.operation_kind, p.package_id
    FROM ${S}.ledger_authorizations a LEFT JOIN ${S}.ledger_packages p ON p.authorization_id = a.authorization_id AND p.user_id = a.user_id
    WHERE a.command_id = $1 AND a.user_id = $2`, [result.commandId, userId])).rows[0] as { authorization_id: string; quote_id: string; quote_version_id: string; operation_kind: ReservationKind; package_id: string | null } | undefined;
  if (!auth) throw new LedgerError("DATABASE_ERROR"); // an applied authorize command without its authorization is corruption: fail closed
  const rows = (await db.query(`SELECT ${RESERVATION_COLUMNS} FROM ${S}.credit_reservations WHERE authorization_id = $1 AND user_id = $2 ORDER BY operation_index`, [auth.authorization_id, userId])).rows as unknown as ReservationRow[];
  return {
    authorizationId: auth.authorization_id, quoteId: auth.quote_id, quoteVersionId: auth.quote_version_id, operationKind: auth.operation_kind,
    packageId: auth.package_id, reservations: rows.map(toReservation), replayed: result.replayed,
  };
}

/** Every LedgerDb used here in practice (a Pool, or a test double that also implements query) can run a plain read. */
const asQueryable = (db: LedgerDb) => db as unknown as LedgerQueryable;
const isFinal = (kind: string) => kind === "final_standard" || kind === "final_premium";

/**
 * Customer command `reservation_authorize` (ADR-0021 D7 order, inside one transaction under the wallet lock):
 * owner match (else NOT_FOUND) -> not a promo (INVALID_TRANSITION) -> lineage not yet authorized (QUOTE_STALE) -> S3 assessment:
 * lineage head, expiry with the injected clock (now == expiresAt is expired), price version current, stored-view integrity,
 * allocations (QUOTE_STALE | QUOTE_EXPIRED | ALLOCATION_INVALID) -> contract guard (bundle: quoteGrantsEligibleBundleAuthorization
 * else DOWNSTREAM_USE_UNAVAILABLE; final: finalQuoteHasRequiredConsent else TERMS_NOT_APPROVED) -> AuthorizationEligibilityPort,
 * called inline and never cached (TERMS_NOT_APPROVED | CANCELLATION_WINDOW_UNDISCLOSED | RIGHTS_INELIGIBLE |
 * DOWNSTREAM_USE_UNAVAILABLE) -> explicit consent to this consent text version (TERMS_NOT_APPROVED) -> final only: the caller's
 * original package (NOT_FOUND) -> enough available units for the whole maximum hold (INSUFFICIENT_CREDITS). Then, atomically:
 * the authorization, the package (bundle), one reservation per frozen allocation and one `reserve` entry each. A business rejection
 * is persisted under the key and replays identically (a top-up never turns an old press into an authorization: a new press needs a
 * new key). A grant never authorizes anything; no code path leads from a grant here.
 */
export async function authorizeQuote(db: LedgerDb, input: AuthorizeQuoteInput): Promise<AuthorizationResult> {
  const userId = assertUuid(input.userId), quoteVersionId = assertQuoteVersionId(input.quoteVersionId), idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
  if (!(input.now instanceof Date) || Number.isNaN(input.now.getTime())) throw new LedgerError("INVALID_INPUT");
  // An absent port denies before any SQL: nothing is recorded, so the same key can be retried once a port exists.
  if (typeof input.eligibility?.check !== "function" || typeof input.pricePolicy?.isPriceVersionCurrent !== "function") throw new LedgerError("INVALID_INPUT");
  const consent = input.consent;
  if (typeof consent !== "object" || consent === null || typeof consent.accepted !== "boolean" || typeof consent.consentTextVersion !== "string"
    || consent.consentTextVersion.length < 1 || consent.consentTextVersion.length > MAX_CONSENT_TEXT_VERSION) throw new LedgerError("INVALID_INPUT");
  const originalPackageId = input.originalPackageId === undefined ? null : assertUuid(input.originalPackageId);
  const now = input.now, eligibility = input.eligibility, pricePolicy = input.pricePolicy;

  const result = await runLedgerCommand(db, {
    actor: "customer", userId, commandKind: "reservation_authorize", idempotencyKey,
    payload: asLedgerJson({ quoteVersionId, consent: { accepted: consent.accepted, consentTextVersion: consent.consentTextVersion }, originalPackageId }),
  }, async tx => {
    const quote = await getQuote(tx, userId, quoteVersionId); // owner-scoped; absent and foreign are the same NOT_FOUND
    const kind = quote.record.operationKind;
    if (kind === "promo_single_preview") throw new LedgerBusinessRejection("INVALID_TRANSITION"); // promos are S4 claims, never reservations (D8)
    if ((await tx.query(`SELECT 1 FROM ${S}.ledger_authorizations WHERE quote_id = $1`, [quote.record.quoteId])).rows.length) throw new LedgerBusinessRejection("QUOTE_STALE");
    const assessment = await assessQuoteForAuthorization(tx, { userId, quoteVersionId, now, pricePolicy });
    if (!assessment.ok) {
      if (assessment.code === "NOT_FOUND" || assessment.code === "DATABASE_ERROR") throw new LedgerError(assessment.code);
      throw new LedgerBusinessRejection(assessment.code);
    }
    const view = quote.record.quoteView;
    if (kind === "concept_bundle_3x2" ? !quoteGrantsEligibleBundleAuthorization(view) : !finalQuoteHasRequiredConsent(view))
      throw new LedgerBusinessRejection(kind === "concept_bundle_3x2" ? "DOWNSTREAM_USE_UNAVAILABLE" : "TERMS_NOT_APPROVED");
    const decision = EligibilityDecisionV1Schema.safeParse(await eligibility.check({ userId, quote: quote.record, now: now.toISOString() }));
    if (!decision.success) throw new LedgerError("INVALID_INPUT"); // a malformed port answer is never an approval; nothing is recorded
    if (!decision.data.ok) throw new LedgerBusinessRejection(decision.data.code);
    if (consent.accepted !== true || consent.consentTextVersion !== quote.record.consentTextVersion) throw new LedgerBusinessRejection("TERMS_NOT_APPROVED");

    let preAttemptPackageState: PackageState | null = null;
    if (isFinal(kind)) {
      if (originalPackageId === null) throw new LedgerError("INVALID_INPUT");
      const pkg = (await tx.query(`SELECT state FROM ${S}.ledger_packages WHERE package_id = $1 AND user_id = $2`, [originalPackageId, userId])).rows[0] as { state: PackageState } | undefined;
      if (!pkg) throw new LedgerError("NOT_FOUND");
      preAttemptPackageState = pkg.state;
    } else if (originalPackageId !== null) throw new LedgerError("INVALID_INPUT");

    const wallet = (await tx.query(`SELECT available_units::text AS a FROM ${S}.wallets WHERE user_id = $1`, [userId])).rows[0] as { a: string } | undefined;
    if (!wallet) throw new LedgerError("NOT_FOUND");
    if (parseSafeUnits(wallet.a) < quote.record.maxChargeUnits) throw new LedgerBusinessRejection("INSUFFICIENT_CREDITS");

    await writeAuthorization(tx, {
      kind: kind as ReservationKind, quoteId: quote.record.quoteId, quoteVersionId, consentTextVersion: quote.record.consentTextVersion,
      allocations: quote.allocations, originalPackageId, preAttemptPackageState,
    });
  });
  return authorizationOfCommand(asQueryable(db), userId, result);
}

async function writeAuthorization(tx: LedgerTx, input: {
  kind: ReservationKind; quoteId: string; quoteVersionId: string; consentTextVersion: string;
  allocations: readonly { operationIndex: number; holdUnits: number; chargeUnits: number }[]; originalPackageId: string | null; preAttemptPackageState: PackageState | null;
}): Promise<void> {
  const authorizationId = randomUUID();
  await tx.query(`INSERT INTO ${S}.ledger_authorizations(authorization_id, user_id, command_id, quote_version_id, quote_id, operation_kind, consent_text_version) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [authorizationId, tx.userId, tx.commandId, input.quoteVersionId, input.quoteId, input.kind, input.consentTextVersion]);
  let packageId: string | null = null;
  if (input.kind === "concept_bundle_3x2") {
    packageId = randomUUID();
    await tx.query(`INSERT INTO ${S}.ledger_packages(package_id, user_id, authorization_id, state) VALUES($1,$2,$3,'authorized')`, [packageId, tx.userId, authorizationId]);
  }
  for (const allocation of [...input.allocations].sort((a, b) => a.operationIndex - b.operationIndex)) {
    const reservationId = randomUUID();
    await tx.query(
      `INSERT INTO ${S}.credit_reservations(reservation_id, user_id, authorization_id, quote_version_id, operation_index, operation_kind, operation_id, hold_units, charge_units, state, package_id, original_package_id, pre_attempt_package_state)
       VALUES($1,$2,$3,$4,$5::smallint,$6,$7,$8::bigint,$9::bigint,'authorization_requested',$10,$11,$12)`,
      [reservationId, tx.userId, authorizationId, input.quoteVersionId, allocation.operationIndex, input.kind, "op_" + randomUUID(), String(allocation.holdUnits), String(allocation.chargeUnits), packageId, input.originalPackageId, input.preAttemptPackageState]);
    await tx.query(
      `INSERT INTO ${S}.ledger_entries(entry_id, user_id, command_id, entry_kind, delta_available, delta_reserved, delta_held, delta_consumed, delta_external, reservation_id, evidence_kind, evidence_ref, cause_kind, cause_ref)
       VALUES($1,$2,$3,'reserve',-$4::bigint,$4::bigint,0,0,0,$5::uuid,'authorization',$6::uuid::text,'reservation',$5::uuid::text || ':reserve')`,
      [randomUUID(), tx.userId, tx.commandId, String(allocation.holdUnits), reservationId, authorizationId]);
  }
}

/** Locks one reservation (the wallet is already locked by runLedgerCommand: lock order wallet -> reservation). Absent/foreign => NOT_FOUND. */
async function lockReservation(tx: LedgerTx, reservationId: string): Promise<ReservationRow> {
  const row = (await tx.query(`SELECT ${RESERVATION_COLUMNS} FROM ${S}.credit_reservations WHERE reservation_id = $1 AND user_id = $2 FOR UPDATE`, [reservationId, tx.userId])).rows[0] as ReservationRow | undefined;
  if (!row) throw new LedgerError("NOT_FOUND");
  return row;
}

/**
 * System command `reservation_release` (ADR-0021 D6). Releases ONLY on Plane B `verified_zero_charge_failure` evidence whose
 * operationId equals this reservation's own operation (read from the database, never trusted from the caller), and only for a
 * dispatched reservation (workflow_ref recorded): a never-dispatched reservation stays reserved for a human (orphan finder, S8;
 * founder question Q9). A timeout, cancel or unknown outcome cannot release: such evidence does not parse as release evidence.
 * The full hold returns to `available` in the same entry and is never netted against a sibling. Replays are safe.
 */
export async function releaseReservation(db: LedgerDb, input: ReleaseReservationInput): Promise<ReservationRecord> {
  const userId = assertUuid(input.userId), component = assertComponent(input.component), reservationId = assertUuid(input.reservationId);
  const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
  const parsed = TransitionEvidenceV1Schema.safeParse(input.evidence);
  if (!parsed.success || parsed.data.transition !== "release" || parsed.data.evidenceRef.length > MAX_EVIDENCE_REF) throw new LedgerError("EVIDENCE_INVALID"); // before any SQL
  const evidence = parsed.data;
  await runLedgerCommand(db, {
    actor: "system", component, expectedUserId: userId, userId, commandKind: "reservation_release", idempotencyKey,
    payload: asLedgerJson({ reservationId, evidence }),
  }, async tx => {
    const reservation = await lockReservation(tx, reservationId);
    if (evidence.operationId !== reservation.operation_id) throw new LedgerBusinessRejection("EVIDENCE_INVALID");
    if (reservation.state !== "reserved" || reservation.workflow_ref === null) throw new LedgerBusinessRejection("INVALID_TRANSITION");
    await tx.query(
      `INSERT INTO ${S}.ledger_entries(entry_id, user_id, command_id, entry_kind, delta_available, delta_reserved, delta_held, delta_consumed, delta_external, reservation_id, evidence_kind, evidence_ref, cause_kind, cause_ref)
       VALUES($1,$2,$3,'release',$4::bigint,-$4::bigint,0,0,0,$5::uuid,'verified_zero_charge_failure',$6,'reservation',$5::uuid::text || ':release')`,
      [randomUUID(), tx.userId, tx.commandId, reservation.hold_units, reservationId, evidence.evidenceRef]);
  });
  return getReservation(asQueryable(db), userId, reservationId);
}

/**
 * System command `reservation_dispatch`: records, once, the workflow reference of a reserved reservation (the dispatch marker that
 * D6 release requires). Recording the same reference again is a no-op; a different one, or a reservation that is not reserved, is
 * INVALID_TRANSITION. It moves no units and changes no state.
 */
export async function recordWorkflowRef(db: LedgerDb, input: RecordWorkflowRefInput): Promise<ReservationRecord> {
  const userId = assertUuid(input.userId), component = assertComponent(input.component), reservationId = assertUuid(input.reservationId);
  const idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
  if (typeof input.workflowRef !== "string" || !WORKFLOW_REF.test(input.workflowRef)) throw new LedgerError("INVALID_INPUT");
  const workflowRef = input.workflowRef;
  await runLedgerCommand(db, {
    actor: "system", component, expectedUserId: userId, userId, commandKind: "reservation_dispatch", idempotencyKey,
    payload: asLedgerJson({ reservationId, workflowRef }),
  }, async tx => {
    const reservation = await lockReservation(tx, reservationId);
    if (reservation.workflow_ref === workflowRef) return;
    if (reservation.workflow_ref !== null || reservation.state !== "reserved") throw new LedgerBusinessRejection("INVALID_TRANSITION");
    await tx.query(`UPDATE ${S}.credit_reservations SET workflow_ref = $1 WHERE reservation_id = $2 AND user_id = $3 AND workflow_ref IS NULL`, [workflowRef, reservationId, tx.userId]);
  });
  return getReservation(asQueryable(db), userId, reservationId);
}
