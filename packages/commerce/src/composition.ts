import "server-only";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import {
  CompositionSceneV1Schema, EMPTY_SYNTHETIC_SCENE, LICENSED_FONTS, SYNTHETIC_PREVIEW_PROFILE, SceneLimitError, assertSceneLimits,
  canonicalSceneJson, normalizeScene, runPreviewPreflight, sceneSourceHashes, canTransitionPlaneD,
  type AssetFacts, type CompositionSceneV1, type EditorDraftProjectionV1, type PlaneDState, type PrintProfileV1,
} from "@vynvori/contracts";
import type { CompositionAccess, CompositionRecord, AssetRecord, VersionRecord, CompositionStore } from "@vynvori/contracts/composition-port";
import { inspectImage, type ImageLimits, ImageRejectedError } from "./image-inspect";
import type { CompositionAssetStorage } from "./composition-storage";
import type { RateLimitedOperation, RatePolicies, RatePolicy } from "./composition-limits";

/** SHA-256 over the canonical normalised scene JSON. The sole definition of `sceneHashSha256`. */
export const sceneSha256 = (scene: CompositionSceneV1) => createHash("sha256").update(canonicalSceneJson(scene)).digest("hex");
export const secretHash = (secret: string) => createHash("sha256").update(secret).digest("hex");
const capabilityPattern = /^[A-Za-z0-9_-]{43}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isUuid = (value: unknown): value is string => typeof value === "string" && uuidPattern.test(value);

export type { CompositionAccess, CompositionRecord, AssetRecord, VersionRecord, SaveOutcome, CompositionStore } from "@vynvori/contracts/composition-port";

export class CompositionError extends Error {
  constructor(readonly code:
    | "NOT_FOUND" | "REVISION_CONFLICT" | "INVALID_SCENE" | "SCENE_LIMIT" | "ASSET_NOT_OWNED" | "FONT_UNLICENSED" | "UPLOADS_DISABLED"
    | "UNSUPPORTED_MEDIA" | "ASSET_TOO_LARGE" | "ASSET_QUOTA" | "OWNER_REQUIRED" | "ILLEGAL_TRANSITION" | "STORAGE_UNAVAILABLE" | "LIMITS_NOT_CONFIGURED" | "ASSET_NOT_CLEAN" | "RATE_LIMITED" | "GUEST_CAPACITY", readonly detail?: string) { super(code); this.name = "CompositionError"; }
}

/**
 * Policy numbers are supplied by the composition root from typed `M3_LIMIT_*` configuration (composition-limits.ts) and have NO
 * default. An `undefined` field means "not configured": the operation that needs it answers LIMITS_NOT_CONFIGURED.
 */
export type CompositionConfig = Readonly<{
  uploadsEnabled: boolean;
  guestTtlMs: number | undefined;
  imageLimits: ImageLimits | undefined;
  maxAssetsPerComposition: number | undefined;
  maxBytesPerComposition: number | undefined;
  /** Fixed-window policy per rate-limited operation (ADR-0022 D2). An absent entry closes that operation; nothing is ever unlimited. */
  rate: RatePolicies;
  /** Global cap of live (unexpired, unclaimed) guest drafts. `undefined` closes guest creation. */
  liveGuestDraftsMax: number | undefined;
}>;

/** What a caller is about to do, for rate limiting (ADR-0022 D1): the ten limited operations are these four kinds x guest/owner, plus the two global ones. */
export type AdmissionKind = "write" | "assetUpload" | "downloadGrant" | "rescan";
const ADMISSION_SUFFIX = { write: "WRITE", assetUpload: "ASSET_UPLOAD", downloadGrant: "DOWNLOAD_GRANT", rescan: "RESCAN" } as const;

const fontIndex = new Map(LICENSED_FONTS.map(font => [font.fontAssetId, font]));
const profileDefinitionSha = (profile: PrintProfileV1) => createHash("sha256").update(JSON.stringify(profile)).digest("hex");

/** Plane D stepwise transition; a path that skips a graph edge is rejected rather than silently written. */
export function advancePlaneD(from: PlaneDState, path: readonly PlaneDState[]): PlaneDState {
  let current = from;
  for (const next of path) {
    if (next === current) continue;
    if (!canTransitionPlaneD(current, next)) throw new CompositionError("ILLEGAL_TRANSITION", `${current}->${next}`);
    current = next;
  }
  return current;
}

export function compositionService(store: CompositionStore, storage: CompositionAssetStorage | null, config: CompositionConfig, now: () => Date = () => new Date(), profile: PrintProfileV1 = SYNTHETIC_PREVIEW_PROFILE) {
  const profileSha = profileDefinitionSha(profile);
  let profileReady: Promise<void> | undefined;
  const ready = () => (profileReady ??= store.ensurePrintProfile(profile, profileSha).catch(error => { profileReady = undefined; throw error; }));

  /** Parse + canonicalise + limit-check an untrusted scene. Returns the normalised scene and its hash. */
  function accept(raw: unknown): { scene: CompositionSceneV1; hash: string } {
    const parsed = CompositionSceneV1Schema.safeParse(raw);
    if (!parsed.success) throw new CompositionError("INVALID_SCENE");
    try { assertSceneLimits(parsed.data); } catch (error) { if (error instanceof SceneLimitError) throw new CompositionError("SCENE_LIMIT", error.message); throw error; }
    const scene = normalizeScene(parsed.data);
    if (scene.printProfileId !== profile.profileId || scene.printProfileVersion !== profile.version || scene.productFamily !== profile.productFamily) throw new CompositionError("INVALID_SCENE", "profile");
    const zones = new Set(profile.zones.map(zone => zone.zoneId));
    if (scene.pages.some(page => !zones.has(page.zoneId))) throw new CompositionError("INVALID_SCENE", "zone");
    for (const page of scene.pages) for (const layer of page.layers) {
      if (layer.kind !== "text") continue;
      const font = fontIndex.get(layer.fontAssetId);
      if (!font || font.fileSha256 !== layer.fontFileSha256 || font.licenseVersion !== layer.fontLicenseVersion) throw new CompositionError("FONT_UNLICENSED", layer.layerId);
    }
    return { scene, hash: sceneSha256(scene) };
  }
  /** A persisted scene may only reference assets that belong to THIS composition with the exact stored hash. */
  async function assertOwnedAssets(scene: CompositionSceneV1, id: string, access: CompositionAccess): Promise<ReadonlyMap<string, AssetFacts>> {
    const assets = await store.listAssets(id, access, now());
    if (!assets) throw new CompositionError("NOT_FOUND");
    const facts = new Map<string, AssetFacts>(assets.map(asset => [asset.id, { sha256: asset.sha256, widthPx: asset.widthPx, heightPx: asset.heightPx }]));
    for (const page of scene.pages) for (const layer of page.layers) {
      if (layer.kind === "image" && facts.get(layer.sourceAssetId)?.sha256 !== layer.sourceAssetSha256) throw new CompositionError("ASSET_NOT_OWNED", layer.layerId);
    }
    return facts;
  }
  const required = async (id: string, access: CompositionAccess) => {
    if (!isUuid(id)) throw new CompositionError("NOT_FOUND");
    const record = await store.get(id, access, now());
    if (!record) throw new CompositionError("NOT_FOUND"); // same answer for absent, foreign and expired: no existence oracle
    return record;
  };

  /** Flag first (UPLOADS_DISABLED), then configuration (LIMITS_NOT_CONFIGURED). Configured-but-incomplete is never unlimited. */
  function assertUploadsAvailable(): void {
    if (!config.uploadsEnabled || !storage) throw new CompositionError("UPLOADS_DISABLED");
    if (!config.imageLimits || config.maxAssetsPerComposition === undefined || config.maxBytesPerComposition === undefined) throw new CompositionError("LIMITS_NOT_CONFIGURED");
  }

  const retryAfterSeconds = (resetAt: Date, windowSeconds: number) => Math.min(windowSeconds, Math.max(1, Math.ceil((resetAt.getTime() - now().getTime()) / 1000)));
  /** One atomic admission against the database clock. A refused caller learns only how long to wait. */
  async function charge(operation: RateLimitedOperation, subject: string, policy: RatePolicy): Promise<void> {
    const outcome = await store.consumeRateToken({ operation, subject, windowSeconds: policy.windowSeconds, max: policy.max });
    if (!outcome.admitted) throw new CompositionError("RATE_LIMITED", String(retryAfterSeconds(outcome.resetAt, policy.windowSeconds)));
  }
  const policyOf = (operation: RateLimitedOperation): RatePolicy => { const policy = config.rate[operation]; if (!policy) throw new CompositionError("LIMITS_NOT_CONFIGURED"); return policy; };

  return Object.freeze({
    profile,
    assertUploadsAvailable,
    /** Flag only (UPLOADS_DISABLED). The configuration answer comes later, after access, so a caller without access learns nothing about it. */
    assertUploadsEnabled(): void { if (!config.uploadsEnabled || !storage) throw new CompositionError("UPLOADS_DISABLED"); },
    /**
     * Step 1 of the D2 order (parse and format-check ids, verify access in SQL). Nothing is charged and nothing is created. Absent,
     * foreign, expired and claimed subjects all answer the same `NOT_FOUND`. For guests this is a DATABASE check of the capability,
     * not only its cookie format.
     */
    async authorize(id: string, access: CompositionAccess): Promise<void> { await required(id, access); },
    /**
     * Steps 1 and 2 of the D2 order for one composition-scoped operation: verify access in SQL, THEN charge the bucket, and only then may
     * the caller read a request body. Safe by construction: an unauthorised subject never reaches the limiter, so it creates no bucket
     * row and learns nothing (NOT_FOUND). Guests are keyed by the composition id (the capability), owners by their verified user id.
     * An unset policy answers `LIMITS_NOT_CONFIGURED` before anything is charged. Uploads also draw on the global upload bucket, charged
     * second so a caller who is limited on its own bucket never spends the shared one.
     */
    async admit(kind: AdmissionKind, id: string, access: CompositionAccess): Promise<void> {
      await required(id, access);
      const operation = `${access.kind === "owner" ? "OWNER" : "GUEST"}_${ADMISSION_SUFFIX[kind]}` as RateLimitedOperation;
      const policy = policyOf(operation), globalPolicy = kind === "assetUpload" ? policyOf("ASSET_UPLOAD_GLOBAL") : undefined;
      await charge(operation, access.kind === "owner" ? access.userId : id, policy);
      if (globalPolicy) await charge("ASSET_UPLOAD_GLOBAL", "global", globalPolicy);
    },
    /**
     * A write by a verified owner that is not scoped to one composition they already own: creating a durable composition, or claiming
     * a guest draft (the guest capability itself is proven by the M1b claim, which runs after this charge). The charged subject is the
     * verified user, so nothing is charged for an unauthenticated caller.
     */
    async admitOwnerWrite(userId: string): Promise<void> { await charge("OWNER_WRITE", userId, policyOf("OWNER_WRITE")); },
    /**
     * Free, accountless. The raw capability is returned exactly once and only its hash is stored. Closed unless the TTL, the global
     * `GUEST_CREATE` policy and the live-draft cap are all configured; then the global bucket is charged, and the cap is enforced in
     * SQL in the same transaction as the insert (ADR-0022 D2).
     */
    async createGuest(): Promise<{ record: CompositionRecord; capability: string; expiresAt: Date }> {
      const policy = config.rate.GUEST_CREATE_GLOBAL, cap = config.liveGuestDraftsMax;
      if (config.guestTtlMs === undefined || !policy || cap === undefined) throw new CompositionError("LIMITS_NOT_CONFIGURED");
      await charge("GUEST_CREATE_GLOBAL", "global", policy);
      await ready();
      const scene = EMPTY_SYNTHETIC_SCENE(), id = randomUUID(), capability = randomBytes(32).toString("base64url");
      const at = now(), expiresAt = new Date(at.getTime() + config.guestTtlMs);
      const created = await store.createGuest({ id, capabilityHash: secretHash(capability), guestExpiresAt: expiresAt, scene, sceneSha256: sceneSha256(scene), state: "guest_draft", now: at, liveGuestDraftsMax: cap });
      if (created.status === "cap_reached") throw new CompositionError("GUEST_CAPACITY");
      return { record: created.record, capability, expiresAt };
    },
    async createOwned(userId: string, rawScene?: unknown): Promise<CompositionRecord> {
      await ready();
      const { scene, hash } = accept(rawScene ?? EMPTY_SYNTHETIC_SCENE());
      if (scene.pages.some(page => page.layers.some(layer => layer.kind === "image"))) throw new CompositionError("ASSET_NOT_OWNED"); // no assets exist yet
      return store.createOwned({ id: randomUUID(), ownerUserId: userId, scene, sceneSha256: hash, state: "saved_owned" });
    },
    get: (id: string, access: CompositionAccess) => required(id, access),
    async list(userId: string) { return store.listOwned(userId); },

    async saveDraft(id: string, access: CompositionAccess, expectedRevision: number, rawScene: unknown): Promise<CompositionRecord> {
      const current = await required(id, access);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new CompositionError("INVALID_SCENE", "revision");
      const { scene, hash } = accept(rawScene);
      await assertOwnedAssets(scene, id, access);
      const target: PlaneDState = access.kind === "owner" ? "saved_owned" : "editable_scene";
      // frozen_version -> editable_scene -> saved_owned (owner) | guest_draft -> editable_scene (guest)
      const state = advancePlaneD(current.lifecycleState, access.kind === "owner" ? ["editable_scene", target] : ["editable_scene"]);
      const outcome = await store.saveDraft(id, access, now(), { expectedRevision, scene, sceneSha256: hash, state });
      if (outcome.status === "conflict") throw new CompositionError("REVISION_CONFLICT", String(outcome.currentRevision));
      if (outcome.status === "not_found") throw new CompositionError("NOT_FOUND");
      return outcome.record;
    },

    /** Convert the live draft into the next immutable version. The frozen row is never edited afterwards. */
    async freeze(id: string, access: CompositionAccess, expectedRevision: number): Promise<{ version: VersionRecord; record: CompositionRecord }> {
      const current = await required(id, access);
      if (current.draftRevision !== expectedRevision) throw new CompositionError("REVISION_CONFLICT", String(current.draftRevision));
      const facts = await assertOwnedAssets(current.scene, id, access);
      const fonts = fontIndex;
      const preflight = runPreviewPreflight(current.scene, profile, facts, fonts);
      const hashes = sceneSourceHashes(current.scene);
      const state = advancePlaneD(current.lifecycleState, current.lifecycleState === "guest_draft" ? ["editable_scene", "frozen_version"] : ["frozen_version"]);
      const result = await store.freeze(id, access, now(), {
        expectedRevision, state, sourceAssetSha256: hashes.assets, sourceFontSha256: hashes.fonts,
        version: { id: randomUUID(), scene: current.scene, sceneSha256: current.sceneSha256, printProfileId: profile.profileId, printProfileVersion: profile.version, preflightState: preflight.state, preflightIssues: preflight.issues },
      });
      if (result.status === "conflict") throw new CompositionError("REVISION_CONFLICT", String(result.currentRevision));
      if (result.status === "not_found") throw new CompositionError("NOT_FOUND");
      if (result.status === "asset_not_clean") throw new CompositionError("ASSET_NOT_CLEAN"); // D5: checked by the store inside the freeze transaction
      return { version: result.version, record: result.record };
    },

    /** Restore = copy a frozen scene into the draft as a NEW revision. The frozen version itself is untouched. */
    async restore(id: string, access: CompositionAccess, versionId: string, expectedRevision: number): Promise<CompositionRecord> {
      await required(id, access);
      if (!isUuid(versionId)) throw new CompositionError("NOT_FOUND");
      const version = await store.getVersion(id, versionId, access, now());
      if (!version) throw new CompositionError("NOT_FOUND");
      return this.saveDraft(id, access, expectedRevision, version.scene);
    },
    async getVersion(id: string, versionId: string, access: CompositionAccess) {
      await required(id, access);
      if (!isUuid(versionId)) throw new CompositionError("NOT_FOUND");
      const version = await store.getVersion(id, versionId, access, now());
      if (!version) throw new CompositionError("NOT_FOUND");
      return version;
    },
    async listVersions(id: string, access: CompositionAccess) {
      const versions = isUuid(id) ? await store.listVersions(id, access, now()) : null;
      if (!versions) throw new CompositionError("NOT_FOUND");
      return versions;
    },
    async listAssets(id: string, access: CompositionAccess) {
      const assets = isUuid(id) ? await store.listAssets(id, access, now()) : null;
      if (!assets) throw new CompositionError("NOT_FOUND");
      return assets;
    },

    /** Adopt a guest composition after M1b `claimGuest` succeeded for the same draft. Fails closed on any mismatch. */
    async claim(id: string, userId: string, capability: string): Promise<CompositionRecord> {
      if (!isUuid(id) || !capabilityPattern.test(capability)) throw new CompositionError("NOT_FOUND");
      const current = await store.get(id, { kind: "owner", userId }, now()).catch(() => null);
      if (current) return current; // already owned by this user (idempotent replay)
      const record = await store.adoptClaimedGuest(id, userId, secretHash(capability), now());
      if (!record) throw new CompositionError("NOT_FOUND");
      return record;
    },

    /** Store the unchanged original privately. Disabled unless `assets.production_uploads` is enabled by the composition root. */
    async uploadAsset(id: string, access: CompositionAccess, bytes: Uint8Array, declaredMime: string | null): Promise<AssetRecord> {
      assertUploadsAvailable();
      if (!storage) throw new CompositionError("UPLOADS_DISABLED"); // narrowing only; assertUploadsAvailable already refused this
      const { imageLimits, maxAssetsPerComposition, maxBytesPerComposition } = config;
      if (!imageLimits || maxAssetsPerComposition === undefined || maxBytesPerComposition === undefined) throw new CompositionError("LIMITS_NOT_CONFIGURED");
      await required(id, access);
      let image;
      try { image = inspectImage(bytes, imageLimits); }
      catch (error) {
        if (error instanceof ImageRejectedError) throw new CompositionError(error.code === "TOO_LARGE" ? "ASSET_TOO_LARGE" : "UNSUPPORTED_MEDIA", error.code);
        throw error;
      }
      if (declaredMime && declaredMime.split(";")[0]!.trim().toLowerCase() !== image.mime) throw new CompositionError("UNSUPPORTED_MEDIA", "MIME_MISMATCH");
      const existing = (await store.listAssets(id, access, now())) ?? [];
      const duplicate = existing.find(asset => asset.sha256 === image.sha256);
      if (duplicate) return duplicate;
      if (existing.length >= maxAssetsPerComposition || existing.reduce((sum, asset) => sum + asset.byteSize, 0) + bytes.byteLength > maxBytesPerComposition) throw new CompositionError("ASSET_QUOTA");
      const objectKey = `private/composition/v1/${id}/${image.sha256}`;
      try { await storage.put(objectKey, bytes, image.mime, image.sha256); }
      catch { throw new CompositionError("STORAGE_UNAVAILABLE"); }
      // The quota is enforced again, authoritatively, in SQL under the per-composition lock: the pre-check above only avoids a pointless
      // storage write. (A concurrent loser can still leave one unreferenced private object; no garbage collection exists in W1.)
      const outcome = await store.insertAsset(id, access, now(), { id: randomUUID(), sha256: image.sha256, mime: image.mime, byteSize: bytes.byteLength, widthPx: image.widthPx, heightPx: image.heightPx, objectKey }, { maxAssets: maxAssetsPerComposition, maxBytes: maxBytesPerComposition });
      if (outcome.status === "quota_exceeded") throw new CompositionError("ASSET_QUOTA");
      if (outcome.status === "not_found") throw new CompositionError("NOT_FOUND");
      return outcome.asset;
    },
    /** Bytes are streamed through the app after an ownership check; no presigned or public URL is ever issued. */
    async readAsset(id: string, assetId: string, access: CompositionAccess): Promise<{ asset: AssetRecord; bytes: Uint8Array }> {
      if (!storage || !isUuid(id) || !isUuid(assetId)) throw new CompositionError("NOT_FOUND");
      const asset = await store.getAsset(id, assetId, access, now());
      if (!asset) throw new CompositionError("NOT_FOUND");
      try { return { asset, bytes: await storage.get(asset.objectKey, asset.sha256, asset.byteSize) }; }
      catch { throw new CompositionError("STORAGE_UNAVAILABLE"); }
    },
  });
}
export type CompositionService = ReturnType<typeof compositionService>;

/** ED-02 draft projection. Never includes capability material. */
export function draftProjection(record: CompositionRecord, access: CompositionAccess, selectedZoneId?: string): EditorDraftProjectionV1 {
  const zones = record.scene.pages.map(page => page.zoneId);
  return {
    schemaVersion: "editor-draft.v1", compositionId: record.id, draftRevision: record.draftRevision,
    ownerKind: access.kind === "owner" ? "authenticated_owner" : "guest_capability",
    pages: record.scene.pages.map(page => ({ zoneId: page.zoneId, layers: [...page.layers] })),
    selectedZoneId: selectedZoneId && zones.includes(selectedZoneId) ? selectedZoneId : zones[0]!,
    hasUnfrozenChanges: record.currentVersionSceneSha256 !== record.sceneSha256,
    canPersistToAccount: access.kind === "guest",
  };
}
