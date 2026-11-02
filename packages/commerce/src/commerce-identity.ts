import "server-only";
import { randomUUID } from "node:crypto";
import { centralEntityId, type VerifiedCentralContact } from "./central-identity";
import { credentialVault, type CredentialBinding } from "./auth-vault";
import type { AuthenticatedSession } from "./auth-sessions";

type MappingRow = Readonly<{ userId: string; projectId: string; entityId: string; operationId: string; requestCipher: string;
  state: "reserved" | "dispatching" | "ready" | "reconcile_required" | "conflict"; authIdentityId: string | null; customerId: string | null }>;
export interface CommerceMappingJournal {
  reserve(input: { userId: string; projectId: string; entityId: string; operationId: string; requestCipher: string }): Promise<MappingRow>;
  get(userId: string, projectId: string): Promise<MappingRow | null>;
  claimDispatch(operationId: string): Promise<boolean>;
  markUncertain(operationId: string): Promise<void>;
  releaseUndispatched(operationId: string): Promise<void>;
  markConflict(operationId: string): Promise<void>;
  complete(operationId: string, authIdentityId: string, customerId: string): Promise<boolean>;
}
export type ProvisioningResult = Readonly<{ state: "ready"; projectId: string; entityId: string; operationId: string; authIdentityId: string; customerId: string }>
  | Readonly<{ state: "reconcile_required"; projectId: string; entityId: string; operationId: string }>;
export interface NativeCustomerProvisioner {
  ensure(input: { mode: "create" | "reconcile"; projectId: string; operationId: string; identity: VerifiedCentralContact; originalEmail: string; accessToken: string }): Promise<ProvisioningResult>;
}
export class CommerceIdentityError extends Error {
  constructor(readonly code: "disabled" | "conflict" | "unavailable" | "not_started") { super(code); this.name = "CommerceIdentityError"; }
}
export type CommerceMappingOutcome = Readonly<{ state: "ready"; userId: string; projectId: string; authIdentityId: string; customerId: string }>
  | Readonly<{ state: "reconcile_required" | "conflict" | "unavailable" }>;
type Input = { session: AuthenticatedSession; contact: VerifiedCentralContact; accessToken: string };

/** One native create dispatch per durable reservation. Reconciliation can never create. */
export function commerceIdentityCoordinator(input: Readonly<{ enabled: boolean; deployment: string; issuer: string; clientId: string; audience: string; projectId: string }>,
  journal: CommerceMappingJournal, native: NativeCustomerProvisioner, vault: ReturnType<typeof credentialVault>) {
  const config = Object.freeze({ ...input });
  if (config.enabled && (!config.projectId || config.projectId.length > 256)) throw new CommerceIdentityError("unavailable");
  const binding = (operationId: string): CredentialBinding => ({ deployment: config.deployment, issuer: config.issuer, clientId: config.clientId, ownerId: operationId, generation: 0, purpose: "commerce-provisioning" });
  function validateSession(session: AuthenticatedSession) {
    if (!config.enabled) throw new CommerceIdentityError("disabled");
    const { identity } = session;
    if (identity.issuer !== config.issuer || identity.clientId !== config.clientId || identity.audience !== config.audience) throw new CommerceIdentityError("conflict");
  }
  function validate(value: Input) {
    validateSession(value.session);
    const { identity } = value.session;
    if (
        value.contact.issuer !== identity.issuer || value.contact.subject !== identity.subject || value.contact.clientId !== identity.clientId || value.contact.audience !== identity.audience) throw new CommerceIdentityError("conflict");
  }
  function rowMatches(row: MappingRow, value: Input) {
    if (row.userId !== value.session.userId || row.projectId !== config.projectId || row.entityId !== centralEntityId(value.contact.issuer, value.contact.subject)) throw new CommerceIdentityError("conflict");
  }
  const ready = (row: MappingRow): CommerceMappingOutcome => {
    if (!row.authIdentityId || !row.customerId) throw new CommerceIdentityError("unavailable");
    return Object.freeze({ state: "ready", userId: row.userId, projectId: row.projectId, authIdentityId: row.authIdentityId, customerId: row.customerId });
  };
  async function dispatch(row: MappingRow, value: Input, mode: "create" | "reconcile"): Promise<CommerceMappingOutcome> {
    try {
      const stored: unknown = JSON.parse(vault.open(row.requestCipher, binding(row.operationId)));
      if (!stored || typeof stored !== "object") throw new CommerceIdentityError("conflict");
      const request = stored as Record<string, unknown>;
      if (request.issuer !== value.contact.issuer || request.subject !== value.contact.subject || typeof request.email !== "string") throw new CommerceIdentityError("conflict");
      const result = await native.ensure({ mode, projectId: row.projectId, operationId: row.operationId, identity: value.contact, originalEmail: request.email, accessToken: value.accessToken });
      if (result.projectId !== row.projectId || result.operationId !== row.operationId || result.entityId !== row.entityId) throw new CommerceIdentityError("conflict");
      if (result.state !== "ready") { await journal.markUncertain(row.operationId); return { state: "reconcile_required" }; }
      if (![result.authIdentityId, result.customerId].every(id => typeof id === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(id))) throw new CommerceIdentityError("conflict");
      if (!await journal.complete(row.operationId, result.authIdentityId, result.customerId)) return { state: "reconcile_required" };
      return ready({ ...row, state: "ready", authIdentityId: result.authIdentityId, customerId: result.customerId });
    } catch (error) {
      if (error instanceof CommerceIdentityError && error.code === "not_started") {
        if (mode === "create") await journal.releaseUndispatched(row.operationId);
        else await journal.markUncertain(row.operationId);
        return { state: "unavailable" };
      }
      if (error instanceof CommerceIdentityError && error.code === "conflict") { await journal.markConflict(row.operationId); return { state: "conflict" }; }
      await journal.markUncertain(row.operationId);
      return { state: "reconcile_required" };
    }
  }
  return Object.freeze({
    async existing(session: AuthenticatedSession): Promise<CommerceMappingOutcome | null> {
      validateSession(session);
      const row = await journal.get(session.userId, config.projectId);
      if (!row) return null;
      if (row.userId !== session.userId || row.projectId !== config.projectId || row.entityId !== centralEntityId(session.identity.issuer, session.identity.subject)) throw new CommerceIdentityError("conflict");
      return row.state === "ready" ? ready(row) : { state: row.state === "conflict" ? "conflict" : "reconcile_required" };
    },
    async ensure(value: Input): Promise<CommerceMappingOutcome> {
      validate(value);
      const operationId = randomUUID();
      const row = await journal.reserve({ userId: value.session.userId, projectId: config.projectId, entityId: centralEntityId(value.contact.issuer, value.contact.subject), operationId,
        requestCipher: vault.seal(JSON.stringify({ issuer: value.contact.issuer, subject: value.contact.subject, email: value.contact.email }), binding(operationId)) });
      rowMatches(row, value);
      if (row.state === "ready") return ready(row);
      if (row.state === "conflict") return { state: "conflict" };
      if (row.state !== "reserved" || !await journal.claimDispatch(row.operationId)) return { state: "reconcile_required" };
      return dispatch(row, value, "create");
    },
    async reconcile(value: Input): Promise<CommerceMappingOutcome> {
      validate(value);
      const row = await journal.get(value.session.userId, config.projectId);
      if (!row) return { state: "reconcile_required" };
      rowMatches(row, value);
      if (row.state === "ready") return ready(row);
      if (row.state === "conflict") return { state: "conflict" };
      if (row.state === "reserved") return { state: "reconcile_required" };
      return dispatch(row, value, "reconcile");
    },
  });
}
