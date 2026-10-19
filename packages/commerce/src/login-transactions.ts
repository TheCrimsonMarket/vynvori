import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { authSecretHash, credentialVault, opaqueAuthSecret, type CredentialBinding } from "./auth-vault";

type LoginRecord = Readonly<{ id: string; stateHash: string; browserHash: string; verifierCipher: string; callback: string; returnPath: string }>;
export interface LoginTransactionStore {
  createLogin(input: LoginRecord): Promise<void>;
  consumeLogin(id: string, stateHash: string, browserHash: string): Promise<LoginRecord | null>;
}
export type LoginConfig = Readonly<{ enabled: boolean; deployment: string; issuer: string; appOrigin: string; clientId: string }>;
export class LoginTransactionError extends Error {
  constructor() { super("Invalid login transaction"); this.name = "LoginTransactionError"; }
}
const returns = new Set(["/account", "/studio", "/customize"]);
const transactionState = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.[A-Za-z0-9_-]{43}$/;

/** OAuth start/callback mechanics, independent of cookies, framework routes or live activation. */
export function loginTransactions(input: LoginConfig, store: LoginTransactionStore, vault: ReturnType<typeof credentialVault>, now = Date.now) {
  const config = Object.freeze({ ...input });
  if (config.enabled) {
    for (const value of [config.issuer, config.appOrigin]) {
      let valid = false;
      try { const url = new URL(value); valid = url.protocol === "https:" && url.origin === value; } catch { /* sanitized below */ }
      if (!valid) throw new Error("Invalid login configuration");
    }
    if (!config.clientId || !/^[a-z0-9_-]{1,64}$/.test(config.deployment)) throw new Error("Invalid login configuration");
  }
  const callback = `${config.appOrigin}/auth/tcm/callback`;
  const binding = (id: string): CredentialBinding => ({ deployment: config.deployment, issuer: config.issuer, clientId: config.clientId, ownerId: id, generation: 0, purpose: "login-verifier" });
  function enabled() { if (!config.enabled) throw new Error("Login disabled"); }
  return Object.freeze({
    async begin(returnPath: string) {
      enabled();
      if (!returns.has(returnPath)) throw new Error("Invalid login return path");
      const id = randomUUID(), verifier = opaqueAuthSecret(), browserBinding = opaqueAuthSecret();
      const state = `${id}.${opaqueAuthSecret()}`;
      const authorize = new URL("/oauth/authorize", config.issuer);
      authorize.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: callback, response_type: "code", scope: "profile email", state,
        code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString();
      await store.createLogin({ id, stateHash: authSecretHash(state), browserHash: authSecretHash(browserBinding), verifierCipher: vault.seal(verifier, binding(id)), callback, returnPath });
      return Object.freeze({ transactionId: id, authorizeUrl: authorize.toString(), browserBinding, expiresAt: now() + 600000 });
    },
    async consume(state: string, browserBinding: string) {
      enabled();
      if (typeof state !== "string" || !transactionState.test(state) || typeof browserBinding !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(browserBinding)) throw new LoginTransactionError();
      const id = state.split(".")[0]!;
      const record = await store.consumeLogin(id, authSecretHash(state), authSecretHash(browserBinding));
      if (!record || record.callback !== callback || !returns.has(record.returnPath)) throw new LoginTransactionError();
      // The durable consume has already committed. A later failure cannot replay code exchange.
      const verifier = vault.open(record.verifierCipher, binding(id));
      if (!/^[A-Za-z0-9_-]{43}$/.test(verifier)) throw new LoginTransactionError();
      return Object.freeze({ transactionId: id, verifier, callback, returnPath: record.returnPath });
    },
  });
}
