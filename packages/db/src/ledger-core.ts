import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
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

/** Internal-only failure codes beyond the contract enum. None of them reaches a customer projection. */
export type LedgerFailureCode = LedgerErrorCodeV1 | "INVALID_INPUT" | "GRANT_SOURCE_UNREGISTERED" | "DUPLICATE_CAUSE" | "DATABASE_REJECTED" | "DATABASE_ERROR" | "TRANSIENT";
export class LedgerError extends Error {
  constructor(readonly code: LedgerFailureCode, readonly sqlstate?: string, cause?: unknown) { super(code, cause === undefined ? undefined : { cause }); this.name = "LedgerError"; }
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
function canonicalize(value: unknown, depth = 0): string {
  if (depth > 32) throw new LedgerError("INVALID_INPUT"); // also stops cyclic payloads
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new LedgerError("INVALID_INPUT"); return JSON.stringify(value); }
  if (Array.isArray(value)) return "[" + value.map(item => canonicalize(item, depth + 1)).join(",") + "]";
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record).sort().map(key => { if (record[key] === undefined) throw new LedgerError("INVALID_INPUT"); return JSON.stringify(key) + ":" + canonicalize(record[key], depth + 1); }).join(",") + "}";
  }
  throw new LedgerError("INVALID_INPUT"); // undefined, bigint, functions, class instances, symbols
}
/** Sorted-key canonical JSON -> SHA-256 hex. The ledger computes this itself; a caller-supplied hash is never accepted. */
export function canonicalRequestHash(payload: Json): string { return createHash("sha256").update(canonicalize(payload)).digest("hex"); }

/**
 * ADR-0021 D10 outcome classification for an error raised while COMMIT is in flight: definite ONLY for a server-reported
 * ERROR in SQLSTATE class 23 (integrity) or 40001/40002/40P01 (serialization/deadlock; 40003 is unknown). Everything else -- connection errors, no SQLSTATE,
 * FATAL, class 08/57 -- is unknown and is resolved only by replaying the same idempotency key.
 */
export function classifyCommitFailure(error: unknown): "definite" | "unknown" {
  if (typeof error !== "object" || error === null) return "unknown";
  const { code, severity } = error as { code?: unknown; severity?: unknown };
  if (severity !== "ERROR" || typeof code !== "string" || !/^[0-9A-Z]{5}$/.test(code)) return "unknown";
  return code.startsWith("23") || code === "40001" || code === "40002" || code === "40P01" ? "definite" : "unknown"; // 40003 (statement_completion_unknown) is an unknown outcome
}
/** Errors raised BEFORE COMMIT is sent are definite rollbacks when the server reported them (any SQLSTATE with severity ERROR). */
export function classifyStatementFailure(error: unknown): "definite" | "unknown" {
  if (typeof error !== "object" || error === null) return "unknown";
  const { code, severity } = error as { code?: unknown; severity?: unknown };
  return severity === "ERROR" && typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? "definite" : "unknown";
}
function mapDefinite(error: unknown): LedgerError {
  if (error instanceof LedgerError || error instanceof LedgerBusinessRejection) return error as LedgerError;
  const code = typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "";
  if (code === "40001" || code === "40P01" || code === "55P03") return new LedgerError("TRANSIENT", code, error);
  if (code.startsWith("23")) return new LedgerError("DATABASE_REJECTED", code, error);
  return new LedgerError("DATABASE_ERROR", code || undefined, error);
}
const unknownOutcome = () => new LedgerError("LEDGER_OUTCOME_UNKNOWN");

// ---- connections ---------------------------------------------------------------------------------------------------

export interface LedgerQueryResult { rows: Record<string, unknown>[]; rowCount: number | null }
export interface LedgerQueryable { query(text: string, values?: unknown[]): Promise<LedgerQueryResult> }
export interface LedgerConn extends LedgerQueryable { release?(destroy?: boolean): void }
/** A pool, or an object that hands out an exclusive connection (fault-injection tests). A bare Client is deliberately not accepted: it cannot be destroyed and cannot isolate concurrent commands. */
export type LedgerDb = Pool | { acquire(): Promise<LedgerConn> };
async function acquire(db: LedgerDb): Promise<LedgerConn> {
  if (db instanceof Pool) return (await db.connect()) as unknown as LedgerConn;
  return db.acquire();
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

export interface LedgerEntryRecord {
  readonly entryId: string; readonly commandId: string; readonly entryKind: LedgerEntryKindV1;
  readonly deltaAvailable: number; readonly deltaReserved: number; readonly deltaHeld: number; readonly deltaConsumed: number; readonly deltaExternal: number;
  readonly causeKind: string; readonly causeRef: string;
}
export interface LedgerCommandResult { readonly commandId: string; readonly replayed: boolean; readonly entries: readonly LedgerEntryRecord[] }
/** Handle given to a command callback: the open transaction, scoped to one command. Internal code only. */
export interface LedgerTx extends LedgerQueryable { readonly commandId: string; readonly userId: string; readonly actor: "system" | "customer" }

function parseCommand(spec: LedgerCommandSpec) {
  const base = {
    idempotencyScope: `${spec.userId}:${spec.commandKind}`, idempotencyKey: spec.idempotencyKey, requestSha256: canonicalRequestHash(spec.payload),
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
  catch (error) { throw classifyStatementFailure(error) === "definite" ? mapDefinite(error) : unknownOutcome(); }
  try { await conn.query("COMMIT"); }
  catch (error) { throw classifyCommitFailure(error) === "definite" ? mapDefinite(error) : unknownOutcome(); }
}

/**
 * The single place that opens a ledger transaction. Wallet row locked first; the command row is inserted next (ON CONFLICT DO
 * NOTHING); a prior row with the same key replays (same canonical hash) or conflicts (different hash) without running the
 * callback. Terminal business rejections are recorded under the key in their own small transaction and replayed identically;
 * transient failures and unknown outcomes are NOT recorded -- retry the same key. The returned entries are reconstructed from
 * the ledger, never from the callback. A connection that produced an unknown outcome is destroyed, never reused.
 */
export async function runLedgerCommand(db: LedgerDb, spec: LedgerCommandSpec, callback: (tx: LedgerTx) => Promise<void>): Promise<LedgerCommandResult> {
  const command = parseCommand(spec);
  const conn = await acquire(db);
  let destroy = false;
  const rollback = () => conn.query("ROLLBACK").then(() => undefined, () => { destroy = true; });
  const fail = async (error: unknown): Promise<never> => {
    if (isOutcomeUnknown(error)) { destroy = true; throw unknownOutcome(); }
    await rollback();
    throw error instanceof LedgerError || error instanceof LedgerBusinessRejection ? error : mapDefinite(error);
  };
  try {
    try { return await attempt(conn, command, spec, callback); }
    catch (error) {
      if (error instanceof LedgerBusinessRejection && !error.replayed) {
        await rollback();
        if (destroy) throw error; // the connection is broken: surface the original rejection, record nothing
        try { return await recordRejection(conn, command, error.code); } catch (inner) { return await fail(inner); }
      }
      return await fail(error);
    }
  } finally { conn.release?.(destroy); }
}

/** A failure after which the caller cannot know whether the transaction committed: lost connection, FATAL, class 08/57, or an already-classified unknown. */
function isOutcomeUnknown(error: unknown): boolean {
  if (error instanceof LedgerError) return error.code === "LEDGER_OUTCOME_UNKNOWN";
  if (error instanceof LedgerBusinessRejection || typeof error !== "object" || error === null) return false;
  const { code, severity, message } = error as { code?: unknown; severity?: unknown; message?: unknown };
  if (typeof severity === "string") return severity !== "ERROR" || (typeof code === "string" && (code.startsWith("08") || code.startsWith("57")));
  return (typeof code === "string" && /^E(CONNRESET|PIPE|TIMEDOUT|CONNREFUSED|NOTFOUND)$/.test(code)) || (typeof message === "string" && /connection (terminated|closed|ended)|terminating connection/i.test(message));
}

async function attempt(conn: LedgerConn, command: ReturnType<typeof parseCommand>, spec: LedgerCommandSpec, callback: (tx: LedgerTx) => Promise<void>): Promise<LedgerCommandResult> {
  await conn.query("BEGIN");
  await lockWallet(conn, command.userId);
  const commandId = await insertCommand(conn, command, "applied", null);
  if (!commandId) { // same scope + key already exists (serialized by the wallet lock): replay or conflict, never execute
    const result = await replay(conn, command);
    await conn.query("ROLLBACK");
    return result;
  }
  let open = true;
  try { await callback({ commandId, userId: command.userId, actor: spec.actor, query: (text, values) => open ? conn.query(text, values) : Promise.reject(new LedgerError("INVALID_TRANSITION")) }); }
  finally { open = false; } // a retained handle must never reach a connection that has moved on
  const entries = await entriesOf(conn, commandId, command.userId);
  await finish(conn);
  return { commandId, replayed: false, entries };
}

async function replay(conn: LedgerQueryable, command: ReturnType<typeof parseCommand>): Promise<LedgerCommandResult> {
  const prior = await readPrior(conn, command.idempotencyScope, command.idempotencyKey);
  if (!prior) throw unknownOutcome(); // cannot happen under the wallet lock; fail closed rather than guess
  if (prior.requestSha256 !== command.requestSha256) throw new LedgerError("IDEMPOTENCY_CONFLICT");
  if (prior.outcome === "rejected") throw new LedgerBusinessRejection(prior.rejectionCode as PersistableRejectionCode, true);
  return { commandId: prior.commandId, replayed: true, entries: await entriesOf(conn, prior.commandId, command.userId) };
}

/** Records the rejection in its own small transaction, then throws it. If a concurrent same-key command won meanwhile, its result is returned instead. */
async function recordRejection(conn: LedgerConn, command: ReturnType<typeof parseCommand>, code: PersistableRejectionCode): Promise<LedgerCommandResult> {
  await conn.query("BEGIN");
  await lockWallet(conn, command.userId);
  const commandId = await insertCommand(conn, command, "rejected", code);
  if (!commandId) { const result = await replay(conn, command); await conn.query("ROLLBACK"); return result; }
  await finish(conn);
  throw new LedgerBusinessRejection(code);
}

// ---- grants --------------------------------------------------------------------------------------------------------

/**
 * Appends a `grant` entry. System actor only, and only against an already-registered grant source: this module has no function that
 * registers one, so with no source registered no credit can be created. A grant never authorizes anything (D7).
 */
export async function appendGrantEntry(tx: LedgerTx, input: { grantSourceId: string; sourceRef: string; units: number }): Promise<{ entryId: string }> {
  if (tx.actor !== "system") throw new LedgerError("INVALID_TRANSITION");
  const units = assertPositiveUnits(input.units), sourceId = assertUuid(input.grantSourceId);
  if (typeof input.sourceRef !== "string" || !SOURCE_REF.test(input.sourceRef)) throw new LedgerError("INVALID_INPUT");
  if ((await tx.query(`SELECT 1 FROM ${S}.ledger_grant_sources WHERE grant_source_id = $1`, [sourceId])).rows.length !== 1) throw new LedgerError("GRANT_SOURCE_UNREGISTERED");
  const entryId = randomUUID();
  try {
    await tx.query(
      `INSERT INTO ${S}.ledger_entries(entry_id, user_id, command_id, entry_kind, delta_available, delta_reserved, delta_held, delta_consumed, delta_external, grant_source_id, source_ref, cause_kind, cause_ref)
       VALUES($1,$2,$3,'grant',$4::bigint,0,0,0,-$4::bigint,$5::uuid,$6::text,'grant',$5::uuid::text || ':' || $6::text)`, [entryId, tx.userId, tx.commandId, String(units), sourceId, input.sourceRef]);
  } catch (error) {
    if ((error as { code?: string; constraint?: string }).code === "23505" && (error as { constraint?: string }).constraint === "ledger_entries_cause_unique") throw new LedgerError("DUPLICATE_CAUSE", "23505");
    throw error;
  }
  return { entryId };
}
