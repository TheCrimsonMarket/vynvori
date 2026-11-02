import { createHash } from "node:crypto";

export function centralEntityId(issuer: string, subject: string): string {
  return `vynvori:v1:${createHash("sha256").update(JSON.stringify(["vynvori-central-identity-v1", issuer, subject])).digest("hex")}`;
}
export type CentralIdentityConfig = Readonly<{
  enabled: boolean;
  issuer: string;
  apiBase: string;
  clientId: string;
  clientSecret: string;
  audience: string;
  callback?: string;
}>;
export type CentralTokens = Readonly<{ accessToken: string; refreshToken: string; expiresAt: number }>;
const verified = Symbol("central-verified-identity");
export type VerifiedCentralIdentity = Readonly<{
  [verified]: true;
  issuer: string;
  subject: string;
  clientId: string;
  audience: string;
  expiresAt: number;
}>;
export type VerifiedCentralContact = VerifiedCentralIdentity & Readonly<{
  email: string;
  emailVerified: boolean;
  name?: string;
}>;
export class CentralIdentityError extends Error {
  constructor(readonly code: "disabled" | "invalid_configuration" | "reauth_required" | "unavailable" | "outcome_unknown" | "contact_required" | "insufficient_scope") {
    super(code);
    this.name = "CentralIdentityError";
  }
}
type JsonObject = Record<string, unknown>;
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\x00-\x20\x7f]/.test(value);

/** No route or provider is activated by constructing this server-only adapter. */
export function centralIdentityClient(input: CentralIdentityConfig, fetcher: typeof fetch = fetch, now = Date.now) {
  const config = Object.freeze({ ...input });
  if (config.enabled) {
    try {
      const issuer = new URL(config.issuer);
      const api = new URL(config.apiBase);
      if (issuer.protocol !== "https:" || issuer.origin !== config.issuer || api.origin !== issuer.origin ||
          api.pathname !== "/mana" || api.search || api.hash || api.username || api.password ||
          !nonempty(config.clientId) || config.clientId.includes(":") || !nonempty(config.clientSecret) || !nonempty(config.audience)) throw new Error();
      if (config.callback !== undefined) {
        const callback = new URL(config.callback);
        if (callback.protocol !== "https:" || callback.username || callback.password || callback.search || callback.hash || callback.pathname !== "/auth/tcm/callback") throw new Error();
      }
    } catch { throw new CentralIdentityError("invalid_configuration"); }
  }

  async function rpc(operation: "introspect" | "profile" | "token" | "revoke", body: Readonly<Record<string, string>>): Promise<JsonObject> {
    if (!config.enabled) throw new CentralIdentityError("disabled");
    const uncertain = operation === "token" || operation === "revoke";
    const failure = () => new CentralIdentityError(uncertain ? "outcome_unknown" : "unavailable");
    if (Object.values(body).some(value => !nonempty(value))) throw new CentralIdentityError("reauth_required");
    try {
      const response = await fetcher(`${config.apiBase}/oauth/strict/v1/${operation}`, {
        method: "POST", redirect: "error", cache: "no-store", credentials: "omit",
        signal: AbortSignal.timeout(5000),
        headers: { authorization: `Basic ${Buffer.from(`${new URLSearchParams({ v: config.clientId }).toString().slice(2)}:${new URLSearchParams({ v: config.clientSecret }).toString().slice(2)}`).toString("base64")}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams(body),
      });
      if (response.status !== 200) {
        await response.body?.cancel();
        if (operation === "profile" && response.status === 409) throw new CentralIdentityError("contact_required");
        if (operation === "profile" && response.status === 403) throw new CentralIdentityError("insufficient_scope");
        if (response.status === 401 || (operation === "token" && response.status === 400)) throw new CentralIdentityError("reauth_required");
        throw failure();
      }
      if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json" || !response.body) {
        await response.body?.cancel(); throw failure();
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > 16384) throw failure();
          chunks.push(part.value);
        }
      } finally { await reader.cancel(); reader.releaseLock(); }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw failure();
      return value as JsonObject;
    } catch (error) {
      if (error instanceof CentralIdentityError) throw error;
      throw failure();
    }
  }
  function binding(data: JsonObject, subject?: string) {
    if (data.iss !== config.issuer || data.client_id !== config.clientId || data.aud !== config.audience ||
        !nonempty(data.sub) || (subject !== undefined && data.sub !== subject)) throw new CentralIdentityError("reauth_required");
    return data.sub;
  }
  async function active(token: string, subject?: string) {
    const data = await rpc("introspect", { token });
    if (data.active !== true) throw new CentralIdentityError("reauth_required");
    const sub = binding(data, subject);
    const seconds = Math.floor(now() / 1000);
    if (!Number.isSafeInteger(data.exp) || !Number.isSafeInteger(data.verified_at) ||
        (data.exp as number) <= seconds || (data.exp as number) > seconds + 300 ||
        (data.verified_at as number) > seconds + 5 || (data.verified_at as number) < seconds - 30) throw new CentralIdentityError("reauth_required");
    return { subject: sub, expiresAt: (data.exp as number) * 1000 };
  }
  function tokens(data: JsonObject): CentralTokens {
    const scopes = typeof data.scope === "string" ? data.scope.split(" ").filter(Boolean) : [];
    if (!nonempty(data.access_token) || !nonempty(data.refresh_token) || data.access_token === data.refresh_token || data.token_type !== "Bearer" ||
        !Number.isSafeInteger(data.expires_in) || (data.expires_in as number) < 1 || (data.expires_in as number) > 300 ||
        scopes.length !== 2 || !scopes.includes("profile") || !scopes.includes("email")) throw new CentralIdentityError("outcome_unknown");
    return Object.freeze({ accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: now() + (data.expires_in as number) * 1000 });
  }
  return Object.freeze({
    async verifyIdentity(token: string): Promise<VerifiedCentralIdentity> {
      const current = await active(token);
      return Object.freeze({ [verified]: true as const, issuer: config.issuer, subject: current.subject, clientId: config.clientId, audience: config.audience, expiresAt: current.expiresAt });
    },
    async exchange(code: string, verifier: string, callback: string): Promise<CentralTokens> {
      if (!config.enabled) throw new CentralIdentityError("disabled");
      if (!config.callback || callback !== config.callback || !/^[A-Za-z0-9_-]{43,128}$/.test(verifier)) throw new CentralIdentityError("invalid_configuration");
      return tokens(await rpc("token", { grant_type: "authorization_code", code, redirect_uri: config.callback, code_verifier: verifier }));
    },
    async refresh(refreshToken: string): Promise<CentralTokens> {
      return tokens(await rpc("token", { grant_type: "refresh_token", refresh_token: refreshToken }));
    },
    async revoke(token: string): Promise<void> { await rpc("revoke", { token }); },
    /** Recheck current authority state on every call, including after contact I/O. */
    async verifyContact(token: string): Promise<VerifiedCentralContact> {
      const first = await active(token);
      const contact = await rpc("profile", { token });
      binding(contact, first.subject);
      if (typeof contact.email !== "string" || contact.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email) ||
          /[\x00-\x1f\x7f]/.test(contact.email) || typeof contact.email_verified !== "boolean" ||
          (contact.name !== undefined && (typeof contact.name !== "string" || contact.name.length > 200 || /[\x00-\x1f\x7f]/.test(contact.name)))) throw new CentralIdentityError("contact_required");
      const current = await active(token, first.subject);
      return Object.freeze({ [verified]: true as const, issuer: config.issuer, subject: current.subject, clientId: config.clientId,
        audience: config.audience, expiresAt: current.expiresAt, email: contact.email, emailVerified: contact.email_verified,
        ...(typeof contact.name === "string" ? { name: contact.name } : {}) });
    },
  });
}
