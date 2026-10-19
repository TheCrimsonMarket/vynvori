import { createHash, createHmac, timingSafeEqual } from "node:crypto";
export type BridgePayload = Readonly<Record<string, string>>;
export type BridgeProofConfig = Readonly<{ origin: string; projectId: string; keyId: string; keys: Readonly<Record<string, Uint8Array>> }>;
function material(config: BridgeProofConfig, path: string, body: BridgePayload, accessToken: string, timestamp: string) {
  if (!["/auth/customer/tcm/provision", "/auth/customer/tcm/exchange", "/auth/customer/tcm/owned"].includes(path) || Object.values(body).some(value => typeof value !== "string")) throw new Error("Invalid bridge request");
  return JSON.stringify(["vynvori-private-medusa-v1", config.origin, config.projectId, "POST", path, timestamp,
    createHash("sha256").update(accessToken).digest("hex"), Object.keys(body).sort().map(key => [key, body[key]])]);
}
export function bridgeRequestProof(input: BridgeProofConfig, now = Date.now) {
  const keys = new Map<string, Buffer>();
  for (const [id, bytes] of Object.entries(input.keys)) { if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || bytes.length !== 32) throw new Error("Invalid bridge proof configuration"); keys.set(id, Buffer.from(bytes)); }
  if (!keys.has(input.keyId) || !input.projectId || !input.origin) throw new Error("Invalid bridge proof configuration");
  const config = Object.freeze({ origin: input.origin, projectId: input.projectId, keyId: input.keyId, keys: input.keys });
  return Object.freeze({
    sign(path: string, body: BridgePayload, accessToken: string): string {
      const timestamp = String(Math.floor(now() / 1000));
      return `v1.${config.keyId}.${timestamp}.${createHmac("sha256", keys.get(config.keyId)!).update(material(config, path, body, accessToken, timestamp)).digest("base64url")}`;
    },
    verify(proof: string | undefined, path: string, body: BridgePayload, accessToken: string): boolean {
      try {
        if (typeof proof !== "string" || proof.length > 256) return false;
        const parts = proof.split(".");
        if (parts.length !== 4 || parts[0] !== "v1" || !/^\d{10}$/.test(parts[2]!) || !/^[A-Za-z0-9_-]{43}$/.test(parts[3]!)) return false;
        const timestamp = Number(parts[2]), key = keys.get(parts[1]!);
        if (!key || Math.abs(Math.floor(now() / 1000) - timestamp) > 30) return false;
        const actual = Buffer.from(parts[3]!, "base64url"), expected = createHmac("sha256", key).update(material(config, path, body, accessToken, parts[2]!)).digest();
        return actual.length === expected.length && timingSafeEqual(actual, expected);
      } catch { return false; }
    },
  });
}
