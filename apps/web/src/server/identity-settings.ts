import "server-only";
import { parseServerConfig } from "@vynvori/shared/server";
type Env = Readonly<Record<string, string | undefined>>;
type EnabledSettings = Readonly<{ enabled: true; deployment: "staging"; appOrigin: string; issuer: string; apiBase: string; audience: string; clientId: string; clientSecret: string; callback: string;
  currentKeyId: string; keys: Readonly<Record<string, Uint8Array>>; databaseUrl: string; databaseHost: string }>;
export type IdentitySettings = Readonly<{ enabled: false }> | EnabledSettings;
export function identitySettings(env: Env): IdentitySettings {
  if (!parseServerConfig(env).features["identity.central_sso"]) return Object.freeze({ enabled: false });
  try {
    if (env.NODE_TLS_REJECT_UNAUTHORIZED !== undefined && env.NODE_TLS_REJECT_UNAUTHORIZED !== "1") throw new Error();
    const clientId = env.M1B_CENTRAL_CLIENT_ID, clientSecret = env.M1B_CENTRAL_CLIENT_SECRET, currentKeyId = env.M1B_CURRENT_KEY_ID;
    if (!clientId || !/^tcm_[a-f0-9]{32}$/.test(clientId) || !clientSecret || clientSecret.length < 32 || clientSecret.length > 4096 || /[\x00-\x20\x7f]/.test(clientSecret) || !currentKeyId) throw new Error();
    const supplied: unknown = JSON.parse(env.M1B_CREDENTIAL_KEYS_JSON ?? "");
    if (!supplied || typeof supplied !== "object" || Array.isArray(supplied) || Object.keys(supplied).length > 8) throw new Error();
    const keys: Record<string, Uint8Array> = Object.create(null);
    for (const [id, value] of Object.entries(supplied)) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || typeof value !== "string") throw new Error();
      const bytes = Buffer.from(value, "base64"); if (bytes.length !== 32 || bytes.toString("base64") !== value) throw new Error(); keys[id] = bytes;
    }
    if (!Object.hasOwn(keys, currentKeyId)) throw new Error();
    const url = new URL(env.M1B_CREATIVE_DATABASE_URL ?? ""), host = env.M1B_CREATIVE_DATABASE_HOST;
    if (!host || !host.endsWith(".neon.tech") || !host.includes("-pooler.") || url.hostname !== host ||
        !["postgres:", "postgresql:"].includes(url.protocol) || url.pathname !== "/vynvori_creative_staging" || !url.password || decodeURIComponent(url.username) !== "vynvori_identity_runtime_scoped" ||
        url.hash || [...url.searchParams].length !== 1 || url.searchParams.get("sslmode") !== "verify-full") throw new Error();
    const appOrigin = "https://staging.vynvori.com", issuer = "https://dev.portal.raum.au";
    return Object.freeze({ enabled: true, deployment: "staging", appOrigin, issuer, apiBase: issuer + "/mana", audience: "urn:vynvori:staging", clientId, clientSecret,
      callback: appOrigin + "/auth/tcm/callback", currentKeyId, keys: Object.freeze(keys), databaseUrl: url.toString(), databaseHost: host });
  } catch { throw new Error("Invalid private identity configuration"); }
}
