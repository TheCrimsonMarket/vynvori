import "server-only";
import type { PrivateMedusaConfig, PrivateServiceIdentity } from "@vynvori/commerce/identity";
import type { IdentitySettings } from "./identity-settings";
type Env = Readonly<Record<string, string | undefined>>;
/** Staging-only private transport. Credential acquisition is an explicit operator integration. */
export function privateMedusaSettings(env: Env, identity: Pick<Extract<IdentitySettings, { enabled: true }>, "enabled" | "deployment">): { config: PrivateMedusaConfig; serviceIdentity: PrivateServiceIdentity } | null {
  if (env.M1B_MEDUSA_TRANSPORT_ENABLED === undefined || env.M1B_MEDUSA_TRANSPORT_ENABLED === "false") return null;
  try {
    if (env.M1B_MEDUSA_TRANSPORT_ENABLED !== "true" || !identity.enabled || identity.deployment !== "staging") throw new Error();
    const url = new URL(env.M1B_MEDUSA_ORIGIN ?? ""), projectId = env.M1B_MEDUSA_PROJECT_ID, proofKeyId = env.M1B_BRIDGE_PROOF_KEY_ID;
    if (url.protocol !== "https:" || url.origin !== env.M1B_MEDUSA_ORIGIN || !url.hostname.endsWith(".run.app") || !projectId || projectId.length > 256 || !proofKeyId) throw new Error();
    const supplied: unknown = JSON.parse(env.M1B_BRIDGE_PROOF_KEYS_JSON ?? "");
    if (!supplied || typeof supplied !== "object" || Array.isArray(supplied) || Object.keys(supplied).length > 8) throw new Error();
    const proofKeys: Record<string, Uint8Array> = Object.create(null);
    for (const [id, value] of Object.entries(supplied)) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || typeof value !== "string") throw new Error();
      const key = Buffer.from(value, "base64"); if (key.length !== 32 || key.toString("base64") !== value) throw new Error(); proofKeys[id] = key;
    }
    if (!Object.hasOwn(proofKeys, proofKeyId)) throw new Error();
    const origin = url.origin;
    return { config: Object.freeze({ enabled: true, deployment: "staging", origin, projectId, proofKeyId, proofKeys }),
      serviceIdentity: async audience => {
        // Private, short-lived staging input only. Never accepts a browser header or claims to verify Google's signature.
        // Cloud Run validates signature/audience/IAM. These checks prevent sending stale or misdirected operator input.
        try {
          const token = env.M1B_MEDUSA_SERVICE_ID_TOKEN;
          if (audience !== origin || !token || token.length > 16384 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error();
          const claims: unknown = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());
          if (!claims || typeof claims !== "object" || !("aud" in claims) || claims.aud !== origin || !("exp" in claims) || !Number.isSafeInteger(claims.exp) || (claims.exp as number) <= Math.floor(Date.now() / 1000) + 10) throw new Error();
          return token;
        } catch { throw new Error("Private service identity unavailable"); }
      } };
  } catch { throw new Error("Invalid private Medusa transport configuration"); }
}
