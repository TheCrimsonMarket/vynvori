import "server-only";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export type CredentialBinding = Readonly<{
  deployment: string; issuer: string; clientId: string;
  ownerId: string; generation: number; purpose: "login-verifier" | "session-credentials" | "medusa-credentials" | "commerce-provisioning";
}>;
const validId = /^[a-zA-Z0-9_-]{1,64}$/;
const encoded = /^[a-zA-Z0-9_-]+$/;
export const opaqueAuthSecret = () => randomBytes(32).toString("base64url");
export function authSecretHash(secret: string): string {
  if (typeof secret !== "string" || secret.length < 32 || secret.length > 512 || !/^[a-zA-Z0-9_.-]+$/.test(secret)) throw new Error("Invalid auth secret");
  return createHash("sha256").update(secret).digest("hex");
}
function associatedData(binding: CredentialBinding): Buffer {
  if (!Number.isSafeInteger(binding.generation) || binding.generation < 0 || !binding.ownerId || !binding.issuer || !binding.clientId || !binding.deployment ||
      !["login-verifier", "session-credentials", "medusa-credentials", "commerce-provisioning"].includes(binding.purpose)) throw new Error("Invalid credential binding");
  return Buffer.from(JSON.stringify(["vynvori", 1, binding.deployment, binding.issuer, binding.clientId, binding.ownerId, binding.generation, binding.purpose]));
}
/** Key-versioned AES-GCM; no key loading, generation, storage or network access. */
export function credentialVault(currentKeyId: string, inputKeys: Readonly<Record<string, Uint8Array>>) {
  const keys = new Map<string, Buffer>();
  for (const [id, bytes] of Object.entries(inputKeys)) {
    if (!validId.test(id) || bytes.length !== 32) throw new Error("Invalid credential key configuration");
    keys.set(id, Buffer.from(bytes));
  }
  if (!validId.test(currentKeyId) || !keys.has(currentKeyId)) throw new Error("Invalid credential key configuration");
  return Object.freeze({
    seal(plaintext: string, binding: CredentialBinding): string {
      if (typeof plaintext !== "string" || !plaintext || Buffer.byteLength(plaintext) > 16384) throw new Error("Invalid credential payload");
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", keys.get(currentKeyId)!, iv);
      cipher.setAAD(associatedData(binding));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return ["v1", currentKeyId, iv.toString("base64url"), ciphertext.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
    },
    open(envelope: string, binding: CredentialBinding): string {
      try {
        if (typeof envelope !== "string" || envelope.length > 24000) throw new Error();
        const parts = envelope.split(".");
        if (parts.length !== 5 || parts[0] !== "v1" || !validId.test(parts[1]!) || parts.slice(2).some(part => !encoded.test(part))) throw new Error();
        const key = keys.get(parts[1]!);
        const iv = Buffer.from(parts[2]!, "base64url"), ciphertext = Buffer.from(parts[3]!, "base64url"), tag = Buffer.from(parts[4]!, "base64url");
        if (!key || iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0 || ciphertext.length > 16384) throw new Error();
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAAD(associatedData(binding)); decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      } catch { throw new Error("Credential unavailable"); }
    },
  });
}
