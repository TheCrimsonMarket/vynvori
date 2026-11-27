import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { connectionString, freshCompositionDatabase, compositionPool, POOL_CAPS } from "./composition-fixture";
import { EMPTY_SYNTHETIC_SCENE, SYNTHETIC_PREVIEW_PROFILE } from "@vynvori/contracts";
import { compositionStore, lockAsset, lockComposition, withCompositionTransaction, type CompositionTx } from "../src/composition-store";

// CI sets CI_REQUIRE_PG_TESTS=1 so a missing database fails the run instead of silently skipping.
const requirePg = process.env.CI_REQUIRE_PG_TESTS === "1";
const hashOf = (label: string) => createHash("sha256").update(label).digest("hex");

test("M3 0002 concurrency: scan-event, attempt, grant and rate-bucket races; lock-order deadlock-freedom", { skip: !connectionString && !requirePg }, async t => {
  assert.ok(connectionString, "CI_REQUIRE_PG_TESTS=1 requires M3_TEST_POSTGRES_URL");
  const setup = await freshCompositionDatabase("concurrency");
  const q = (text: string, values?: unknown[]) => setup.query(text, values);
  const { pool } = await compositionPool("concurrency", "concurrency"); // pool cap 18 (ADR-0022 D8)
  const store = compositionStore(pool); // C3b: the store shares this file's pool, so the races below stay inside the 20 budget
  let peakClients = 0;
  const sampler = setInterval(() => { peakClients = Math.max(peakClients, pool.totalCount); }, 1);
  const later = (ms: number) => new Promise<"pending">(resolve => setTimeout(() => resolve("pending"), ms));

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
    return { compositionId: id, assetId, hash, access: { kind: "guest" as const, capabilityHash: hashOf(label + ":cap") } };
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
    // ---- C3b: the same races through the store primitives -------------------------------------------------------------
    const lease = () => ({ attemptId: randomUUID(), leaseExpiresAt: new Date(Date.now() + 60_000) });
    const clean = async (a: Awaited<ReturnType<typeof makeAsset>>) => {
      const opened = await store.openScanAttempt(a.compositionId, a.assetId, a.access, new Date(), lease());
      assert.equal(opened.status, "opened"); if (opened.status !== "opened") return;
      assert.equal((await store.completeScanAttempt(a.compositionId, a.assetId, a.access, new Date(), { attemptId: opened.attempt.attemptId, result: { toStatus: "clean", scannerId: "synthetic-scanner", engineVersion: "synthetic-engine-0", definitionsVersion: "synthetic-defs-0", evidenceRef: "evidence://synthetic/clean" } })).status, "recorded");
    };

    await t.test("C3b store: SYNTHETIC_CONCURRENCY concurrent redeems of one grant (mixed with wrong-principal callers) give exactly one winner", async () => {
      const SYNTHETIC_CONCURRENCY = 12;
      const a = await makeAsset("store-grant-race"), intruder = await makeAsset("store-grant-intruder"), token = hashOf("store-grant-race:token");
      await clean(a);
      const minted = await store.createDownloadGrant(a.compositionId, a.assetId, a.access, new Date(), { grantId: randomUUID(), tokenHash: token, expiresAt: new Date(Date.now() + 300_000) });
      assert.equal(minted.status, "created");
      const callers = Array.from({ length: SYNTHETIC_CONCURRENCY }, (_, i) => i % 3 === 0 ? intruder.access : a.access);
      const results = await Promise.all(callers.map(access => store.consumeDownloadGrant(a.compositionId, a.assetId, access, new Date(), token)));
      assert.equal(results.filter(r => r !== null).length, 1, "exactly one redeem wins");
      results.forEach((r, i) => { if (r) assert.equal(callers[i], a.access, "only the minting principal can win"); });
      const row = await q("SELECT count(*) FILTER (WHERE redeemed_at IS NOT NULL) AS n FROM vynvori_composition.asset_download_grants WHERE token_hash=$1", [token]);
      assert.equal(Number(row.rows[0].n), 1);
    });

    await t.test("C3b store: a wrong-principal consume returns nothing and leaves the grant spendable", async () => {
      const a = await makeAsset("store-grant-wrong"), intruder = await makeAsset("store-grant-wrong-intruder"), token = hashOf("store-grant-wrong:token");
      await clean(a);
      assert.equal((await store.createDownloadGrant(a.compositionId, a.assetId, a.access, new Date(), { grantId: randomUUID(), tokenHash: token, expiresAt: new Date(Date.now() + 300_000) })).status, "created");
      assert.equal(await store.consumeDownloadGrant(a.compositionId, a.assetId, intruder.access, new Date(), token), null);
      const spendable = await q("SELECT redeemed_at FROM vynvori_composition.asset_download_grants WHERE token_hash=$1", [token]);
      assert.equal(spendable.rows[0].redeemed_at, null, "the wrong principal did not burn the grant");
      assert.ok(await store.consumeDownloadGrant(a.compositionId, a.assetId, a.access, new Date(), token));
    });

    await t.test("C3b store: SYNTHETIC_CONCURRENCY concurrent openScanAttempt calls reserve exactly one attempt; the rest see busy", async () => {
      const SYNTHETIC_CONCURRENCY = 12;
      const a = await makeAsset("store-open-race");
      const results = await Promise.all(Array.from({ length: SYNTHETIC_CONCURRENCY }, () => store.openScanAttempt(a.compositionId, a.assetId, a.access, new Date(), lease())));
      assert.equal(results.filter(r => r.status === "opened").length, 1);
      assert.equal(results.filter(r => r.status === "busy").length, SYNTHETIC_CONCURRENCY - 1);
    });

    await t.test("C3b store: SYNTHETIC_CONCURRENCY concurrent completions of one attempt record exactly one event; seq stays gap-free", async () => {
      const SYNTHETIC_CONCURRENCY = 12;
      const a = await makeAsset("store-complete-race");
      const opened = await store.openScanAttempt(a.compositionId, a.assetId, a.access, new Date(), lease());
      if (opened.status !== "opened") return assert.fail(opened.status);
      const verdicts = ["clean", "quarantined"] as const;
      const results = await Promise.all(Array.from({ length: SYNTHETIC_CONCURRENCY }, (_, i) => store.completeScanAttempt(a.compositionId, a.assetId, a.access, new Date(), {
        attemptId: opened.attempt.attemptId, result: { toStatus: verdicts[i % 2]!, scannerId: "synthetic-scanner", engineVersion: "synthetic-engine-0", definitionsVersion: "synthetic-defs-0", evidenceRef: `evidence://synthetic/${i}` },
      })));
      assert.equal(results.filter(r => r.status === "recorded").length, 1);
      assert.ok(results.every(r => r.status === "recorded" || (r.status === "rejected" && r.reason === "attempt_not_open")));
      const seqs = await q("SELECT seq FROM vynvori_composition.asset_scan_events WHERE asset_id=$1 ORDER BY seq", [a.assetId]);
      assert.deepEqual(seqs.rows.map(r => r.seq), [1]);
    });

    /** Runs `take` inside a composition transaction and keeps it open until `release()`; `held` resolves once `take` has its locks. */
    function hold(take: (tx: CompositionTx) => Promise<unknown>) {
      let release!: () => void, held!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; }), acquired = new Promise<void>(resolve => { held = resolve; });
      const done = withCompositionTransaction(pool, async tx => { await take(tx); held(); await gate; return tx; });
      return { acquired, release, done };
    }

    await t.test("C3b store: the per-asset lock serialises store scan events (a held asset lock blocks the store until it is released)", async () => {
      const a = await makeAsset("store-lock-serial");
      const opened = await store.openScanAttempt(a.compositionId, a.assetId, a.access, new Date(), lease());
      if (opened.status !== "opened") return assert.fail(opened.status);
      const holder = hold(tx => lockAsset(tx, a.compositionId, a.assetId));
      try {
        await holder.acquired;
        const pending = store.completeScanAttempt(a.compositionId, a.assetId, a.access, new Date(), { attemptId: opened.attempt.attemptId, result: { toStatus: "unknown", reasonCode: "scanner_error" } });
        assert.equal(await Promise.race([pending.then(() => "done" as const), later(300)]), "pending", "the store must wait for the asset lock");
        const waiting = await q("SELECT count(*) AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())");
        assert.ok(Number(waiting.rows[0].n) >= 1, "the store's session is queued on an advisory lock");
        assert.deepEqual((await q("SELECT count(*)::int AS n FROM vynvori_composition.asset_scan_events WHERE asset_id=$1", [a.assetId])).rows[0].n, 0);
        holder.release(); await holder.done;
        assert.equal((await pending).status, "recorded");
      } finally { holder.release(); await holder.done.catch(() => undefined); }
    });

    await t.test("C3b store: freeze takes the composition advisory lock before the row lock, so an asset insert under that lock cannot deadlock it", async () => {
      // A C4-style writer holds lockComposition and then inserts an asset (FK KEY SHARE on the compositions row) while a freeze waits.
      const id = randomUUID(), capabilityHash = hashOf("freeze-order:cap"), access = { kind: "guest" as const, capabilityHash };
      const profile = SYNTHETIC_PREVIEW_PROFILE, profileSha = createHash("sha256").update(JSON.stringify(profile)).digest("hex");
      await store.ensurePrintProfile(profile, profileSha);
      const scene = EMPTY_SYNTHETIC_SCENE(), sceneSha = hashOf("freeze-order:scene");
      await store.createGuest({ id, capabilityHash, guestExpiresAt: new Date(Date.now() + 3_600_000), scene, sceneSha256: sceneSha, state: "guest_draft" });
      const writer = hold(tx => lockComposition(tx, id));
      try {
        await writer.acquired;
        const freezing = store.freeze(id, access, new Date(), { expectedRevision: 0, state: "frozen_version", sourceAssetSha256: [], sourceFontSha256: [],
          version: { id: randomUUID(), scene, sceneSha256: sceneSha, printProfileId: profile.profileId, printProfileVersion: profile.version, preflightState: "preview_only", preflightIssues: [] } });
        assert.equal(await Promise.race([freezing.then(() => "done" as const), later(300)]), "pending", "freeze queues on the composition advisory lock");
        const hash = hashOf("freeze-order:bytes"), assetInsert = q(`INSERT INTO vynvori_composition.assets(id,composition_id,kind,object_key,sha256,mime,byte_size,width_px,height_px)
          VALUES($1,$2,'customer_original',$3,$4,'image/png',10,1,1)`, [randomUUID(), id, `private/composition/v1/${id}/${hash}`, hash]);
        // The insert runs on another session here; what matters is that freeze holds no row lock yet, so the FK check is not blocked.
        assert.equal(await Promise.race([assetInsert.then(() => "inserted" as const), later(3000)]), "inserted", "the FK check is not blocked by freeze");
        writer.release(); await writer.done;
        assert.equal((await freezing).status, "frozen", "freeze completes after the writer commits, with no deadlock (40P01)");
      } finally { writer.release(); await writer.done.catch(() => undefined); }
    });

    await t.test("C3b store: consumeRateToken admits exactly SYNTHETIC_LIMIT of SYNTHETIC_CONCURRENCY concurrent callers", async () => {
      const SYNTHETIC_LIMIT = 5, SYNTHETIC_CONCURRENCY = 14, SYNTHETIC_WINDOW_SECONDS = 60, at = new Date(Date.UTC(2026, 0, 1));
      const subject = randomUUID();
      const results = await Promise.all(Array.from({ length: SYNTHETIC_CONCURRENCY }, () => store.consumeRateToken({ operation: "GUEST_ASSET_UPLOAD", subject, windowSeconds: SYNTHETIC_WINDOW_SECONDS, max: SYNTHETIC_LIMIT, at })));
      assert.equal(results.filter(r => r.admitted).length, SYNTHETIC_LIMIT);
      assert.deepEqual(results.filter(r => r.admitted).map(r => (r as { count: number }).count).sort((x, y) => x - y), [1, 2, 3, 4, 5]);
    });

    await t.test("C3b lock helpers: refused outside a composition transaction; class-4 high word survives a negative hashtext; xact-scoped; opposite orders never deadlock", async () => {
      const outside = await pool.connect();
      try {
        await assert.rejects(lockComposition(outside as CompositionTx, randomUUID()), /open composition transaction/);
        await assert.rejects(lockAsset(outside as CompositionTx, randomUUID(), randomUUID()), /open composition transaction/);
      } finally { outside.release(); }
      let negative = "";
      for (let i = 0; i < 200 && !negative; i += 1) { const id = randomUUID(); if ((await q("SELECT hashtext($1::uuid::text) < 0 AS neg", [id])).rows[0].neg) negative = id; }
      assert.ok(negative, "found a subject whose hashtext is negative");
      const tx = await withCompositionTransaction(pool, async tx => {
        await lockComposition(tx, negative);
        const mine = await tx.query("SELECT classid::bigint AS hi, objid::bigint AS lo, objsubid FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()");
        assert.equal(mine.rows.length, 1); assert.equal(Number(mine.rows[0].hi), 4, "high word is the class constant 4"); assert.equal(mine.rows[0].objsubid, 1, "single-bigint lock form");
        const expected = await tx.query("SELECT (hashtext($1::uuid::text)::bigint & 4294967295) AS lo", [negative]);
        assert.equal(String(mine.rows[0].lo), String(expected.rows[0].lo), "low word is the masked hashtext");
        return tx;
      });
      await assert.rejects(lockComposition(tx, negative), /open composition transaction/, "the client is no longer inside a transaction after commit");
      const left = await q("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())");
      assert.equal(left.rows[0].n, 0, "transaction-scoped: released at commit");
      const { compositionId, assetId } = await makeAsset("store-lock-order");
      for (let round = 0; round < 5; round += 1) {
        // Caller one asks composition-then-asset explicitly; caller two asks for the asset first. lockAsset takes the composition lock
        // first by construction, so both queue on the composition lock and serialise instead of forming a cycle.
        const first = withCompositionTransaction(pool, async tx => { await lockComposition(tx, compositionId); await later(20); await lockAsset(tx, compositionId, assetId); });
        const second = withCompositionTransaction(pool, async tx => { await lockAsset(tx, compositionId, assetId); await later(20); await lockComposition(tx, compositionId); });
        assert.equal(await Promise.race([Promise.all([first, second]).then(() => "done" as const), later(5000)]), "done", "no deadlock and no hang");
      }
    });

    await t.test("C3b connection budget: the race file never held more than its declared pool cap", async () => {
      assert.ok(pool.options.max !== undefined && pool.options.max <= POOL_CAPS.concurrency);
      assert.ok(peakClients <= POOL_CAPS.concurrency, `peak pool clients ${peakClients} exceeds ${POOL_CAPS.concurrency}`);
      assert.ok(peakClients >= 2, "the sampler observed the races");
    });
  } finally {
    clearInterval(sampler);
    await pool.end().catch(() => {});
    await setup.end().catch(() => {});
  }
});
