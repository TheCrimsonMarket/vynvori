import "server-only";
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { CompositionSceneV1Schema, sceneSourceHashes, type PreflightIssue, type PrintProfileV1 } from "@vynvori/contracts";
import type {
  ArtifactScanStatus, AssetRecord, CompositionAccess, CompositionRecord, CompositionStore, CreateGuestOutcome, DownloadGrantRecord, InsertAssetOutcome, RateLimitOperation,
  ScanAttemptRecord, ScanEventRecord, ScanResultEvent, ScanTransitionOutcome, VersionRecord,
} from "@vynvori/contracts/composition-port";

const S = "vynvori_composition", I = "vynvori_identity";
// biome-ignore lint/suspicious/noExplicitAny: rows come back from loosely typed SQL results
type Row = Record<string, any>;

/**
 * Access predicate used verbatim in every statement so authorisation happens in SQL, never after the fact.
 * owner: the composition belongs to the verified user. guest: composition still unowned AND the capability hash matches AND the
 * M1b guest draft is unexpired AND unclaimed. Absent, foreign, expired and claimed all look identical (no rows).
 */
function allowed(access: CompositionAccess, alias: string, params: unknown[], now: Date): string {
  if (access.kind === "owner") { params.push(access.userId); return `${alias}.owner_user_id = $${params.length}`; }
  params.push(access.capabilityHash, now);
  return `(${alias}.owner_user_id IS NULL AND EXISTS (SELECT 1 FROM ${I}.guest_drafts gd WHERE gd.id = ${alias}.guest_draft_id
    AND gd.capability_hash = $${params.length - 1} AND gd.expires_at > $${params.length} AND gd.owner_id IS NULL))`;
}

/**
 * Current scan status of asset alias `a`: the to_status of its highest seq, or "pending" when no event exists (ADR-0022 D3).
 * Scan results belong to one (composition, asset) row and are never shared across compositions, even for identical bytes.
 */
const scanStatusOf = (alias: string) => `COALESCE((SELECT e.to_status FROM ${S}.asset_scan_events e WHERE e.asset_id = ${alias}.id
  AND e.composition_id = ${alias}.composition_id ORDER BY e.seq DESC LIMIT 1), 'pending')`;
const ASSET = `SELECT a.*, ${scanStatusOf("a")} AS scan_status FROM ${S}.assets a`;

const SCAN_STATUSES: readonly ArtifactScanStatus[] = ["pending", "clean", "quarantined", "unknown"];
const isScanStatus = (value: unknown): value is ArtifactScanStatus => (SCAN_STATUSES as readonly unknown[]).includes(value);
/** Mirrors the 0002 `check_scan_event` trigger (defence in depth: the store refuses first, and the trigger refuses anyway). */
const SCAN_EDGES: Readonly<Record<ArtifactScanStatus, readonly ArtifactScanStatus[]>> = { pending: ["clean", "quarantined", "unknown"], unknown: ["pending"], clean: ["quarantined"], quarantined: [] };
const RATE_OPERATIONS: readonly RateLimitOperation[] = ["GUEST_CREATE_GLOBAL", "ASSET_UPLOAD_GLOBAL", "GUEST_WRITE", "GUEST_ASSET_UPLOAD", "GUEST_DOWNLOAD_GRANT", "GUEST_RESCAN", "OWNER_WRITE", "OWNER_ASSET_UPLOAD", "OWNER_DOWNLOAD_GRANT", "OWNER_RESCAN"];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, hex64 = /^[a-f0-9]{64}$/, reasonCodePattern = /^[a-z][a-z0-9_]*$/;
const isId = (value: unknown): value is string => typeof value === "string" && uuid.test(value);
const isDate = (value: unknown): value is Date => value instanceof Date && Number.isFinite(value.getTime());
/**
 * Structural ceilings (engineering constants, not policy; ADR-0022 C3b): the PostgreSQL `integer` range that the rate statement casts
 * to, and a length cap on scanner-reported text so append-only tables cannot be filled with arbitrarily large strings.
 */
const PG_INTEGER_MAX = 2147483647, SCAN_TEXT_MAX = 512;
const isText = (value: unknown): value is string => typeof value === "string" && value.trim() !== "" && value === value.trim() && value.length <= SCAN_TEXT_MAX;
const isPositiveInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= PG_INTEGER_MAX;
/** Policy maxima that are compared in JavaScript (not cast to a PostgreSQL integer): any positive safe integer. Unset or zero is never "unlimited". */
const isSafePositive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const isReason = (value: unknown): value is string => typeof value === "string" && value.length <= SCAN_TEXT_MAX && reasonCodePattern.test(value);
/** Programming errors (malformed ids, unset or non-positive policy, a lease or expiry not after `now`) throw. Nothing defaults. */
function invalid(what: string): never { throw new RangeError(`composition store: invalid ${what}`); }
function assertScanResult(result: ScanResultEvent): void {
  if (result?.toStatus === "clean" || result?.toStatus === "quarantined") {
    if (![result.scannerId, result.engineVersion, result.definitionsVersion, result.evidenceRef].every(isText)) invalid("scan evidence");
  } else if (result?.toStatus === "unknown") {
    if (!isReason(result.reasonCode) || (result.scannerId !== undefined && !isText(result.scannerId))) invalid("scan reason");
  } else invalid("scan result");
}
/** The principal a grant is bound to: SHA-256 of the verified user id, or the guest capability hash (ADR-0022 D4). */
export function grantPrincipal(access: CompositionAccess): { kind: "owner" | "guest"; hash: string } {
  return access.kind === "owner" ? { kind: "owner", hash: createHash("sha256").update(access.userId).digest("hex") } : { kind: "guest", hash: access.capabilityHash };
}

const record = (row: Row): CompositionRecord => ({
  id: row.id, ownerUserId: row.owner_user_id, lifecycleState: row.lifecycle_state, scene: CompositionSceneV1Schema.parse(row.draft_scene),
  sceneSha256: row.draft_scene_sha256, draftRevision: row.draft_revision, currentVersionId: row.current_version_id,
  currentVersionSceneSha256: row.current_version_scene_sha256 ?? null, printProfileId: row.print_profile_id, printProfileVersion: row.print_profile_version,
  createdAt: row.created_at, updatedAt: row.updated_at, guestExpiresAt: row.owner_user_id ? null : row.guest_expires_at ?? null,
});
const asset = (row: Row): AssetRecord => {
  if (!isScanStatus(row.scan_status)) throw new Error("asset row read without its scan status"); // every asset query joins the status
  return { id: row.id, compositionId: row.composition_id, sha256: row.sha256, mime: row.mime, byteSize: row.byte_size, widthPx: row.width_px, heightPx: row.height_px, objectKey: row.object_key, createdAt: row.created_at, scanStatus: row.scan_status };
};
const version = (row: Row): VersionRecord => ({
  id: row.id, compositionId: row.composition_id, versionNo: row.version_no, scene: CompositionSceneV1Schema.parse(row.scene), sceneSha256: row.scene_sha256,
  printProfileId: row.print_profile_id, printProfileVersion: row.print_profile_version, preflightState: row.preflight_state, preflightIssues: row.preflight_issues as PreflightIssue[], frozenAt: row.frozen_at,
});
const scanEvent = (row: Row): ScanEventRecord => ({
  assetId: row.asset_id, compositionId: row.composition_id, seq: row.seq, fromStatus: row.from_status, toStatus: row.to_status, assetSha256: row.asset_sha256,
  attemptId: row.attempt_id, scannerId: row.scanner_id, engineVersion: row.engine_version, definitionsVersion: row.definitions_version, evidenceRef: row.evidence_ref,
  reasonCode: row.reason_code, recordedAt: row.recorded_at,
});
const scanAttempt = (row: Row): ScanAttemptRecord => ({
  attemptId: row.attempt_id, assetId: row.asset_id, compositionId: row.composition_id, startedAt: row.started_at, leaseExpiresAt: row.lease_expires_at, finishedAt: row.finished_at, outcome: row.outcome,
});
/** Never exposes token_hash or principal_hash. */
const grant = (row: Row): DownloadGrantRecord => ({
  grantId: row.grant_id, assetId: row.asset_id, compositionId: row.composition_id, principalKind: row.principal_kind, issuedAt: row.issued_at, expiresAt: row.expires_at, redeemedAt: row.redeemed_at,
});
const COMPOSITION = `SELECT c.*, v.scene_sha256 AS current_version_scene_sha256, gd0.expires_at AS guest_expires_at
  FROM ${S}.compositions c LEFT JOIN ${S}.composition_versions v ON v.id = c.current_version_id AND v.composition_id = c.id
  LEFT JOIN ${I}.guest_drafts gd0 ON gd0.id = c.guest_draft_id`;

/**
 * Lock helpers (ADR-0022 D8, RR-2). They call the 0002 SQL functions, which build the class-4 single-bigint key with the explicit
 * unsigned mask and take the composition lock BEFORE the asset lock by construction. Transaction-scoped only
 * (`pg_advisory_xact_lock`): they accept only a client inside this store's `transaction()`; there is no session-level variant.
 */
export type CompositionTx = PoolClient & { readonly __compositionTransaction: true };
/** Clients currently inside `withCompositionTransaction`. Outside a transaction block an xact lock would be released at once. */
const openTransactions = new WeakSet<PoolClient>();
function assertInTransaction(tx: PoolClient): void { if (!openTransactions.has(tx)) throw new Error("composition lock helpers need an open composition transaction"); }
export async function lockComposition(tx: CompositionTx, compositionId: string): Promise<void> { assertInTransaction(tx); await tx.query(`SELECT ${S}.m3_lock_composition($1::uuid)`, [compositionId]); }
export async function lockAsset(tx: CompositionTx, compositionId: string, assetId: string): Promise<void> { assertInTransaction(tx); await tx.query(`SELECT ${S}.m3_lock_asset($1::uuid, $2::uuid)`, [compositionId, assetId]); }
/**
 * Global serialisation of the live-guest-draft cap (ADR-0022 D2, C4). A class-4 transaction lock keyed by one fixed subject string,
 * built by the same SQL helper as the per-subject locks (unsigned mask included). `createGuest` takes this lock and nothing else, so
 * it can never take part in a lock cycle; a `hashtext` collision with another subject only adds harmless waiting.
 */
const LIVE_GUEST_CAP_SUBJECT = "m3:live-guest-drafts";
export async function lockLiveGuestCap(tx: CompositionTx): Promise<void> { assertInTransaction(tx); await tx.query(`SELECT pg_advisory_xact_lock(${S}.m3_lock_key_from_hash(hashtext($1)))`, [LIVE_GUEST_CAP_SUBJECT]); }
/** Unexpired, unclaimed, unowned guest compositions at `now`: the same population the guest access predicate admits. */
async function liveGuestDrafts(runner: Pick<Pool, "query">, now: Date): Promise<number> {
  const result = await runner.query(`SELECT count(*)::integer AS n FROM ${S}.compositions c JOIN ${I}.guest_drafts gd ON gd.id = c.guest_draft_id
    WHERE c.owner_user_id IS NULL AND c.guest_draft_id IS NOT NULL AND gd.expires_at > $1 AND gd.owner_id IS NULL`, [now]);
  return result.rows[0].n as number;
}
/** The only way to obtain a `CompositionTx`: BEGIN, run `work`, COMMIT (ROLLBACK on error), and release the client. */
export async function withCompositionTransaction<T>(pool: Pool, work: (tx: CompositionTx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN"); openTransactions.add(client);
    const result = await work(client as CompositionTx);
    openTransactions.delete(client); await client.query("COMMIT"); return result;
  } catch (error) { openTransactions.delete(client); await client.query("ROLLBACK").catch(() => {}); throw error; }
  finally { client.release(); }
}
/** A unique-key collision on a caller-chosen id surfaces as a RangeError, never as a raw driver error echoing key values. */
async function insertOnce<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (error) { if ((error as { code?: string })?.code === "23505") invalid("duplicate id"); throw error; }
}

export function compositionStore(pool: Pool): CompositionStore {
  const transaction = <T>(work: (client: CompositionTx) => Promise<T>) => withCompositionTransaction(pool, work);
  async function read(runner: Pick<Pool, "query">, id: string, access: CompositionAccess, now: Date, lock = ""): Promise<CompositionRecord | null> {
    const params: unknown[] = [id], predicate = allowed(access, "c", params, now);
    const result = await runner.query(`${COMPOSITION} WHERE c.id = $1 AND ${predicate}${lock}`, params);
    return result.rows[0] ? record(result.rows[0]) : null;
  }
  /** Pinned hashes that are missing or not `clean`, read after taking each asset's lock (composition lock first, ids sorted). */
  async function uncleanPins(tx: CompositionTx, compositionId: string, pins: readonly string[]): Promise<string[]> {
    const wanted = [...new Set(pins)].sort();
    if (!wanted.length) return [];
    const ids = (await tx.query(`SELECT id FROM ${S}.assets WHERE composition_id=$1 AND sha256 = ANY($2::text[]) ORDER BY id`, [compositionId, wanted])).rows;
    for (const { id } of ids) await lockAsset(tx, compositionId, id);
    const rows = (await tx.query(`${ASSET} WHERE a.composition_id=$1 AND a.sha256 = ANY($2::text[])`, [compositionId, wanted])).rows;
    const clean = new Set(rows.filter(r => r.scan_status === "clean").map(r => r.sha256 as string));
    return wanted.filter(hash => !clean.has(hash));
  }
  /** The asset with its current scan status, only if `access` passes the predicate at `now`. */
  async function accessibleAsset(runner: Pick<Pool, "query">, compositionId: string, assetId: string, access: CompositionAccess, now: Date): Promise<Row | null> {
    const params: unknown[] = [compositionId, assetId], predicate = allowed(access, "c", params, now);
    return (await runner.query(`${ASSET} JOIN ${S}.compositions c ON c.id=a.composition_id WHERE a.composition_id=$1 AND a.id=$2 AND ${predicate}`, params)).rows[0] ?? null;
  }
  /**
   * Access check, then the per-asset lock, then the authoritative re-read under the lock. A caller without access never takes a
   * lock. `work` receives the row read under the lock, so the status it sees cannot change before commit.
   */
  async function underAssetLock<T>(compositionId: string, assetId: string, access: CompositionAccess, now: Date, work: (tx: CompositionTx, row: Row) => Promise<T>): Promise<T | { status: "not_found" }> {
    if (!isId(compositionId) || !isId(assetId)) return { status: "not_found" };
    return transaction(async tx => {
      if (!(await accessibleAsset(tx, compositionId, assetId, access, now))) return { status: "not_found" as const };
      await lockAsset(tx, compositionId, assetId);
      const row = await accessibleAsset(tx, compositionId, assetId, access, now);
      return row ? work(tx, row) : { status: "not_found" as const };
    });
  }
  async function openAttempt(tx: CompositionTx, compositionId: string, assetId: string, attemptId?: string): Promise<Row | undefined> {
    const params: unknown[] = [compositionId, assetId];
    if (attemptId) params.push(attemptId);
    return (await tx.query(`SELECT * FROM ${S}.asset_scan_attempts WHERE composition_id=$1 AND asset_id=$2 AND finished_at IS NULL${attemptId ? " AND attempt_id=$3" : ""}`, params)).rows[0];
  }
  /** Appends the next event (seq + 1, from = the status read under the lock the caller holds); the 0002 trigger re-verifies it all. */
  async function appendEvent(tx: CompositionTx, row: Row, now: Date, event: { toStatus: ArtifactScanStatus; attemptId: string | null; scannerId?: string | null; engineVersion?: string | null; definitionsVersion?: string | null; evidenceRef?: string | null; reasonCode?: string | null }): Promise<ScanEventRecord> {
    const last = (await tx.query(`SELECT seq FROM ${S}.asset_scan_events WHERE asset_id=$1 ORDER BY seq DESC LIMIT 1`, [row.id])).rows[0];
    const inserted = await tx.query(`INSERT INTO ${S}.asset_scan_events(asset_id,composition_id,seq,from_status,to_status,asset_sha256,attempt_id,scanner_id,engine_version,definitions_version,evidence_ref,reason_code,recorded_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`, [row.id, row.composition_id, (last?.seq ?? 0) + 1, row.scan_status, event.toStatus, row.sha256, event.attemptId,
      event.scannerId ?? null, event.engineVersion ?? null, event.definitionsVersion ?? null, event.evidenceRef ?? null, event.reasonCode ?? null, now]);
    return scanEvent(inserted.rows[0]);
  }
  const rejected = (reason: "attempt_not_open" | "lease_active" | "illegal_transition", row: Row): ScanTransitionOutcome => ({ status: "rejected", reason, scanStatus: row.scan_status });
  /** Every redeem condition, shared verbatim by validate (SELECT) and consume (UPDATE ... WHERE). Aliases: g grant, a asset, c composition. */
  function grantConditions(compositionId: string, assetId: string, access: CompositionAccess, now: Date, tokenHash: string, params: unknown[]): string {
    const principal = grantPrincipal(access);
    params.push(tokenHash, compositionId, assetId, principal.kind, principal.hash, now);
    const n = params.length, predicate = allowed(access, "c", params, now);
    return `g.token_hash=$${n - 5} AND g.composition_id=$${n - 4} AND g.asset_id=$${n - 3} AND g.principal_kind=$${n - 2} AND g.principal_hash=$${n - 1}
      AND g.redeemed_at IS NULL AND g.expires_at > $${n} AND a.composition_id=g.composition_id AND a.id=g.asset_id AND c.id=a.composition_id
      AND ${scanStatusOf("a")} = 'clean' AND ${predicate}`;
  }
  const grantArgs = (compositionId: string, assetId: string, now: Date, tokenHash: string) => isId(compositionId) && isId(assetId) && isDate(now) && typeof tokenHash === "string" && hex64.test(tokenHash);
  async function validateGrant(runner: Pick<Pool, "query">, compositionId: string, assetId: string, access: CompositionAccess, now: Date, tokenHash: string): Promise<DownloadGrantRecord | null> {
    const params: unknown[] = [], where = grantConditions(compositionId, assetId, access, now, tokenHash, params);
    const result = await runner.query(`SELECT g.* FROM ${S}.asset_download_grants g, ${S}.assets a, ${S}.compositions c WHERE ${where}`, params);
    return result.rows[0] ? grant(result.rows[0]) : null;
  }

  return {
    async ensurePrintProfile(profile: PrintProfileV1, sha: string) {
      await pool.query(`INSERT INTO ${S}.print_profiles(profile_id,version,status,supplier_approved,print_release_eligible,definition,definition_sha256) VALUES($1,$2,$3,false,false,$4,$5) ON CONFLICT DO NOTHING`,
        [profile.profileId, profile.version, profile.status, JSON.stringify(profile), sha]);
      const stored = await pool.query(`SELECT definition_sha256 FROM ${S}.print_profiles WHERE profile_id=$1 AND version=$2`, [profile.profileId, profile.version]);
      if (stored.rows[0]?.definition_sha256 !== sha) throw new Error("Print profile version already exists with different content");
    },
    async createGuest(input) {
      if (!isSafePositive(input?.liveGuestDraftsMax)) invalid("live guest cap");
      if (!isDate(input.now)) invalid("time");
      return transaction(async client => {
        // Count, decision and both inserts under one global lock: concurrent creators serialise here, so the cap cannot be overshot.
        await lockLiveGuestCap(client);
        if (await liveGuestDrafts(client, input.now) >= input.liveGuestDraftsMax) return { status: "cap_reached" as const };
        await client.query(`INSERT INTO ${I}.guest_drafts(id,capability_hash,expires_at) VALUES($1,$2,$3)`, [input.id, input.capabilityHash, input.guestExpiresAt]);
        await client.query(`INSERT INTO ${S}.compositions(id,guest_draft_id,product_family,print_profile_id,print_profile_version,lifecycle_state,draft_scene,draft_scene_sha256)
          VALUES($1,$1,$2,$3,$4,$5,$6,$7)`, [input.id, input.scene.productFamily, input.scene.printProfileId, input.scene.printProfileVersion, input.state, JSON.stringify(input.scene), input.sceneSha256]);
        return { status: "created" as const, record: (await read(client, input.id, { kind: "guest", capabilityHash: input.capabilityHash }, input.now))! };
      }) satisfies Promise<CreateGuestOutcome>;
    },
    async createOwned(input) {
      await pool.query(`INSERT INTO ${S}.compositions(id,owner_user_id,product_family,print_profile_id,print_profile_version,lifecycle_state,draft_scene,draft_scene_sha256)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [input.id, input.ownerUserId, input.scene.productFamily, input.scene.printProfileId, input.scene.printProfileVersion, input.state, JSON.stringify(input.scene), input.sceneSha256]);
      return (await read(pool, input.id, { kind: "owner", userId: input.ownerUserId }, new Date()))!;
    },
    get: (id, access, now) => read(pool, id, access, now),
    async listOwned(userId) {
      return (await pool.query(`${COMPOSITION} WHERE c.owner_user_id = $1 ORDER BY c.updated_at DESC LIMIT 100`, [userId])).rows.map(record);
    },
    async saveDraft(id, access, now, input) {
      const params: unknown[] = [id, input.expectedRevision, JSON.stringify(input.scene), input.sceneSha256, input.state, now], predicate = allowed(access, "c", params, now);
      const updated = await pool.query(`UPDATE ${S}.compositions c SET draft_scene=$3, draft_scene_sha256=$4, draft_revision=c.draft_revision+1, lifecycle_state=$5, updated_at=$6
        WHERE c.id=$1 AND c.draft_revision=$2 AND ${predicate} RETURNING c.id`, params);
      const current = await read(pool, id, access, now);
      if (!current) return { status: "not_found" as const };
      return updated.rowCount === 1 ? { status: "saved" as const, record: current } : { status: "conflict" as const, currentRevision: current.draftRevision };
    },
    async adoptClaimedGuest(id, userId, capabilityHash, now) {
      const result = await pool.query(`UPDATE ${S}.compositions c SET owner_user_id=$2, updated_at=$4,
          lifecycle_state=CASE WHEN c.lifecycle_state IN ('guest_draft','editable_scene') THEN 'saved_owned' ELSE c.lifecycle_state END
        FROM ${I}.guest_drafts gd WHERE c.id=$1 AND c.owner_user_id IS NULL AND gd.id=c.guest_draft_id AND gd.capability_hash=$3
          AND gd.owner_id=$2 AND gd.claimed_at IS NOT NULL RETURNING c.id`, [id, userId, capabilityHash, now]);
      return result.rowCount === 1 ? read(pool, id, { kind: "owner", userId }, now) : null;
    },
    async insertAsset(id, access, now, value, quota) {
      if (!isSafePositive(quota?.maxAssets) || !isSafePositive(quota?.maxBytes)) invalid("asset quota"); // unset or non-positive is never unlimited
      if (!isDate(now) || !isSafePositive(value?.byteSize)) invalid("asset");
      if (!isId(id)) return { status: "not_found" as const };
      return transaction(async tx => {
        // Order (ADR-0022 C3b lock order): access check without a lock, the composition advisory lock, then the authoritative re-read.
        // A caller without access never takes the lock. No row lock on `compositions` is taken here, so this writer can never wait on
        // a row held by a freeze that is itself queued on the advisory lock.
        const probe = async () => { const params: unknown[] = [id], predicate = allowed(access, "c", params, now); return (await tx.query(`SELECT 1 FROM ${S}.compositions c WHERE c.id=$1 AND ${predicate}`, params)).rowCount === 1; };
        if (!(await probe())) return { status: "not_found" as const };
        await lockComposition(tx, id);
        if (!(await probe())) return { status: "not_found" as const };
        const existing = (await tx.query(`${ASSET} WHERE a.composition_id=$1 AND a.sha256=$2`, [id, value.sha256])).rows[0];
        if (existing) return { status: "existing" as const, asset: asset(existing) }; // same bytes are idempotent and never count against the quota
        const totals = (await tx.query(`SELECT count(*)::integer AS n, COALESCE(sum(byte_size), 0)::text AS bytes FROM ${S}.assets WHERE composition_id=$1`, [id])).rows[0];
        if (totals.n >= quota.maxAssets || Number(totals.bytes) + value.byteSize > quota.maxBytes) return { status: "quota_exceeded" as const };
        // A row this statement inserted has no scan event yet: its status is "pending" by definition (ADR-0022 D3).
        const inserted = (await tx.query(`INSERT INTO ${S}.assets(id,composition_id,kind,object_key,sha256,mime,byte_size,width_px,height_px)
          VALUES($1,$2,'customer_original',$3,$4,$5,$6,$7,$8) ON CONFLICT (composition_id, sha256) DO NOTHING RETURNING *, 'pending'::text AS scan_status`,
          [value.id, id, value.objectKey, value.sha256, value.mime, value.byteSize, value.widthPx, value.heightPx])).rows[0];
        if (inserted) return { status: "inserted" as const, asset: asset(inserted) };
        const raced = (await tx.query(`${ASSET} WHERE a.composition_id=$1 AND a.sha256=$2`, [id, value.sha256])).rows[0]; // a writer outside the lock won
        return raced ? { status: "existing" as const, asset: asset(raced) } : { status: "not_found" as const };
      }) satisfies Promise<InsertAssetOutcome>;
    },
    async getAsset(compositionId, assetId, access, now) {
      const params: unknown[] = [compositionId, assetId], predicate = allowed(access, "c", params, now);
      const result = await pool.query(`${ASSET} JOIN ${S}.compositions c ON c.id=a.composition_id WHERE a.composition_id=$1 AND a.id=$2 AND ${predicate}`, params);
      return result.rows[0] ? asset(result.rows[0]) : null;
    },
    async listAssets(compositionId, access, now) {
      const params: unknown[] = [compositionId], predicate = allowed(access, "c", params, now);
      if (!(await pool.query(`SELECT 1 FROM ${S}.compositions c WHERE c.id=$1 AND ${predicate}`, params)).rowCount) return null;
      return (await pool.query(`${ASSET} WHERE a.composition_id=$1 ORDER BY a.created_at, a.id`, [compositionId])).rows.map(asset);
    },
    async freeze(compositionId, access, now, input) {
      return transaction(async client => {
        // Lock order (ADR-0022 C3b): advisory composition lock, then the compositions row, then advisory asset locks. The access
        // check runs first without a lock, so a caller without access never takes one. FOR NO KEY UPDATE (not FOR UPDATE) leaves
        // FK KEY SHARE checks (an asset insert under the composition lock) unblocked.
        if (!(await read(client, compositionId, access, now))) return { status: "not_found" as const };
        await lockComposition(client, compositionId);
        const current = await read(client, compositionId, access, now, " FOR NO KEY UPDATE OF c");
        if (!current) return { status: "not_found" as const };
        if (current.draftRevision !== input.expectedRevision) return { status: "conflict" as const, currentRevision: current.draftRevision };
        const existing = await client.query(`SELECT * FROM ${S}.composition_versions WHERE composition_id=$1 AND scene_sha256=$2`, [compositionId, input.version.sceneSha256]);
        let row: Row | undefined = existing.rows[0];
        // D5: every pinned image must be clean, read under the per-asset lock, on BOTH branches. The idempotent re-point branch
        // checks the pins of the version it re-points to, where no insert trigger fires.
        // On the insert branch the pins are the caller's list PLUS every image the scene itself references, so a dropped pin cannot skip the check.
        const pins = row ? (row.source_asset_sha256 as string[]) : [...input.sourceAssetSha256, ...sceneSourceHashes(input.version.scene).assets];
        const notClean = await uncleanPins(client, compositionId, pins);
        if (notClean.length) return { status: "asset_not_clean" as const, assetSha256: notClean };
        if (!row) {
          const next = (await client.query(`SELECT COALESCE(MAX(version_no),0)+1 AS n FROM ${S}.composition_versions WHERE composition_id=$1`, [compositionId])).rows[0].n;
          row = (await client.query(`INSERT INTO ${S}.composition_versions(id,composition_id,version_no,scene,scene_sha256,source_asset_sha256,source_font_sha256,print_profile_id,print_profile_version,preflight_state,preflight_issues,frozen_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [input.version.id, compositionId, next, JSON.stringify(input.version.scene), input.version.sceneSha256, input.sourceAssetSha256, input.sourceFontSha256,
            input.version.printProfileId, input.version.printProfileVersion, input.version.preflightState, JSON.stringify(input.version.preflightIssues), now])).rows[0];
        }
        await client.query(`UPDATE ${S}.compositions SET current_version_id=$2, lifecycle_state=$3, updated_at=$4 WHERE id=$1`, [compositionId, row!.id, input.state, now]);
        return { status: "frozen" as const, version: version(row!), record: (await read(client, compositionId, access, now))! };
      });
    },
    async getVersion(compositionId, versionId, access, now) {
      const params: unknown[] = [compositionId, versionId], predicate = allowed(access, "c", params, now);
      const result = await pool.query(`SELECT v.* FROM ${S}.composition_versions v JOIN ${S}.compositions c ON c.id=v.composition_id WHERE v.composition_id=$1 AND v.id=$2 AND ${predicate}`, params);
      return result.rows[0] ? version(result.rows[0]) : null;
    },
    async listVersions(compositionId, access, now) {
      const params: unknown[] = [compositionId], predicate = allowed(access, "c", params, now);
      if (!(await pool.query(`SELECT 1 FROM ${S}.compositions c WHERE c.id=$1 AND ${predicate}`, params)).rowCount) return null;
      return (await pool.query(`SELECT * FROM ${S}.composition_versions WHERE composition_id=$1 ORDER BY version_no`, [compositionId])).rows.map(version);
    },

    // ---- ADR-0022 C3b primitives (C4 wires the limiter and quota, C5 the scan path, C6 the download grants). ---------------------------------
    async listScanEvents(compositionId, assetId, access, now) {
      if (!isId(compositionId) || !isId(assetId) || !(await accessibleAsset(pool, compositionId, assetId, access, now))) return null;
      return (await pool.query(`SELECT * FROM ${S}.asset_scan_events WHERE composition_id=$1 AND asset_id=$2 ORDER BY seq`, [compositionId, assetId])).rows.map(scanEvent);
    },
    async openScanAttempt(compositionId, assetId, access, now, input) {
      if (!isId(input?.attemptId)) invalid("attempt id");
      if (!isDate(now) || !isDate(input.leaseExpiresAt) || input.leaseExpiresAt <= now) invalid("scan lease");
      return underAssetLock(compositionId, assetId, access, now, async (tx, row) => {
        const open = await openAttempt(tx, compositionId, assetId);
        if (open) return { status: "busy" as const, attempt: scanAttempt(open) };
        if (row.scan_status !== "pending") return { status: "not_scannable" as const, scanStatus: row.scan_status as ArtifactScanStatus };
        const inserted = await insertOnce(() => tx.query(`INSERT INTO ${S}.asset_scan_attempts(attempt_id,asset_id,composition_id,started_at,lease_expires_at) VALUES($1,$2,$3,$4,$5) RETURNING *`,
          [input.attemptId, assetId, compositionId, now, input.leaseExpiresAt]));
        return { status: "opened" as const, attempt: scanAttempt(inserted.rows[0]) };
      });
    },
    async completeScanAttempt(compositionId, assetId, access, now, input) {
      if (!isId(input?.attemptId)) invalid("attempt id");
      if (!isDate(now)) invalid("time");
      assertScanResult(input.result);
      return underAssetLock(compositionId, assetId, access, now, async (tx, row) => {
        if (!(await openAttempt(tx, compositionId, assetId, input.attemptId))) return rejected("attempt_not_open", row);
        const result = input.result;
        if (!SCAN_EDGES[row.scan_status as ArtifactScanStatus].includes(result.toStatus)) return rejected("illegal_transition", row);
        await tx.query(`UPDATE ${S}.asset_scan_attempts SET finished_at=$2, outcome='completed' WHERE attempt_id=$1 AND finished_at IS NULL`, [input.attemptId, now]);
        const event = result.toStatus === "unknown"
          ? await appendEvent(tx, row, now, { toStatus: "unknown", attemptId: input.attemptId, scannerId: result.scannerId ?? null, reasonCode: result.reasonCode })
          : await appendEvent(tx, row, now, { toStatus: result.toStatus, attemptId: input.attemptId, scannerId: result.scannerId, engineVersion: result.engineVersion, definitionsVersion: result.definitionsVersion, evidenceRef: result.evidenceRef });
        return { status: "recorded" as const, event };
      });
    },
    async expireScanAttempt(compositionId, assetId, access, now, input) {
      if (!isId(input?.attemptId)) invalid("attempt id");
      if (!isDate(now)) invalid("time");
      return underAssetLock(compositionId, assetId, access, now, async (tx, row) => {
        const open = await openAttempt(tx, compositionId, assetId, input.attemptId);
        if (!open) return rejected("attempt_not_open", row);
        // Never auto-closed, and never before the lease has passed on BOTH the caller's clock and the database clock, so a skewed or
        // request-influenced `now` cannot end a running scan early and trigger a second billable call (AGENTS rule 7).
        const dbPassed = (await tx.query("SELECT now() >= $1::timestamptz AS passed", [open.lease_expires_at])).rows[0].passed === true;
        if (now < open.lease_expires_at || !dbPassed) return rejected("lease_active", row);
        if (!SCAN_EDGES[row.scan_status as ArtifactScanStatus].includes("unknown")) return rejected("illegal_transition", row);
        await tx.query(`UPDATE ${S}.asset_scan_attempts SET finished_at=$2, outcome='lease_expired' WHERE attempt_id=$1 AND finished_at IS NULL`, [input.attemptId, now]);
        return { status: "recorded" as const, event: await appendEvent(tx, row, now, { toStatus: "unknown", attemptId: input.attemptId, reasonCode: "lease_expired" }) };
      });
    },
    async requestRescan(compositionId, assetId, access, now, input) {
      if (!isReason(input?.reasonCode)) invalid("rescan reason");
      if (!isDate(now)) invalid("time");
      return underAssetLock(compositionId, assetId, access, now, async (tx, row) => {
        if (row.scan_status !== "unknown") return rejected("illegal_transition", row);
        return { status: "recorded" as const, event: await appendEvent(tx, row, now, { toStatus: "pending", attemptId: null, reasonCode: input.reasonCode }) };
      });
    },

    async recordLateDetection(compositionId, assetId, access, now, input) {
      // ADR-0022 C5 late detection: scanner-side only (see the port). Lock first, re-read under it, then the born-closed attempt and the event.
      if (!isId(input?.attemptId)) invalid("attempt id");
      if (!isDate(now) || !isDate(input.startedAt) || !isDate(input.leaseExpiresAt) || input.leaseExpiresAt <= input.startedAt || input.startedAt > now) invalid("late detection time");
      if (input.result?.toStatus !== "quarantined") invalid("scan result");
      assertScanResult(input.result);
      return underAssetLock(compositionId, assetId, access, now, async (tx, row) => {
        if (row.scan_status !== "clean" || (await openAttempt(tx, compositionId, assetId))) return rejected("illegal_transition", row);
        await insertOnce(() => tx.query(`INSERT INTO ${S}.asset_scan_attempts(attempt_id,asset_id,composition_id,started_at,lease_expires_at,finished_at,outcome) VALUES($1,$2,$3,$4,$5,$6,'completed')`,
          [input.attemptId, assetId, compositionId, input.startedAt, input.leaseExpiresAt, now]));
        const r = input.result;
        return { status: "recorded" as const, event: await appendEvent(tx, row, now, { toStatus: "quarantined", attemptId: input.attemptId, scannerId: r.scannerId, engineVersion: r.engineVersion, definitionsVersion: r.definitionsVersion, evidenceRef: r.evidenceRef }) };
      });
    },

    async createDownloadGrant(compositionId, assetId, access, now, input) {
      if (!isId(input?.grantId)) invalid("grant id");
      if (typeof input.tokenHash !== "string" || !hex64.test(input.tokenHash)) invalid("token hash");
      if (!isDate(now) || !isDate(input.expiresAt) || input.expiresAt <= now) invalid("grant expiry");
      return underAssetLock(compositionId, assetId, access, now, async (tx, row) => {
        if (row.scan_status !== "clean") return { status: "asset_not_clean" as const, scanStatus: row.scan_status as ArtifactScanStatus };
        const principal = grantPrincipal(access);
        const inserted = await insertOnce(() => tx.query(`INSERT INTO ${S}.asset_download_grants(grant_id,token_hash,asset_id,composition_id,principal_kind,principal_hash,issued_at,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [input.grantId, input.tokenHash, assetId, compositionId, principal.kind, principal.hash, now, input.expiresAt]));
        return { status: "created" as const, grant: grant(inserted.rows[0]) };
      });
    },
    async validateDownloadGrant(compositionId, assetId, access, now, tokenHash) {
      return grantArgs(compositionId, assetId, now, tokenHash) ? validateGrant(pool, compositionId, assetId, access, now, tokenHash) : null;
    },
    async consumeDownloadGrant(compositionId, assetId, access, now, tokenHash) {
      if (!grantArgs(compositionId, assetId, now, tokenHash)) return null;
      if (!(await validateGrant(pool, compositionId, assetId, access, now, tokenHash))) return null; // a caller that cannot redeem takes no lock
      return transaction(async tx => {
        await lockAsset(tx, compositionId, assetId); // serialises with scan events (for example a late quarantine) on the same asset
        const params: unknown[] = [], where = grantConditions(compositionId, assetId, access, now, tokenHash, params);
        params.push(now);
        const result = await tx.query(`UPDATE ${S}.asset_download_grants g SET redeemed_at=$${params.length} FROM ${S}.assets a, ${S}.compositions c WHERE ${where} RETURNING g.*`, params);
        return result.rows[0] ? grant(result.rows[0]) : null;
      });
    },

    async consumeRateToken(input) {
      if (!RATE_OPERATIONS.includes(input?.operation)) invalid("rate operation");
      if (input.operation.endsWith("_GLOBAL") ? input.subject !== "global" : !isId(input.subject)) invalid("rate subject");
      if (!isPositiveInteger(input.windowSeconds) || !isPositiveInteger(input.max)) invalid("rate policy"); // unset or non-positive is never unlimited
      if (input.at !== undefined && !isDate(input.at)) invalid("time");
      // One statement: the window is computed once (from `at`, else the database clock) and admission is the atomic D2 upsert.
      const result = await pool.query(`WITH w AS (SELECT date_bin(make_interval(secs => $2::integer), COALESCE($3::timestamptz, now()), TIMESTAMPTZ '1970-01-01 00:00:00+00') AS ws),
        admitted AS (INSERT INTO ${S}.rate_limit_buckets AS b (bucket_key, window_start, count) SELECT $1, w.ws, 1 FROM w
          ON CONFLICT (bucket_key, window_start) DO UPDATE SET count = b.count + 1 WHERE b.count < $4 RETURNING b.count)
        SELECT w.ws AS window_start, w.ws + make_interval(secs => $2::integer) AS reset_at, (SELECT count FROM admitted) AS count FROM w`,
        [`${input.operation}:${input.subject}`, input.windowSeconds, input.at ?? null, input.max]);
      const row = result.rows[0];
      return row.count === null ? { admitted: false as const, windowStart: row.window_start, resetAt: row.reset_at } : { admitted: true as const, count: row.count, windowStart: row.window_start, resetAt: row.reset_at };
    },
    async countLiveGuestDrafts(now) {
      if (!isDate(now)) invalid("time");
      return liveGuestDrafts(pool, now);
    },
    async pruneRateBuckets(input) {
      // A window that started before the cut-off must also have ENDED by `now`, so no active window (and no live limit) is ever reset.
      if (!isDate(input?.olderThan) || !isDate(input.now) || !isPositiveInteger(input.longestWindowSeconds)) invalid("prune cut-off");
      if (input.olderThan.getTime() > input.now.getTime() - input.longestWindowSeconds * 1000) invalid("prune cut-off");
      return (await pool.query(`DELETE FROM ${S}.rate_limit_buckets WHERE window_start < $1`, [input.olderThan])).rowCount ?? 0;
    },
  };
}
