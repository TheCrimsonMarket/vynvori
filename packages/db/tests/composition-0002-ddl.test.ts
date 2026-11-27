import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { Client } from "pg";
import { applyCompositionMigrations, compositionMigrationPlan, CompositionMigrationError } from "../src/composition-migrations";
import {
  connectionString, freshCompositionDatabase, databaseFor, compositionPool, poolBudget,
  DECLARED_PEAK_CONNECTIONS, M3_CONNECTION_BUDGET,
} from "./composition-fixture";

// CI sets CI_REQUIRE_PG_TESTS=1 so a missing database fails the run instead of silently skipping.
const requirePg = process.env.CI_REQUIRE_PG_TESTS === "1";
const hashOf = (label: string) => createHash("sha256").update(label).digest("hex");

test("M3 connection budget: declared peaks fit the shared 40-connection ceiling", () => {
  const total = Object.values(DECLARED_PEAK_CONNECTIONS).reduce((sum, n) => sum + n, 0);
  assert.ok(total <= M3_CONNECTION_BUDGET, `declared M3 peak ${total} exceeds the ${M3_CONNECTION_BUDGET}-connection budget`);
  assert.deepEqual(poolBudget(10, "concurrency"), { max: 7, degraded: true });
  assert.deepEqual(poolBudget(250, "concurrency"), { max: 18, degraded: false });
  assert.deepEqual(poolBudget(250, "standard"), { max: 3, degraded: false });
});

test("M3 0002 DDL: lifecycle, immutability, rate buckets, locks and rollback in disposable PostgreSQL", { skip: !connectionString && !requirePg }, async t => {
  assert.ok(connectionString, "CI_REQUIRE_PG_TESTS=1 requires M3_TEST_POSTGRES_URL");
  let client: Client = await freshCompositionDatabase("ddl");
  const q = (text: string, values?: unknown[]) => client.query(text, values);
  const extraClient = () => {
    const url = new URL(connectionString!); url.pathname = "/" + databaseFor("ddl");
    return new Client({ connectionString: url.toString() });
  };
  let windowTick = 0;
  const nextWindow = () => new Date(Date.now() + windowTick++ * 1000);

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
  async function cleanFields(assetId: string, compositionId: string) {
    // Only one open attempt per asset is allowed; close any attempt left open by an earlier call for this asset.
    await q("UPDATE vynvori_composition.asset_scan_attempts SET finished_at = now(), outcome = 'completed' WHERE asset_id = $1 AND finished_at IS NULL", [assetId]);
    const attemptId = await openAttempt(assetId, compositionId);
    return { attemptId, scannerId: "synthetic-scanner", engineVersion: "1.0.0", definitionsVersion: "2026-11-04", evidenceRef: "evidence://synthetic/1" };
  }
  type EventFields = { attemptId?: string | null; scannerId?: string | null; engineVersion?: string | null; definitionsVersion?: string | null; evidenceRef?: string | null; reasonCode?: string | null; sha?: string };
  function scanEvent(assetId: string, compositionId: string, hash: string, seq: number, from: string, to: string, opts: EventFields = {}) {
    return q(
      `INSERT INTO vynvori_composition.asset_scan_events
         (asset_id, composition_id, seq, from_status, to_status, asset_sha256, attempt_id, scanner_id, engine_version, definitions_version, evidence_ref, reason_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [assetId, compositionId, seq, from, to, opts.sha ?? hash, opts.attemptId ?? null, opts.scannerId ?? null, opts.engineVersion ?? null, opts.definitionsVersion ?? null, opts.evidenceRef ?? null, opts.reasonCode ?? null],
    );
  }

  try {
    await t.test("0002 is pinned and replay applies nothing; journal drift on 0002 is rejected", async () => {
      const plan = compositionMigrationPlan();
      assert.equal(plan.migrations.length, 2);
      assert.equal(plan.migrations[1]!.file, "0002_asset_access_and_limits.sql");
      const expected = { database: databaseFor("ddl"), role: "synthetic", planSha256: plan.digest };
      assert.equal((await applyCompositionMigrations(client, expected)).applied, 0);
      await q("UPDATE vynvori_composition_migrations.applied SET sha256='0'||substr(sha256,2) WHERE file=$1", ["0002_asset_access_and_limits.sql"]);
      await assert.rejects(applyCompositionMigrations(client, expected), (e: unknown) => e instanceof CompositionMigrationError && e.code === "HISTORY_OR_SCHEMA_DRIFT");
      await q("UPDATE vynvori_composition_migrations.applied SET sha256=$1 WHERE file=$2", [plan.migrations[1]!.sha256, "0002_asset_access_and_limits.sql"]);
    });

    await t.test("0002 SQL is additive-only", () => {
      const sql = readFileSync(new URL("../composition-migrations/0002_asset_access_and_limits.sql", import.meta.url), "utf8");
      const stripped = sql.replace(/--.*$/gm, "");
      assert.doesNotMatch(
        stripped,
        /\b(GRANT|REVOKE|DROP\s+(TABLE|SCHEMA|FUNCTION|INDEX)|TRUNCATE\s+vynvori|ALTER\s+TABLE\s+vynvori_composition\.(compositions|assets|composition_versions|print_profiles))\b/i,
        "additive only: no grants, drops, truncates or alterations of an existing table",
      );
      const createIndexOnCompositions = stripped.match(/CREATE\s+INDEX[^;]*ON\s+vynvori_composition\.compositions\b/gi) ?? [];
      assert.equal(createIndexOnCompositions.length, 1, "exactly one new index is the only change to the existing compositions table");
    });

    await t.test("scan lifecycle: implicit pending and every legal edge is accepted", async () => {
      {
        const { compositionId, assetId, hash } = await makeAsset("legal-pending-clean");
        await scanEvent(assetId, compositionId, hash, 1, "pending", "clean", await cleanFields(assetId, compositionId));
      }
      {
        const { compositionId, assetId, hash } = await makeAsset("legal-pending-quarantined");
        await scanEvent(assetId, compositionId, hash, 1, "pending", "quarantined", await cleanFields(assetId, compositionId));
      }
      {
        const { compositionId, assetId, hash } = await makeAsset("legal-pending-unknown");
        await scanEvent(assetId, compositionId, hash, 1, "pending", "unknown", { reasonCode: "scanner_timeout" });
      }
      {
        const { compositionId, assetId, hash } = await makeAsset("legal-unknown-pending");
        await scanEvent(assetId, compositionId, hash, 1, "pending", "unknown", { reasonCode: "scanner_timeout" });
        await scanEvent(assetId, compositionId, hash, 2, "unknown", "pending", { reasonCode: "rescan_requested" });
      }
      {
        const { compositionId, assetId, hash } = await makeAsset("legal-clean-quarantined");
        await scanEvent(assetId, compositionId, hash, 1, "pending", "clean", await cleanFields(assetId, compositionId));
        await scanEvent(assetId, compositionId, hash, 2, "clean", "quarantined", await cleanFields(assetId, compositionId));
      }
    });

    await t.test("scan lifecycle: every illegal edge is rejected", async () => {
      {
        const { compositionId, assetId, hash } = await makeAsset("illegal-pending-pending");
        await assert.rejects(scanEvent(assetId, compositionId, hash, 1, "pending", "pending", { reasonCode: "x" }), /not allowed/);
      }
      {
        const { compositionId, assetId, hash } = await makeAsset("illegal-clean-pending");
        await scanEvent(assetId, compositionId, hash, 1, "pending", "clean", await cleanFields(assetId, compositionId));
        await assert.rejects(scanEvent(assetId, compositionId, hash, 2, "clean", "pending", { reasonCode: "x" }), /not allowed/);
      }
      {
        const { compositionId, assetId, hash } = await makeAsset("illegal-quarantined-terminal");
        await scanEvent(assetId, compositionId, hash, 1, "pending", "quarantined", await cleanFields(assetId, compositionId));
        for (const to of ["pending", "clean", "unknown"] as const) {
          await assert.rejects(scanEvent(assetId, compositionId, hash, 2, "quarantined", to, { reasonCode: "x", ...(await cleanFields(assetId, compositionId)) }), /not allowed/);
        }
      }
      {
        const { compositionId, assetId, hash } = await makeAsset("illegal-from-mismatch");
        await scanEvent(assetId, compositionId, hash, 1, "pending", "clean", await cleanFields(assetId, compositionId));
        await assert.rejects(scanEvent(assetId, compositionId, hash, 2, "pending", "unknown", { reasonCode: "x" }), /does not match the current status/);
      }
    });

    await t.test("scan lifecycle: asset_sha256 mismatch is rejected", async () => {
      const { compositionId, assetId } = await makeAsset("hash-mismatch");
      await assert.rejects(scanEvent(assetId, compositionId, "f".repeat(64), 1, "pending", "clean", await cleanFields(assetId, compositionId)), /does not match the asset row/);
    });

    await t.test("scan lifecycle: seq must be gap-free; duplicates rejected", async () => {
      const { compositionId, assetId, hash } = await makeAsset("seq-gap");
      await assert.rejects(scanEvent(assetId, compositionId, hash, 2, "pending", "clean", await cleanFields(assetId, compositionId)), /gap-free/);
      await scanEvent(assetId, compositionId, hash, 1, "pending", "clean", await cleanFields(assetId, compositionId));
      await assert.rejects(scanEvent(assetId, compositionId, hash, 1, "clean", "quarantined", await cleanFields(assetId, compositionId)), /gap-free/);
    });

    await t.test("scan lifecycle: clean/quarantined require scanner, engine, definitions, evidence and attempt; unknown/pending(rescan) require reason_code", async () => {
      const { compositionId, assetId, hash } = await makeAsset("required-fields");
      await assert.rejects(scanEvent(assetId, compositionId, hash, 1, "pending", "clean", {}), /check/i);
      const attemptId = await openAttempt(assetId, compositionId);
      await assert.rejects(scanEvent(assetId, compositionId, hash, 1, "pending", "clean", { attemptId, scannerId: "s" }), /check/i);
      await assert.rejects(scanEvent(assetId, compositionId, hash, 1, "pending", "unknown", {}), /check/i);

      const { compositionId: c2, assetId: a2, hash: h2 } = await makeAsset("required-fields-pending-rescan");
      await scanEvent(a2, c2, h2, 1, "pending", "unknown", { reasonCode: "x" });
      await assert.rejects(scanEvent(a2, c2, h2, 2, "unknown", "pending", {}), /check/i);
    });

    await t.test("scan events are immutable: UPDATE, DELETE and TRUNCATE are all rejected", async () => {
      const { compositionId, assetId, hash } = await makeAsset("immutable-events");
      await scanEvent(assetId, compositionId, hash, 1, "pending", "unknown", { reasonCode: "x" });
      await assert.rejects(q("UPDATE vynvori_composition.asset_scan_events SET reason_code='y' WHERE asset_id=$1", [assetId]), /immutable/);
      await assert.rejects(q("DELETE FROM vynvori_composition.asset_scan_events WHERE asset_id=$1", [assetId]), /immutable/);
      await assert.rejects(q("TRUNCATE vynvori_composition.asset_scan_events"), /immutable|cannot truncate/);
    });

    await t.test("scan attempts: one open attempt per asset; update is a one-way close only", async () => {
      const { compositionId, assetId } = await makeAsset("attempts");
      const attemptId = await openAttempt(assetId, compositionId);
      await assert.rejects(openAttempt(assetId, compositionId), /duplicate key|unique/i);
      await q("UPDATE vynvori_composition.asset_scan_attempts SET finished_at = now(), outcome = 'completed' WHERE attempt_id = $1", [attemptId]);
      await assert.rejects(q("UPDATE vynvori_composition.asset_scan_attempts SET finished_at = now(), outcome = 'completed' WHERE attempt_id = $1", [attemptId]), /one-way|already closed/);
      const attemptId2 = await openAttempt(assetId, compositionId);
      await assert.rejects(q("UPDATE vynvori_composition.asset_scan_attempts SET started_at = now() WHERE attempt_id = $1", [attemptId2]), /only finished_at\/outcome may change/);
      await assert.rejects(q("DELETE FROM vynvori_composition.asset_scan_attempts WHERE attempt_id = $1", [attemptId2]), /immutable/);
      await assert.rejects(q("TRUNCATE vynvori_composition.asset_scan_attempts"), /immutable|cannot truncate/);
    });

    await t.test("download grants: token uniqueness, expiry CHECK, and only redeemed_at NULL->non-null may change", async () => {
      const { compositionId, assetId } = await makeAsset("grants");
      const grantId = randomUUID(), token = hashOf("grants:token");
      await assert.rejects(
        q(
          "INSERT INTO vynvori_composition.asset_download_grants(grant_id, token_hash, asset_id, composition_id, principal_kind, principal_hash, issued_at, expires_at) VALUES ($1,$2,$3,$4,'guest',$5, now(), now())",
          [grantId, token, assetId, compositionId, hashOf("grants:principal")],
        ),
        /check/i,
      );
      await q(
        "INSERT INTO vynvori_composition.asset_download_grants(grant_id, token_hash, asset_id, composition_id, principal_kind, principal_hash, expires_at) VALUES ($1,$2,$3,$4,'guest',$5, now() + interval '1 hour')",
        [grantId, token, assetId, compositionId, hashOf("grants:principal")],
      );
      await assert.rejects(
        q(
          "INSERT INTO vynvori_composition.asset_download_grants(grant_id, token_hash, asset_id, composition_id, principal_kind, principal_hash, expires_at) VALUES ($1,$2,$3,$4,'guest',$5, now() + interval '1 hour')",
          [randomUUID(), token, assetId, compositionId, hashOf("grants:principal")],
        ),
        /duplicate key|unique/i,
      );
      await q("UPDATE vynvori_composition.asset_download_grants SET redeemed_at = now() WHERE grant_id = $1", [grantId]);
      await assert.rejects(q("UPDATE vynvori_composition.asset_download_grants SET redeemed_at = now() WHERE grant_id = $1", [grantId]), /one-way|already redeemed/);
      await assert.rejects(q("UPDATE vynvori_composition.asset_download_grants SET principal_kind = 'owner' WHERE grant_id = $1", [grantId]), /only redeemed_at may change/);
      await assert.rejects(q("DELETE FROM vynvori_composition.asset_download_grants WHERE grant_id = $1", [grantId]), /immutable/);
      await assert.rejects(q("TRUNCATE vynvori_composition.asset_download_grants"), /immutable|cannot truncate/);
    });

    await t.test("rate-limit buckets: bucket_key pattern accepts the ten operations with the right subjects, rejects others; count < 1 rejected", async () => {
      const subjectUuid = randomUUID();
      const ok = [
        "GUEST_CREATE_GLOBAL:global", "ASSET_UPLOAD_GLOBAL:global",
        `GUEST_WRITE:${subjectUuid}`, `GUEST_ASSET_UPLOAD:${subjectUuid}`, `GUEST_DOWNLOAD_GRANT:${subjectUuid}`, `GUEST_RESCAN:${subjectUuid}`,
        `OWNER_WRITE:${subjectUuid}`, `OWNER_ASSET_UPLOAD:${subjectUuid}`, `OWNER_DOWNLOAD_GRANT:${subjectUuid}`, `OWNER_RESCAN:${subjectUuid}`,
      ];
      assert.equal(ok.length, 10);
      for (const key of ok) await q("INSERT INTO vynvori_composition.rate_limit_buckets(bucket_key, window_start, count) VALUES ($1, $2, 1)", [key, nextWindow()]);
      const bad = ["GUEST_CREATE_GLOBAL:" + subjectUuid, "GUEST_WRITE:global", "UNKNOWN_OP:global", `guest_write:${subjectUuid}`];
      for (const key of bad) await assert.rejects(q("INSERT INTO vynvori_composition.rate_limit_buckets(bucket_key, window_start, count) VALUES ($1, $2, 1)", [key, nextWindow()]), /check/i);
      await assert.rejects(q("INSERT INTO vynvori_composition.rate_limit_buckets(bucket_key, window_start, count) VALUES ($1, $2, 0)", ["GUEST_CREATE_GLOBAL:global", nextWindow()]), /check/i);
    });

    await t.test("lock helpers: m3_lock_key_from_hash keeps the class-4 high word for negative and extreme inputs", async () => {
      for (const h of [-1, -2147483648, 2147483647, 0, 1, -42]) {
        const { rows } = await q("SELECT vynvori_composition.m3_lock_key_from_hash($1) AS k", [h]);
        const key = BigInt(rows[0].k as string);
        assert.equal(key >> 32n, 4n, `h=${h} should keep the class-4 high word, got key=${key}`);
      }
    });

    await t.test("lock helpers: m3_lock_asset takes the composition lock before the asset lock", async () => {
      const { compositionId, assetId } = await makeAsset("lock-order");
      const blocker = extraClient(), waiter = extraClient(), probe = extraClient();
      await blocker.connect(); await waiter.connect(); await probe.connect();
      try {
        await blocker.query("BEGIN");
        await blocker.query("SELECT pg_advisory_xact_lock(vynvori_composition.m3_lock_key_from_hash(hashtext($1::text)))", [assetId]);

        await waiter.query("BEGIN");
        const waiterPid = (await waiter.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        const blocked = waiter.query("SELECT vynvori_composition.m3_lock_asset($1,$2)", [compositionId, assetId]);

        await new Promise(resolve => setTimeout(resolve, 300));
        const locks = await probe.query("SELECT granted FROM pg_locks WHERE pid = $1 AND locktype = 'advisory' ORDER BY granted DESC", [waiterPid]);
        assert.equal(locks.rows.length, 2, "the waiter should hold exactly two advisory locks while blocked: composition (granted) and asset (waiting)");
        assert.equal(locks.rows[0].granted, true, "the composition lock must already be granted");
        assert.equal(locks.rows[1].granted, false, "the asset lock is still waiting on the blocker");

        await blocker.query("ROLLBACK");
        await blocked;
        await waiter.query("ROLLBACK");
      } finally {
        await blocker.end().catch(() => {}); await waiter.end().catch(() => {}); await probe.end().catch(() => {});
      }
    });

    await t.test("fixture pool sizing matches SHOW max_connections and the declared caps", async () => {
      const { pool, max, degraded, serverMax } = await compositionPool("ddl", "standard");
      try { assert.equal(degraded, false); assert.equal(max, 3); assert.ok(serverMax >= 50); } finally { await pool.end(); }
    });

    // The rollback drill needs a pristine database: every table above is append-only or delete-rejecting, so the
    // rows created by the tests already run can never be removed, and a clean-rollback assertion would otherwise
    // always find data present.
    await client.end().catch(() => {});
    client = await freshCompositionDatabase("ddl");

    await t.test("rollback: 0002 up -> down -> up works; 0002 down refuses with data in each guarded table", async () => {
      const down0002 = readFileSync(new URL("../composition-migrations/rollback/0002_asset_access_and_limits.down.sql", import.meta.url), "utf8");
      const plan = compositionMigrationPlan();
      const expected = { database: databaseFor("ddl"), role: "synthetic", planSha256: plan.digest };

      assert.equal((await q("SELECT to_regclass('vynvori_composition.asset_scan_events') AS r")).rows[0].r, "vynvori_composition.asset_scan_events");
      await q(down0002);
      assert.equal((await q("SELECT to_regclass('vynvori_composition.asset_scan_events') AS r")).rows[0].r, null);
      assert.equal((await q("SELECT 1 FROM vynvori_composition_migrations.applied WHERE file=$1", ["0002_asset_access_and_limits.sql"])).rows.length, 0);
      assert.equal((await applyCompositionMigrations(client, expected)).applied, 1);
      assert.equal((await q("SELECT to_regclass('vynvori_composition.asset_scan_events') AS r")).rows[0].r, "vynvori_composition.asset_scan_events");

      for (const seed of ["events", "attempts", "grants"] as const) {
        await client.end().catch(() => {});
        client = await freshCompositionDatabase("ddl");
        const { compositionId, assetId, hash } = await makeAsset("rollback-guard-" + seed);
        if (seed === "events") await scanEvent(assetId, compositionId, hash, 1, "pending", "unknown", { reasonCode: "x" });
        else if (seed === "attempts") await openAttempt(assetId, compositionId);
        else {
          await q(
            "INSERT INTO vynvori_composition.asset_download_grants(grant_id, token_hash, asset_id, composition_id, principal_kind, principal_hash, expires_at) VALUES ($1,$2,$3,$4,'guest',$5, now() + interval '1 hour')",
            [randomUUID(), hashOf(seed + ":token"), assetId, compositionId, hashOf(seed + ":principal")],
          );
        }
        await assert.rejects(q(down0002), /refusing rollback/);
      }
    });

    await t.test("rollback: 0001 down refuses while 0002 is applied; the full chain up -> 0002 down -> 0001 down -> up proves the F8 repair", async () => {
      await client.end().catch(() => {});
      client = await freshCompositionDatabase("ddl");
      const down0001 = readFileSync(new URL("../composition-migrations/rollback/0001_composition_scene.down.sql", import.meta.url), "utf8");
      const down0002 = readFileSync(new URL("../composition-migrations/rollback/0002_asset_access_and_limits.down.sql", import.meta.url), "utf8");
      const plan = compositionMigrationPlan();
      const expected = { database: databaseFor("ddl"), role: "synthetic", planSha256: plan.digest };

      await assert.rejects(q(down0001), /a later migration is still applied/);

      await q(down0002);
      await q(down0001);
      assert.equal((await q("SELECT to_regnamespace('vynvori_composition') AS ns")).rows[0].ns, null);
      assert.equal((await q("SELECT to_regnamespace('vynvori_composition_migrations') AS ns")).rows[0].ns, null);
      assert.equal((await applyCompositionMigrations(client, expected)).applied, 2);
      assert.equal((await q("SELECT to_regclass('vynvori_composition.asset_scan_events') AS r")).rows[0].r, "vynvori_composition.asset_scan_events");
    });

    await t.test("F8 regression: the OLD (unrepaired) 0001 down script breaks re-apply; the repaired script does not", async () => {
      await client.end().catch(() => {});
      client = await freshCompositionDatabase("ddl");
      const down0002 = readFileSync(new URL("../composition-migrations/rollback/0002_asset_access_and_limits.down.sql", import.meta.url), "utf8");
      const plan = compositionMigrationPlan();
      const expected = { database: databaseFor("ddl"), role: "synthetic", planSha256: plan.digest };
      await q(down0002); // leaves only 0001 applied

      const oldBuggyDown = `
        DO $guard$
        BEGIN
          IF to_regclass('vynvori_composition.compositions') IS NULL THEN RAISE EXCEPTION 'schema not present'; END IF;
          IF EXISTS (SELECT 1 FROM vynvori_composition.compositions) OR EXISTS (SELECT 1 FROM vynvori_composition.assets)
             OR EXISTS (SELECT 1 FROM vynvori_composition.composition_versions) THEN
            RAISE EXCEPTION 'refusing rollback: customer composition data exists; export it and delete rows deliberately first';
          END IF;
        END
        $guard$;
        DROP SCHEMA vynvori_composition CASCADE;
        DELETE FROM vynvori_composition_migrations.applied WHERE file = '0001_composition_scene.sql';
      `;
      await q(oldBuggyDown);
      // Reproduces F8: the journal schema survives (now empty) while the data schema is gone, so the runner's
      // hasJournal !== hasSchema check reads this as drift and blocks every future apply.
      await assert.rejects(applyCompositionMigrations(client, expected), (e: unknown) => e instanceof CompositionMigrationError && e.code === "HISTORY_OR_SCHEMA_DRIFT");

      await client.end().catch(() => {});
      client = await freshCompositionDatabase("ddl");
      const down0001 = readFileSync(new URL("../composition-migrations/rollback/0001_composition_scene.down.sql", import.meta.url), "utf8");
      await q(down0002);
      await q(down0001); // the repaired script also drops the now-empty journal schema
      assert.equal((await applyCompositionMigrations(client, expected)).applied, 2);
    });
  } finally {
    await client.end().catch(() => {});
  }
});
