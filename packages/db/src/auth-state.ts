import "server-only";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

export type LoginTransaction = Readonly<{ id: string; stateHash: string; browserHash: string; verifierCipher: string; callback: string; returnPath: string }>;
export type StoredSession = Readonly<{ id: string; userId: string; generation: number; credentialsCipher: string; expiresAt: Date; idleExpiresAt: Date }>;
export type SessionSnapshot = StoredSession & Readonly<{ issuer: string; subject: string; status: "active" | "refreshing" | "reauth_required" | "revoked"; refreshDeadline: Date | null }>;
export type StoredCustomerCredential = Readonly<{ cipher: string; projectId: string; authIdentityId: string; customerId: string; expiresAt: Date }>;
type SessionRow = { id: string; user_id: string; generation: number; credentials_cipher: string; expires_at: Date; idle_expires_at: Date };
const session = (row: SessionRow): StoredSession => ({ id: row.id, userId: row.user_id, generation: row.generation, credentialsCipher: row.credentials_cipher, expiresAt: row.expires_at, idleExpiresAt: row.idle_expires_at });

/** Runtime DML only. Caller supplies a separately configured restricted creative pool. */
export function identityStateStore(pool: Pool, now: () => number = Date.now) {
  function liveTimes(familyExpiresAt: number) {
    const time = now();
    const expires = Math.min(familyExpiresAt, time + 8 * 60 * 60 * 1000);
    if (!Number.isSafeInteger(expires) || expires <= time) throw new Error("Invalid session lifetime");
    return [new Date(time), new Date(expires), new Date(Math.min(expires, time + 30 * 60 * 1000))];
  }
  type SnapshotRow = SessionRow & { issuer: string; subject: string; status: SessionSnapshot["status"]; refresh_deadline: Date | null };
  function snapshot(row: SnapshotRow): SessionSnapshot {
    return { ...session(row), issuer: row.issuer, subject: row.subject, status: row.status, refreshDeadline: row.refresh_deadline };
  }
  return {
    async ensureProfile(issuer: string, subject: string): Promise<string> {
      const result = await pool.query<{ id: string }>(`INSERT INTO vynvori_identity.profiles(id,issuer,subject) VALUES ($1,$2,$3)
        ON CONFLICT (issuer,subject) DO UPDATE SET subject=EXCLUDED.subject RETURNING id`, [randomUUID(), issuer, subject]);
      return result.rows[0]!.id;
    },
    async createLogin(input: LoginTransaction): Promise<void> {
      const created = now();
      await pool.query(`INSERT INTO vynvori_identity.login_transactions(id,state_hash,browser_hash,verifier_cipher,callback,return_path,created_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [input.id, input.stateHash, input.browserHash, input.verifierCipher, input.callback, input.returnPath, new Date(created), new Date(created + 600000)]);
    },
    /** One statement commits consumption before any external code exchange. */
    async consumeLogin(id: string, stateHash: string, browserHash: string): Promise<LoginTransaction | null> {
      const result = await pool.query<{ id: string; state_hash: string; browser_hash: string; verifier_cipher: string; callback: string; return_path: string }>(`UPDATE vynvori_identity.login_transactions
        SET consumed_at=$4 WHERE id=$1 AND state_hash=$2 AND browser_hash=$3 AND consumed_at IS NULL AND expires_at>$4
        RETURNING id,state_hash,browser_hash,verifier_cipher,callback,return_path`, [id, stateHash, browserHash, new Date(now())]);
      const row = result.rows[0];
      return row ? { id: row.id, stateHash: row.state_hash, browserHash: row.browser_hash, verifierCipher: row.verifier_cipher, callback: row.callback, returnPath: row.return_path } : null;
    },
    async createSession(input: { id: string; tokenHash: string; userId: string; credentialsCipher: string; familyExpiresAt: number; clientId: string; deployment: string }): Promise<void> {
      const times = liveTimes(input.familyExpiresAt);
      if (!input.clientId || input.clientId.length > 256 || !input.deployment || input.deployment.length > 128) throw new Error("Invalid session cohort");
      await pool.query(`INSERT INTO vynvori_identity.sessions(id,token_hash,user_id,status,credentials_cipher,created_at,expires_at,idle_expires_at,authority_client_id,deployment)
        VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$8,$9)`, [input.id, input.tokenHash, input.userId, input.credentialsCipher, ...times, input.clientId, input.deployment]);
    },
    async readSession(tokenHash: string): Promise<StoredSession | null> {
      const result = await pool.query<SessionRow>(`SELECT id,user_id,generation,credentials_cipher,expires_at,idle_expires_at FROM vynvori_identity.sessions
        WHERE token_hash=$1 AND status='active' AND expires_at>$2 AND idle_expires_at>$2`, [tokenHash, new Date(now())]);
      return result.rows[0] ? session(result.rows[0]) : null;
    },
    async lookupSession(tokenHash: string): Promise<SessionSnapshot | null> {
      const result = await pool.query<SnapshotRow>(`SELECT s.id,s.user_id,s.generation,s.credentials_cipher,s.expires_at,s.idle_expires_at,s.status,s.refresh_deadline,p.issuer,p.subject
        FROM vynvori_identity.sessions s JOIN vynvori_identity.profiles p ON p.id=s.user_id WHERE s.token_hash=$1`, [tokenHash]);
      return result.rows[0] ? snapshot(result.rows[0]) : null;
    },
    async readCustomerCredential(id: string, generation: number, projectId: string): Promise<StoredCustomerCredential | null> {
      const result = await pool.query<{ commerce_cipher: string; commerce_project_id: string; commerce_auth_identity_id: string; commerce_customer_id: string; commerce_expires_at: Date }>(`SELECT commerce_cipher,commerce_project_id,commerce_auth_identity_id,commerce_customer_id,commerce_expires_at
        FROM vynvori_identity.sessions WHERE id=$1 AND generation=$2 AND status='active' AND expires_at>$4 AND idle_expires_at>$4 AND commerce_project_id=$3 AND commerce_expires_at>$4`, [id, generation, projectId, new Date(now())]);
      const row = result.rows[0]; return row ? { cipher: row.commerce_cipher, projectId: row.commerce_project_id, authIdentityId: row.commerce_auth_identity_id, customerId: row.commerce_customer_id, expiresAt: row.commerce_expires_at } : null;
    },
    async cacheCustomerCredential(id: string, generation: number, input: StoredCustomerCredential): Promise<boolean> {
      const time = now();
      if (!Number.isFinite(input.expiresAt.getTime()) || input.expiresAt.getTime() <= time || input.expiresAt.getTime() > time + 300000) throw new Error("Invalid customer credential expiry");
      const result = await pool.query(`UPDATE vynvori_identity.sessions s SET commerce_cipher=$3,commerce_project_id=$4,commerce_auth_identity_id=$5,commerce_customer_id=$6,commerce_expires_at=LEAST(s.expires_at,$7)
        WHERE s.id=$1 AND s.generation=$2 AND s.status='active' AND s.expires_at>$8 AND s.idle_expires_at>$8
        AND EXISTS (SELECT 1 FROM vynvori_identity.commerce_mappings m WHERE m.user_id=s.user_id AND m.project_id=$4 AND m.state='ready' AND m.auth_identity_id=$5 AND m.customer_id=$6)`,
      [id, generation, input.cipher, input.projectId, input.authIdentityId, input.customerId, input.expiresAt, new Date(time)]);
      return result.rowCount === 1;
    },
    /** Call only after current central verification; generation/status prevents logout resurrection. */
    async touchSession(id: string, generation: number): Promise<boolean> {
      const time = now();
      const result = await pool.query(`UPDATE vynvori_identity.sessions SET idle_expires_at=LEAST(expires_at,$4)
        WHERE id=$1 AND generation=$2 AND status='active' AND expires_at>$3 AND idle_expires_at>$3`, [id, generation, new Date(time), new Date(time + 1800000)]);
      return result.rowCount === 1;
    },
    async claimRefresh(id: string, generation: number): Promise<string | null> {
      const lease = randomUUID(); const time = now();
      const result = await pool.query(`UPDATE vynvori_identity.sessions SET status='refreshing',refresh_lease_id=$3,refresh_deadline=$5
        WHERE id=$1 AND generation=$2 AND generation<96 AND status='active' AND expires_at>$4 AND idle_expires_at>$4`,
      [id, generation, lease, new Date(time), new Date(time + 15000)]);
      return result.rowCount === 1 ? lease : null;
    },
    /** No lease stealing/retries: a lost upstream rotation requires reauthentication. */
    async finishRefresh(id: string, generation: number, lease: string, credentialsCipher: string): Promise<boolean> {
      const time = now();
      const result = await pool.query(`UPDATE vynvori_identity.sessions SET status='active',generation=generation+1,credentials_cipher=$4,
        idle_expires_at=LEAST(expires_at,$6),refresh_lease_id=NULL,refresh_deadline=NULL,
        commerce_cipher=NULL,commerce_project_id=NULL,commerce_auth_identity_id=NULL,commerce_customer_id=NULL,commerce_expires_at=NULL
        WHERE id=$1 AND generation=$2 AND status='refreshing' AND refresh_lease_id=$3 AND refresh_deadline>$5 AND expires_at>$5 AND idle_expires_at>$5`,
      [id, generation, lease, credentialsCipher, new Date(time), new Date(time + 1800000)]);
      return result.rowCount === 1;
    },
    async requireReauth(id: string, generation: number, lease: string): Promise<void> {
      await pool.query(`UPDATE vynvori_identity.sessions SET status='reauth_required',refresh_lease_id=NULL,refresh_deadline=NULL
        WHERE id=$1 AND generation=$2 AND status='refreshing' AND refresh_lease_id=$3`, [id, generation, lease]);
    },
    async revokeSession(tokenHash: string): Promise<void> {
      await pool.query(`UPDATE vynvori_identity.sessions SET status='revoked',refresh_lease_id=NULL,refresh_deadline=NULL,
        commerce_cipher=NULL,commerce_project_id=NULL,commerce_auth_identity_id=NULL,commerce_customer_id=NULL,commerce_expires_at=NULL,
        central_revoke_state=CASE WHEN central_revoke_state='confirmed' THEN 'confirmed' ELSE 'pending' END WHERE token_hash=$1`, [tokenHash]);
    },
    /** Local revocation and durable central-revoke pending state commit before network I/O. */
    async revokeSessionAndRead(tokenHash: string): Promise<SessionSnapshot | null> {
      const result = await pool.query<SnapshotRow>(`UPDATE vynvori_identity.sessions s SET status='revoked',refresh_lease_id=NULL,refresh_deadline=NULL,
        commerce_cipher=NULL,commerce_project_id=NULL,commerce_auth_identity_id=NULL,commerce_customer_id=NULL,commerce_expires_at=NULL,
        central_revoke_state=CASE WHEN central_revoke_state='confirmed' THEN 'confirmed' ELSE 'pending' END FROM vynvori_identity.profiles p
        WHERE s.token_hash=$1 AND p.id=s.user_id RETURNING s.id,s.user_id,s.generation,s.credentials_cipher,s.expires_at,s.idle_expires_at,s.status,s.refresh_deadline,p.issuer,p.subject`, [tokenHash]);
      return result.rows[0] ? snapshot(result.rows[0]) : null;
    },
    async confirmCentralRevoke(id: string): Promise<void> {
      await pool.query(`UPDATE vynvori_identity.sessions SET central_revoke_state='confirmed',revoke_lease_id=NULL,revoke_lease_until=NULL,revoke_next_at=NULL WHERE id=$1 AND status='revoked'`, [id]);
    },
    /** One atomic lease; expired/abandoned local sessions close before any network request. */
    async claimCentralRevocation(cohort: { issuer: string; clientId: string; deployment: string }): Promise<(SessionSnapshot & { lease: string; attempts: number }) | null> {
      const time = now(), lease = randomUUID();
      const result = await pool.query<SnapshotRow & { revoke_attempts: number }>(`WITH candidate AS (
        SELECT s.id FROM vynvori_identity.sessions s JOIN vynvori_identity.profiles p ON p.id=s.user_id
        WHERE p.issuer=$1 AND s.authority_client_id=$2 AND s.deployment=$3 AND s.central_revoke_state<>'confirmed'
          AND s.revoke_attempts<8 AND (s.revoke_next_at IS NULL OR s.revoke_next_at<=$4)
          AND (s.revoke_lease_until IS NULL OR s.revoke_lease_until<=$4)
          AND ((s.status='revoked' AND s.central_revoke_state='pending') OR s.status='reauth_required'
            OR (s.status='active' AND (s.expires_at<=$4 OR s.idle_expires_at<=$4))
            OR (s.status='refreshing' AND (s.refresh_deadline<=$4 OR s.expires_at<=$4 OR s.idle_expires_at<=$4)))
        ORDER BY s.created_at,s.id FOR UPDATE OF s SKIP LOCKED LIMIT 1
      ) UPDATE vynvori_identity.sessions s SET status='revoked',central_revoke_state='pending',
        refresh_lease_id=NULL,refresh_deadline=NULL,revoke_attempts=s.revoke_attempts+1,revoke_lease_id=$5,revoke_lease_until=$6,
        commerce_cipher=NULL,commerce_project_id=NULL,commerce_auth_identity_id=NULL,commerce_customer_id=NULL,commerce_expires_at=NULL
        FROM candidate c,vynvori_identity.profiles p WHERE s.id=c.id AND p.id=s.user_id
        RETURNING s.id,s.user_id,s.generation,s.credentials_cipher,s.expires_at,s.idle_expires_at,s.status,s.refresh_deadline,p.issuer,p.subject,s.revoke_attempts`,
      [cohort.issuer, cohort.clientId, cohort.deployment, new Date(time), lease, new Date(time + 30000)]);
      const row = result.rows[0]; return row ? { ...snapshot(row), lease, attempts: row.revoke_attempts } : null;
    },
    /** Late workers cannot acknowledge a replaced lease or alter a confirmed revocation. */
    async settleCentralRevocation(id: string, lease: string, confirmed: boolean, delayMs: number): Promise<boolean> {
      if (!Number.isSafeInteger(delayMs) || delayMs < 60000 || delayMs > 3600000) throw new Error("Invalid revocation backoff");
      const time = now();
      const result = await pool.query(`UPDATE vynvori_identity.sessions SET central_revoke_state=$3,revoke_lease_id=NULL,revoke_lease_until=NULL,revoke_next_at=$4
        WHERE id=$1 AND revoke_lease_id=$2 AND revoke_lease_until>$5 AND status='revoked' AND central_revoke_state='pending'`,
      [id, lease, confirmed ? 'confirmed' : 'pending', confirmed ? null : new Date(time + delayMs), new Date(time)]);
      return result.rowCount === 1;
    },
    async createGuestDraft(id: string, capabilityHash: string, expiresAt: Date): Promise<void> {
      if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= now()) throw new Error("Invalid guest expiry");
      await pool.query(`INSERT INTO vynvori_identity.guest_drafts(id,capability_hash,expires_at) VALUES ($1,$2,$3)`, [id, capabilityHash, expiresAt]);
    },
    /** Both possession of the guest capability and a current local session are necessary. */
    async claimGuestDraft(id: string, capabilityHash: string, sessionId: string, generation: number): Promise<boolean> {
      const result = await pool.query(`UPDATE vynvori_identity.guest_drafts AS draft SET owner_id=s.user_id,claimed_at=COALESCE(draft.claimed_at,$5)
        FROM vynvori_identity.sessions AS s WHERE draft.id=$1 AND draft.capability_hash=$2 AND draft.expires_at>$5
        AND s.id=$3 AND s.generation=$4 AND s.status='active' AND s.expires_at>$5 AND s.idle_expires_at>$5
        AND (draft.owner_id IS NULL OR draft.owner_id=s.user_id)`, [id, capabilityHash, sessionId, generation, new Date(now())]);
      return result.rowCount === 1;
    },
  };
}
