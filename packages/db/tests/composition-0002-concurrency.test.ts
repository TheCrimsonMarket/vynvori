import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { connectionString, freshCompositionDatabase, compositionPool } from "./composition-fixture";

// CI sets CI_REQUIRE_PG_TESTS=1 so a missing database fails the run instead of silently skipping.
const requirePg = process.env.CI_REQUIRE_PG_TESTS === "1";
const hashOf = (label: string) => createHash("sha256").update(label).digest("hex");

test("M3 0002 concurrency: scan-event, attempt, grant and rate-bucket races; lock-order deadlock-freedom", { skip: !connectionString && !requirePg }, async t => {
  assert.ok(connectionString, "CI_REQUIRE_PG_TESTS=1 requires M3_TEST_POSTGRES_URL");
  const setup = await freshCompositionDatabase("concurrency");
  const q = (text: string, values?: unknown[]) => setup.query(text, values);
  const { pool } = await compositionPool("concurrency", "concurrency"); // pool cap 18 (ADR-0022 D8)

  async function makeAsset(label: string) {
    const id = randomUUID(); // composition id doubles as the guest_draft id, as in the 0001 fixture pattern.
    const assetId = randomUUID();
    const hash = hashOf(label + ":bytes");
    await q(
      "INSERT INTO vynvori_composition.print_profiles(profile_id,version,status,definition,definition_sha256) VALUES('p','1','synthetic_unapproved','{}',$1) ON CONFLICT DO NOTHING",
      ["a".repeat(64)],
    );
    await q("INSERT INTO vynvori_identity.guest_drafts(id,capability_hash,expires_at) VALUES($1,$2,now()+interval '1 day')", [id, hashOf(label + ":cap")]);
    await q(
      "INSERT INTO vynvori_composition.compositions(id,guest_draft_id,product_family,print_profile_id,print_profile_version,lifecycle_state,draft_scene,draft_scene_sha256) VALUES($1,$1,'f','p','1','guest_draft','{}',$2)",
      [id, hashOf(label + ":scene")],
    );
    await q(
      "INSERT INTO vynvori_composition.assets(id,composition_id,kind,object_key,sha256,mime,byte_size,width_px,height_px) VALUES($1,$2,'customer_original',$3,$4,'image/png',10,1,1)",
      [assetId, id, `private/composition/v1/${id}/${hash}`, hash],
    );
    return { compositionId: id, assetId, hash };
  }
  async function openAttempt(assetId: string, compositionId: string) {
    const attemptId = randomUUID();
    await q(
      "INSERT INTO vynvori_composition.asset_scan_attempts(attempt_id, asset_id, composition_id, lease_expires_at) VALUES ($1,$2,$3, now() + interval '1 minute')",
      [attemptId, assetId, compositionId],
    );
    return attemptId;
  }

  try {
    await t.test("SYNTHETIC_CONCURRENCY concurrent inserts of the same next scan event for one asset: exactly one wins, seq stays gap-free", async () => {
      const SYNTHETIC_CONCURRENCY = 10;
      const { compositionId, assetId, hash } = await makeAsset("race-events");
      const attemptIds: string[] = [];
      for (let i = 0; i < SYNTHETIC_CONCURRENCY; i += 1) {
        // Only one open attempt per asset is allowed; close each before opening the next so the FK target exists
        // without violating that constraint. The event insert's trigger does not require the attempt to be open.
        const attemptId = await openAttempt(assetId, compositionId);
        await q("UPDATE vynvori_composition.asset_scan_attempts SET finished_at = now(), outcome = 'completed' WHERE attempt_id = $1", [attemptId]);
        attemptIds.push(attemptId);
      }
      const results = await Promise.allSettled(
        attemptIds.map(attemptId => pool.query(
          `INSERT INTO vynvori_composition.asset_scan_events
             (asset_id, composition_id, seq, from_status, to_status, asset_sha256, attempt_id, scanner_id, engine_version, definitions_version, evidence_ref)
           VALUES ($1,$2,1,'pending','clean',$3,$4,'synthetic-scanner','1.0.0','2026-11-04','evidence://synthetic/1')`,
          [assetId, compositionId, hash, attemptId],
        )),
      );
      assert.equal(results.filter(r => r.status === "fulfilled").length, 1, "exactly one insert should win the race for seq=1");
      const rows = await q("SELECT seq FROM vynvori_composition.asset_scan_events WHERE asset_id=$1 ORDER BY seq", [assetId]);
      assert.deepEqual(rows.rows.map(r => r.seq), [1], "seq stays gap-free: no row for any loser");
    });

    await t.test("SYNTHETIC_CONCURRENCY concurrent opens of a scan attempt for one asset: exactly one open attempt", async () => {
      const SYNTHETIC_CONCURRENCY = 10;
      const { compositionId, assetId } = await makeAsset("race-attempts");
      const results = await Promise.allSettled(
        Array.from({ length: SYNTHETIC_CONCURRENCY }, () => pool.query(
          "INSERT INTO vynvori_composition.asset_scan_attempts(attempt_id, asset_id, composition_id, lease_expires_at) VALUES ($1,$2,$3, now() + interval '1 minute')",
          [randomUUID(), assetId, compositionId],
        )),
      );
      assert.equal(results.filter(r => r.status === "fulfilled").length, 1, "exactly one attempt should open for this asset");
      const open = await q("SELECT count(*) AS n FROM vynvori_composition.asset_scan_attempts WHERE asset_id=$1 AND finished_at IS NULL", [assetId]);
      assert.equal(Number(open.rows[0].n), 1);
    });

    await t.test("SYNTHETIC_CONCURRENCY concurrent redeems of one grant: exactly one winner", async () => {
      const SYNTHETIC_CONCURRENCY = 10;
      const { compositionId, assetId } = await makeAsset("race-grants");
      const grantId = randomUUID(), token = hashOf("race-grants:token");
      await q(
        "INSERT INTO vynvori_composition.asset_download_grants(grant_id, token_hash, asset_id, composition_id, principal_kind, principal_hash, expires_at) VALUES ($1,$2,$3,$4,'guest',$5, now() + interval '1 hour')",
        [grantId, token, assetId, compositionId, hashOf("race-grants:principal")],
      );
      const redeem = () => pool.query(
        "UPDATE vynvori_composition.asset_download_grants SET redeemed_at = now() WHERE token_hash = $1 AND redeemed_at IS NULL AND expires_at > now() RETURNING grant_id",
        [token],
      );
      const results = await Promise.all(Array.from({ length: SYNTHETIC_CONCURRENCY }, redeem));
      assert.equal(results.filter(r => r.rows.length === 1).length, 1, "exactly one redeem should return a row");
    });

    await t.test("atomic bucket admission: SYNTHETIC_CONCURRENCY callers, SYNTHETIC_LIMIT < SYNTHETIC_CONCURRENCY, admits exactly SYNTHETIC_LIMIT", async () => {
      const SYNTHETIC_LIMIT = 5, SYNTHETIC_CONCURRENCY = 12;
      const bucketKey = "OWNER_WRITE:" + randomUUID(), windowStart = new Date();
      const admit = () => pool.query(
        `INSERT INTO vynvori_composition.rate_limit_buckets AS b (bucket_key, window_start, count) VALUES ($1, $2, 1)
         ON CONFLICT (bucket_key, window_start) DO UPDATE SET count = b.count + 1 WHERE b.count < $3
         RETURNING count`,
        [bucketKey, windowStart, SYNTHETIC_LIMIT],
      );
      const results = await Promise.all(Array.from({ length: SYNTHETIC_CONCURRENCY }, admit));
      assert.equal(results.filter(r => r.rows.length === 1).length, SYNTHETIC_LIMIT, `exactly ${SYNTHETIC_LIMIT} callers should be admitted`);
      const row = await q("SELECT count FROM vynvori_composition.rate_limit_buckets WHERE bucket_key=$1 AND window_start=$2", [bucketKey, windowStart]);
      assert.equal(Number(row.rows[0].count), SYNTHETIC_LIMIT);
    });

    await t.test("two callers through the lock helpers serialize on the shared composition-then-asset order without a deadlock", async () => {
      // m3_lock_asset always takes the composition lock before the asset lock (enforced by construction), so there
      // is no way for two callers going through the helpers to acquire these two locks in opposite orders; the
      // strongest contention case is both callers wanting the SAME composition and asset at once. This proves that
      // case resolves by simple serialization (one finishes, then the other) rather than a deadlock_timeout error.
      const { compositionId, assetId } = await makeAsset("deadlock-free");
      const sessionA = await pool.connect(), sessionB = await pool.connect();
      try {
        await sessionA.query("BEGIN"); await sessionB.query("BEGIN");
        const a = sessionA.query("SELECT vynvori_composition.m3_lock_asset($1,$2)", [compositionId, assetId]);
        const b = sessionB.query("SELECT vynvori_composition.m3_lock_asset($1,$2)", [compositionId, assetId]);
        const winner = await Promise.race([a.then(() => "a" as const), b.then(() => "b" as const)]);
        const [winnerClient, loserPromise] = winner === "a" ? [sessionA, b] : [sessionB, a];
        await winnerClient.query("COMMIT"); // release both locks the winner held, so the loser can proceed
        const finished = await Promise.race([
          loserPromise.then(() => "completed" as const),
          new Promise<"timeout">(resolve => setTimeout(() => resolve("timeout"), 5000)),
        ]);
        assert.equal(finished, "completed", "the second caller must finish once the first commits, with no deadlock");
        await (winner === "a" ? sessionB : sessionA).query("COMMIT");
      } finally {
        await sessionA.query("ROLLBACK").catch(() => undefined);
        await sessionB.query("ROLLBACK").catch(() => undefined);
        sessionA.release(); sessionB.release();
      }
    });
  } finally {
    await pool.end().catch(() => {});
    await setup.end().catch(() => {});
  }
});
