import { bridgeRequestProof } from "./medusa-proof";
import type { CentralIdentityConfig } from "./central-identity";
type Env = Readonly<Record<string, string | undefined>>;
export type BridgeSettings = Readonly<{ enabled: false }> | (CentralIdentityConfig & Readonly<{ enabled: true; origin: string; projectId: string; proof: ReturnType<typeof bridgeRequestProof> }>);
export function bridgeSettings(env: Env): BridgeSettings {
  if (env.M1B_MEDUSA_BRIDGE_ENABLED === undefined || env.M1B_MEDUSA_BRIDGE_ENABLED === "false") return { enabled: false };
  try {
    if (env.NODE_TLS_REJECT_UNAUTHORIZED !== undefined && env.NODE_TLS_REJECT_UNAUTHORIZED !== "1") throw new Error();
    if (env.M1B_MEDUSA_BRIDGE_ENABLED !== "true" || !["local", "staging"].includes(env.M2_ENV ?? "")) throw new Error();
    const origin = new URL(env.M1B_MEDUSA_ORIGIN ?? ""), projectId = env.M1B_MEDUSA_PROJECT_ID, clientId = env.M1B_CENTRAL_CLIENT_ID, clientSecret = env.M1B_CENTRAL_CLIENT_SECRET;
    const local = env.M2_ENV === "local" && origin.protocol === "http:" && origin.hostname === "127.0.0.1";
    const staging = env.M2_ENV === "staging" && origin.protocol === "https:" && origin.hostname.endsWith(".run.app");
    if ((!local && !staging) || origin.origin !== env.M1B_MEDUSA_ORIGIN || !projectId || projectId.length > 256 ||
        !clientId || !/^tcm_[a-f0-9]{32}$/.test(clientId) || !clientSecret || clientSecret.length < 32 || /[\x00-\x20\x7f]/.test(clientSecret)) throw new Error();
    const supplied: unknown = JSON.parse(env.M1B_BRIDGE_PROOF_KEYS_JSON ?? ""), keyId = env.M1B_BRIDGE_PROOF_KEY_ID;
    if (!keyId || !supplied || typeof supplied !== "object" || Array.isArray(supplied) || Object.keys(supplied).length > 8) throw new Error();
    const keys: Record<string, Uint8Array> = Object.create(null);
    for (const [id, value] of Object.entries(supplied)) {
      if (typeof value !== "string") throw new Error(); const key = Buffer.from(value, "base64");
      if (key.length !== 32 || key.toString("base64") !== value) throw new Error(); keys[id] = key;
    }
    const proof = bridgeRequestProof({ origin: origin.origin, projectId, keyId, keys });
    return Object.freeze({ enabled: true, issuer: "https://dev.portal.raum.au", apiBase: "https://dev.portal.raum.au/mana", audience: "urn:vynvori:staging", clientId, clientSecret, origin: origin.origin, projectId, proof });
  } catch { throw new Error("Invalid private Medusa bridge configuration"); }
}
