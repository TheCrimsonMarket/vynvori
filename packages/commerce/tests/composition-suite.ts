/** biome-ignore-all lint/suspicious/noExplicitAny: in-memory test double mirrors loosely-typed SQL rows */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { canonicalSceneJson, sceneSourceHashes } from "@vynvori/contracts";
import type {
  ArtifactScanStatus, AssetRecord, CompositionAccess, CompositionRecord, CompositionStore, DownloadGrantRecord, RateLimitOperation, ScanAttemptRecord,
  ScanEventRecord, ScanResultEvent, ScanTransitionOutcome, VersionRecord,
} from "@vynvori/contracts/composition-port";
import { compositionService, CompositionError, secretHash, draftProjection } from "../src/composition";
import { SYNTHETIC_COMPOSITION_CONFIG, SYNTHETIC_GUEST_TTL_SECONDS } from "./composition-synthetic";
import { imageLayer, memoryStorage, png, jpeg, sceneWith, sha256, textLayer, webp } from "./composition-fixtures";
import { markClean, type StoreHarness } from "./composition-store-suite";

export type Harness = Readonly<{
  store: CompositionStore;
  /** Create a verified-user id (a profile row in PostgreSQL). */
  newUser(): Promise<string>;
  /** Simulates the M1b `claimGuest` effect: guest draft gets owner_id + claimed_at. */
  m1bClaim(draftId: string, userId: string): Promise<void>;
  /** Moves the M1b guest draft's expiry into the past (an expired capability). */
  expireGuest(draftId: string): Promise<void>;
}>;

/** In-memory port implementation with the same access semantics as the SQL store (and the same C3b primitives, ADR-0022). */
export function memoryHarness(): StoreHarness {
  type Draft = { capabilityHash: string; expiresAt: Date; ownerId: string | null };
  type RawAsset = Omit<AssetRecord, "scanStatus">;
  type Grant = DownloadGrantRecord & { tokenHash: string; principalHash: string };
  const drafts = new Map<string, Draft>(), comps = new Map<string, any>(), assets = new Map<string, RawAsset>(), versions = new Map<string, VersionRecord[]>();
  const pinsOf = new Map<string, readonly string[]>(), events = new Map<string, ScanEventRecord[]>(), attempts = new Map<string, ScanAttemptRecord>(), grants = new Map<string, Grant>(), buckets = new Map<string, number>();
  const ok = (c: any, access: CompositionAccess, now: Date) => access.kind === "owner" ? c.ownerUserId === access.userId
    : c.ownerUserId === null && !!c.guestDraftId && drafts.get(c.guestDraftId)?.capabilityHash === access.capabilityHash && drafts.get(c.guestDraftId)!.expiresAt > now && drafts.get(c.guestDraftId)!.ownerId === null;
  const project = (c: any): CompositionRecord => {
    const v = versions.get(c.id)?.find(x => x.id === c.currentVersionId);
    return { ...c, currentVersionSceneSha256: v?.sceneSha256 ?? null, guestExpiresAt: c.ownerUserId ? null : drafts.get(c.guestDraftId)?.expiresAt ?? null };
  };
  const statusOf = (assetId: string): ArtifactScanStatus => events.get(assetId)?.at(-1)?.toStatus ?? "pending";
  const view = (a: RawAsset): AssetRecord => ({ ...a, scanStatus: statusOf(a.id) });
  /** The asset if `access` passes at `now` (same uniform not-found as the SQL predicate). */
  const accessible = (compositionId: string, assetId: string, access: CompositionAccess, now: Date): RawAsset | null => {
    if (!MEM_ID.test(compositionId) || !MEM_ID.test(assetId)) return null;
    const c = comps.get(compositionId), a = assets.get(assetId);
    return c && a && a.compositionId === compositionId && ok(c, access, now) ? a : null;
  };
  const openAttemptOf = (assetId: string) => [...attempts.values()].find(x => x.assetId === assetId && x.finishedAt === null);
  const append = (a: RawAsset, now: Date, e: Partial<ScanEventRecord> & { toStatus: ArtifactScanStatus }): ScanEventRecord => {
    const list = events.get(a.id) ?? [];
    const event: ScanEventRecord = Object.freeze({ assetId: a.id, compositionId: a.compositionId, seq: list.length + 1, fromStatus: statusOf(a.id), assetSha256: a.sha256, attemptId: null, scannerId: null, engineVersion: null, definitionsVersion: null, evidenceRef: null, reasonCode: null, recordedAt: now, ...e });
    list.push(event); events.set(a.id, list); return event;
  };
  const rejected = (reason: "attempt_not_open" | "lease_active" | "illegal_transition", a: RawAsset): ScanTransitionOutcome => ({ status: "rejected", reason, scanStatus: statusOf(a.id) });
  const close = (attempt: ScanAttemptRecord, now: Date, outcome: "completed" | "lease_expired") => attempts.set(attempt.attemptId, Object.freeze({ ...attempt, finishedAt: now, outcome }));
  const principal = (access: CompositionAccess) => access.kind === "owner" ? { kind: "owner" as const, hash: sha256(Buffer.from(access.userId)) } : { kind: "guest" as const, hash: access.capabilityHash };
  const redeemable = (compositionId: string, assetId: string, access: CompositionAccess, now: Date, tokenHash: string): Grant | null => {
    if (!isMemDate(now) || typeof tokenHash !== "string" || !MEM_HEX64.test(tokenHash)) return null;
    const g = grants.get(tokenHash), a = accessible(compositionId, assetId, access, now), p = principal(access);
    return g && a && g.compositionId === compositionId && g.assetId === assetId && g.principalKind === p.kind && g.principalHash === p.hash && g.redeemedAt === null && g.expiresAt > now && statusOf(a.id) === "clean" ? g : null;
  };
  const liveCount = (now: Date) => [...comps.values()].filter(c => c.ownerUserId === null && c.guestDraftId && drafts.get(c.guestDraftId)!.expiresAt > now && drafts.get(c.guestDraftId)!.ownerId === null).length;
  const publicGrant = ({ tokenHash: _t, principalHash: _p, ...g }: Grant): DownloadGrantRecord => g;

  const store: CompositionStore = {
    async ensurePrintProfile() {},
    async createGuest(i) {
      if (!memSafePositive(i?.liveGuestDraftsMax) || !isMemDate(i.now)) memInvalid(); // unset or zero is never "unlimited"
      if (liveCount(i.now) >= i.liveGuestDraftsMax) return { status: "cap_reached" };
      drafts.set(i.id, { capabilityHash: i.capabilityHash, expiresAt: i.guestExpiresAt, ownerId: null });
      const c = { id: i.id, guestDraftId: i.id, ownerUserId: null, lifecycleState: i.state, scene: i.scene, sceneSha256: i.sceneSha256, draftRevision: 0, currentVersionId: null, printProfileId: i.scene.printProfileId, printProfileVersion: i.scene.printProfileVersion, createdAt: new Date(), updatedAt: new Date() };
      comps.set(i.id, c); return { status: "created", record: project(c) }; },
    async createOwned(i) { const c = { id: i.id, guestDraftId: null, ownerUserId: i.ownerUserId, lifecycleState: i.state, scene: i.scene, sceneSha256: i.sceneSha256, draftRevision: 0, currentVersionId: null, printProfileId: i.scene.printProfileId, printProfileVersion: i.scene.printProfileVersion, createdAt: new Date(), updatedAt: new Date() }; comps.set(i.id, c); return project(c); },
    async get(id, access, now) { const c = comps.get(id); return c && ok(c, access, now) ? project(c) : null; },
    async listOwned(userId) { return [...comps.values()].filter(c => c.ownerUserId === userId).map(project); },
    async saveDraft(id, access, now, i) { const c = comps.get(id); if (!c || !ok(c, access, now)) return { status: "not_found" };
      if (c.draftRevision !== i.expectedRevision) return { status: "conflict", currentRevision: c.draftRevision };
      Object.assign(c, { scene: i.scene, sceneSha256: i.sceneSha256, draftRevision: c.draftRevision + 1, lifecycleState: i.state, updatedAt: now }); return { status: "saved", record: project(c) }; },
    async adoptClaimedGuest(id, userId, hash, now) { const c = comps.get(id), d = c?.guestDraftId ? drafts.get(c.guestDraftId) : undefined;
      if (!c || c.ownerUserId !== null || !d || d.capabilityHash !== hash || d.ownerId !== userId) return null;
      c.ownerUserId = userId; if (["guest_draft", "editable_scene"].includes(c.lifecycleState)) c.lifecycleState = "saved_owned"; c.updatedAt = now; return project(c); },
    async insertAsset(id, access, now, a, quota) {
      if (!memSafePositive(quota?.maxAssets) || !memSafePositive(quota?.maxBytes) || !isMemDate(now) || !memSafePositive(a?.byteSize)) memInvalid();
      const c = MEM_ID.test(id) ? comps.get(id) : undefined; if (!c || !ok(c, access, now)) return { status: "not_found" };
      const owned = [...assets.values()].filter(x => x.compositionId === id), dup = owned.find(x => x.sha256 === a.sha256);
      if (dup) return { status: "existing", asset: view(dup) };
      if (owned.length >= quota.maxAssets || owned.reduce((sum, x) => sum + x.byteSize, 0) + a.byteSize > quota.maxBytes) return { status: "quota_exceeded" };
      const row = { ...a, compositionId: id, createdAt: now }; assets.set(a.id, row); return { status: "inserted", asset: view(row) }; },
    async getAsset(id, assetId, access, now) { const c = comps.get(id), a = assets.get(assetId); return c && a && a.compositionId === id && ok(c, access, now) ? view(a) : null; },
    async listAssets(id, access, now) { const c = comps.get(id); return c && ok(c, access, now) ? [...assets.values()].filter(a => a.compositionId === id).map(view) : null; },
    async freeze(id, access, now, i) { const c = comps.get(id); if (!c || !ok(c, access, now)) return { status: "not_found" };
      if (c.draftRevision !== i.expectedRevision) return { status: "conflict", currentRevision: c.draftRevision };
      const list = versions.get(id) ?? []; let v = list.find(x => x.sceneSha256 === i.version.sceneSha256);
      // D5 on both branches: the re-point branch checks the pins of the version it re-points to.
      const pins = [...new Set(v ? pinsOf.get(v.id)! : [...i.sourceAssetSha256, ...sceneSourceHashes(i.version.scene).assets])].sort();
      const notClean = pins.filter(hash => { const a = [...assets.values()].find(x => x.compositionId === id && x.sha256 === hash); return !a || statusOf(a.id) !== "clean"; });
      if (notClean.length) return { status: "asset_not_clean", assetSha256: notClean };
      if (!v) { v = { ...i.version, compositionId: id, versionNo: list.length + 1, frozenAt: now }; pinsOf.set(v.id, [...i.sourceAssetSha256]); list.push(Object.freeze(v)); versions.set(id, list); }
      Object.assign(c, { currentVersionId: v.id, lifecycleState: i.state, updatedAt: now }); return { status: "frozen", version: v, record: project(c) }; },
    async getVersion(id, vid, access, now) { const c = comps.get(id); return c && ok(c, access, now) ? versions.get(id)?.find(v => v.id === vid) ?? null : null; },
    async listVersions(id, access, now) { const c = comps.get(id); return c && ok(c, access, now) ? versions.get(id) ?? [] : null; },

    async listScanEvents(compositionId, assetId, access, now) { const a = accessible(compositionId, assetId, access, now); return a ? [...(events.get(a.id) ?? [])] : null; },
    async openScanAttempt(compositionId, assetId, access, now, input) {
      if (!MEM_ID.test(input?.attemptId ?? "")) memInvalid();
      if (!isMemDate(now) || !isMemDate(input.leaseExpiresAt) || input.leaseExpiresAt <= now) memInvalid();
      const a = accessible(compositionId, assetId, access, now); if (!a) return { status: "not_found" };
      const open = openAttemptOf(a.id); if (open) return { status: "busy", attempt: open };
      if (statusOf(a.id) !== "pending") return { status: "not_scannable", scanStatus: statusOf(a.id) };
      if (attempts.has(input.attemptId)) memInvalid(); // the SQL primary key refuses a reused id the same way
      const attempt: ScanAttemptRecord = Object.freeze({ attemptId: input.attemptId, assetId, compositionId, startedAt: now, leaseExpiresAt: input.leaseExpiresAt, finishedAt: null, outcome: null });
      attempts.set(attempt.attemptId, attempt); return { status: "opened", attempt };
    },
    async completeScanAttempt(compositionId, assetId, access, now, input) {
      if (!MEM_ID.test(input?.attemptId ?? "") || !isMemDate(now)) memInvalid();
      memScanResult(input.result);
      const a = accessible(compositionId, assetId, access, now); if (!a) return { status: "not_found" };
      const attempt = attempts.get(input.attemptId);
      if (!attempt || attempt.assetId !== a.id || attempt.compositionId !== compositionId || attempt.finishedAt !== null) return rejected("attempt_not_open", a);
      if (!MEM_EDGES[statusOf(a.id)].includes(input.result.toStatus)) return rejected("illegal_transition", a);
      close(attempt, now, "completed");
      const r = input.result;
      return { status: "recorded", event: r.toStatus === "unknown"
        ? append(a, now, { toStatus: "unknown", attemptId: attempt.attemptId, scannerId: r.scannerId ?? null, reasonCode: r.reasonCode })
        : append(a, now, { toStatus: r.toStatus, attemptId: attempt.attemptId, scannerId: r.scannerId, engineVersion: r.engineVersion, definitionsVersion: r.definitionsVersion, evidenceRef: r.evidenceRef, reasonCode: r.reasonCode ?? null }) };
    },
    async expireScanAttempt(compositionId, assetId, access, now, input) {
      if (!MEM_ID.test(input?.attemptId ?? "") || !isMemDate(now)) memInvalid();
      const a = accessible(compositionId, assetId, access, now); if (!a) return { status: "not_found" };
      const attempt = attempts.get(input.attemptId);
      if (!attempt || attempt.assetId !== a.id || attempt.compositionId !== compositionId || attempt.finishedAt !== null) return rejected("attempt_not_open", a);
      if (now < attempt.leaseExpiresAt || Date.now() < attempt.leaseExpiresAt.getTime()) return rejected("lease_active", a); // caller clock AND the store clock
      if (!MEM_EDGES[statusOf(a.id)].includes("unknown")) return rejected("illegal_transition", a);
      close(attempt, now, "lease_expired");
      return { status: "recorded", event: append(a, now, { toStatus: "unknown", attemptId: attempt.attemptId, reasonCode: "lease_expired" }) };
    },
    async requestRescan(compositionId, assetId, access, now, input) {
      if (!memReason(input?.reasonCode) || !isMemDate(now)) memInvalid();
      const a = accessible(compositionId, assetId, access, now); if (!a) return { status: "not_found" };
      if (statusOf(a.id) !== "unknown") return rejected("illegal_transition", a);
      return { status: "recorded", event: append(a, now, { toStatus: "pending", reasonCode: input.reasonCode }) };
    },

    async recordLateDetection(compositionId, assetId, access, now, input) {
      if (!MEM_ID.test(input?.attemptId ?? "") || !isMemDate(now) || !isMemDate(input.startedAt) || !isMemDate(input.leaseExpiresAt) || input.leaseExpiresAt <= input.startedAt || input.startedAt > now) memInvalid();
      if (input.result?.toStatus !== "quarantined") memInvalid();
      memScanResult(input.result);
      const a = accessible(compositionId, assetId, access, now); if (!a) return { status: "not_found" };
      if (statusOf(a.id) !== "clean" || openAttemptOf(a.id)) return rejected("illegal_transition", a);
      if (attempts.has(input.attemptId)) memInvalid();
      attempts.set(input.attemptId, Object.freeze({ attemptId: input.attemptId, assetId, compositionId, startedAt: input.startedAt, leaseExpiresAt: input.leaseExpiresAt, finishedAt: now, outcome: "completed" }));
      const r = input.result;
      return { status: "recorded", event: append(a, now, { toStatus: "quarantined", attemptId: input.attemptId, scannerId: r.scannerId, engineVersion: r.engineVersion, definitionsVersion: r.definitionsVersion, evidenceRef: r.evidenceRef }) };
    },

    async createDownloadGrant(compositionId, assetId, access, now, input) {
      if (!MEM_ID.test(input?.grantId ?? "") || typeof input.tokenHash !== "string" || !MEM_HEX64.test(input.tokenHash)) memInvalid();
      if (!isMemDate(now) || !isMemDate(input.expiresAt) || input.expiresAt <= now) memInvalid();
      const a = accessible(compositionId, assetId, access, now); if (!a) return { status: "not_found" };
      if (statusOf(a.id) !== "clean") return { status: "asset_not_clean", scanStatus: statusOf(a.id) };
      if (grants.has(input.tokenHash) || [...grants.values()].some(x => x.grantId === input.grantId)) memInvalid(); // the SQL unique keys refuse the same way
      const p = principal(access);
      const g: Grant = { grantId: input.grantId, assetId, compositionId, principalKind: p.kind, issuedAt: now, expiresAt: input.expiresAt, redeemedAt: null, tokenHash: input.tokenHash, principalHash: p.hash };
      grants.set(input.tokenHash, g); return { status: "created", grant: publicGrant(g) };
    },
    async validateDownloadGrant(compositionId, assetId, access, now, tokenHash) { const g = redeemable(compositionId, assetId, access, now, tokenHash); return g ? publicGrant(g) : null; },
    async consumeDownloadGrant(compositionId, assetId, access, now, tokenHash) {
      const g = redeemable(compositionId, assetId, access, now, tokenHash); if (!g) return null;
      const spent: Grant = { ...g, redeemedAt: now }; grants.set(tokenHash, spent); return publicGrant(spent);
    },

    async consumeRateToken(input) {
      if (!MEM_OPERATIONS.includes(input?.operation)) memInvalid();
      if (input.operation.endsWith("_GLOBAL") ? input.subject !== "global" : !MEM_ID.test(input.subject ?? "")) memInvalid();
      if (![input.windowSeconds, input.max].every(memPositive)) memInvalid();
      if (input.at !== undefined && !isMemDate(input.at)) memInvalid();
      const stride = input.windowSeconds * 1000, at = (input.at ?? new Date()).getTime();
      const windowStart = new Date(Math.floor(at / stride) * stride), resetAt = new Date(windowStart.getTime() + stride);
      const key = `${input.operation}:${input.subject}|${windowStart.toISOString()}`, count = buckets.get(key) ?? 0;
      if (count >= input.max) return { admitted: false, windowStart, resetAt };
      buckets.set(key, count + 1); return { admitted: true, count: count + 1, windowStart, resetAt };
    },
    async countLiveGuestDrafts(now) {
      if (!isMemDate(now)) memInvalid();
      return liveCount(now);
    },
    async pruneRateBuckets(input) {
      if (!isMemDate(input?.olderThan) || !isMemDate(input.now) || !memPositive(input.longestWindowSeconds)) memInvalid();
      if (input.olderThan.getTime() > input.now.getTime() - input.longestWindowSeconds * 1000) memInvalid();
      let removed = 0;
      for (const key of [...buckets.keys()]) if (new Date(key.slice(key.indexOf("|") + 1)) < input.olderThan) { buckets.delete(key); removed += 1; }
      return removed;
    },
  };
  return {
    store, async newUser() { return randomUUID(); }, async m1bClaim(draftId, userId) { drafts.get(draftId)!.ownerId = userId; },
    async expireGuest(draftId) { drafts.get(draftId)!.expiresAt = new Date(0); },
    async bucketCount() { return buckets.size; },
    /** Test-only injection of the `clean -> quarantined` late-detection edge (no store primitive produces it in C3b). */
    async lateQuarantine(compositionId, assetId) {
      const a = assets.get(assetId)!;
      if (a.compositionId !== compositionId || statusOf(assetId) !== "clean") throw new Error("lateQuarantine needs a clean asset");
      const attemptId = randomUUID(), now = new Date();
      attempts.set(attemptId, Object.freeze({ attemptId, assetId, compositionId, startedAt: now, leaseExpiresAt: new Date(now.getTime() + 1000), finishedAt: now, outcome: "completed" }));
      append(a, now, { toStatus: "quarantined", attemptId, scannerId: "synthetic-scanner", engineVersion: "synthetic-engine-0", definitionsVersion: "synthetic-defs-1", evidenceRef: "evidence://synthetic/late" });
    },
  };
}
const MEM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, MEM_HEX64 = /^[a-f0-9]{64}$/, MEM_REASON = /^[a-z][a-z0-9_]*$/;
const MEM_EDGES: Readonly<Record<ArtifactScanStatus, readonly ArtifactScanStatus[]>> = { pending: ["clean", "quarantined", "unknown"], unknown: ["pending"], clean: ["quarantined"], quarantined: [] };
const MEM_OPERATIONS: readonly RateLimitOperation[] = ["GUEST_CREATE_GLOBAL", "ASSET_UPLOAD_GLOBAL", "GUEST_WRITE", "GUEST_ASSET_UPLOAD", "GUEST_DOWNLOAD_GRANT", "GUEST_RESCAN", "OWNER_WRITE", "OWNER_ASSET_UPLOAD", "OWNER_DOWNLOAD_GRANT", "OWNER_RESCAN"];
const isMemDate = (value: unknown): value is Date => value instanceof Date && Number.isFinite(value.getTime());
/** Same structural ceilings as the SQL store (PostgreSQL integer range; scanner text length). Not policy. */
const MEM_INTEGER_MAX = 2147483647, MEM_TEXT_MAX = 512;
const memSafePositive = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n > 0;
const memPositive = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n > 0 && n <= MEM_INTEGER_MAX;
const memText = (value: unknown) => typeof value === "string" && value.trim() !== "" && value === value.trim() && value.length <= MEM_TEXT_MAX;
const memReason = (value: unknown): value is string => typeof value === "string" && value.length <= MEM_TEXT_MAX && MEM_REASON.test(value);
function memInvalid(): never { throw new RangeError("composition store: invalid input"); }
function memScanResult(r: ScanResultEvent) {
  if (r?.toStatus === "clean" || r?.toStatus === "quarantined") {
    if (![r.scannerId, r.engineVersion, r.definitionsVersion, r.evidenceRef].every(memText)) memInvalid();
    if (r.reasonCode !== undefined && (r.toStatus !== "quarantined" || !memReason(r.reasonCode))) memInvalid(); // mirrors the SQL store: only a quarantine may carry one
  }
  else if (r?.toStatus === "unknown") { if (!memReason(r.reasonCode) || (r.scannerId !== undefined && !memText(r.scannerId))) memInvalid(); }
  else memInvalid();
}

const code = (promise: Promise<unknown>, expected: CompositionError["code"]) => assert.rejects(promise, (error: unknown) => error instanceof CompositionError && error.code === expected);

export function compositionConformance(label: string, factory: () => Promise<Harness>, options: { skip?: boolean } = {}) {
  const t = (name: string, fn: () => Promise<void>) => test(`${label}: ${name}`, { skip: options.skip ?? false }, fn);
  // Anchored to real time: the PostgreSQL store reads a new guest draft back with the real clock, so a fixed past date plus a short TTL would already be expired.
  let clock = new Date();
  const setup = async (uploads = true) => {
    const h = await factory(), storage = memoryStorage();
    const service = compositionService(h.store, storage, { ...SYNTHETIC_COMPOSITION_CONFIG, uploadsEnabled: uploads }, () => clock);
    return { h, storage, service };
  };
  const guest = async (service: ReturnType<typeof compositionService>) => {
    const created = await service.createGuest();
    return { id: created.record.id, access: { kind: "guest", capabilityHash: secretHash(created.capability) } as CompositionAccess, capability: created.capability, record: created.record };
  };
  t("guest draft is free, accountless and starts in guest_draft; only the capability hash is stored", async () => {
    clock = new Date();
    const { service } = await setup(); const g = await guest(service);
    assert.equal(g.record.lifecycleState, "guest_draft"); assert.equal(g.record.ownerUserId, null); assert.equal(g.capability.length, 43);
    assert.equal(JSON.stringify(g.record).includes(g.capability), false);
    const projection = draftProjection(g.record, g.access);
    assert.equal(projection.ownerKind, "guest_capability"); assert.equal(projection.canPersistToAccount, true);
  });
  t("guest rights: wrong capability, other draft's capability and expiry all look like NOT_FOUND", async () => {
    const { service } = await setup(); const a = await guest(service), b = await guest(service);
    await code(service.get(a.id, b.access), "NOT_FOUND");
    await code(service.get(a.id, { kind: "guest", capabilityHash: secretHash("x".repeat(43)) }), "NOT_FOUND");
    await code(service.saveDraft(a.id, b.access, 0, sceneWith()), "NOT_FOUND");
    assert.equal((await service.get(a.id, a.access)).id, a.id);
    clock = new Date(clock.getTime() + (SYNTHETIC_GUEST_TTL_SECONDS + 3600) * 1000);
    await code(service.get(a.id, a.access), "NOT_FOUND");
    await code(service.saveDraft(a.id, a.access, 0, sceneWith()), "NOT_FOUND");
    await code(service.freeze(a.id, a.access, 0), "NOT_FOUND");
    clock = new Date();
  });
  t("upload is closed by default (assets.production_uploads OFF) and never reaches storage", async () => {
    const { service, storage } = await setup(false); const g = await guest(service);
    await code(service.uploadAsset(g.id, g.access, png(), "image/png"), "UPLOADS_DISABLED");
    assert.equal(storage.objects.size, 0);
  });
  t("upload stores a private content-addressed original, dedupes, and rejects hostile input", async () => {
    const { service, storage } = await setup(); const g = await guest(service);
    const bytes = png(300, 200), asset = await service.uploadAsset(g.id, g.access, bytes, "image/png");
    assert.equal(asset.sha256, sha256(bytes)); assert.equal(asset.widthPx, 300); assert.equal(asset.objectKey, `private/composition/v1/${g.id}/${asset.sha256}`);
    assert.deepEqual([...storage.objects.get(asset.objectKey)!.bytes], [...bytes]); // unchanged original
    assert.equal((await service.uploadAsset(g.id, g.access, bytes, "image/png")).id, asset.id);
    assert.equal(storage.objects.size, 1);
    assert.equal((await service.uploadAsset(g.id, g.access, jpeg(), "image/jpeg")).mime, "image/jpeg");
    assert.equal((await service.uploadAsset(g.id, g.access, webp(), "image/webp")).mime, "image/webp");
    for (const [bytes_, mime, expected] of [
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "image/svg+xml", "UNSUPPORTED_MEDIA"],
      [Buffer.from("GIF89a....................................."), "image/gif", "UNSUPPORTED_MEDIA"],
      [Buffer.alloc(0), "image/png", "UNSUPPORTED_MEDIA"],
      [png(4, 4, 9), "image/jpeg", "UNSUPPORTED_MEDIA"], // declared type does not match magic bytes
      [Buffer.concat([png(4, 4, 8), Buffer.from("<script>")]), "image/png", "UNSUPPORTED_MEDIA"], // polyglot trailer
      [png(30000, 30000, 7), "image/png", "UNSUPPORTED_MEDIA"], // decompression-bomb dimensions
      [webp(8, 8, true), "image/webp", "UNSUPPORTED_MEDIA"], // animated
    ] as const) await code(service.uploadAsset(g.id, g.access, bytes_, mime), expected);
    assert.equal(storage.objects.size, 3);
  });
  t("storage failure is surfaced, nothing is recorded, and a retry is idempotent", async () => {
    const { service, storage } = await setup(); const g = await guest(service);
    storage.failNext = true;
    await code(service.uploadAsset(g.id, g.access, png(10, 10), "image/png"), "STORAGE_UNAVAILABLE");
    assert.equal((await service.listAssets(g.id, g.access)).length, 0);
    assert.equal((await service.uploadAsset(g.id, g.access, png(10, 10), "image/png")).widthPx, 10);
  });
  t("assets are scoped to their composition: no cross-owner read, upload or layer reference", async () => {
    const { service } = await setup(); const a = await guest(service), b = await guest(service);
    const asset = await service.uploadAsset(a.id, a.access, png(2000, 2000), "image/png");
    await code(service.readAsset(a.id, asset.id, a.access), "NOT_FOUND"); // D5 (C5): a pending asset is never served
    assert.equal(await service.scanAsset(a.id, asset.id, a.access, png(2000, 2000)), "clean"); // the SYNTHETIC double answers clean
    await code(service.readAsset(a.id, asset.id, b.access), "NOT_FOUND");
    await code(service.readAsset(b.id, asset.id, b.access), "NOT_FOUND"); // right owner, wrong composition id
    assert.equal((await service.readAsset(a.id, asset.id, a.access)).bytes.byteLength > 0, true);
    await code(service.saveDraft(b.id, b.access, 0, sceneWith([imageLayer("l1", asset.id, asset.sha256)])), "ASSET_NOT_OWNED");
    await code(service.saveDraft(a.id, a.access, 0, sceneWith([imageLayer("l1", asset.id, "0".repeat(64))])), "ASSET_NOT_OWNED");
    await code(service.uploadAsset(a.id, b.access, png(5, 5), "image/png"), "NOT_FOUND");
  });
  t("scene validation: unlicensed font, huge geometry and wrong profile are rejected before persistence", async () => {
    const { service } = await setup(); const g = await guest(service);
    await code(service.saveDraft(g.id, g.access, 0, sceneWith([textLayer("t", { fontFileSha256: "c".repeat(64) })])), "FONT_UNLICENSED");
    await code(service.saveDraft(g.id, g.access, 0, sceneWith([textLayer("t", { xMm: 1e7 })])), "SCENE_LIMIT");
    await code(service.saveDraft(g.id, g.access, 0, { ...sceneWith(), printProfileVersion: "other" }), "INVALID_SCENE");
    await code(service.saveDraft(g.id, g.access, 0, { nonsense: true }), "INVALID_SCENE");
    assert.equal((await service.get(g.id, g.access)).draftRevision, 0);
  });
  t("geometry is identical after reload (millimetres, 1 µm canonical form) and the hash is stable", async () => {
    const { service } = await setup(); const g = await guest(service);
    const asset = await service.uploadAsset(g.id, g.access, png(3000, 3000), "image/png");
    const saved = await service.saveDraft(g.id, g.access, 0, sceneWith([imageLayer("l1", asset.id, asset.sha256), textLayer("t1")], [textLayer("t2", { text: "BACK" })]));
    const reloaded = await service.get(g.id, g.access);
    assert.equal(canonicalSceneJson(reloaded.scene), canonicalSceneJson(saved.scene));
    assert.deepEqual(reloaded.scene, saved.scene);
    const layer = reloaded.scene.pages.find(p => p.zoneId === "front")!.layers.find(l => l.layerId === "l1")!;
    assert.equal(layer.xMm, 20); assert.equal(layer.yMm, 20.123); assert.equal(layer.rotationDeg, 12.5);
    assert.equal(reloaded.sceneSha256, saved.sceneSha256); assert.equal(reloaded.lifecycleState, "editable_scene");
  });
  t("optimistic revisions: a stale writer gets REVISION_CONFLICT and cannot overwrite", async () => {
    const { service } = await setup(); const g = await guest(service);
    const first = await service.saveDraft(g.id, g.access, 0, sceneWith([textLayer("t", { text: "FIRST" })]));
    assert.equal(first.draftRevision, 1);
    await assert.rejects(service.saveDraft(g.id, g.access, 0, sceneWith([textLayer("t", { text: "STALE" })])), (e: unknown) => e instanceof CompositionError && e.code === "REVISION_CONFLICT" && e.detail === "1");
    const layer = (await service.get(g.id, g.access)).scene.pages.find(p => p.zoneId === "front")!.layers[0]!;
    assert.equal(layer.kind === "text" && layer.text, "FIRST");
  });
  t("frozen versions are immutable; edits start a new draft; restore never rewrites history", async () => {
    const { service, h } = await setup(); const g = await guest(service);
    const asset = await service.uploadAsset(g.id, g.access, png(3000, 3000), "image/png");
    await markClean(h.store, g.id, asset.id, g.access, clock); // ADR-0022 D5: freeze requires every pinned asset to be clean
    const s1 = await service.saveDraft(g.id, g.access, 0, sceneWith([imageLayer("l1", asset.id, asset.sha256)]));
    const frozen = await service.freeze(g.id, g.access, s1.draftRevision);
    assert.equal(frozen.version.versionNo, 1); assert.equal(frozen.record.lifecycleState, "frozen_version"); assert.equal(frozen.version.sceneSha256, s1.sceneSha256);
    assert.equal(frozen.version.preflightState, "preview_only");
    assert.equal((await service.freeze(g.id, g.access, s1.draftRevision)).version.id, frozen.version.id); // idempotent
    const s2 = await service.saveDraft(g.id, g.access, s1.draftRevision, sceneWith([imageLayer("l1", asset.id, asset.sha256, { xMm: 40 })]));
    assert.equal(s2.lifecycleState, "editable_scene");
    assert.equal(draftProjection(s2, g.access).hasUnfrozenChanges, true);
    const v1 = await service.getVersion(g.id, frozen.version.id, g.access);
    assert.equal(v1.sceneSha256, s1.sceneSha256); assert.deepEqual(v1.scene, s1.scene);
    const second = await service.freeze(g.id, g.access, s2.draftRevision);
    assert.equal(second.version.versionNo, 2);
    const restored = await service.restore(g.id, g.access, frozen.version.id, s2.draftRevision);
    assert.deepEqual(restored.scene, s1.scene); assert.equal(restored.draftRevision, s2.draftRevision + 1);
    const versions = await service.listVersions(g.id, g.access);
    assert.deepEqual(versions.map(v => v.versionNo), [1, 2]); assert.equal(versions[1]!.sceneSha256, s2.sceneSha256);
    assert.equal((await service.get(g.id, g.access)).currentVersionId, second.version.id);
    void h;
  });
  t("preflight is preview-only: out-of-bounds freezes as blocked, nothing is ever print-eligible", async () => {
    const { service, h } = await setup(); const g = await guest(service);
    const asset = await service.uploadAsset(g.id, g.access, png(3000, 3000), "image/png");
    await markClean(h.store, g.id, asset.id, g.access, clock); // ADR-0022 D5
    const saved = await service.saveDraft(g.id, g.access, 0, sceneWith([imageLayer("l1", asset.id, asset.sha256, { xMm: 150 })]));
    const { version } = await service.freeze(g.id, g.access, saved.draftRevision);
    assert.equal(version.preflightState, "blocked"); assert.ok(version.preflightIssues.some(i => i.code === "LAYER_OUT_OF_BOUNDS"));
    assert.ok(version.preflightIssues.some(i => i.code === "PRINT_PROFILE_UNAPPROVED"));
    assert.equal(service.profile.printReleaseEligible, false);
  });
  t("owner rights: durable composition, own listing only, strangers see NOT_FOUND", async () => {
    const { service, h } = await setup(); const u1 = await h.newUser(), u2 = await h.newUser();
    const mine = await service.createOwned(u1);
    assert.equal(mine.lifecycleState, "saved_owned");
    const o1: CompositionAccess = { kind: "owner", userId: u1 }, o2: CompositionAccess = { kind: "owner", userId: u2 };
    await code(service.get(mine.id, o2), "NOT_FOUND"); await code(service.saveDraft(mine.id, o2, 0, sceneWith()), "NOT_FOUND"); await code(service.freeze(mine.id, o2, 0), "NOT_FOUND");
    assert.equal((await service.list(u1)).length, 1); assert.equal((await service.list(u2)).length, 0);
    const saved = await service.saveDraft(mine.id, o1, 0, sceneWith([textLayer("t")]));
    assert.equal(saved.lifecycleState, "saved_owned");
    const { record } = await service.freeze(mine.id, o1, saved.draftRevision);
    assert.equal(record.lifecycleState, "frozen_version");
    const edited = await service.saveDraft(mine.id, o1, saved.draftRevision, sceneWith([textLayer("t", { text: "EDIT" })]));
    assert.equal(edited.lifecycleState, "saved_owned"); // frozen -> editable_scene -> saved_owned
    await code(service.createOwned(u1, sceneWith([imageLayer("l", randomUUID(), "a".repeat(64))])), "ASSET_NOT_OWNED");
  });
  t("guest claim needs BOTH the capability and the verified M1b claim, then the capability stops working", async () => {
    const { service, h } = await setup(); const g = await guest(service), user = await h.newUser(), other = await h.newUser();
    const saved = await service.saveDraft(g.id, g.access, 0, sceneWith([textLayer("t", { text: "MINE" })]));
    await code(service.claim(g.id, user, g.capability), "NOT_FOUND"); // M1b claim not performed yet
    await code(service.claim(g.id, user, "y".repeat(43)), "NOT_FOUND");
    await h.m1bClaim(g.id, user);
    await code(service.claim(g.id, other, g.capability), "NOT_FOUND"); // a different verified user cannot adopt
    await code(service.claim(g.id, user, "y".repeat(43)), "NOT_FOUND"); // wrong capability
    const claimed = await service.claim(g.id, user, g.capability);
    assert.equal(claimed.ownerUserId, user); assert.equal(claimed.lifecycleState, "saved_owned"); assert.equal(claimed.sceneSha256, saved.sceneSha256);
    await code(service.get(g.id, g.access), "NOT_FOUND"); // leaked capability is now useless
    assert.equal((await service.claim(g.id, user, g.capability)).id, g.id); // replay is idempotent
    assert.equal((await service.get(g.id, { kind: "owner", userId: user })).draftRevision, saved.draftRevision);
    await code(service.get(g.id, { kind: "owner", userId: other }), "NOT_FOUND");
  });
}
