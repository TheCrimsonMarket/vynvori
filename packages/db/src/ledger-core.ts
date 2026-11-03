import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { CreditWalletSummaryV1Schema, type CreditWalletSummaryV1 } from "@vynvori/contracts";
import {
  LedgerCustomerCommandV1Schema, LedgerInternalCommandV1Schema, type LedgerEntryKindV1, type LedgerErrorCodeV1,
} from "@vynvori/contracts/ledger-internal";

/**
 * M7 S2 ledger core (ADR-0021 D1-D4, D10-D13). Library only: nothing under apps/ imports it (static test). It writes the
 * Neon/Drizzle ledger schema `vynvori_ledger` and nothing else; it never touches Medusa. No prices, rates or package sizes
 * live here, and no function registers a grant source (sources are inserted by privileged operators/test fixtures only).
 */
const S = "vynvori_ledger";
const SAFE_MAX = BigInt(Number.MAX_SAFE_INTEGER);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SOURCE_REF = /^[A-Za-z0-9._:-]{1,128}$/;
/** Technical bounds, not business values (ADR-0021 S2 addendum). Private on purpose: the package exports no numeric constants. */
const LOCK_TIMEOUT_MS = 10_000, STATEMENT_TIMEOUT_MS = 30_000, IDLE_IN_TRANSACTION_TIMEOUT_MS = 30_000;
const CANONICAL_NODE_BUDGET = 10_000, CANONICAL_MAX_DEPTH = 32;

/** Internal-only failure codes beyond the contract enum. None of them reaches a customer projection. */
export type LedgerFailureCode = LedgerErrorCodeV1 | "INVALID_INPUT" | "GRANT_SOURCE_UNREGISTERED" | "DUPLICATE_CAUSE" | "DATABASE_REJECTED" | "DATABASE_ERROR" | "TRANSIENT";
/** Carries only a code, a SQLSTATE and a constraint name. It never keeps the raw driver error: that can contain the idempotency key. */
export class LedgerError extends Error {
  constructor(readonly code: LedgerFailureCode, readonly sqlstate?: string, readonly constraint?: string) { super(code); this.name = "LedgerError"; }
}

/** Business rejections that may be persisted under an idempotency key. Conflicts, absence and unknown outcomes never are. */
export const PERSISTABLE_REJECTION_CODES = Object.freeze([
  "INSUFFICIENT_CREDITS", "QUOTE_EXPIRED", "QUOTE_STALE", "ALLOCATION_INVALID", "TERMS_NOT_APPROVED", "CANCELLATION_WINDOW_UNDISCLOSED",
  "RIGHTS_INELIGIBLE", "DOWNSTREAM_USE_UNAVAILABLE", "PROMO_ALREADY_USED", "EVIDENCE_INVALID", "INVALID_TRANSITION",
] as const satisfies readonly LedgerErrorCodeV1[]);
export type PersistableRejectionCode = (typeof PERSISTABLE_REJECTION_CODES)[number];
/** Thrown by a command callback for a terminal business outcome. The ledger records it under the key and replays it. */
export class LedgerBusinessRejection extends Error {
  constructor(readonly code: PersistableRejectionCode, readonly replayed = false) {
    super(code); this.name = "LedgerBusinessRejection";
    if (!(PERSISTABLE_REJECTION_CODES as readonly string[]).includes(code)) throw new LedgerError("INVALID_INPUT");
  }
}

// ---- pure helpers -------------------------------------------------------------------------------------------------

/** Exact bigint text -> safe-integer number. Anything that could lose precision throws; Number() is never applied to unchecked text. */
export function parseSafeUnits(text: unknown): number {
  if (typeof text !== "string" || !/^-?\d{1,19}$/.test(text)) throw new LedgerError("INVALID_INPUT");
  const value = BigInt(text);
  if (value > SAFE_MAX || value < -SAFE_MAX) throw new LedgerError("INVALID_INPUT");
  return Number(value);
}
/** Whole, positive, safe-integer credit units; rejects NaN, fractions, negatives and anything above 2^53-1 before any SQL. */
export function assertPositiveUnits(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new LedgerError("INVALID_INPUT");
  return value;
}
function assertUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new LedgerError("INVALID_INPUT");
  return value;
}

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
/** Canonical JSON with a node budget and ancestor tracking, so cycles and shared sub-structures cannot fan out exponentially. */
function canonicalize(value: unknown, budget = { nodes: 0 }, ancestors: object[] = []): string {
  if (++budget.nodes > CANONICAL_NODE_BUDGET || ancestors.length > CANONICAL_MAX_DEPTH) throw new LedgerError("INVALID_INPUT");
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new LedgerError("INVALID_INPUT"); return JSON.stringify(value); }
  if (Array.isArray(value) || (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)) {
    if (ancestors.includes(value as object)) throw new LedgerError("INVALID_INPUT");
    const next = [...ancestors, value as object];
    if (Array.isArray(value) && (value.length > CANONICAL_NODE_BUDGET || Object.keys(value).length !== value.length)) throw new LedgerError("INVALID_INPUT"); // huge or sparse
    if (Array.isArray(value)) return "[" + value.map(item => canonicalize(item, budget, next)).join(",") + "]";
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record).sort().map(key => { if (record[key] === undefined) throw new LedgerError("INVALID_INPUT"); return JSON.stringify(key) + ":" + canonicalize(record[key], budget, next); }).join(",") + "}";
  }
  throw new LedgerError("INVALID_INPUT"); // undefined, bigint, functions, class instances, symbols
}
/** Sorted-key canonical JSON -> SHA-256 hex. The ledger computes this itself; a caller-supplied hash is never accepted. */
export function canonicalRequestHash(payload: Json): string { return createHash("sha256").update(canonicalize(payload)).digest("hex"); }

const SQLSTATE = /^[0-9A-Z]{5}$/;
/**
 * ADR-0021 D10, while COMMIT is in flight: definite ONLY for a server-reported ERROR in SQLSTATE class 23 (integrity) or 40
 * (serialization/deadlock). Everything else -- connection errors, no SQLSTATE, FATAL, classes 08/57 -- is unknown and is
 * resolved only by replaying the same idempotency key. Stricter than the class rule by one code: 40003
 * (statement_completion_unknown) is by definition an unknown outcome and is never definite.
 */
export function classifyCommitFailure(error: unknown): "definite" | "unknown" {
  if (typeof error !== "object" || error === null) return "unknown";
  const { code, severity } = error as { code?: unknown; severity?: unknown };
  if (severity !== "ERROR" || typeof code !== "string" || !SQLSTATE.test(code) || code === "40003") return "unknown";
  return code.startsWith("23") || code.startsWith("40") ? "definite" : "unknown";
}
/**
 * ADR-0021 D10, before COMMIT is sent: an error carrying a SQLSTATE and severity ERROR is a DEFINITE rollback in every class
 * (including 57014 and server-reported 08xxx ERRORs). No SQLSTATE, no severity, any FATAL, and the driver's own client-level
 * failures ("not queryable", "Client was closed", "Connection terminated") are unknown, in every phase. Relies on the server's
 * English severity string; an unrecognised locale degrades to unknown, never to a wrong "definite".
 */
export function classifyStatementFailure(error: unknown): "definite" | "unknown" {
  if (typeof error !== "object" || error === null) return "unknown";
  const { code, severity } = error as { code?: unknown; severity?: unknown };
  return severity === "ERROR" && typeof code === "string" && SQLSTATE.test(code) ? "definite" : "unknown";
}
/** Errors that came back from a connection (tagged by the connection wrapper); a callback's own TypeError is never in this set. */
const connectionErrors = new WeakSet<object>();
function isOutcomeUnknown(error: unknown): boolean {
  if (error instanceof LedgerError) return error.code === "LEDGER_OUTCOME_UNKNOWN";
  if (error instanceof LedgerBusinessRejection || typeof error !== "object" || error === null) return false;
  if (typeof (error as { severity?: unknown }).severity === "string") return classifyStatementFailure(error) === "unknown";
  return connectionErrors.has(error); // no server report at all: the client cannot know what the server did
}
function mapDefinite(error: unknown): LedgerError {
  if (error instanceof LedgerError || error instanceof LedgerBusinessRejection) return error as LedgerError;
  const { code, constraint } = typeof error === "object" && error !== null ? (error as { code?: unknown; constraint?: unknown }) : {};
  const sqlstate = typeof code === "string" ? code : undefined, name = typeof constraint === "string" ? constraint : undefined;
  if (sqlstate === "40001" || sqlstate === "40P01" || sqlstate === "55P03" || sqlstate === "57014") return new LedgerError("TRANSIENT", sqlstate, name);
  if (sqlstate?.startsWith("23")) return new LedgerError("DATABASE_REJECTED", sqlstate, name);
  return new LedgerError("DATABASE_ERROR", sqlstate, name);
}
/** Server-reported errors map by SQLSTATE; anything else thrown by a callback (a bug of its own) is a generic DATABASE_ERROR without its message. */
function toLedgerError(error: unknown): LedgerError | LedgerBusinessRejection {
  if (error instanceof LedgerError || error instanceof LedgerBusinessRejection) return error;
  return typeof error === "object" && error !== null && typeof (error as { severity?: unknown }).severity === "string" ? mapDefinite(error) : new LedgerError("DATABASE_ERROR");
}
const unknownOutcome = () => new LedgerError("LEDGER_OUTCOME_UNKNOWN");

// ---- connections ---------------------------------------------------------------------------------------------------

export interface LedgerQueryResult { rows: Record<string, unknown>[]; rowCount: number | null }
export interface LedgerQueryable { query(text: string, values?: unknown[]): Promise<LedgerQueryResult> }
export interface LedgerConn extends LedgerQueryable { release?(destroy?: boolean): void }
/** A pool, or an object that hands out an exclusive connection (fault-injection tests). A bare Client is deliberately not accepted: it cannot be destroyed and cannot isolate concurrent commands. */
export type LedgerDb = Pool | PoolLike | { acquire(): Promise<LedgerConn> };
type PoolLike = { connect(): Promise<{ query(text: string, values?: unknown[]): Promise<LedgerQueryResult>; on(event: "error", listener: () => void): unknown; off(event: "error", listener: () => void): unknown; release(destroy?: boolean): void }> };
/** Duck-typed on `connect`, so a second copy of pg or a serverless pool works; anything else must supply `acquire`. */
async function acquire(db: LedgerDb): Promise<LedgerConn> {
  let conn: LedgerConn;
  try {
    if (typeof (db as Partial<PoolLike>).connect === "function") {
      const client = await (db as PoolLike).connect();
      // A checked-out pg client emits 'error' when its connection ends. Without a listener that crashes the process; with one
      // the next statement fails ("not queryable") and is classified. A client that saw an error is never returned to the pool.
      let broken = false; const onError = () => { broken = true; };
      client.on("error", onError);
      conn = { query: (text, values) => client.query(text, values), release: destroy => { client.off("error", onError); client.release(destroy || broken); } };
    } else conn = await (db as { acquire(): Promise<LedgerConn> }).acquire();
  } catch { throw new LedgerError("TRANSIENT"); } // nothing was sent; never surface the driver error (host, port, credentials hints)
  return { query: async (text, values) => { try { return await conn.query(text, values); } catch (error) { if (typeof error === "object" && error !== null) connectionErrors.add(error); throw error; } }, release: destroy => conn.release?.(destroy) };
}

// ---- wallets -------------------------------------------------------------------------------------------------------

/** Creates the empty wallet for a verified profile. A missing profile (a guest) is NOT_FOUND; creation is not a balance change. */
export async function ensureWallet(db: LedgerQueryable, userId: string): Promise<{ created: boolean }> {
  assertUuid(userId);
  try {
    const result = await db.query(`INSERT INTO ${S}.wallets(user_id) VALUES($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);
    return { created: result.rowCount === 1 };
  } catch (error) {
    if ((error as { code?: string }).code === "23503") throw new LedgerError("NOT_FOUND");
    throw error;
  }
}

/** Owner-scoped read in the existing public CreditWalletSummaryV1 shape. Absent and foreign wallets are the same NOT_FOUND. */
export async function getWalletSummary(db: LedgerQueryable, userId: string): Promise<CreditWalletSummaryV1> {
  assertUuid(userId);
  const result = await db.query(
    `SELECT available_units::text AS a, reserved_units::text AS r, held_for_review_units::text AS h, revision::text AS rev, now() AS at FROM ${S}.wallets WHERE user_id = $1`, [userId]);
  const row = result.rows[0];
  if (!row) throw new LedgerError("NOT_FOUND");
  return CreditWalletSummaryV1Schema.parse({
    unit: "credits", availableUnits: parseSafeUnits(row["a"]), reservedUnits: parseSafeUnits(row["r"]), heldForReviewUnits: parseSafeUnits(row["h"]),
    snapshotAt: (row["at"] as Date).toISOString(), walletRevision: String(row["rev"]),
  });
}

// ---- commands ------------------------------------------------------------------------------------------------------

export type LedgerCommandSpec =
  | { readonly actor: "system"; readonly component: string; readonly expectedUserId: string; readonly userId: string; readonly commandKind: string; readonly idempotencyKey: string; readonly payload: Json }
  | { readonly actor: "customer"; readonly userId: string; readonly commandKind: string; readonly idempotencyKey: string; readonly payload: Json };
/** Options can only SHORTEN the lock wait (tests, callers with tighter budgets); they can never lengthen it. */
export interface LedgerCommandOptions { readonly lockTimeoutMs?: number }

export interface LedgerEntryRecord {
  readonly entryId: string; readonly commandId: string; readonly entryKind: LedgerEntryKindV1;
  readonly deltaAvailable: number; readonly deltaReserved: number; readonly deltaHeld: number; readonly deltaConsumed: number; readonly deltaExternal: number;
  readonly causeKind: string; readonly causeRef: string;
}
export interface LedgerCommandResult { readonly commandId: string; readonly replayed: boolean; readonly entries: readonly LedgerEntryRecord[] }
/** Handle given to a command callback: the open transaction, scoped to one command. Only runLedgerCommand can issue one; it dies when the command ends. */
export interface LedgerTx extends LedgerQueryable { readonly commandId: string; readonly userId: string; readonly actor: "system" | "customer"; readonly requestSha256: string }
const issuedHandles = new WeakSet<object>();

/** The idempotency hash binds the actor kind as well as the payload, so a customer command can never replay a system command's result. */
const requestHashFor = (actor: "system" | "customer", payload: Json) => canonicalRequestHash({ actor, payload });
function parseCommand(spec: LedgerCommandSpec) {
  const base = {
    idempotencyScope: `${spec.userId}:${spec.commandKind}`, idempotencyKey: spec.idempotencyKey, requestSha256: requestHashFor(spec.actor, spec.payload),
    userId: spec.userId, commandKind: spec.commandKind,
  };
  const parsed = spec.actor === "system"
    ? LedgerInternalCommandV1Schema.safeParse({ ...base, actor: { kind: "system", component: spec.component, expectedUserId: spec.expectedUserId } })
    : LedgerCustomerCommandV1Schema.safeParse(base);
  if (!parsed.success) throw new LedgerError("INVALID_INPUT"); // never echo the issues: they could contain the idempotency key
  return parsed.data;
}

const ENTRY_COLUMNS = `entry_id, command_id, entry_kind, delta_available::text AS da, delta_reserved::text AS dr, delta_held::text AS dh, delta_consumed::text AS dc, delta_external::text AS de, cause_kind, cause_ref`;
async function entriesOf(conn: LedgerQueryable, commandId: string, userId: string): Promise<LedgerEntryRecord[]> {
  const rows = (await conn.query(`SELECT ${ENTRY_COLUMNS} FROM ${S}.ledger_entries WHERE command_id = $1 AND user_id = $2 ORDER BY created_at, entry_id`, [commandId, userId])).rows;
  return rows.map(r => ({
    entryId: String(r["entry_id"]), commandId: String(r["command_id"]), entryKind: r["entry_kind"] as LedgerEntryKindV1,
    deltaAvailable: parseSafeUnits(r["da"]), deltaReserved: parseSafeUnits(r["dr"]), deltaHeld: parseSafeUnits(r["dh"]), deltaConsumed: parseSafeUnits(r["dc"]), deltaExternal: parseSafeUnits(r["de"]),
    causeKind: String(r["cause_kind"]), causeRef: String(r["cause_ref"]),
  }));
}

type Prior = { commandId: string; requestSha256: string; outcome: "applied" | "rejected"; rejectionCode: string | null };
const readPrior = async (conn: LedgerQueryable, scope: string, key: string): Promise<Prior | undefined> => {
  const row = (await conn.query(`SELECT command_id, request_sha256, outcome, rejection_code FROM ${S}.ledger_commands WHERE scope = $1 AND idempotency_key = $2`, [scope, key])).rows[0];
  return row ? { commandId: String(row["command_id"]), requestSha256: String(row["request_sha256"]).trim(), outcome: row["outcome"] as Prior["outcome"], rejectionCode: (row["rejection_code"] as string | null) } : undefined;
};
const insertCommand = async (conn: LedgerQueryable, command: ReturnType<typeof parseCommand>, outcome: "applied" | "rejected", rejectionCode: string | null) => {
  const commandId = randomUUID();
  const inserted = await conn.query(
    `INSERT INTO ${S}.ledger_commands(command_id, scope, idempotency_key, request_sha256, user_id, command_kind, outcome, rejection_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (scope, idempotency_key) DO NOTHING`, [commandId, command.idempotencyScope, command.idempotencyKey, command.requestSha256, command.userId, command.commandKind, outcome, rejectionCode]);
  return inserted.rowCount === 1 ? commandId : undefined;
};
/** Wallet row first, FOR UPDATE: the single lock every ledger transaction takes (D10). Same-user commands therefore serialize here. */
const lockWallet = async (conn: LedgerQueryable, userId: string) => {
  if ((await conn.query(`SELECT 1 FROM ${S}.wallets WHERE user_id = $1 FOR UPDATE`, [userId])).rows.length !== 1) throw new LedgerError("NOT_FOUND");
};

/** COMMIT with D10 classification. `SET CONSTRAINTS ALL IMMEDIATE` runs first so deterministic deferred failures are definite. */
async function finish(conn: LedgerConn): Promise<void> {
  try { await conn.query("SET CONSTRAINTS ALL IMMEDIATE"); }
  catch (error) { throw isOutcomeUnknown(error) ? unknownOutcome() : mapDefinite(error); }
  try { await conn.query("COMMIT"); }
  catch (error) { throw classifyCommitFailure(error) === "definite" ? mapDefinite(error) : unknownOutcome(); }
}

/**
 * The single place that opens a ledger transaction. Wallet row locked first; the command row is inserted next (ON CONFLICT DO
 * NOTHING); a prior row with the same key replays (same canonical hash) or conflicts (different hash) without running the
 * callback. A terminal business rejection is recorded under the key IN THE SAME TRANSACTION (rolled back to a savepoint, the
 * rejected row inserted, committed) while the wallet lock is still held, so no top-up can slip in between the decision and its
 * record. Guarantee: once a key is recorded, its callback never runs again. Transient failures and unknown outcomes are NOT
 * recorded -- retry the same key. Returned entries are reconstructed from the ledger, never from the callback. A connection that
 * produced an unknown outcome is destroyed, never reused.
 */
export async function runLedgerCommand(db: LedgerDb, spec: LedgerCommandSpec, callback: (tx: LedgerTx) => Promise<void>, options: LedgerCommandOptions = {}): Promise<LedgerCommandResult> {
  const command = parseCommand(spec);
  const lockMs = options.lockTimeoutMs === undefined ? LOCK_TIMEOUT_MS : Math.min(LOCK_TIMEOUT_MS, assertPositiveUnits(options.lockTimeoutMs));
  const conn = await acquire(db);
  const state = { destroy: false, done: false };
  try {
    return await attempt(conn, command, spec, callback, lockMs, state);
  } catch (error) {
    if (isOutcomeUnknown(error)) { state.destroy = true; throw unknownOutcome(); }
    if (!state.done) await conn.query("ROLLBACK").then(() => undefined, () => { state.destroy = true; });
    throw toLedgerError(error);
  } finally { conn.release?.(state.destroy); }
}

async function attempt(conn: LedgerConn, command: ReturnType<typeof parseCommand>, spec: LedgerCommandSpec, callback: (tx: LedgerTx) => Promise<void>, lockMs: number, state: { destroy: boolean; done: boolean }): Promise<LedgerCommandResult> {
  await conn.query("BEGIN");
  await conn.query(`SET LOCAL lock_timeout = '${lockMs}ms'`);
  await conn.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT_MS}ms'`);
  await conn.query(`SET LOCAL idle_in_transaction_session_timeout = '${IDLE_IN_TRANSACTION_TIMEOUT_MS}ms'`);
  await lockWallet(conn, command.userId);
  await conn.query("SAVEPOINT ledger_command");
  const commandId = await insertCommand(conn, command, "applied", null);
  if (!commandId) { // same scope + key already recorded (serialized by the wallet lock): replay or conflict, never execute
    const result = await replay(conn, command);
    await conn.query("ROLLBACK").catch(() => { state.destroy = true; }); state.done = true;
    return result;
  }
  let open = true;
  const tx: LedgerTx = { commandId, userId: command.userId, actor: spec.actor, requestSha256: command.requestSha256, query: (text, values) => open ? conn.query(text, values) : Promise.reject(new LedgerError("INVALID_TRANSITION")) };
  Object.freeze(tx); issuedHandles.add(tx);
  try { await callback(tx); }
  catch (error) {
    open = false;
    if (!(error instanceof LedgerBusinessRejection) || error.replayed) throw error;
    await conn.query("ROLLBACK TO SAVEPOINT ledger_command");
    if (!await insertCommand(conn, command, "rejected", error.code)) throw unknownOutcome(); // cannot happen under the wallet lock; fail closed
    await finish(conn); state.done = true;
    throw new LedgerBusinessRejection(error.code);
  } finally { open = false; } // a retained handle must never reach a connection that has moved on
  const entries = await entriesOf(conn, commandId, command.userId);
  await finish(conn); state.done = true;
  return { commandId, replayed: false, entries };
}

async function replay(conn: LedgerQueryable, command: ReturnType<typeof parseCommand>): Promise<LedgerCommandResult> {
  const prior = await readPrior(conn, command.idempotencyScope, command.idempotencyKey);
  if (!prior) throw unknownOutcome(); // cannot happen under the wallet lock; fail closed rather than guess
  if (prior.requestSha256 !== command.requestSha256) throw new LedgerError("IDEMPOTENCY_CONFLICT");
  if (prior.outcome === "rejected") throw new LedgerBusinessRejection(prior.rejectionCode as PersistableRejectionCode, true);
  return { commandId: prior.commandId, replayed: true, entries: await entriesOf(conn, prior.commandId, command.userId) };
}

// ---- grants --------------------------------------------------------------------------------------------------------

/**
 * Appends a `grant` entry. System actor only, only through a handle issued by runLedgerCommand, and only against an
 * already-registered grant source: this module has no function that registers one, so with no source registered no credit can
 * be created. The command's idempotency hash must equal the hash of THIS entry (actor + source + ref + amount), so a caller
 * cannot record one effect under a key and write another. A grant never authorizes anything (D7).
 */
export async function appendGrantEntry(tx: LedgerTx, input: { grantSourceId: string; sourceRef: string; units: number }): Promise<{ entryId: string }> {
  const units = assertPositiveUnits(input.units), sourceId = assertUuid(input.grantSourceId);
  if (typeof input.sourceRef !== "string" || !SOURCE_REF.test(input.sourceRef)) throw new LedgerError("INVALID_INPUT");
  if (tx.actor !== "system") throw new LedgerError("INVALID_TRANSITION");
  if (!issuedHandles.has(tx)) throw new LedgerError("INVALID_INPUT"); // hand-built or copied handles are rejected
  if (requestHashFor("system", { grantSourceId: sourceId, sourceRef: input.sourceRef, units }) !== tx.requestSha256) throw new LedgerError("INVALID_INPUT");
  if ((await tx.query(`SELECT 1 FROM ${S}.ledger_grant_sources WHERE grant_source_id = $1`, [sourceId])).rows.length !== 1) throw new LedgerError("GRANT_SOURCE_UNREGISTERED");
  const entryId = randomUUID();
  try {
    await tx.query(
      `INSERT INTO ${S}.ledger_entries(entry_id, user_id, command_id, entry_kind, delta_available, delta_reserved, delta_held, delta_consumed, delta_external, grant_source_id, source_ref, cause_kind, cause_ref)
       VALUES($1,$2,$3,'grant',$4::bigint,0,0,0,-$4::bigint,$5::uuid,$6::text,'grant',$5::uuid::text || ':' || $6::text)`, [entryId, tx.userId, tx.commandId, String(units), sourceId, input.sourceRef]);
  } catch (error) {
    if ((error as { code?: string; constraint?: string }).code === "23505" && (error as { constraint?: string }).constraint === "ledger_entries_cause_unique") throw new LedgerError("DUPLICATE_CAUSE", "23505", "ledger_entries_cause_unique");
    throw error;
  }
  return { entryId };
}
