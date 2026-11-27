import "server-only";
import { LedgerError, parseSafeUnits, type LedgerConn, type LedgerDb, type LedgerQueryable } from "./ledger-core";

/**
 * M7 S8 read-only ledger checks (ADR-0021 D14, S2 follow-up "S8"). Library only: nothing under apps/ imports it (static test).
 * It REPORTS and never repairs: every statement it sends is a SELECT inside one READ ONLY, REPEATABLE READ transaction (one
 * consistent snapshot, so concurrent writers can never produce a false finding), and the transaction is always rolled back.
 * It takes no lock, calls no ledger command, writes no row and never releases, settles, holds or resolves anything. It reads no
 * vendor-cost evidence, no idempotency key and no workflow reference, so none of them can reach a report. A report is INTERNAL
 * (it names user and reservation ids): it must never be mapped into a customer projection.
 *
 * Honest limits (ADR-0021 S8 addendum): it detects, it does not prove. It does not inspect role grants, role membership or
 * function owners (S9 grants proposal and the rollout re-own procedure own those), and it cannot see a change made after its
 * snapshot. No dispatch timestamp is stored, so "stale" is measured from the reservation's creation. No threshold, price, rate or
 * duration lives here: the orphan cut-off is a required argument with no default.
 */
const S = "vynvori_ledger";
/** Technical bounds, not business values (private on purpose: the package exports no numeric constants). */
const STATEMENT_TIMEOUT_MS = 30_000, LOCK_TIMEOUT_MS = 5_000, IDLE_IN_TRANSACTION_TIMEOUT_MS = 30_000;
/** Findings kept per invariant; one more is fetched so the report can say it was truncated. */
const MAX_FINDINGS_PER_CHECK = 100;
const MAX_SAFE = "9007199254740991";

export type InvariantCode =
  | "WALLET_BUCKET_MISMATCH" | "WALLET_BUCKET_OUT_OF_RANGE" | "ENTRY_UNBALANCED"
  | "RESERVED_BUCKET_MISMATCH" | "HELD_BUCKET_MISMATCH" | "CONSUMED_BUCKET_MISMATCH"
  | "RESERVATION_TRAIL_MISMATCH" | "ALLOCATION_SUM_MISMATCH" | "AUTHORIZATION_ALLOCATION_MISMATCH"
  | "PROMO_UNIQUENESS_VIOLATED" | "PROMO_CLAIM_TRAIL_MISMATCH" | "SYNTHETIC_GRANT_SOURCE_REGISTERED"
  | "TRIGGER_MISSING" | "TRIGGER_DISABLED" | "TRIGGER_MISMATCH" | "TRIGGER_UNEXPECTED" | "RULE_UNEXPECTED"
  | "FUNCTION_PRIVILEGE_MISMATCH" | "FUNCTION_SEARCH_PATH_UNPINNED";

/** Values are strings, booleans or null on purpose: a corrupted balance may exceed the safe-integer range and is never rounded. */
export type FindingDetail = Readonly<Record<string, string | boolean | null>>;
export interface InvariantFinding {
  readonly invariant: InvariantCode;
  readonly userId: string | null;
  /** The row the finding is about (entry, reservation, quote version, authorization, claim, trigger or function), when there is one. */
  readonly subjectId: string | null;
  readonly detail: FindingDetail;
}
export interface WalletInvariantReport {
  /** True only when there are no findings. A registered synthetic grant source is a finding by design (D12). */
  readonly ok: boolean;
  /** The snapshot's transaction time (database clock). */
  readonly checkedAt: string;
  readonly findings: readonly InvariantFinding[];
  /** Invariants that had more than the per-check cap of findings; only the first findings of each were kept. */
  readonly truncated: readonly InvariantCode[];
}

export type OrphanClass = "reserved_never_dispatched" | "reserved_dispatch_stale" | "hold_present";
export interface OrphanedReservation {
  readonly reservationId: string;
  readonly userId: string;
  readonly operationId: string;
  readonly operationKind: string;
  readonly state: "reserved" | "reconciliation_hold";
  readonly orphanClass: OrphanClass;
  readonly holdUnits: number;
  readonly chargeUnits: number;
  readonly dispatched: boolean;
  /** When the reservation was created (reserve time). A hold's age is measured from its hold entry. */
  readonly reservedAt: string;
}
export interface OrphanReport {
  readonly olderThan: string;
  readonly orphans: readonly OrphanedReservation[];
  readonly truncated: boolean;
}
export interface FindOrphanedReservationsOptions {
  /** REQUIRED, no default (D14): only reservations older than this instant are reported. */
  readonly olderThan: Date;
}

// ---- trigger manifest: the exact set of triggers migrations 0002-0007 leave on vynvori_ledger tables -------------------------

/** Compact trigger shape: B|A (before/after), then the events I U D T. T is a statement trigger; everything else is per row. */
type Shape = "BI" | "BU" | "BD" | "BT" | "BUD" | "AI";
interface TriggerSpec { readonly table: string; readonly name: string; readonly fn: string; readonly shape: Shape; readonly constraint: boolean }
const trg = (table: string, name: string, fn: string, shape: Shape, constraint = false): TriggerSpec => ({ table, name, fn, shape, constraint });
const immutable = (table: string): TriggerSpec[] => [trg(table, `${table}_immutable`, "reject_mutation", "BUD"), trg(table, `${table}_no_truncate`, "reject_mutation", "BT")];
const own = (table: string, suffix: string, shape: Shape, constraint = false) => trg(table, `${table}_${suffix}`, `${table}_${suffix}`, shape, constraint);
const EXPECTED_TRIGGERS: readonly TriggerSpec[] = [
  // 0002
  own("wallets", "insert_guard", "BI"), own("wallets", "update_guard", "BU"), trg("wallets", "wallets_no_delete", "reject_mutation", "BD"), trg("wallets", "wallets_no_truncate", "reject_mutation", "BT"),
  ...immutable("ledger_commands"), ...immutable("ledger_grant_sources"),
  own("ledger_entries", "check_command", "BI"), own("ledger_entries", "apply_to_wallet", "AI"), ...immutable("ledger_entries"),
  // 0003
  ...immutable("ledger_quote_lineages"), own("ledger_quotes", "check_version", "BI"), ...immutable("ledger_quotes"), own("ledger_quotes", "refuse_authorized_lineage", "BI"),
  trg("ledger_quotes", "ledger_quotes_check_allocation_sums", "ledger_quote_check_allocation_sums", "AI", true),
  ...immutable("ledger_quote_allocations"), trg("ledger_quote_allocations", "ledger_quote_allocations_check_sums", "ledger_quote_check_allocation_sums", "AI", true),
  // 0004
  own("promo_claims", "insert_guard", "BI"), own("promo_claims", "update_guard", "BU"), trg("promo_claims", "promo_claims_no_delete", "reject_mutation", "BD"), trg("promo_claims", "promo_claims_no_truncate", "reject_mutation", "BT"),
  own("promo_claim_events", "check", "BI"), own("promo_claim_events", "apply", "AI"), ...immutable("promo_claim_events"),
  // 0005
  own("ledger_authorizations", "check_insert", "BI"), ...immutable("ledger_authorizations"), own("ledger_authorizations", "check_complete", "AI", true),
  own("ledger_packages", "check_insert", "BI"), trg("ledger_packages", "ledger_packages_no_truncate", "reject_mutation", "BT"), // 0007 replaced ledger_packages_immutable
  own("credit_reservations", "check_insert", "BI"), own("credit_reservations", "update_guard", "BU"), trg("credit_reservations", "credit_reservations_no_delete", "reject_mutation", "BD"),
  trg("credit_reservations", "credit_reservations_no_truncate", "reject_mutation", "BT"), own("credit_reservations", "check_not_pending", "AI", true),
  own("ledger_entries", "bind_reservation", "BI"), own("ledger_entries", "apply_to_reservation", "AI"),
  // 0006
  ...immutable("vendor_cost_evidence"),
  // 0007
  ...immutable("ledger_package_events"), trg("ledger_packages", "ledger_packages_no_delete", "reject_mutation", "BD"), own("ledger_packages", "update_guard", "BU"),
  own("ledger_package_events", "bind", "BI"), own("ledger_package_events", "apply", "AI"), own("ledger_package_events", "check_complete", "AI", true),
  trg("refinement_slots", "refinement_slots_no_delete", "reject_mutation", "BD"), trg("refinement_slots", "refinement_slots_no_truncate", "reject_mutation", "BT"),
  own("refinement_slots", "insert_guard", "BI"), own("refinement_slots", "update_guard", "BU"),
  ...immutable("refinement_slot_events"), own("refinement_slot_events", "bind", "BI"), own("refinement_slot_events", "apply", "AI"), own("refinement_slot_events", "check_complete", "AI", true),
];
/** pg_trigger.tgtype bits: ROW 1, BEFORE 2, INSERT 4, DELETE 8, UPDATE 16, TRUNCATE 32. */
function tgtypeOf(shape: Shape): number {
  const events = shape.slice(1);
  return (events.includes("T") ? 0 : 1) | (shape[0] === "B" ? 2 : 0) | (events.includes("I") ? 4 : 0) | (events.includes("D") ? 8 : 0) | (events.includes("U") ? 16 : 0) | (events.includes("T") ? 32 : 0);
}
/** The only definer-rights functions the migrations create (privilege model B); every other function is invoker-rights. */
const EXPECTED_DEFINERS: ReadonlySet<string> = new Set(["ledger_entries_apply_to_wallet", "ledger_entries_apply_to_reservation", "ledger_package_events_apply", "refinement_slot_events_apply"]);

// ---- connection handling ---------------------------------------------------------------------------------------------------

type Row = Record<string, unknown>;
type Conn = LedgerConn & { query: LedgerQueryable["query"] };
/** Duck-typed like ledger-core: a pool (`connect`) or an object that hands out an exclusive connection (`acquire`). A bare Client is not accepted. */
async function acquireConn(db: LedgerDb): Promise<Conn> {
  try {
    if (typeof (db as { connect?: unknown }).connect === "function") {
      const client = await (db as unknown as { connect(): Promise<{ query: LedgerQueryable["query"]; on(e: "error", l: () => void): unknown; off(e: "error", l: () => void): unknown; release(destroy?: boolean): void }> }).connect();
      let broken = false; const onError = () => { broken = true; };
      client.on("error", onError);
      return { query: (text, values) => client.query(text, values), release: destroy => { client.off("error", onError); client.release(destroy || broken); } };
    }
    if (typeof (db as { acquire?: unknown }).acquire === "function") return await (db as { acquire(): Promise<Conn> }).acquire();
  } catch { throw new LedgerError("TRANSIENT"); } // nothing was sent; never surface the driver error (host, port, credentials hints)
  throw new LedgerError("INVALID_INPUT");
}
const TRANSIENT_SQLSTATES = new Set(["40001", "40P01", "55P03", "57014"]);
function mapFailure(error: unknown): LedgerError {
  if (error instanceof LedgerError) return error;
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  const sqlstate = typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
  return new LedgerError(sqlstate !== undefined && TRANSIENT_SQLSTATES.has(sqlstate) ? "TRANSIENT" : "DATABASE_ERROR", sqlstate); // never the driver message
}

/** One READ ONLY REPEATABLE READ transaction, always rolled back. Timeouts are set with set_config so every statement stays a SELECT. */
async function readSnapshot<T>(db: LedgerDb, work: (q: LedgerQueryable) => Promise<T>): Promise<T> {
  const conn = await acquireConn(db);
  let destroy = false;
  try {
    await conn.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await conn.query("SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true), set_config('idle_in_transaction_session_timeout', $3, true)",
      [`${STATEMENT_TIMEOUT_MS}ms`, `${LOCK_TIMEOUT_MS}ms`, `${IDLE_IN_TRANSACTION_TIMEOUT_MS}ms`]);
    const result = await work(conn);
    await conn.query("ROLLBACK");
    return result;
  } catch (error) {
    await conn.query("ROLLBACK").then(() => undefined, () => { destroy = true; });
    destroy = destroy || typeof (error as { severity?: unknown } | null)?.severity !== "string"; // no server report: the connection state is unknown, never reuse it
    throw mapFailure(error);
  } finally { conn.release?.(destroy); }
}

// ---- the checks -------------------------------------------------------------------------------------------------------------

const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
interface Collector { findings: InvariantFinding[]; truncated: Set<InvariantCode> }
/** Runs one finding query (it must end with `LIMIT $1`) and maps each row; one row beyond the cap marks the invariant truncated. */
async function collect(q: LedgerQueryable, into: Collector, invariant: InvariantCode, sql: string, map: (row: Row) => { userId?: unknown; subjectId?: unknown; detail: FindingDetail }) {
  const rows = (await q.query(sql, [MAX_FINDINGS_PER_CHECK + 1])).rows;
  if (rows.length > MAX_FINDINGS_PER_CHECK) into.truncated.add(invariant);
  for (const row of rows.slice(0, MAX_FINDINGS_PER_CHECK)) {
    const mapped = map(row);
    into.findings.push({ invariant, userId: text(mapped.userId), subjectId: text(mapped.subjectId), detail: mapped.detail });
  }
}

/**
 * ADR-0021 D14. Reports (never repairs): wallet bucket = sum of entry deltas; every entry sums to zero; no bucket out of range;
 * reserved bucket = sum of `reserved` hold_units; held bucket = sum of hold-state hold_units; consumed bucket = sum of settled
 * charge_units; each reservation's state and amounts match its entry trail; allocation sums; promo uniqueness and trail; any
 * registered synthetic grant source; and that every trigger the migrations create exists, is enabled and has the reviewed shape,
 * that no other trigger or rewrite rule exists on a ledger table, and that exactly the reviewed functions are definer-rights.
 */
export async function checkWalletInvariants(db: LedgerDb): Promise<WalletInvariantReport> {
  return readSnapshot(db, async q => {
    const at = (await q.query("SELECT now() AS at")).rows[0]?.["at"];
    const into: Collector = { findings: [], truncated: new Set() };

    await collect(q, into, "WALLET_BUCKET_MISMATCH", `
      SELECT w.user_id::text AS user_id,
        w.available_units::text AS available_actual, coalesce(e.da, 0)::text AS available_expected,
        w.reserved_units::text AS reserved_actual, coalesce(e.dr, 0)::text AS reserved_expected,
        w.held_for_review_units::text AS held_actual, coalesce(e.dh, 0)::text AS held_expected,
        w.consumed_units::text AS consumed_actual, coalesce(e.dc, 0)::text AS consumed_expected,
        w.revision::text AS revision_actual, coalesce(e.n, 0)::text AS revision_expected
      FROM ${S}.wallets w
      LEFT JOIN (SELECT user_id, sum(delta_available) AS da, sum(delta_reserved) AS dr, sum(delta_held) AS dh, sum(delta_consumed) AS dc, count(*) AS n
                 FROM ${S}.ledger_entries GROUP BY user_id) e ON e.user_id = w.user_id
      WHERE w.available_units <> coalesce(e.da, 0) OR w.reserved_units <> coalesce(e.dr, 0) OR w.held_for_review_units <> coalesce(e.dh, 0)
         OR w.consumed_units <> coalesce(e.dc, 0) OR w.revision <> coalesce(e.n, 0)
      ORDER BY w.user_id LIMIT $1`, row => ({
      userId: row["user_id"], subjectId: row["user_id"],
      detail: {
        availableActual: text(row["available_actual"]), availableExpected: text(row["available_expected"]), reservedActual: text(row["reserved_actual"]), reservedExpected: text(row["reserved_expected"]),
        heldActual: text(row["held_actual"]), heldExpected: text(row["held_expected"]), consumedActual: text(row["consumed_actual"]), consumedExpected: text(row["consumed_expected"]),
        revisionActual: text(row["revision_actual"]), revisionExpected: text(row["revision_expected"]),
      },
    }));

    await collect(q, into, "ENTRY_UNBALANCED", `
      SELECT e.entry_id::text AS entry_id, e.user_id::text AS user_id, e.entry_kind AS entry_kind,
        (e.delta_available::numeric + e.delta_reserved::numeric + e.delta_held::numeric + e.delta_consumed::numeric + e.delta_external::numeric)::text AS imbalance
      FROM ${S}.ledger_entries e
      WHERE e.delta_available::numeric + e.delta_reserved::numeric + e.delta_held::numeric + e.delta_consumed::numeric + e.delta_external::numeric <> 0
      ORDER BY e.created_at, e.entry_id LIMIT $1`, row => ({ userId: row["user_id"], subjectId: row["entry_id"], detail: { entryKind: text(row["entry_kind"]), imbalance: text(row["imbalance"]) } }));

    await collect(q, into, "WALLET_BUCKET_OUT_OF_RANGE", `
      SELECT w.user_id::text AS user_id, w.available_units::text AS available, w.reserved_units::text AS reserved, w.held_for_review_units::text AS held, w.consumed_units::text AS consumed
      FROM ${S}.wallets w
      WHERE w.available_units < 0 OR w.reserved_units < 0 OR w.held_for_review_units < 0 OR w.consumed_units < 0
         OR w.available_units > ${MAX_SAFE} OR w.reserved_units > ${MAX_SAFE} OR w.held_for_review_units > ${MAX_SAFE} OR w.consumed_units > ${MAX_SAFE}
      ORDER BY w.user_id LIMIT $1`, row => ({ userId: row["user_id"], subjectId: row["user_id"], detail: { available: text(row["available"]), reserved: text(row["reserved"]), held: text(row["held"]), consumed: text(row["consumed"]) } }));

    const bucketVsReservations = (invariant: InvariantCode, column: string, aggregate: string) => collect(q, into, invariant, `
      SELECT w.user_id::text AS user_id, w.${column}::text AS actual, coalesce(x.total, 0)::text AS expected
      FROM ${S}.wallets w
      LEFT JOIN (SELECT r.user_id, ${aggregate} AS total FROM ${S}.credit_reservations r GROUP BY r.user_id) x ON x.user_id = w.user_id
      WHERE w.${column} <> coalesce(x.total, 0)
      ORDER BY w.user_id LIMIT $1`, row => ({ userId: row["user_id"], subjectId: row["user_id"], detail: { actual: text(row["actual"]), expected: text(row["expected"]) } }));
    await bucketVsReservations("RESERVED_BUCKET_MISMATCH", "reserved_units", "sum(r.hold_units) FILTER (WHERE r.state = 'reserved')");
    await bucketVsReservations("HELD_BUCKET_MISMATCH", "held_for_review_units", "sum(r.hold_units) FILTER (WHERE r.state = 'reconciliation_hold')");
    await bucketVsReservations("CONSUMED_BUCKET_MISMATCH", "consumed_units", "sum(r.charge_units) FILTER (WHERE r.state = 'settled')");

    // Reservation state and amounts against the entry trail. A committed authorization_requested is itself a violation (0005 defers a check that forbids it).
    await collect(q, into, "RESERVATION_TRAIL_MISMATCH", `
      WITH t AS (
        SELECT r.reservation_id, r.user_id, r.state,
          count(e.entry_id) FILTER (WHERE e.entry_kind = 'reserve')::int AS n_reserve,
          count(e.entry_id) FILTER (WHERE e.entry_kind = 'release')::int AS n_release,
          count(e.entry_id) FILTER (WHERE e.entry_kind = 'settle')::int AS n_settle,
          count(e.entry_id) FILTER (WHERE e.entry_kind = 'hold')::int AS n_hold,
          count(e.entry_id) FILTER (WHERE e.entry_kind NOT IN ('reserve', 'release', 'settle', 'hold') OR e.user_id <> r.user_id OR NOT (CASE e.entry_kind
            WHEN 'reserve' THEN e.delta_reserved = r.hold_units AND e.delta_available = -r.hold_units AND e.delta_held = 0 AND e.delta_consumed = 0
            WHEN 'release' THEN e.delta_available = r.hold_units AND e.delta_reserved = -r.hold_units AND e.delta_held = 0 AND e.delta_consumed = 0
            WHEN 'settle'  THEN e.delta_reserved = -r.hold_units AND e.delta_consumed = r.charge_units AND e.delta_available = r.hold_units - r.charge_units AND e.delta_held = 0
            WHEN 'hold'    THEN e.delta_reserved = -r.hold_units AND e.delta_held = r.hold_units AND e.delta_available = 0 AND e.delta_consumed = 0
            ELSE false END))::int AS n_bad_amount
        FROM ${S}.credit_reservations r LEFT JOIN ${S}.ledger_entries e ON e.reservation_id = r.reservation_id
        GROUP BY r.reservation_id, r.user_id, r.state, r.hold_units, r.charge_units
      ), x AS (
        SELECT t.*, CASE
          WHEN n_reserve = 0 AND n_release + n_settle + n_hold = 0 THEN 'authorization_requested'
          WHEN n_reserve = 1 AND n_release = 0 AND n_settle = 0 AND n_hold = 0 THEN 'reserved'
          WHEN n_reserve = 1 AND n_release = 1 AND n_settle = 0 AND n_hold = 0 THEN 'released'
          WHEN n_reserve = 1 AND n_release = 0 AND n_settle = 1 AND n_hold = 0 THEN 'settled'
          WHEN n_reserve = 1 AND n_release = 0 AND n_settle = 0 AND n_hold = 1 THEN 'reconciliation_hold'
          ELSE NULL END AS expected_state
        FROM t)
      SELECT reservation_id::text AS reservation_id, user_id::text AS user_id, state, expected_state, n_reserve, n_release, n_settle, n_hold, n_bad_amount
      FROM x WHERE expected_state IS DISTINCT FROM state OR n_bad_amount > 0 OR state = 'authorization_requested'
      ORDER BY reservation_id LIMIT $1`, row => ({
      userId: row["user_id"], subjectId: row["reservation_id"],
      detail: {
        reason: row["state"] === "authorization_requested" ? "committed_authorization_requested" : Number(row["n_bad_amount"]) > 0 ? "entry_amount_mismatch" : "state_trail_mismatch",
        state: text(row["state"]), expectedState: text(row["expected_state"]), reserveEntries: text(row["n_reserve"]), releaseEntries: text(row["n_release"]),
        settleEntries: text(row["n_settle"]), holdEntries: text(row["n_hold"]), mismatchedEntries: text(row["n_bad_amount"]),
      },
    }));

    // Allocation sums per quote version (0003 enforces them with deferred triggers; this re-derives them independently).
    await collect(q, into, "ALLOCATION_SUM_MISMATCH", `
      SELECT q.quote_version_id AS quote_version_id, q.user_id::text AS user_id, q.operation_kind AS operation_kind,
        q.max_charge_units::text AS hold_quoted, q.credits_quoted::text AS charge_quoted,
        count(a.operation_index)::int AS allocations, coalesce(sum(a.hold_units), 0)::text AS hold_sum, coalesce(sum(a.charge_units), 0)::text AS charge_sum
      FROM ${S}.ledger_quotes q LEFT JOIN ${S}.ledger_quote_allocations a ON a.quote_version_id = q.quote_version_id
      GROUP BY q.quote_version_id, q.user_id, q.operation_kind, q.max_charge_units, q.credits_quoted
      HAVING CASE WHEN q.operation_kind = 'promo_single_preview' THEN count(a.operation_index) <> 0
                  ELSE count(a.operation_index) = 0 OR max(a.operation_index) <> count(a.operation_index) - 1
                       OR sum(a.hold_units) <> q.max_charge_units OR sum(a.charge_units) <> q.credits_quoted END
      ORDER BY q.quote_version_id LIMIT $1`, row => ({
      userId: row["user_id"], subjectId: row["quote_version_id"],
      detail: { operationKind: text(row["operation_kind"]), allocations: text(row["allocations"]), holdQuoted: text(row["hold_quoted"]), holdSum: text(row["hold_sum"]), chargeQuoted: text(row["charge_quoted"]), chargeSum: text(row["charge_sum"]) },
    }));

    // An authorization reserves exactly its quote's allocations, unit for unit (TypeScript checks the sums too; 0005 defers a count check).
    await collect(q, into, "AUTHORIZATION_ALLOCATION_MISMATCH", `
      SELECT * FROM (
        SELECT la.authorization_id::text AS authorization_id, la.user_id::text AS user_id, la.operation_kind AS operation_kind,
          (SELECT count(*) FROM ${S}.ledger_quote_allocations a WHERE a.quote_version_id = la.quote_version_id)::int AS allocations,
          (SELECT count(*) FROM ${S}.credit_reservations r WHERE r.authorization_id = la.authorization_id)::int AS reservations,
          (SELECT coalesce(sum(a.hold_units), 0) FROM ${S}.ledger_quote_allocations a WHERE a.quote_version_id = la.quote_version_id)::text AS hold_allocated,
          (SELECT coalesce(sum(r.hold_units), 0) FROM ${S}.credit_reservations r WHERE r.authorization_id = la.authorization_id)::text AS hold_reserved,
          (SELECT coalesce(sum(a.charge_units), 0) FROM ${S}.ledger_quote_allocations a WHERE a.quote_version_id = la.quote_version_id)::text AS charge_allocated,
          (SELECT coalesce(sum(r.charge_units), 0) FROM ${S}.credit_reservations r WHERE r.authorization_id = la.authorization_id)::text AS charge_reserved,
          (SELECT count(*) FROM ${S}.credit_reservations r JOIN ${S}.ledger_quote_allocations a ON a.quote_version_id = r.quote_version_id AND a.operation_index = r.operation_index
             WHERE r.authorization_id = la.authorization_id AND (r.hold_units <> a.hold_units OR r.charge_units <> a.charge_units))::int AS unit_differences,
          (SELECT count(*) FROM ${S}.ledger_packages p WHERE p.authorization_id = la.authorization_id)::int AS packages
        FROM ${S}.ledger_authorizations la) z
      WHERE allocations = 0 OR allocations <> reservations OR hold_allocated <> hold_reserved OR charge_allocated <> charge_reserved OR unit_differences <> 0
         OR packages <> CASE WHEN operation_kind = 'concept_bundle_3x2' THEN 1 ELSE 0 END
      ORDER BY authorization_id LIMIT $1`, row => ({
      userId: row["user_id"], subjectId: row["authorization_id"],
      detail: {
        operationKind: text(row["operation_kind"]), allocations: text(row["allocations"]), reservations: text(row["reservations"]), holdAllocated: text(row["hold_allocated"]),
        holdReserved: text(row["hold_reserved"]), chargeAllocated: text(row["charge_allocated"]), chargeReserved: text(row["charge_reserved"]), unitDifferences: text(row["unit_differences"]), packages: text(row["packages"]),
      },
    }));

    // Promo uniqueness (one claim per verified identity, per user and per operation) re-derived without trusting the unique constraints.
    await collect(q, into, "PROMO_UNIQUENESS_VIOLATED", `
      SELECT key_kind, claims, n FROM (
        SELECT 'identity' AS key_kind, string_agg(claim_id::text, ',' ORDER BY claim_id) AS claims, count(*)::int AS n FROM ${S}.promo_claims GROUP BY issuer, subject HAVING count(*) > 1
        UNION ALL SELECT 'user', string_agg(claim_id::text, ',' ORDER BY claim_id), count(*)::int FROM ${S}.promo_claims GROUP BY user_id HAVING count(*) > 1
        UNION ALL SELECT 'operation', string_agg(claim_id::text, ',' ORDER BY claim_id), count(*)::int FROM ${S}.promo_claims GROUP BY operation_id HAVING count(*) > 1) d
      ORDER BY key_kind, claims LIMIT $1`, row => ({ subjectId: row["claims"], detail: { keyKind: text(row["key_kind"]), claims: text(row["claims"]), count: text(row["n"]) } }));

    await collect(q, into, "PROMO_CLAIM_TRAIL_MISMATCH", `
      SELECT * FROM (
        SELECT c.claim_id::text AS claim_id, c.user_id::text AS user_id, c.state AS state, c.event_seq::int AS event_seq,
          (SELECT count(*) FROM ${S}.promo_claim_events e WHERE e.claim_id = c.claim_id)::int AS events,
          coalesce((SELECT e.to_state FROM ${S}.promo_claim_events e WHERE e.claim_id = c.claim_id ORDER BY e.seq DESC LIMIT 1), 'eligible') AS trail_state
        FROM ${S}.promo_claims c) z
      WHERE event_seq <> events OR state <> trail_state
      ORDER BY claim_id LIMIT $1`, row => ({ userId: row["user_id"], subjectId: row["claim_id"], detail: { state: text(row["state"]), trailState: text(row["trail_state"]), eventSeq: text(row["event_seq"]), events: text(row["events"]) } }));

    // D12: a registered synthetic grant source is a finding on any database that is not a disposable test database.
    await collect(q, into, "SYNTHETIC_GRANT_SOURCE_REGISTERED", `
      SELECT s.grant_source_id::text AS grant_source_id, count(e.entry_id)::int AS grants, coalesce(sum(e.delta_available), 0)::text AS granted_units
      FROM ${S}.ledger_grant_sources s LEFT JOIN ${S}.ledger_entries e ON e.grant_source_id = s.grant_source_id AND e.entry_kind = 'grant'
      WHERE s.kind = 'synthetic_test' GROUP BY s.grant_source_id ORDER BY s.grant_source_id LIMIT $1`,
    row => ({ subjectId: row["grant_source_id"], detail: { grants: text(row["grants"]), grantedUnits: text(row["granted_units"]) } }));

    await checkTriggers(q, into);
    await checkFunctions(q, into);
    return { ok: into.findings.length === 0, checkedAt: (at instanceof Date ? at : new Date(String(at))).toISOString(), findings: into.findings, truncated: [...into.truncated] };
  });
}

async function checkTriggers(q: LedgerQueryable, into: Collector) {
  const rows = (await q.query(`
    SELECT c.relname::text AS table_name, t.tgname::text AS name, p.proname::text AS fn, pn.nspname::text AS fn_schema, t.tgtype::int AS tgtype, t.tgenabled::text AS enabled,
      (t.tgconstraint <> 0) AS is_constraint, t.tgdeferrable AS deferrable, t.tginitdeferred AS initially_deferred
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid = p.pronamespace
    WHERE n.nspname = '${S}' AND NOT t.tgisinternal ORDER BY c.relname, t.tgname`)).rows;
  const found = new Map(rows.map(r => [`${String(r["table_name"])}.${String(r["name"])}`, r]));
  for (const spec of EXPECTED_TRIGGERS) {
    const key = `${spec.table}.${spec.name}`, row = found.get(key);
    const detail = { table: spec.table, trigger: spec.name };
    if (!row) { into.findings.push({ invariant: "TRIGGER_MISSING", userId: null, subjectId: key, detail }); continue; }
    found.delete(key);
    const enabled = String(row["enabled"]);
    // 'O' fires in the origin and local replication modes, 'A' always. 'R' (replica only) and 'D' (disabled) leave the ledger unguarded.
    if (enabled !== "O" && enabled !== "A") into.findings.push({ invariant: "TRIGGER_DISABLED", userId: null, subjectId: key, detail: { ...detail, state: enabled } });
    const shapeOk = Number(row["tgtype"]) === tgtypeOf(spec.shape) && String(row["fn"]) === spec.fn && String(row["fn_schema"]) === S && Boolean(row["is_constraint"]) === spec.constraint
      && (!spec.constraint || (row["deferrable"] === true && row["initially_deferred"] === true));
    if (!shapeOk) into.findings.push({ invariant: "TRIGGER_MISMATCH", userId: null, subjectId: key, detail: { ...detail, function: `${String(row["fn_schema"])}.${String(row["fn"])}`, expectedFunction: `${S}.${spec.fn}` } });
  }
  for (const [key, row] of found) into.findings.push({ invariant: "TRIGGER_UNEXPECTED", userId: null, subjectId: key, detail: { table: text(row["table_name"]), trigger: text(row["name"]) } });
  // A rewrite rule can redirect or swallow a write without any trigger firing.
  for (const row of (await q.query(`SELECT tablename::text AS table_name, rulename::text AS name FROM pg_catalog.pg_rules WHERE schemaname = '${S}' ORDER BY tablename, rulename`)).rows)
    into.findings.push({ invariant: "RULE_UNEXPECTED", userId: null, subjectId: `${String(row["table_name"])}.${String(row["name"])}`, detail: { table: text(row["table_name"]), rule: text(row["name"]) } });
}

async function checkFunctions(q: LedgerQueryable, into: Collector) {
  const rows = (await q.query(`
    SELECT p.proname::text AS name, p.prosecdef AS definer, (coalesce(p.proconfig, '{}'::text[]) @> ARRAY['search_path=pg_catalog, pg_temp']::text[]) AS pinned
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = '${S}' ORDER BY p.proname`)).rows;
  const present = new Set<string>();
  for (const row of rows) {
    const name = String(row["name"]);
    present.add(name);
    const definer = row["definer"] === true;
    if (definer !== EXPECTED_DEFINERS.has(name)) into.findings.push({ invariant: "FUNCTION_PRIVILEGE_MISMATCH", userId: null, subjectId: name, detail: { securityDefiner: definer, expectedSecurityDefiner: EXPECTED_DEFINERS.has(name) } });
    if (row["pinned"] !== true) into.findings.push({ invariant: "FUNCTION_SEARCH_PATH_UNPINNED", userId: null, subjectId: name, detail: {} });
  }
  for (const name of EXPECTED_DEFINERS) if (!present.has(name)) into.findings.push({ invariant: "FUNCTION_PRIVILEGE_MISMATCH", userId: null, subjectId: name, detail: { securityDefiner: null, expectedSecurityDefiner: true } });
}

// ---- orphaned reservations --------------------------------------------------------------------------------------------------

/**
 * ADR-0021 D14, D6. Report-only: never mutates, never releases (a never-dispatched reservation stays `reserved` for a human; Q9),
 * never resolves a hold. `olderThan` is REQUIRED and has no default; anything newer than it is not reported. Classes:
 * `reserved_never_dispatched` (reserved, no workflow reference), `reserved_dispatch_stale` (reserved with a workflow reference, no
 * terminal entry yet), `hold_present` (reconciliation_hold; its age is the hold entry's). Evidence kinds, workflow references and
 * idempotency keys are not read.
 */
export async function findOrphanedReservations(db: LedgerDb, options: FindOrphanedReservationsOptions): Promise<OrphanReport> {
  const olderThan = (options as { olderThan?: unknown } | null | undefined)?.olderThan;
  if (!(olderThan instanceof Date) || Number.isNaN(olderThan.getTime())) throw new LedgerError("INVALID_INPUT"); // before any SQL; there is no default cut-off
  const cutoff = olderThan.toISOString();
  return readSnapshot(db, async q => {
    const rows = (await q.query(`
      WITH hold_at AS (SELECT e.reservation_id, min(e.created_at) AS at FROM ${S}.ledger_entries e WHERE e.entry_kind = 'hold' GROUP BY e.reservation_id)
      SELECT r.reservation_id::text AS reservation_id, r.user_id::text AS user_id, r.operation_id AS operation_id, r.operation_kind AS operation_kind, r.state AS state,
        r.hold_units::text AS hold_units, r.charge_units::text AS charge_units, (r.workflow_ref IS NOT NULL) AS dispatched, r.created_at AS reserved_at,
        CASE WHEN r.state = 'reserved' AND r.workflow_ref IS NULL THEN 'reserved_never_dispatched' WHEN r.state = 'reserved' THEN 'reserved_dispatch_stale' ELSE 'hold_present' END AS orphan_class
      FROM ${S}.credit_reservations r LEFT JOIN hold_at h ON h.reservation_id = r.reservation_id
      WHERE (r.state = 'reserved' AND r.created_at < $1::timestamptz) OR (r.state = 'reconciliation_hold' AND coalesce(h.at, r.created_at) < $1::timestamptz)
      ORDER BY r.created_at, r.reservation_id LIMIT $2`, [cutoff, MAX_FINDINGS_PER_CHECK + 1])).rows;
    return {
      olderThan: cutoff,
      truncated: rows.length > MAX_FINDINGS_PER_CHECK,
      orphans: rows.slice(0, MAX_FINDINGS_PER_CHECK).map((row): OrphanedReservation => ({
        reservationId: String(row["reservation_id"]), userId: String(row["user_id"]), operationId: String(row["operation_id"]), operationKind: String(row["operation_kind"]),
        state: row["state"] === "reserved" ? "reserved" : "reconciliation_hold", orphanClass: String(row["orphan_class"]) as OrphanClass,
        holdUnits: parseSafeUnits(row["hold_units"]), chargeUnits: parseSafeUnits(row["charge_units"]), dispatched: row["dispatched"] === true,
        reservedAt: (row["reserved_at"] as Date).toISOString(),
      })),
    };
  });
}
