import "server-only";
import { randomUUID } from "node:crypto";
import { compositionHttpHandlers, compositionService, compositionAssetStorage, parseCompositionLimits, resolveApiLimits, resolveGuestCreateLimits, resolveUploadLimits } from "@vynvori/commerce/composition";
import { compositionStore } from "@vynvori/db/composition";
import { getIdentityRuntime } from "./auth-runtime";
import { identitySettings } from "./identity-settings";

type Env = Readonly<Record<string, string | undefined>>;
export type CompositionSettings = Readonly<{ enabled: false }> | Readonly<{ enabled: true; appOrigin: string; uploads: boolean }>;
/**
 * Closed by default. The composition API needs (1) the isolated staging identity canary (it shares the verified-session and
 * guest-capability tables), (2) an explicit M3_COMPOSITION_ENABLED=true, and (3) never a production deployment. Uploads need a
 * further explicit staging opt-in plus pinned R2 configuration; `assets.production_uploads` itself stays OFF and unsettable.
 */
export function compositionSettings(env: Env): CompositionSettings {
  if (env.M3_COMPOSITION_ENABLED !== "true") return Object.freeze({ enabled: false });
  const identity = identitySettings(env); // throws on invalid private config; returns disabled outside the canary
  if (!identity.enabled || env.VERCEL_ENV === "production") return Object.freeze({ enabled: false });
  return Object.freeze({ enabled: true, appOrigin: identity.appOrigin, uploads: env.M3_COMPOSITION_UPLOADS === "true" });
}

/** Upload limits for the editor, from the SAME parsed `M3_LIMIT_*` configuration the API enforces; null while any needed key is unset. */
export function uploadLimitsFor(env: Env): Readonly<{ maxBytes: number; maxPixels: number; maxSidePx: number }> | null {
  const limits = resolveUploadLimits(parseCompositionLimits(env));
  return limits ? Object.freeze({ maxBytes: limits.imageLimits.maxBytes, maxPixels: limits.imageLimits.maxPixels, maxSidePx: limits.imageLimits.maxSide }) : null;
}

/**
 * What the editor UI may offer. Derived from the SAME settings the API routes gate on, never from a separate client default:
 * with any flag OFF (the default) artwork upload is unavailable, and an invalid private configuration also fails closed.
 * `uploadLimits` is the only source of the editor's client-side pre-check numbers; it is null unless uploads are enabled AND
 * every needed limit is configured. The server stays authoritative.
 */
export function editorCapabilities(env: Env): Readonly<{ artworkUpload: boolean; uploadLimits: Readonly<{ maxBytes: number; maxPixels: number; maxSidePx: number }> | null }> {
  try {
    const settings = compositionSettings(env), artworkUpload = settings.enabled && settings.uploads;
    return Object.freeze({ artworkUpload, uploadLimits: artworkUpload ? uploadLimitsFor(env) : null });
  } catch { return Object.freeze({ artworkUpload: false, uploadLimits: null }); }
}

export function createCompositionRuntime(env: Env) {
  const settings = compositionSettings(env);
  const parsed = parseCompositionLimits(env), api = resolveApiLimits(parsed), guest = resolveGuestCreateLimits(parsed), uploads = resolveUploadLimits(parsed);
  // Unset or invalid keys leave the field undefined, which closes the capability (COMPOSITION_LIMITS_NOT_CONFIGURED). No fallback.
  const config = { enabled: settings.enabled, appOrigin: settings.enabled ? settings.appOrigin : "", guestTtlSeconds: guest?.guestTtlSeconds, maxJsonBytes: api?.jsonMaxBytes, maxUploadBytes: uploads?.imageLimits.maxBytes };
  if (!settings.enabled) return compositionHttpHandlers(config);
  const identity = getIdentityRuntime();
  if (!identity.enabled || !identity.sessions || !identity.pool) throw new Error("Composition requires the identity runtime");
  const sessions = identity.sessions;
  const storage = settings.uploads ? compositionAssetStorage({ ...env, M2_ENV: "staging" } as never) : null;
  const service = compositionService(compositionStore(identity.pool), storage, {
    uploadsEnabled: settings.uploads, guestTtlMs: guest ? guest.guestTtlSeconds * 1000 : undefined, imageLimits: uploads?.imageLimits,
    maxAssetsPerComposition: uploads?.maxAssetsPerComposition, maxBytesPerComposition: uploads?.maxBytesPerComposition,
  });
  return compositionHttpHandlers(config, service, {
    async verify(secret) { const session = await sessions.verify(secret); return { userId: session.userId }; },
    claimGuest: (secret, draftId, capability) => sessions.claimGuest(secret, draftId, capability),
  });
}
let current: ReturnType<typeof createCompositionRuntime> | undefined;
export type CompositionOperation = keyof ReturnType<typeof createCompositionRuntime>;
export async function invokeCompositionRoute(operation: CompositionOperation, request: Request, params: Record<string, string> = {}): Promise<Response> {
  try { return await (current ??= createCompositionRuntime(process.env))[operation](request, params); }
  catch { return Response.json({ error: { code: "COMPOSITION_UNAVAILABLE", message: "The editor service is temporarily unavailable.", retryable: true, correlationId: randomUUID() } }, { status: 503, headers: { "cache-control": "no-store, max-age=0", "referrer-policy": "no-referrer" } }); }
}
