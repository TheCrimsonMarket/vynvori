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
export type AssetRecord = Readonly<{ id: string; compositionId: string; sha256: string; mime: string; byteSize: number; widthPx: number; heightPx: number; objectKey: string; createdAt: Date }>;
export type VersionRecord = Readonly<{
  id: string; compositionId: string; versionNo: number; scene: CompositionSceneV1; sceneSha256: string; printProfileId: string; printProfileVersion: string;
  preflightState: "preview_only" | "blocked"; preflightIssues: readonly PreflightIssue[]; frozenAt: Date;
}>;
export type SaveOutcome = { status: "saved"; record: CompositionRecord } | { status: "conflict"; currentRevision: number } | { status: "not_found" };

/** Persistence port. EVERY read/write is access-scoped inside the store (SQL), never filtered afterwards. */
export interface CompositionStore {
  ensurePrintProfile(profile: PrintProfileV1, definitionSha256: string): Promise<void>;
  createGuest(input: { id: string; capabilityHash: string; guestExpiresAt: Date; scene: CompositionSceneV1; sceneSha256: string; state: PlaneDState }): Promise<CompositionRecord>;
  createOwned(input: { id: string; ownerUserId: string; scene: CompositionSceneV1; sceneSha256: string; state: PlaneDState }): Promise<CompositionRecord>;
  get(id: string, access: CompositionAccess, now: Date): Promise<CompositionRecord | null>;
  listOwned(userId: string): Promise<readonly CompositionRecord[]>;
  saveDraft(id: string, access: CompositionAccess, now: Date, input: { expectedRevision: number; scene: CompositionSceneV1; sceneSha256: string; state: PlaneDState }): Promise<SaveOutcome>;
  adoptClaimedGuest(id: string, userId: string, capabilityHash: string, now: Date): Promise<CompositionRecord | null>;
  insertAsset(id: string, access: CompositionAccess, now: Date, asset: Omit<AssetRecord, "createdAt" | "compositionId">): Promise<AssetRecord | null>;
  getAsset(compositionId: string, assetId: string, access: CompositionAccess, now: Date): Promise<AssetRecord | null>;
  listAssets(compositionId: string, access: CompositionAccess, now: Date): Promise<readonly AssetRecord[] | null>;
  /** Inserts a new immutable version, or returns the existing one with the identical scene hash (idempotent freeze). */
  freeze(compositionId: string, access: CompositionAccess, now: Date, input: { expectedRevision: number; version: Omit<VersionRecord, "versionNo" | "frozenAt" | "compositionId">; sourceAssetSha256: string[]; sourceFontSha256: string[]; state: PlaneDState }): Promise<{ status: "frozen"; version: VersionRecord; record: CompositionRecord } | { status: "conflict"; currentRevision: number } | { status: "not_found" }>;
  getVersion(compositionId: string, versionId: string, access: CompositionAccess, now: Date): Promise<VersionRecord | null>;
  listVersions(compositionId: string, access: CompositionAccess, now: Date): Promise<readonly VersionRecord[] | null>;
}


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
