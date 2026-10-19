import "server-only";
import type { centralIdentityClient } from "./central-identity";
import type { credentialVault } from "./auth-vault";

type Cohort = Readonly<{ issuer: string; clientId: string; deployment: string }>;
type Revocation = Readonly<{ id: string; issuer: string; subject: string; generation: number; status: "active" | "refreshing" | "reauth_required" | "revoked"; credentialsCipher: string; lease: string; attempts: number }>;
export interface RevocationStore {
  claimCentralRevocation(cohort: Cohort): Promise<Revocation | null>;
  settleCentralRevocation(id: string, lease: string, confirmed: boolean, delayMs: number): Promise<boolean>;
}
export class RevocationReconciliationError extends Error {
  constructor() { super("Revocation reconciliation unavailable"); this.name = "RevocationReconciliationError"; }
}

/** Explicit server-side batch only. No scheduler, route, refresh, creation, logs or credentials in results. */
export function revocationReconciler(input: Cohort & { enabled: boolean }, store: RevocationStore,
  authority: Pick<ReturnType<typeof centralIdentityClient>, "revoke">, vault: ReturnType<typeof credentialVault>) {
  const config = Object.freeze({ ...input });
  if (config.enabled && (!config.issuer || !config.clientId || !config.deployment)) throw new RevocationReconciliationError();
  return Object.freeze({
    async run(limit = 5): Promise<Readonly<{ attempted: number; confirmed: number; pending: number; manualReview: number }>> {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5) throw new RevocationReconciliationError();
      const result = { attempted: 0, confirmed: 0, pending: 0, manualReview: 0 };
      if (!config.enabled) return Object.freeze(result);
      for (let index = 0; index < limit; index++) {
        let row: Revocation | null;
        try { row = await store.claimCentralRevocation({ issuer: config.issuer, clientId: config.clientId, deployment: config.deployment }); }
        catch { throw new RevocationReconciliationError(); }
        if (!row) break;
        result.attempted++;
        let confirmed = false;
        try {
          if (row.status !== "revoked" || row.issuer !== config.issuer || !row.subject || !Number.isSafeInteger(row.attempts) || row.attempts < 1 || row.attempts > 8) throw new Error();
          const value: unknown = JSON.parse(vault.open(row.credentialsCipher, { ...config, ownerId: row.id, generation: row.generation, purpose: "session-credentials" }));
          if (!value || typeof value !== "object") throw new Error();
          const data = value as Record<string, unknown>;
          if (data.issuer !== config.issuer || data.subject !== row.subject || typeof data.refreshToken !== "string" || !data.refreshToken || data.refreshToken.length > 16384 || /[\x00-\x20\x7f]/.test(data.refreshToken)) throw new Error();
          // Reviewed strict revocation accepts current/spent refresh hashes and uniform idempotent success.
          // Never rotate a refresh token to discover or repair an uncertain outcome.
          await authority.revoke(data.refreshToken); confirmed = true;
        } catch { /* Pending and locally revoked; only a definite authority success may confirm. */ }
        const delay = Math.min(3600000, 60000 * 2 ** Math.max(0, Math.min(7, row.attempts - 1)));
        let settled = false;
        try { settled = await store.settleCentralRevocation(row.id, row.lease, confirmed, delay); }
        catch { /* Lost local acknowledgement remains uncertain, with no immediate retry. */ }
        if (confirmed && settled) result.confirmed++;
        else { result.pending++; if (row.attempts >= 8) result.manualReview++; }
        if (!settled) break;
      }
      return Object.freeze(result);
    },
  });
}
