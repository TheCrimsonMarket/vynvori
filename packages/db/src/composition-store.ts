import "server-only";
import type { Pool, PoolClient } from "pg";
import { CompositionSceneV1Schema, type PreflightIssue, type PrintProfileV1 } from "@vynvori/contracts";
import type { AssetRecord, CompositionAccess, CompositionRecord, CompositionStore, VersionRecord } from "@vynvori/contracts/composition-port";

const S = "vynvori_composition", I = "vynvori_identity";
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/**
 * Access predicate used verbatim in every statement so authorisation happens in SQL, never after the fact.
 * owner: the composition belongs to the verified user. guest: composition still unowned AND the capability hash matches AND the
 * M1b guest draft is unexpired AND unclaimed. Absent, foreign, expired and claimed all look identical (no rows).
 */
function allowed(access: CompositionAccess, alias: string, params: unknown[], now: Date): string {
  if (access.kind === "owner") { params.push(access.userId); return `${alias}.owner_user_id = $${params.length}`; }
  params.push(access.capabilityHash, now);
  return `(${alias}.owner_user_id IS NULL AND EXISTS (SELECT 1 FROM ${I}.guest_drafts gd WHERE gd.id = ${alias}.guest_draft_id
    AND gd.capability_hash = $${params.length - 1} AND gd.expires_at > $${params.length} AND gd.owner_id IS NULL))`;
}
const record = (row: Row): CompositionRecord => ({
  id: row.id, ownerUserId: row.owner_user_id, lifecycleState: row.lifecycle_state, scene: CompositionSceneV1Schema.parse(row.draft_scene),
  sceneSha256: row.draft_scene_sha256, draftRevision: row.draft_revision, currentVersionId: row.current_version_id,
  currentVersionSceneSha256: row.current_version_scene_sha256 ?? null, printProfileId: row.print_profile_id, printProfileVersion: row.print_profile_version,
  createdAt: row.created_at, updatedAt: row.updated_at, guestExpiresAt: row.owner_user_id ? null : row.guest_expires_at ?? null,
});
const asset = (row: Row): AssetRecord => ({ id: row.id, compositionId: row.composition_id, sha256: row.sha256, mime: row.mime, byteSize: row.byte_size, widthPx: row.width_px, heightPx: row.height_px, objectKey: row.object_key, createdAt: row.created_at });
const version = (row: Row): VersionRecord => ({
  id: row.id, compositionId: row.composition_id, versionNo: row.version_no, scene: CompositionSceneV1Schema.parse(row.scene), sceneSha256: row.scene_sha256,
  printProfileId: row.print_profile_id, printProfileVersion: row.print_profile_version, preflightState: row.preflight_state, preflightIssues: row.preflight_issues as PreflightIssue[], frozenAt: row.frozen_at,
});
const COMPOSITION = `SELECT c.*, v.scene_sha256 AS current_version_scene_sha256, gd0.expires_at AS guest_expires_at
  FROM ${S}.compositions c LEFT JOIN ${S}.composition_versions v ON v.id = c.current_version_id AND v.composition_id = c.id
  LEFT JOIN ${I}.guest_drafts gd0 ON gd0.id = c.guest_draft_id`;

export function compositionStore(pool: Pool): CompositionStore {
  async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    finally { client.release(); }
  }
  async function read(runner: Pick<Pool, "query">, id: string, access: CompositionAccess, now: Date, lock = ""): Promise<CompositionRecord | null> {
    const params: unknown[] = [id], predicate = allowed(access, "c", params, now);
    const result = await runner.query(`${COMPOSITION} WHERE c.id = $1 AND ${predicate}${lock}`, params);
    return result.rows[0] ? record(result.rows[0]) : null;
  }
  return {
    async ensurePrintProfile(profile: PrintProfileV1, sha: string) {
      await pool.query(`INSERT INTO ${S}.print_profiles(profile_id,version,status,supplier_approved,print_release_eligible,definition,definition_sha256) VALUES($1,$2,$3,false,false,$4,$5) ON CONFLICT DO NOTHING`,
        [profile.profileId, profile.version, profile.status, JSON.stringify(profile), sha]);
      const stored = await pool.query(`SELECT definition_sha256 FROM ${S}.print_profiles WHERE profile_id=$1 AND version=$2`, [profile.profileId, profile.version]);
      if (stored.rows[0]?.definition_sha256 !== sha) throw new Error("Print profile version already exists with different content");
    },
    async createGuest(input) {
      return transaction(async client => {
        await client.query(`INSERT INTO ${I}.guest_drafts(id,capability_hash,expires_at) VALUES($1,$2,$3)`, [input.id, input.capabilityHash, input.guestExpiresAt]);
        await client.query(`INSERT INTO ${S}.compositions(id,guest_draft_id,product_family,print_profile_id,print_profile_version,lifecycle_state,draft_scene,draft_scene_sha256)
          VALUES($1,$1,$2,$3,$4,$5,$6,$7)`, [input.id, input.scene.productFamily, input.scene.printProfileId, input.scene.printProfileVersion, input.state, JSON.stringify(input.scene), input.sceneSha256]);
        return (await read(client, input.id, { kind: "guest", capabilityHash: input.capabilityHash }, new Date()))!;
      });
    },
    async createOwned(input) {
      await pool.query(`INSERT INTO ${S}.compositions(id,owner_user_id,product_family,print_profile_id,print_profile_version,lifecycle_state,draft_scene,draft_scene_sha256)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [input.id, input.ownerUserId, input.scene.productFamily, input.scene.printProfileId, input.scene.printProfileVersion, input.state, JSON.stringify(input.scene), input.sceneSha256]);
      return (await read(pool, input.id, { kind: "owner", userId: input.ownerUserId }, new Date()))!;
    },
    get: (id, access, now) => read(pool, id, access, now),
    async listOwned(userId) {
      return (await pool.query(`${COMPOSITION} WHERE c.owner_user_id = $1 ORDER BY c.updated_at DESC LIMIT 100`, [userId])).rows.map(record);
    },
    async saveDraft(id, access, now, input) {
      const params: unknown[] = [id, input.expectedRevision, JSON.stringify(input.scene), input.sceneSha256, input.state, now], predicate = allowed(access, "c", params, now);
      const updated = await pool.query(`UPDATE ${S}.compositions c SET draft_scene=$3, draft_scene_sha256=$4, draft_revision=c.draft_revision+1, lifecycle_state=$5, updated_at=$6
        WHERE c.id=$1 AND c.draft_revision=$2 AND ${predicate} RETURNING c.id`, params);
      const current = await read(pool, id, access, now);
      if (!current) return { status: "not_found" as const };
      return updated.rowCount === 1 ? { status: "saved" as const, record: current } : { status: "conflict" as const, currentRevision: current.draftRevision };
    },
    async adoptClaimedGuest(id, userId, capabilityHash, now) {
      const result = await pool.query(`UPDATE ${S}.compositions c SET owner_user_id=$2, updated_at=$4,
          lifecycle_state=CASE WHEN c.lifecycle_state IN ('guest_draft','editable_scene') THEN 'saved_owned' ELSE c.lifecycle_state END
        FROM ${I}.guest_drafts gd WHERE c.id=$1 AND c.owner_user_id IS NULL AND gd.id=c.guest_draft_id AND gd.capability_hash=$3
          AND gd.owner_id=$2 AND gd.claimed_at IS NOT NULL RETURNING c.id`, [id, userId, capabilityHash, now]);
      return result.rowCount === 1 ? read(pool, id, { kind: "owner", userId }, now) : null;
    },
    async insertAsset(id, access, now, value) {
      const params: unknown[] = [value.id, id, value.objectKey, value.sha256, value.mime, value.byteSize, value.widthPx, value.heightPx], predicate = allowed(access, "c", params, now);
      const inserted = await pool.query(`INSERT INTO ${S}.assets(id,composition_id,kind,object_key,sha256,mime,byte_size,width_px,height_px)
        SELECT $1,c.id,'customer_original',$3,$4,$5,$6,$7,$8 FROM ${S}.compositions c WHERE c.id=$2 AND ${predicate}
        ON CONFLICT (composition_id, sha256) DO NOTHING RETURNING *`, params);
      if (inserted.rows[0]) return asset(inserted.rows[0]);
      const lookup: unknown[] = [id, value.sha256], guard = allowed(access, "c", lookup, now);
      const existing = await pool.query(`SELECT a.* FROM ${S}.assets a JOIN ${S}.compositions c ON c.id=a.composition_id WHERE a.composition_id=$1 AND a.sha256=$2 AND ${guard}`, lookup);
      return existing.rows[0] ? asset(existing.rows[0]) : null;
    },
    async getAsset(compositionId, assetId, access, now) {
      const params: unknown[] = [compositionId, assetId], predicate = allowed(access, "c", params, now);
      const result = await pool.query(`SELECT a.* FROM ${S}.assets a JOIN ${S}.compositions c ON c.id=a.composition_id WHERE a.composition_id=$1 AND a.id=$2 AND ${predicate}`, params);
      return result.rows[0] ? asset(result.rows[0]) : null;
    },
    async listAssets(compositionId, access, now) {
      const params: unknown[] = [compositionId], predicate = allowed(access, "c", params, now);
      if (!(await pool.query(`SELECT 1 FROM ${S}.compositions c WHERE c.id=$1 AND ${predicate}`, params)).rowCount) return null;
      return (await pool.query(`SELECT * FROM ${S}.assets WHERE composition_id=$1 ORDER BY created_at, id`, [compositionId])).rows.map(asset);
    },
    async freeze(compositionId, access, now, input) {
      return transaction(async client => {
        const current = await read(client, compositionId, access, now, " FOR UPDATE OF c");
        if (!current) return { status: "not_found" as const };
        if (current.draftRevision !== input.expectedRevision) return { status: "conflict" as const, currentRevision: current.draftRevision };
        const existing = await client.query(`SELECT * FROM ${S}.composition_versions WHERE composition_id=$1 AND scene_sha256=$2`, [compositionId, input.version.sceneSha256]);
        let row: Row | undefined = existing.rows[0];
        if (!row) {
          const next = (await client.query(`SELECT COALESCE(MAX(version_no),0)+1 AS n FROM ${S}.composition_versions WHERE composition_id=$1`, [compositionId])).rows[0].n;
          row = (await client.query(`INSERT INTO ${S}.composition_versions(id,composition_id,version_no,scene,scene_sha256,source_asset_sha256,source_font_sha256,print_profile_id,print_profile_version,preflight_state,preflight_issues,frozen_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`, [input.version.id, compositionId, next, JSON.stringify(input.version.scene), input.version.sceneSha256, input.sourceAssetSha256, input.sourceFontSha256,
            input.version.printProfileId, input.version.printProfileVersion, input.version.preflightState, JSON.stringify(input.version.preflightIssues), now])).rows[0];
        }
        await client.query(`UPDATE ${S}.compositions SET current_version_id=$2, lifecycle_state=$3, updated_at=$4 WHERE id=$1`, [compositionId, row!.id, input.state, now]);
        return { status: "frozen" as const, version: version(row!), record: (await read(client, compositionId, access, now))! };
      });
    },
    async getVersion(compositionId, versionId, access, now) {
      const params: unknown[] = [compositionId, versionId], predicate = allowed(access, "c", params, now);
      const result = await pool.query(`SELECT v.* FROM ${S}.composition_versions v JOIN ${S}.compositions c ON c.id=v.composition_id WHERE v.composition_id=$1 AND v.id=$2 AND ${predicate}`, params);
      return result.rows[0] ? version(result.rows[0]) : null;
    },
    async listVersions(compositionId, access, now) {
      const params: unknown[] = [compositionId], predicate = allowed(access, "c", params, now);
      if (!(await pool.query(`SELECT 1 FROM ${S}.compositions c WHERE c.id=$1 AND ${predicate}`, params)).rowCount) return null;
      return (await pool.query(`SELECT * FROM ${S}.composition_versions WHERE composition_id=$1 ORDER BY version_no`, [compositionId])).rows.map(version);
    },
  };
}
