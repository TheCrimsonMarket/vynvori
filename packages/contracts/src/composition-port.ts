/**
 * Persistence port for the M3 composition service (implemented by @vynvori/db's PostgreSQL store; the commerce service and
 * the tests depend only on this shape). Types only: no runtime code, intentionally NOT re-exported from the public barrel.
 */
import type { CompositionSceneV1, PlaneDState, PrintProfileV1, PreflightIssue } from "./index";

/** How the caller proves access. A guest holds the unclaimed, unexpired capability; an owner is a verified SSO user. */
export type CompositionAccess = Readonly<{ kind: "owner"; userId: string }> | Readonly<{ kind: "guest"; capabilityHash: string }>;

export type CompositionRecord = Readonly<{
  id: string; ownerUserId: string | null; lifecycleState: PlaneDState; scene: CompositionSceneV1; sceneSha256: string; draftRevision: number;
  currentVersionId: string | null; currentVersionSceneSha256: string | null; printProfileId: string; printProfileVersion: string;
  createdAt: Date; updatedAt: Date; guestExpiresAt: Date | null;
}>;
/**
 * `scanStatus` is the asset's CURRENT scan status, read in the same SQL statement as the row (latest scan event; no event means
 * "pending"). Required so no implementer can omit it (ADR-0022 D3/D5, C3b). It is never supplied by a caller.
 */
export type AssetRecord = Readonly<{ id: string; compositionId: string; sha256: string; mime: string; byteSize: number; widthPx: number; heightPx: number; objectKey: string; createdAt: Date; scanStatus: ArtifactScanStatus }>;
export type VersionRecord = Readonly<{
  id: string; compositionId: string; versionNo: number; scene: CompositionSceneV1; sceneSha256: string; printProfileId: string; printProfileVersion: string;
  preflightState: "preview_only" | "blocked"; preflightIssues: readonly PreflightIssue[]; frozenAt: Date;
}>;
export type SaveOutcome = { status: "saved"; record: CompositionRecord } | { status: "conflict"; currentRevision: number } | { status: "not_found" };
/** `asset_not_clean`: an image the version pins is not `clean` (checked inside the freeze transaction, ADR-0022 D5). */
export type FreezeOutcome =
  | { status: "frozen"; version: VersionRecord; record: CompositionRecord }
  | { status: "conflict"; currentRevision: number }
  | { status: "not_found" }
  | { status: "asset_not_clean"; assetSha256: readonly string[] };

/** Persistence port. EVERY read/write is access-scoped inside the store (SQL), never filtered afterwards. */
export interface CompositionStore {
  ensurePrintProfile(profile: PrintProfileV1, definitionSha256: string): Promise<void>;
  createGuest(input: { id: string; capabilityHash: string; guestExpiresAt: Date; scene: CompositionSceneV1; sceneSha256: string; state: PlaneDState }): Promise<CompositionRecord>;
  createOwned(input: { id: string; ownerUserId: string; scene: CompositionSceneV1; sceneSha256: string; state: PlaneDState }): Promise<CompositionRecord>;
  get(id: string, access: CompositionAccess, now: Date): Promise<CompositionRecord | null>;
  listOwned(userId: string): Promise<readonly CompositionRecord[]>;
  saveDraft(id: string, access: CompositionAccess, now: Date, input: { expectedRevision: number; scene: CompositionSceneV1; sceneSha256: string; state: PlaneDState }): Promise<SaveOutcome>;
  adoptClaimedGuest(id: string, userId: string, capabilityHash: string, now: Date): Promise<CompositionRecord | null>;
  insertAsset(id: string, access: CompositionAccess, now: Date, asset: Omit<AssetRecord, "createdAt" | "compositionId" | "scanStatus">): Promise<AssetRecord | null>;
  getAsset(compositionId: string, assetId: string, access: CompositionAccess, now: Date): Promise<AssetRecord | null>;
  listAssets(compositionId: string, access: CompositionAccess, now: Date): Promise<readonly AssetRecord[] | null>;
  /**
   * Inserts a new immutable version, or returns the existing one with the identical scene hash (idempotent freeze). Every pinned
   * image asset must be `clean`, checked inside the same transaction under the per-asset lock, on BOTH branches (new insert and
   * idempotent re-point); otherwise nothing is written and the outcome is `asset_not_clean`.
   */
  freeze(compositionId: string, access: CompositionAccess, now: Date, input: { expectedRevision: number; version: Omit<VersionRecord, "versionNo" | "frozenAt" | "compositionId">; sourceAssetSha256: string[]; sourceFontSha256: string[]; state: PlaneDState }): Promise<FreezeOutcome>;
  getVersion(compositionId: string, versionId: string, access: CompositionAccess, now: Date): Promise<VersionRecord | null>;
  listVersions(compositionId: string, access: CompositionAccess, now: Date): Promise<readonly VersionRecord[] | null>;

  // ---- ADR-0022 C3b primitives. Every asset-scoped method checks the access predicate in SQL; absent, foreign, expired and
  // ---- claimed callers all get the same `not_found` (or `null`). No method here holds a policy number: TTLs, leases, windows
  // ---- and maxima are supplied by the caller from typed `M3_LIMIT_*` configuration and are validated, never defaulted.

  /** Scan history of one asset, oldest first (seq 1..n, gap-free). `null` when the caller has no access. */
  listScanEvents(compositionId: string, assetId: string, access: CompositionAccess, now: Date): Promise<readonly ScanEventRecord[] | null>;
  /** Reserve the single scan attempt for a `pending` asset BEFORE any scanner call (AGENTS rule 7). Never retried or expired by the store. */
  openScanAttempt(compositionId: string, assetId: string, access: CompositionAccess, now: Date, input: { attemptId: string; leaseExpiresAt: Date }): Promise<OpenScanAttemptOutcome>;
  /** Close the open attempt and append its result event (`pending -> clean | quarantined | unknown`) atomically. */
  completeScanAttempt(compositionId: string, assetId: string, access: CompositionAccess, now: Date, input: { attemptId: string; result: ScanResultEvent }): Promise<ScanTransitionOutcome>;
  /** Explicit request only: close an attempt whose lease has passed as `lease_expired` and record `pending -> unknown(lease_expired)`. */
  expireScanAttempt(compositionId: string, assetId: string, access: CompositionAccess, now: Date, input: { attemptId: string }): Promise<ScanTransitionOutcome>;
  /** Explicit rescan request: `unknown -> pending` with a reason code. */
  requestRescan(compositionId: string, assetId: string, access: CompositionAccess, now: Date, input: { reasonCode: string }): Promise<ScanTransitionOutcome>;

  /** Mint: stores only the token hash, bound to the caller's principal; the asset must be `clean` (checked under the asset lock). */
  createDownloadGrant(compositionId: string, assetId: string, access: CompositionAccess, now: Date, input: { grantId: string; tokenHash: string; expiresAt: Date }): Promise<CreateGrantOutcome>;
  /** Read-only: every redeem condition (principal, composition, asset, expiry, unredeemed, access, `clean`). `null` otherwise. */
  validateDownloadGrant(compositionId: string, assetId: string, access: CompositionAccess, now: Date, tokenHash: string): Promise<DownloadGrantRecord | null>;
  /** One atomic consume whose WHERE repeats every validation condition. `null` (and the grant stays spendable) on any mismatch. */
  consumeDownloadGrant(compositionId: string, assetId: string, access: CompositionAccess, now: Date, tokenHash: string): Promise<DownloadGrantRecord | null>;

  /** Atomic fixed-window admission (D2). Window from `at` or, when omitted, the database clock. Never unlimited: bad policy throws. */
  consumeRateToken(input: { operation: RateLimitOperation; subject: string; windowSeconds: number; max: number; at?: Date }): Promise<RateTokenOutcome>;
  /** Unexpired, unclaimed, unowned guest compositions at `now` (D2 live-guest cap input). */
  countLiveGuestDrafts(now: Date): Promise<number>;
  /**
   * Operator-run only (the runtime role holds no DELETE). Required cut-off and longest configured window, no defaults; refused unless
   * `olderThan <= now - longestWindowSeconds`, so no window that is still active can be deleted.
   */
  pruneRateBuckets(input: { olderThan: Date; now: Date; longestWindowSeconds: number }): Promise<number>;
}

/** The ten rate-limited operations (ADR-0022 D1 table). The two `_GLOBAL` operations take the subject "global"; the rest a UUID. */
export type RateLimitOperation =
  | "GUEST_CREATE_GLOBAL" | "ASSET_UPLOAD_GLOBAL"
  | "GUEST_WRITE" | "GUEST_ASSET_UPLOAD" | "GUEST_DOWNLOAD_GRANT" | "GUEST_RESCAN"
  | "OWNER_WRITE" | "OWNER_ASSET_UPLOAD" | "OWNER_DOWNLOAD_GRANT" | "OWNER_RESCAN";
export type RateTokenOutcome = Readonly<{ admitted: true; count: number; windowStart: Date; resetAt: Date }> | Readonly<{ admitted: false; windowStart: Date; resetAt: Date }>;

export type ScanEventRecord = Readonly<{
  assetId: string; compositionId: string; seq: number; fromStatus: ArtifactScanStatus; toStatus: ArtifactScanStatus; assetSha256: string;
  attemptId: string | null; scannerId: string | null; engineVersion: string | null; definitionsVersion: string | null; evidenceRef: string | null;
  reasonCode: string | null; recordedAt: Date;
}>;
export type ScanAttemptRecord = Readonly<{
  attemptId: string; assetId: string; compositionId: string; startedAt: Date; leaseExpiresAt: Date; finishedAt: Date | null; outcome: "completed" | "lease_expired" | null;
}>;
/** A clean/quarantined result needs the full scanner evidence; an unknown result needs a reason code. */
export type ScanResultEvent =
  | Readonly<{ toStatus: "clean" | "quarantined"; scannerId: string; engineVersion: string; definitionsVersion: string; evidenceRef: string }>
  | Readonly<{ toStatus: "unknown"; reasonCode: string; scannerId?: string }>;
export type OpenScanAttemptOutcome =
  | { status: "opened"; attempt: ScanAttemptRecord }
  | { status: "not_found" }
  /** Another attempt is already open (the reservation); the caller must not call the scanner. */
  | { status: "busy"; attempt: ScanAttemptRecord }
  /** Only a `pending` asset can be scanned; `unknown` needs `requestRescan` first. */
  | { status: "not_scannable"; scanStatus: ArtifactScanStatus };
export type ScanTransitionOutcome =
  | { status: "recorded"; event: ScanEventRecord }
  | { status: "not_found" }
  /** The attempt is not open for this asset, the lease has not passed yet (expire), or the current status does not allow the edge. */
  | { status: "rejected"; reason: "attempt_not_open" | "lease_active" | "illegal_transition"; scanStatus: ArtifactScanStatus };

export type DownloadGrantRecord = Readonly<{
  grantId: string; assetId: string; compositionId: string; principalKind: "owner" | "guest"; issuedAt: Date; expiresAt: Date; redeemedAt: Date | null;
}>;
export type CreateGrantOutcome = { status: "created"; grant: DownloadGrantRecord } | { status: "not_found" } | { status: "asset_not_clean"; scanStatus: ArtifactScanStatus };


/**
 * Malware-scan boundary (ADR-0022 D3). TYPES ONLY: no scanner is chosen, integrated or approximated, and nothing here is
 * implemented by M3 yet. Current status is derived from an append-only event log (added by later steps); no event means "pending".
 * Every outcome other than a well-formed clean/infected verdict for the same bytes maps to "unknown", never to "clean".
 */
export type ArtifactScanStatus = "pending" | "clean" | "quarantined" | "unknown";
export type ArtifactScanRequest = Readonly<{ assetId: string; sha256: string; byteSize: number; mime: string; bytes: Uint8Array }>;
export type ArtifactScanResult = Readonly<{
  verdict: "clean" | "infected" | "error";
  sha256: string; engineVersion: string; definitionsVersion: string; evidenceRef: string; scannedAt: string;
}>;
export interface ArtifactScanPort {
  readonly scannerId: string;
  scan(request: ArtifactScanRequest, signal: AbortSignal): Promise<ArtifactScanResult>;
}
