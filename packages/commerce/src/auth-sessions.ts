import "server-only";
import { randomUUID } from "node:crypto";
import { centralIdentityClient, CentralIdentityError, type CentralTokens, type VerifiedCentralIdentity, type VerifiedCentralContact } from "./central-identity";
import { authSecretHash, credentialVault, opaqueAuthSecret, type CredentialBinding } from "./auth-vault";
import { loginTransactions, LoginTransactionError } from "./login-transactions";
import type { commerceIdentityCoordinator, CommerceMappingOutcome } from "./commerce-identity";
import { CustomerAccessError, type PrivateCustomerTransport, type CustomerMappingRef, type CustomerRead, type OwnedCustomerResult } from "./customer-access";

type Snapshot = Readonly<{ id: string; userId: string; issuer: string; subject: string; generation: number; credentialsCipher: string;
  expiresAt: Date; idleExpiresAt: Date; status: "active" | "refreshing" | "reauth_required" | "revoked"; refreshDeadline: Date | null }>;
export interface AuthSessionStore {
  ensureProfile(issuer: string, subject: string): Promise<string>;
  createSession(input: { id: string; tokenHash: string; userId: string; credentialsCipher: string; familyExpiresAt: number; clientId: string; deployment: string }): Promise<void>;
  lookupSession(tokenHash: string): Promise<Snapshot | null>;
  touchSession(id: string, generation: number): Promise<boolean>;
  claimRefresh(id: string, generation: number): Promise<string | null>;
  finishRefresh(id: string, generation: number, lease: string, credentialsCipher: string): Promise<boolean>;
  requireReauth(id: string, generation: number, lease: string): Promise<void>;
  revokeSessionAndRead(tokenHash: string): Promise<Snapshot | null>;
  confirmCentralRevoke(id: string): Promise<void>;
  claimGuestDraft(id: string, capabilityHash: string, sessionId: string, generation: number): Promise<boolean>;
  readCustomerCredential(id: string, generation: number, projectId: string): Promise<Readonly<{ cipher: string; projectId: string; authIdentityId: string; customerId: string; expiresAt: Date }> | null>;
  cacheCustomerCredential(id: string, generation: number, input: Readonly<{ cipher: string; projectId: string; authIdentityId: string; customerId: string; expiresAt: Date }>): Promise<boolean>;
}
export type AuthenticatedSession = Readonly<{ sessionId: string; userId: string; generation: number; expiresAt: number; identity: VerifiedCentralIdentity }>;
export class AuthSessionError extends Error {
  constructor(readonly code: "disabled" | "reauth_required" | "renew_required" | "unavailable" | "forbidden" | "contact_required" | "insufficient_scope" | "commerce_setup_required" | "not_found") { super(code); this.name = "AuthSessionError"; }
}
type Config = Readonly<{ enabled: boolean; deployment: string; issuer: string; clientId: string; audience: string }>;
type Credentials = CentralTokens & Readonly<{ issuer: string; subject: string }>;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

/** Server composition only: opaque browser cookie secret out, central tokens never out. */
export function authSessionService(input: Config, store: AuthSessionStore, authority: ReturnType<typeof centralIdentityClient>,
  transactions: ReturnType<typeof loginTransactions>, vault: ReturnType<typeof credentialVault>, now = Date.now, commerce?: ReturnType<typeof commerceIdentityCoordinator>, customerTransport?: PrivateCustomerTransport) {
  const config = Object.freeze({ ...input });
  function enabled() { if (!config.enabled) throw new AuthSessionError("disabled"); }
  function tokenHash(token: string) { if (!tokenPattern.test(token)) throw new AuthSessionError("reauth_required"); return authSecretHash(token); }
  const binding = (id: string, generation: number): CredentialBinding => ({ deployment: config.deployment, issuer: config.issuer, clientId: config.clientId, ownerId: id, generation, purpose: "session-credentials" });
  function decrypt(row: Snapshot): Credentials {
    try {
      const value: unknown = JSON.parse(vault.open(row.credentialsCipher, binding(row.id, row.generation)));
      if (!value || typeof value !== "object") throw new Error();
      const data = value as Record<string, unknown>;
      if (typeof data.accessToken !== "string" || !data.accessToken || typeof data.refreshToken !== "string" || !data.refreshToken ||
          !Number.isSafeInteger(data.expiresAt) || data.issuer !== config.issuer || data.issuer !== row.issuer || data.subject !== row.subject) throw new Error();
      return { accessToken: data.accessToken, refreshToken: data.refreshToken, expiresAt: data.expiresAt as number, issuer: config.issuer, subject: row.subject };
    } catch { throw new AuthSessionError("reauth_required"); }
  }
  async function lookup(token: string): Promise<Snapshot> {
    enabled();
    const row = await store.lookupSession(tokenHash(token));
    if (!row || row.issuer !== config.issuer || row.status === "revoked" || row.status === "reauth_required" || row.expiresAt.getTime() <= now() || row.idleExpiresAt.getTime() <= now()) throw new AuthSessionError("reauth_required");
    if (row.status === "refreshing") throw new AuthSessionError(row.refreshDeadline && row.refreshDeadline.getTime() > now() ? "unavailable" : "reauth_required");
    return row;
  }
  function matches(identity: VerifiedCentralIdentity, subject: string) {
    if (identity.issuer !== config.issuer || identity.clientId !== config.clientId || identity.audience !== config.audience || identity.subject !== subject) throw new AuthSessionError("reauth_required");
  }
  function sanitized(error: unknown): AuthSessionError {
    if (error instanceof AuthSessionError) return error;
    if (error instanceof LoginTransactionError) return new AuthSessionError("reauth_required");
    if (error instanceof CustomerAccessError) return new AuthSessionError(error.code === "not_found" ? "not_found" : error.code === "reauth_required" ? "reauth_required" : "unavailable");
    if (error instanceof CentralIdentityError) {
      if (["reauth_required", "contact_required", "insufficient_scope"].includes(error.code)) return new AuthSessionError(error.code as "reauth_required" | "contact_required" | "insufficient_scope");
    }
    return new AuthSessionError("unavailable");
  }
  async function checked(token: string): Promise<AuthenticatedSession> {
    const row = await lookup(token);
    const credentials = decrypt(row);
    if (credentials.expiresAt <= now()) throw new AuthSessionError("renew_required");
    const identity = await authority.verifyIdentity(credentials.accessToken);
    matches(identity, row.subject);
    if (!await store.touchSession(row.id, row.generation)) throw new AuthSessionError("reauth_required");
    return Object.freeze({ sessionId: row.id, userId: row.userId, generation: row.generation, expiresAt: row.expiresAt.getTime(), identity });
  }
  async function commerceOperation(cookieSecret: string, mode: "ensure" | "reconcile"): Promise<CommerceMappingOutcome> {
    if (!commerce) throw new AuthSessionError("unavailable");
    if (mode === "ensure") {
      const existing = await commerce.existing(await checked(cookieSecret));
      if (existing?.state === "ready") return existing;
    }
    const row = await lookup(cookieSecret), credentials = decrypt(row);
    const contact = await authority.verifyContact(credentials.accessToken); matches(contact, row.subject);
    if (!await store.touchSession(row.id, row.generation)) throw new AuthSessionError("reauth_required");
    const session: AuthenticatedSession = { sessionId: row.id, userId: row.userId, generation: row.generation, expiresAt: row.expiresAt.getTime(), identity: contact };
    return commerce[mode]({ session, contact, accessToken: credentials.accessToken });
  }
  return Object.freeze({
    async customer(cookieSecret: string, request: CustomerRead): Promise<OwnedCustomerResult> {
      try {
        if (!commerce || !customerTransport) throw new AuthSessionError("unavailable");
        const session = await checked(cookieSecret), row = await lookup(cookieSecret), central = decrypt(row);
        if (session.generation !== row.generation) throw new AuthSessionError("reauth_required");
        const mapping = await commerce.existing(session);
        if (!mapping || mapping.state !== "ready") throw new AuthSessionError("commerce_setup_required");
        const ref: CustomerMappingRef = mapping;
        const context: CredentialBinding = { deployment: config.deployment, issuer: config.issuer, clientId: config.clientId, generation: row.generation, purpose: "medusa-credentials",
          ownerId: JSON.stringify([row.id, ref.projectId, ref.authIdentityId, ref.customerId]) };
        let credential: { token: string; expiresAt: number };
        const cached = await store.readCustomerCredential(row.id, row.generation, ref.projectId);
        if (cached) {
          if (cached.authIdentityId !== ref.authIdentityId || cached.customerId !== ref.customerId) throw new AuthSessionError("unavailable");
          const value: unknown = JSON.parse(vault.open(cached.cipher, context));
          if (!value || typeof value !== "object") throw new AuthSessionError("reauth_required");
          const data = value as Record<string, unknown>;
          if (typeof data.token !== "string" || !data.token || data.token.length > 8192 || /[\x00-\x20\x7f]/.test(data.token) || data.expiresAt !== cached.expiresAt.getTime()) throw new AuthSessionError("reauth_required");
          credential = { token: data.token, expiresAt: cached.expiresAt.getTime() };
        } else {
          const minted = await customerTransport.exchange({ identity: session.identity, mapping: ref, accessToken: central.accessToken });
          if (!Number.isSafeInteger(minted.expiresAt) || minted.expiresAt <= now() || minted.expiresAt > session.identity.expiresAt || !minted.token || minted.token.length > 8192 || /[\x00-\x20\x7f]/.test(minted.token)) throw new AuthSessionError("unavailable");
          credential = { token: minted.token, expiresAt: Math.min(minted.expiresAt, row.expiresAt.getTime()) };
          if (!await store.cacheCustomerCredential(row.id, row.generation, { cipher: vault.seal(JSON.stringify(credential), context), projectId: ref.projectId, authIdentityId: ref.authIdentityId, customerId: ref.customerId, expiresAt: new Date(credential.expiresAt) })) throw new AuthSessionError("reauth_required");
        }
        const result = await customerTransport.owned({ identity: session.identity, mapping: ref, accessToken: central.accessToken, customerToken: credential.token, request });
        const current = await checked(cookieSecret);
        if (current.userId !== session.userId || current.generation !== session.generation) throw new AuthSessionError("reauth_required");
        return result;
      } catch (error) { throw sanitized(error); }
    },
    async completeLogin(state: string, browserBinding: string, code: string) {
      enabled();
      try {
        const transaction = await transactions.consume(state, browserBinding);
        const familyExpiresAt = now() + 28800000;
        const tokens = await authority.exchange(code, transaction.verifier, transaction.callback);
        const identity = await authority.verifyIdentity(tokens.accessToken);
        matches(identity, identity.subject);
        const userId = await store.ensureProfile(identity.issuer, identity.subject);
        const id = randomUUID(), cookieSecret = opaqueAuthSecret();
        const credentials: Credentials = { ...tokens, expiresAt: Math.min(tokens.expiresAt, identity.expiresAt), issuer: identity.issuer, subject: identity.subject };
        await store.createSession({ id, tokenHash: tokenHash(cookieSecret), userId, credentialsCipher: vault.seal(JSON.stringify(credentials), binding(id, 0)), familyExpiresAt, clientId: config.clientId, deployment: config.deployment });
        return Object.freeze({ cookieSecret, returnPath: transaction.returnPath, expiresAt: familyExpiresAt });
      } catch (error) { throw sanitized(error); }
    },
    async verify(cookieSecret: string): Promise<AuthenticatedSession> {
      try { return await checked(cookieSecret); } catch (error) { throw sanitized(error); }
    },
    /** Commerce contact is a separate requirement; missing email must not prevent identity/guest access. */
    async contact(cookieSecret: string): Promise<VerifiedCentralContact> {
      try {
        const row = await lookup(cookieSecret);
        const contact = await authority.verifyContact(decrypt(row).accessToken);
        matches(contact, row.subject);
        if (!await store.touchSession(row.id, row.generation)) throw new AuthSessionError("reauth_required");
        return contact;
      } catch (error) { throw sanitized(error); }
    },
    async ensureCommerce(cookieSecret: string): Promise<CommerceMappingOutcome> {
      try { return await commerceOperation(cookieSecret, "ensure"); } catch (error) { throw sanitized(error); }
    },
    async existingCommerce(cookieSecret: string): Promise<CommerceMappingOutcome | null> {
      try {
        if (!commerce) throw new AuthSessionError("unavailable");
        return await commerce.existing(await checked(cookieSecret));
      } catch (error) { throw sanitized(error); }
    },
    async reconcileCommerce(cookieSecret: string): Promise<CommerceMappingOutcome> {
      try { return await commerceOperation(cookieSecret, "reconcile"); } catch (error) { throw sanitized(error); }
    },
    async refresh(cookieSecret: string): Promise<AuthenticatedSession> {
      let claimed: { id: string; generation: number; lease: string } | undefined;
      try {
        const row = await lookup(cookieSecret);
        const old = decrypt(row);
        const lease = await store.claimRefresh(row.id, row.generation);
        if (!lease) throw new AuthSessionError("unavailable");
        claimed = { id: row.id, generation: row.generation, lease };
        const tokens = await authority.refresh(old.refreshToken);
        const identity = await authority.verifyIdentity(tokens.accessToken);
        matches(identity, row.subject);
        const credentials: Credentials = { ...tokens, expiresAt: Math.min(tokens.expiresAt, identity.expiresAt), issuer: row.issuer, subject: row.subject };
        const cipher = vault.seal(JSON.stringify(credentials), binding(row.id, row.generation + 1));
        if (!await store.finishRefresh(row.id, row.generation, lease, cipher)) throw new AuthSessionError("reauth_required");
        claimed = undefined;
        return await checked(cookieSecret);
      } catch (error) {
        if (claimed) {
          try { await store.revokeSessionAndRead(tokenHash(cookieSecret)); }
          catch { throw new AuthSessionError("unavailable"); }
          // Never retry the central rotation after it may have consumed the old credential.
          throw new AuthSessionError("reauth_required");
        }
        throw sanitized(error);
      }
    },
    async logout(cookieSecret: string): Promise<Readonly<{ localRevoked: true; upstream: "confirmed" | "pending" | "unconfirmed" }>> {
      enabled();
      let row: Snapshot | null;
      try { row = await store.revokeSessionAndRead(tokenHash(cookieSecret)); }
      catch { throw new AuthSessionError("unavailable"); }
      if (!row) return { localRevoked: true, upstream: "unconfirmed" };
      try {
        const credentials = decrypt(row);
        await authority.revoke(credentials.refreshToken);
        await store.confirmCentralRevoke(row.id);
        return { localRevoked: true, upstream: "confirmed" };
      } catch { return { localRevoked: true, upstream: "pending" }; }
    },
    async claimGuest(cookieSecret: string, draftId: string, capability: string): Promise<void> {
      try {
        const session = await checked(cookieSecret);
        if (!tokenPattern.test(capability) || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(draftId) || !await store.claimGuestDraft(draftId, authSecretHash(capability), session.sessionId, session.generation)) throw new AuthSessionError("forbidden");
      } catch (error) { throw sanitized(error); }
    },
  });
}
