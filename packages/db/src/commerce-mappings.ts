import "server-only";
import type { Pool } from "pg";

export type CommerceMappingRecord = Readonly<{ userId: string; projectId: string; entityId: string; operationId: string; requestCipher: string;
  state: "reserved" | "dispatching" | "ready" | "reconcile_required" | "conflict"; authIdentityId: string | null; customerId: string | null }>;
type Row = { user_id: string; project_id: string; entity_id: string; operation_id: string; request_cipher: string;
  state: CommerceMappingRecord["state"]; auth_identity_id: string | null; customer_id: string | null };
const record = (row: Row): CommerceMappingRecord => ({ userId: row.user_id, projectId: row.project_id, entityId: row.entity_id, operationId: row.operation_id,
  requestCipher: row.request_cipher, state: row.state, authIdentityId: row.auth_identity_id, customerId: row.customer_id });
/** Creative database mapping journal only; never accesses the Medusa database. */
export function commerceMappingStore(pool: Pool) {
  return {
    /**
     * First writer wins; every concurrent caller converges on that one row. The ON CONFLICT clause names no target on purpose, so every
     * unique constraint of the table arbitrates: a racing insert that collides on (project_id,entity_id) or operation_id waits for the
     * winner and does nothing instead of raising 23505 (M1b-fix-1). The read is a separate statement so it sees the committed winner.
     * Only this user's own row is ever returned; a collision with another user's row leaves nothing to read and fails closed.
     */
    async reserve(input: { userId: string; projectId: string; entityId: string; operationId: string; requestCipher: string }): Promise<CommerceMappingRecord> {
      await pool.query(`INSERT INTO vynvori_identity.commerce_mappings(user_id,project_id,entity_id,operation_id,request_cipher)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [input.userId, input.projectId, input.entityId, input.operationId, input.requestCipher]);
      const result = await pool.query<Row>(`SELECT * FROM vynvori_identity.commerce_mappings WHERE user_id=$1 AND project_id=$2`, [input.userId, input.projectId]);
      if (!result.rows[0]) throw new Error("Mapping unavailable");
      return record(result.rows[0]);
    },
    async get(userId: string, projectId: string): Promise<CommerceMappingRecord | null> {
      const result = await pool.query<Row>(`SELECT * FROM vynvori_identity.commerce_mappings WHERE user_id=$1 AND project_id=$2`, [userId, projectId]);
      return result.rows[0] ? record(result.rows[0]) : null;
    },
    async claimDispatch(operationId: string): Promise<boolean> {
      const result = await pool.query(`UPDATE vynvori_identity.commerce_mappings SET state='dispatching',updated_at=now()
        WHERE operation_id=$1 AND state='reserved'`, [operationId]);
      return result.rowCount === 1;
    },
    async markUncertain(operationId: string): Promise<void> {
      await pool.query(`UPDATE vynvori_identity.commerce_mappings SET state='reconcile_required',updated_at=now()
        WHERE operation_id=$1 AND state='dispatching'`, [operationId]);
    },
    /** Only for a trusted local transport receipt that no HTTP request was dispatched. */
    async releaseUndispatched(operationId: string): Promise<void> {
      await pool.query(`UPDATE vynvori_identity.commerce_mappings SET state='reserved',updated_at=now() WHERE operation_id=$1 AND state='dispatching'`, [operationId]);
    },
    async markConflict(operationId: string): Promise<void> {
      await pool.query(`UPDATE vynvori_identity.commerce_mappings SET state='conflict',updated_at=now()
        WHERE operation_id=$1 AND state IN ('reserved','dispatching','reconcile_required')`, [operationId]);
    },
    async complete(operationId: string, authIdentityId: string, customerId: string): Promise<boolean> {
      const result = await pool.query(`UPDATE vynvori_identity.commerce_mappings SET state='ready',auth_identity_id=$2,customer_id=$3,updated_at=now()
        WHERE operation_id=$1 AND (state IN ('dispatching','reconcile_required') OR (state='ready' AND auth_identity_id=$2 AND customer_id=$3))`,
      [operationId, authIdentityId, customerId]);
      return result.rowCount === 1;
    },
  };
}
