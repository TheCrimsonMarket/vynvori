import { after } from "node:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { compositionStore } from "@vynvori/db/composition";
import { compositionConformance } from "./composition-suite";
import { storeConformance, type StoreHarness } from "./composition-store-suite";
import { limiterConformance } from "./composition-limiter-suite";
import { scanConformance } from "./composition-scan-suite";
import { downloadConformance } from "./composition-download-suite";
import { SYNTHETIC_SCAN_EVIDENCE } from "./composition-synthetic";
import { freshComposition } from "../../db/tests/composition-fixture";
// CI sets CI_REQUIRE_PG_TESTS=1 so a missing database fails the run instead of silently skipping.
const requirePg = process.env.CI_REQUIRE_PG_TESTS === "1";

const connection = process.env.M3_TEST_POSTGRES_URL;
const skip = !connection && !requirePg;
/**
 * ONE pool for the whole file, capped at 4 (ADR-0022 D8: this file's declared peak is 5 = pool 4 + the transient admin client
 * that `freshComposition` opens and closes per test). Tests in a file run sequentially, so the schema reset never races a query.
 */
let pool: Pool | undefined;
after(async () => { await pool?.end(); });

/** The identical behavioural suites, against the real SQL store, constraints and triggers. */
async function pgHarness(): Promise<StoreHarness> {
  const admin = await freshComposition("vynvori_m3_service_test"); await admin.end();
  pool ??= new Pool({ connectionString: connection!.replace("vynvori_m3_migration_test", "vynvori_m3_service_test"), max: 4 });
  const db = pool;
  return {
    store: compositionStore(db),
    async newUser() { const id = randomUUID(); await db.query("INSERT INTO vynvori_identity.profiles(id,issuer,subject) VALUES($1,'https://issuer.test',$2)", [id, id]); return id; },
    async m1bClaim(draftId, userId) { await db.query("UPDATE vynvori_identity.guest_drafts SET owner_id=$2, claimed_at=now() WHERE id=$1", [draftId, userId]); },
    async bucketCount() { return (await db.query("SELECT count(*)::int AS n FROM vynvori_composition.rate_limit_buckets")).rows[0].n as number; },
    async expireGuest(draftId) { await db.query("UPDATE vynvori_identity.guest_drafts SET expires_at=to_timestamp(0) WHERE id=$1", [draftId]); },
    /** Test-only injection of the `clean -> quarantined` late-detection edge through the real trigger (no C3b primitive produces it). */
    async lateQuarantine(compositionId, assetId) {
      const attemptId = randomUUID();
      await db.query(`INSERT INTO vynvori_composition.asset_scan_attempts(attempt_id,asset_id,composition_id,started_at,lease_expires_at,finished_at,outcome)
        VALUES($1,$2,$3,now(),now()+interval '1 second',now(),'completed')`, [attemptId, assetId, compositionId]);
      await db.query(`INSERT INTO vynvori_composition.asset_scan_events(asset_id,composition_id,seq,from_status,to_status,asset_sha256,attempt_id,scanner_id,engine_version,definitions_version,evidence_ref)
        SELECT a.id, a.composition_id, (SELECT COALESCE(MAX(seq),0)+1 FROM vynvori_composition.asset_scan_events WHERE asset_id=a.id), 'clean', 'quarantined', a.sha256, $3, $4, $5, 'synthetic-defs-1', 'evidence://synthetic/late'
        FROM vynvori_composition.assets a WHERE a.id=$2 AND a.composition_id=$1`, [compositionId, assetId, attemptId, SYNTHETIC_SCAN_EVIDENCE.scannerId, SYNTHETIC_SCAN_EVIDENCE.engineVersion]);
    },
  };
}
compositionConformance("composition service (PostgreSQL store)", pgHarness, { skip });
storeConformance("composition store primitives (PostgreSQL store)", pgHarness, { skip });
limiterConformance("composition limiter (PostgreSQL store)", pgHarness, { skip });
scanConformance("composition scan boundary (PostgreSQL store)", pgHarness, { skip });
downloadConformance("composition download grants (PostgreSQL store)", pgHarness, { skip });
