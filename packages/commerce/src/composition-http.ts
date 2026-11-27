import "server-only";
import { randomUUID, timingSafeEqual } from "node:crypto";
import type { CompositionReviewProjectionV1 } from "@vynvori/contracts";
import { CompositionError, draftProjection, isUuid, secretHash, type AssetRecord, type CompositionAccess, type CompositionRecord, type CompositionService, type VersionRecord } from "./composition";

export const compositionCookies = Object.freeze({ guest: "__Host-vynvori_guest", session: "__Host-vynvori_session", csrf: "__Host-vynvori_csrf" });
const opaque = /^[A-Za-z0-9_-]{43}$/;
const statuses: Record<CompositionError["code"], [number, string, boolean]> = {
  NOT_FOUND: [404, "The requested composition was not found.", false],
  REVISION_CONFLICT: [409, "This composition changed elsewhere. Reload before saving.", false],
  INVALID_SCENE: [422, "The composition is not valid.", false],
  SCENE_LIMIT: [422, "The composition exceeds an allowed limit.", false],
  ASSET_NOT_OWNED: [422, "A layer references artwork that is not part of this composition.", false],
  FONT_UNLICENSED: [422, "A text layer uses a font that is not available.", false],
  UPLOADS_DISABLED: [503, "Artwork upload is not available yet.", false],
  UNSUPPORTED_MEDIA: [415, "Upload a PNG, JPEG or WebP image.", false],
  ASSET_TOO_LARGE: [413, "That file is too large.", false],
  ASSET_QUOTA: [409, "This composition has reached its artwork limit.", false],
  OWNER_REQUIRED: [401, "Sign in to continue.", false],
  ILLEGAL_TRANSITION: [409, "That change is not allowed in the current state.", false],
  STORAGE_UNAVAILABLE: [503, "Storage is temporarily unavailable.", true],
  LIMITS_NOT_CONFIGURED: [503, "This feature is not configured yet.", false],
  ASSET_NOT_CLEAN: [409, "Artwork in this design has not passed its safety check yet.", false],
  RATE_LIMITED: [429, "Too many requests. Wait a moment and try again.", true],
  GUEST_CAPACITY: [503, "Guest drafts are at capacity right now. Try again later or sign in.", true],
  SCAN_UNAVAILABLE: [503, "Artwork safety checks are not available yet.", false],
};
class HttpError extends Error { constructor(readonly status: number, readonly code: "INVALID_REQUEST" | "FORBIDDEN" | "AUTH_REQUIRED" | "DISABLED" | "UNAVAILABLE") { super(code); } }

export interface CompositionIdentityPort {
  verify(sessionSecret: string): Promise<Readonly<{ userId: string }>>;
  claimGuest(sessionSecret: string, draftId: string, capability: string): Promise<void>;
}
/** Limits come from typed `M3_LIMIT_*` configuration and have no default; `undefined` closes the route that needs them. */
export type CompositionHttpConfig = Readonly<{ enabled: boolean; appOrigin: string; guestTtlSeconds: number | undefined; maxJsonBytes: number | undefined; maxUploadBytes: number | undefined }>;

function cookie(request: Request, name: string): string | null {
  const values = (request.headers.get("cookie") ?? "").split(";").map(part => part.trim()).filter(part => part.slice(0, part.indexOf("=")) === name);
  if (values.length > 1) throw new HttpError(400, "INVALID_REQUEST");
  return values[0]?.slice(name.length + 1) ?? null;
}
const baseHeaders = () => new Headers({ "cache-control": "private, no-store, max-age=0", pragma: "no-cache", vary: "Cookie", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" });
/**
 * The ONLY shape in which an asset leaves the API (ADR-0022 C5 whitelist). `scanStatus` is the coarse current status; scan history,
 * evidence references, scanner identifiers, attempt ids and object keys are internal and are never serialised.
 */
const assetView = (a: Pick<AssetRecord, "id" | "sha256" | "mime" | "widthPx" | "heightPx" | "scanStatus">) => ({ assetId: a.id, sha256: a.sha256, mime: a.mime, widthPx: a.widthPx, heightPx: a.heightPx, scanStatus: a.scanStatus });
const json = (value: unknown, status = 200, extra?: Headers) => { const headers = baseHeaders(); extra?.forEach((v, k) => headers.append(k, v)); return Response.json(value, { status, headers }); };

async function readBody(request: Request, limit: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413 as never, "INVALID_REQUEST");
  if (!request.body) throw new HttpError(400, "INVALID_REQUEST");
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HttpError(400, "INVALID_REQUEST")), 30000); });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      size += part.value.length;
      if (size > limit) throw new HttpError(413 as never, "INVALID_REQUEST");
      chunks.push(part.value);
    }
    return Buffer.concat(chunks);
  } finally { if (timer) clearTimeout(timer); void reader.cancel().catch(() => {}); }
}

/**
 * Framework-independent HTTP boundary for /api/v1/compositions (docs/technical/16-api-contracts.md). Next route files only
 * forward `Request` + path params. Guest access = HttpOnly Strict capability cookie; owner access = M1b verified session.
 */
export function compositionHttpHandlers(config: CompositionHttpConfig, service?: CompositionService, identity?: CompositionIdentityPort) {
  const cfg = Object.freeze({ ...config });
  if (cfg.enabled && (!service || !identity || new URL(cfg.appOrigin).origin !== cfg.appOrigin)) throw new Error("Composition HTTP dependencies missing");

  function guardMutation(request: Request, hasSession: boolean) {
    if (request.headers.get("origin") !== cfg.appOrigin || (request.headers.has("sec-fetch-site") && request.headers.get("sec-fetch-site") !== "same-origin")) throw new HttpError(403, "FORBIDDEN");
    if (hasSession) { // Lax session cookie => double-submit CSRF exactly as the M1b auth routes
      const supplied = request.headers.get("x-vynvori-csrf"), stored = cookie(request, compositionCookies.csrf);
      if (!supplied || !stored || !opaque.test(supplied) || !opaque.test(stored) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(stored))) throw new HttpError(403, "FORBIDDEN");
    }
  }
  /** Resolve who is calling. A present-but-invalid session is a 401, never a silent downgrade to guest. */
  /** The API as a whole needs the JSON limit. Checked only AFTER the caller is authenticated, so unauthenticated callers learn nothing about configuration. */
  const requireApiLimits = () => { if (cfg.maxJsonBytes === undefined) throw new CompositionError("LIMITS_NOT_CONFIGURED"); };
  async function actor(request: Request, compositionId: string | null, mutating: boolean, needsApi = true): Promise<{ access: CompositionAccess; session: string | null }> {
    const resolved = await resolveActor(request, compositionId, mutating);
    if (needsApi) requireApiLimits();
    return resolved;
  }
  async function resolveActor(request: Request, compositionId: string | null, mutating: boolean): Promise<{ access: CompositionAccess; session: string | null }> {
    if (!cfg.enabled) throw new HttpError(503, "DISABLED");
    const session = cookie(request, compositionCookies.session);
    if (mutating) guardMutation(request, session !== null);
    if (session !== null) {
      if (!opaque.test(session)) throw new HttpError(401, "AUTH_REQUIRED");
      try { return { access: { kind: "owner", userId: (await identity!.verify(session)).userId }, session }; }
      catch { throw new HttpError(401, "AUTH_REQUIRED"); }
    }
    const guest = cookie(request, compositionCookies.guest), [id, capability] = (guest ?? "").split(".");
    if (!guest || !id || !capability || !opaque.test(capability) || !isUuid(id) || (compositionId !== null && id !== compositionId)) throw new HttpError(401, "AUTH_REQUIRED");
    return { access: { kind: "guest", capabilityHash: secretHash(capability) }, session: null };
  }
  const requireOwner = async (request: Request, mutating: boolean) => {
    const resolved = await actor(request, null, mutating);
    if (resolved.access.kind !== "owner") throw new HttpError(401, "AUTH_REQUIRED");
    return resolved as { access: Extract<CompositionAccess, { kind: "owner" }>; session: string };
  };
  const view = (record: CompositionRecord, access: CompositionAccess, zone?: string) => ({ draft: draftProjection(record, access, zone), lifecycleState: record.lifecycleState, currentVersionId: record.currentVersionId, expiresAt: record.guestExpiresAt?.toISOString() ?? null, printProfile: { profileId: record.printProfileId, version: record.printProfileVersion, previewOnly: true } });
  const versionView = (v: VersionRecord) => ({ versionId: v.id, versionNo: v.versionNo, sceneHashSha256: v.sceneSha256, frozenAt: v.frozenAt.toISOString(), preflight: { state: v.preflightState, issues: v.preflightIssues, printProfileVersion: v.printProfileVersion } });

  function wrapped(handler: (request: Request, params: Record<string, string>) => Promise<Response>) {
    return async (request: Request, params: Record<string, string> = {}): Promise<Response> => {
      try {
        return await handler(request, params);
      }
      catch (error) {
        const correlationId = randomUUID();
        if (error instanceof CompositionError) {
          const [status, message, retryable] = statuses[error.code];
          // 429 carries Retry-After (whole seconds, from the database-clock window), in the header and in the body for the editor.
          const wait = error.code === "RATE_LIMITED" ? Number(error.detail) : null;
          return json({ error: { code: `COMPOSITION_${error.code}`, message, retryable, correlationId, ...(error.code === "REVISION_CONFLICT" ? { currentRevision: Number(error.detail) } : {}), ...(wait !== null ? { retryAfterSeconds: wait } : {}) } }, status, wait !== null ? new Headers({ "retry-after": String(wait) }) : undefined);
        }
        if (error instanceof HttpError) {
          const status = error.status as number;
          const message = { INVALID_REQUEST: "Invalid request.", FORBIDDEN: "This request is not permitted.", AUTH_REQUIRED: "Sign in again or start a new draft.", DISABLED: "The editor service is not available yet.", UNAVAILABLE: "Temporarily unavailable." }[error.code];
          return json({ error: { code: `COMPOSITION_${error.code}`, message, retryable: error.code === "UNAVAILABLE", correlationId } }, status);
        }
        return json({ error: { code: "COMPOSITION_UNAVAILABLE", message: "Temporarily unavailable.", retryable: true, correlationId } }, 503);
      }
    };
  }
  const requireJsonLimit = (): number => { if (cfg.maxJsonBytes === undefined) throw new CompositionError("LIMITS_NOT_CONFIGURED"); return cfg.maxJsonBytes; };
  const parseJson = async (request: Request): Promise<Record<string, unknown>> => {
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new HttpError(400, "INVALID_REQUEST");
    try {
      const value: unknown = JSON.parse(Buffer.from(await readBody(request, requireJsonLimit())).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      return value as Record<string, unknown>;
    } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, "INVALID_REQUEST"); }
  };
  const exact = (data: Record<string, unknown>, allowed: string[]) => { if (Object.keys(data).some(key => !allowed.includes(key))) throw new HttpError(400, "INVALID_REQUEST"); };
  const revisionOf = (data: Record<string, unknown>) => { if (typeof data.expectedRevision !== "number" || !Number.isSafeInteger(data.expectedRevision) || data.expectedRevision < 0) throw new HttpError(400, "INVALID_REQUEST"); return data.expectedRevision; };
  const id = (params: Record<string, string>, key: string) => { const value = params[key]; if (!isUuid(value)) throw new CompositionError("NOT_FOUND"); return value; };

  return Object.freeze({
    /** POST /api/v1/compositions. No session => free guest draft + capability cookie. Session => durable owned composition. */
    create: wrapped(async request => {
      if (!cfg.enabled) throw new HttpError(503, "DISABLED");
      const session = cookie(request, compositionCookies.session);
      if (session !== null) {
        const { access } = await requireOwner(request, true);
        await service!.admitOwnerWrite(access.userId); // charge before any body is read (ADR-0022 D2)
        const data = request.headers.get("content-length") === "0" ? {} : await parseJson(request).catch(() => ({}));
        exact(data, ["scene"]);
        const record = await service!.createOwned(access.userId, data.scene);
        return json(view(record, access), 201);
      }
      guardMutation(request, false);
      requireApiLimits();
      if (cfg.guestTtlSeconds === undefined) throw new CompositionError("LIMITS_NOT_CONFIGURED");
      const { record, capability, expiresAt } = await service!.createGuest();
      const headers = new Headers({ "set-cookie": `${compositionCookies.guest}=${record.id}.${capability}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${cfg.guestTtlSeconds}` });
      void expiresAt;
      return json(view(record, { kind: "guest", capabilityHash: secretHash(capability) }), 201, headers);
    }),
    list: wrapped(async request => {
      const { access } = await requireOwner(request, false);
      const records = await service!.list(access.userId);
      return json({ compositions: records.map(record => ({ compositionId: record.id, lifecycleState: record.lifecycleState, draftRevision: record.draftRevision, updatedAt: record.updatedAt.toISOString() })) });
    }),
    get: wrapped(async (request, params) => {
      const compositionId = id(params, "id"), { access } = await actor(request, compositionId, false);
      const [record, assets, versions] = await Promise.all([service!.get(compositionId, access), service!.listAssets(compositionId, access), service!.listVersions(compositionId, access)]);
      return json({ ...view(record, access, new URL(request.url).searchParams.get("zone") ?? undefined), scene: record.scene, sceneHashSha256: record.sceneSha256,
        assets: assets.map(assetView), versions: versions.map(versionView) });
    }),
    save: wrapped(async (request, params) => {
      const compositionId = id(params, "id"), { access } = await actor(request, compositionId, true, false); // the JSON-limit answer waits until access is proven
      await service!.admit("write", compositionId, access); // access in SQL, then charge, then (only then) the body
      requireApiLimits();
      const data = await parseJson(request); exact(data, ["expectedRevision", "scene"]);
      const record = await service!.saveDraft(compositionId, access, revisionOf(data), data.scene);
      return json({ ...view(record, access), sceneHashSha256: record.sceneSha256 });
    }),
    freeze: wrapped(async (request, params) => {
      const compositionId = id(params, "id"), { access } = await actor(request, compositionId, true, false); // the JSON-limit answer waits until access is proven
      await service!.admit("write", compositionId, access);
      requireApiLimits();
      const data = await parseJson(request); exact(data, ["expectedRevision"]);
      const { version, record } = await service!.freeze(compositionId, access, revisionOf(data));
      return json({ ...view(record, access), version: versionView(version) }, 201);
    }),
    restore: wrapped(async (request, params) => {
      const compositionId = id(params, "id"), { access } = await actor(request, compositionId, true, false); // the JSON-limit answer waits until access is proven
      await service!.admit("write", compositionId, access);
      requireApiLimits();
      const data = await parseJson(request); exact(data, ["expectedRevision", "versionId"]);
      if (typeof data.versionId !== "string") throw new HttpError(400, "INVALID_REQUEST");
      const record = await service!.restore(compositionId, access, data.versionId, revisionOf(data));
      return json({ ...view(record, access), scene: record.scene, sceneHashSha256: record.sceneSha256 });
    }),
    /** ED-03 version-bound review. Preview-only: no proof artifact, no quote, no cart (M4/M5). */
    review: wrapped(async (request, params) => {
      const compositionId = id(params, "id"), { access } = await actor(request, compositionId, false);
      const version = await service!.getVersion(compositionId, id(params, "versionId"), access);
      const projection: CompositionReviewProjectionV1 = {
        screenId: "ED-03",
        identity: { compositionId, compositionVersionId: version.id as never, sceneHashSha256: version.sceneSha256, variantId: "unselected", printProfileVersion: version.printProfileVersion },
        displayedProof: null,
        validation: { validationId: `preflight:${version.id}`, sourceCompositionVersionId: version.id as never, sourceSceneSha256: version.sceneSha256, state: version.preflightState, issueCodes: version.preflightIssues.map(issue => issue.code), rightsSnapshotId: "none:m3-preview-only", printProfileVersion: version.printProfileVersion },
        cartQuote: null,
        newUnfrozenEditsExist: (await service!.get(compositionId, access)).sceneSha256 !== version.sceneSha256,
        allowedActions: ["inspect", "edit_new_version", ...(access.kind === "guest" ? ["sign_in" as const] : [])],
      };
      return json({ review: projection, preflightIssues: version.preflightIssues });
    }),
    claim: wrapped(async (request, params) => {
      const compositionId = id(params, "id"), session = cookie(request, compositionCookies.session);
      const resolved = await requireOwner(request, true);
      const [cookieId, capability] = (cookie(request, compositionCookies.guest) ?? "").split(".");
      if (cookieId !== compositionId || !capability || !opaque.test(capability)) throw new HttpError(401, "AUTH_REQUIRED");
      await service!.admitOwnerWrite(resolved.access.userId); // charged to the verified user before the M1b claim runs
      try { await identity!.claimGuest(session!, compositionId, capability); } catch { throw new CompositionError("NOT_FOUND"); }
      const record = await service!.claim(compositionId, resolved.access.userId, capability);
      const headers = new Headers({ "set-cookie": `${compositionCookies.guest}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` });
      return json(view(record, resolved.access), 200, headers);
    }),
    uploadAsset: wrapped(async (request, params) => {
      const compositionId = id(params, "id"), { access } = await actor(request, compositionId, true, false);
      // ADR-0022 D2 / F4b order: format-check ids and credentials, access verified IN SQL (a guest cookie's format proves nothing), flag,
      // configuration, charge, and only then read the body. A caller without access therefore buffers nothing, creates no bucket row and
      // learns nothing about configuration.
      await service!.authorize(compositionId, access);
      service!.assertUploadsEnabled();
      service!.assertUploadsAvailable();
      requireApiLimits();
      if (cfg.maxUploadBytes === undefined) throw new CompositionError("LIMITS_NOT_CONFIGURED");
      await service!.admit("assetUpload", compositionId, access);
      const bytes = await readBody(request, cfg.maxUploadBytes);
      const asset = await service!.uploadAsset(compositionId, access, bytes, request.headers.get("content-type"));
      // ADR-0022 D3: scanned inline, once, after the row exists. The verdict comes only from the server's scan port; nothing from this
      // request (no header, no field) can influence it. A non-clean result is still a stored upload (201) with its status.
      const scanStatus = await service!.scanAsset(compositionId, asset.id, access, bytes);
      return json({ asset: assetView({ ...asset, scanStatus }) }, 201);
    }),
    /**
     * POST /api/v1/compositions/:id/assets/:assetId/scan: an explicit rescan request (ADR-0022 C5). It accepts NO body: no verdict,
     * evidence, reason or time can come from the client (C3b hard gate). Order: ids and credentials, access in SQL, scanner and
     * configuration, charge `*_RESCAN`, then the empty-body check. Answers only the coarse status.
     */
    scanAsset: wrapped(async (request, params) => {
      const compositionId = id(params, "id"), assetId = id(params, "assetId"), { access } = await actor(request, compositionId, true, false);
      await service!.authorize(compositionId, access);
      service!.assertScanningAvailable();
      requireApiLimits();
      await service!.admit("rescan", compositionId, access);
      if (request.body) await readBody(request, 0); // any byte at all is refused (413)
      const scanStatus = await service!.rescanAsset(compositionId, assetId, access);
      return json({ asset: { assetId, scanStatus } });
    }),
    readAsset: wrapped(async (request, params) => {
      const compositionId = id(params, "id"), { access } = await actor(request, compositionId, false);
      const { asset, bytes } = await service!.readAsset(compositionId, id(params, "assetId"), access);
      const headers = baseHeaders();
      headers.set("content-type", asset.mime); headers.set("content-length", String(bytes.byteLength));
      headers.set("content-security-policy", "default-src 'none'; sandbox"); headers.set("cross-origin-resource-policy", "same-origin");
      headers.set("content-disposition", 'inline; filename="artwork"'); headers.set("etag", `"${asset.sha256}"`);
      return new Response(Buffer.from(bytes), { status: 200, headers });
    }),
  });
}
