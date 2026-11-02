import "server-only";
import { randomUUID } from "node:crypto";
import { compositionHttpHandlers, compositionService, compositionAssetStorage, defaultCompositionConfig } from "@vynvori/commerce/composition";
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

export function createCompositionRuntime(env: Env) {
  const settings = compositionSettings(env);
  const config = { enabled: settings.enabled, appOrigin: settings.enabled ? settings.appOrigin : "", guestTtlSeconds: defaultCompositionConfig.guestTtlMs / 1000, maxJsonBytes: 256 * 1024, maxUploadBytes: defaultCompositionConfig.imageLimits.maxBytes };
  if (!settings.enabled) return compositionHttpHandlers(config);
  const identity = getIdentityRuntime();
  if (!identity.enabled || !identity.sessions || !identity.pool) throw new Error("Composition requires the identity runtime");
  const sessions = identity.sessions;
  const storage = settings.uploads ? compositionAssetStorage({ ...env, M2_ENV: "staging" } as never) : null;
  const service = compositionService(compositionStore(identity.pool), storage, { ...defaultCompositionConfig, uploadsEnabled: settings.uploads });
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
