import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { applyCompositionMigrations, compositionMigrationPlan, CompositionMigrationError } from "../src/composition-migrations";
import { connectionString, freshComposition } from "./composition-fixture";
// CI sets CI_REQUIRE_PG_TESTS=1 so a missing database fails the run instead of silently skipping.
const requirePg = process.env.CI_REQUIRE_PG_TESTS === "1";

test("composition migration plan pins exact reviewed SQL and refuses any non-local target", async () => {
  const plan = compositionMigrationPlan(); assert.equal(plan.migrations.length, 2); assert.match(plan.digest, /^[a-f0-9]{64}$/);
  const client = new Client({ host: "db.example.neon.tech", ssl: true });
  for (const expected of [{ database: "vynvori_creative_staging", role: "vynvori_staging_app" }, { database: "vynvori_m3_migration_test", role: "synthetic" }, { database: "production", role: "synthetic" }]) {
    await assert.rejects(applyCompositionMigrations(client, { ...expected, planSha256: plan.digest }), (e: unknown) => e instanceof CompositionMigrationError && e.code === "TARGET_REJECTED");
  }
  const sql = readFileSync(new URL("../composition-migrations/0001_composition_scene.sql", import.meta.url), "utf8");
  assert.doesNotMatch(sql.replace(/--.*$/gm, ""), /\b(GRANT|REVOKE|DROP\s+(TABLE|SCHEMA)|ALTER\s+TABLE\s+vynvori_identity|TRUNCATE\s+vynvori)/i, "additive only: no grants, drops or identity alterations");
});

test("composition DDL: replay, drift, immutability, ownership and no-print guarantees in disposable PostgreSQL", { skip: !connectionString && !requirePg }, async t => {
  assert.ok(connectionString, "CI_REQUIRE_PG_TESTS=1 requires M3_TEST_POSTGRES_URL");
  const client = await freshComposition();
  const q = (text: string, values?: unknown[]) => client.query(text, values);
  const plan = compositionMigrationPlan(), expected = { database: "vynvori_m3_migration_test", role: "synthetic", planSha256: plan.digest };
  try {
    await t.test("replay applies nothing; journal drift is rejected", async () => {
      assert.equal((await applyCompositionMigrations(client, expected)).applied, 0);
      await q("UPDATE vynvori_composition_migrations.applied SET sha256='0'||substr(sha256,2)");
      await assert.rejects(applyCompositionMigrations(client, expected), (e: unknown) => e instanceof CompositionMigrationError && e.code === "HISTORY_OR_SCHEMA_DRIFT");
      await q("UPDATE vynvori_composition_migrations.applied SET sha256=$1", [plan.migrations[0]!.sha256]);
    });
    const profile = async () => { await q("INSERT INTO vynvori_composition.print_profiles(profile_id,version,status,definition,definition_sha256) VALUES('p','1','synthetic_unapproved','{}',$1) ON CONFLICT DO NOTHING", ["a".repeat(64)]); };
    await t.test("print profiles can never be supplier-approved or print-eligible, and cannot be edited", async () => {
      await profile();
      await assert.rejects(q("INSERT INTO vynvori_composition.print_profiles(profile_id,version,status,definition,definition_sha256) VALUES('q','1','approved','{}',$1)", ["a".repeat(64)]), /check/i);
      await assert.rejects(q("INSERT INTO vynvori_composition.print_profiles(profile_id,version,status,supplier_approved,definition,definition_sha256) VALUES('q','1','synthetic_unapproved',true,'{}',$1)", ["a".repeat(64)]), /check/i);
      await assert.rejects(q("INSERT INTO vynvori_composition.print_profiles(profile_id,version,status,print_release_eligible,definition,definition_sha256) VALUES('q','1','synthetic_unapproved',true,'{}',$1)", ["a".repeat(64)]), /check/i);
      await assert.rejects(q("UPDATE vynvori_composition.print_profiles SET status='draft_unapproved'"), /immutable/);
    });
    const id = "11111111-1111-4111-8111-111111111111";
    await t.test("ownerless compositions without a guest capability are impossible; saved_owned needs an owner", async () => {
      await assert.rejects(q("INSERT INTO vynvori_composition.compositions(id,product_family,print_profile_id,print_profile_version,lifecycle_state,draft_scene,draft_scene_sha256) VALUES($1,'f','p','1','editable_scene','{}',$2)", [id, "b".repeat(64)]), /check/i);
      await q("INSERT INTO vynvori_identity.guest_drafts(id,capability_hash,expires_at) VALUES($1,$2,now()+interval '1 day')", [id, "c".repeat(64)]);
      await assert.rejects(q("INSERT INTO vynvori_composition.compositions(id,guest_draft_id,product_family,print_profile_id,print_profile_version,lifecycle_state,draft_scene,draft_scene_sha256) VALUES($1,$1,'f','p','1','saved_owned','{}',$2)", [id, "b".repeat(64)]), /check/i);
      await assert.rejects(q("INSERT INTO vynvori_composition.compositions(id,guest_draft_id,product_family,print_profile_id,print_profile_version,lifecycle_state,draft_scene,draft_scene_sha256) VALUES($1,$1,'f','p','1','composition_quoted','{}',$2)", [id, "b".repeat(64)]), /check/i); // M4 states unreachable
      await q("INSERT INTO vynvori_composition.compositions(id,guest_draft_id,product_family,print_profile_id,print_profile_version,lifecycle_state,draft_scene,draft_scene_sha256) VALUES($1,$1,'f','p','1','guest_draft','{}',$2)", [id, "b".repeat(64)]);
    });
    const hash = "d".repeat(64), asset = "22222222-2222-4222-8222-222222222222", version = "33333333-3333-4333-8333-333333333333";
    await t.test("versions may only pin assets of the same composition; assets and versions are immutable", async () => {
      const insertVersion = (n: number, sha: string[]) => q("INSERT INTO vynvori_composition.composition_versions(id,composition_id,version_no,scene,scene_sha256,source_asset_sha256,source_font_sha256,print_profile_id,print_profile_version,preflight_state,preflight_issues) VALUES($1,$2,$3,'{}',$4,$5,'{}','p','1','preview_only','[]')", [n === 1 ? version : "44444444-4444-4444-8444-444444444444", id, n, n === 1 ? "e".repeat(64) : "f".repeat(64), sha]);
      await assert.rejects(insertVersion(1, [hash]), /unknown asset hash/);
      await assert.rejects(q("INSERT INTO vynvori_composition.assets(id,composition_id,kind,object_key,sha256,mime,byte_size,width_px,height_px) VALUES($1,$2,'customer_original',$3,$4,'image/svg+xml',10,1,1)", [asset, id, `private/composition/v1/${id}/${hash}`, hash]), /check/i);
      await assert.rejects(q("INSERT INTO vynvori_composition.assets(id,composition_id,kind,object_key,sha256,mime,byte_size,width_px,height_px) VALUES($1,$2,'customer_original','public/x.png',$3,'image/png',10,1,1)", [asset, id, hash]), /check/i);
      await q("INSERT INTO vynvori_composition.assets(id,composition_id,kind,object_key,sha256,mime,byte_size,width_px,height_px) VALUES($1,$2,'customer_original',$3,$4,'image/png',10,1,1)", [asset, id, `private/composition/v1/${id}/${hash}`, hash]);
      await insertVersion(1, [hash]);
      await assert.rejects(q("UPDATE vynvori_composition.composition_versions SET scene='{\"x\":1}'"), /immutable/);
      await assert.rejects(q("DELETE FROM vynvori_composition.composition_versions"), /immutable/);
      await assert.rejects(q("TRUNCATE vynvori_composition.composition_versions"), /immutable|cannot truncate/);
      await assert.rejects(q("UPDATE vynvori_composition.assets SET sha256=$1", ["9".repeat(64)]), /immutable/);
      await assert.rejects(q("DELETE FROM vynvori_composition.assets"), /immutable/);
      await assert.rejects(q("DELETE FROM vynvori_composition.compositions"), /foreign key|violates/i); // ON DELETE RESTRICT
      await assert.rejects(q("DELETE FROM vynvori_identity.guest_drafts"), /foreign key|violates/i);
    });
    await t.test("current_version must belong to the same composition", async () => {
      const second = "55555555-5555-4555-8555-555555555555";
      await q("INSERT INTO vynvori_identity.guest_drafts(id,capability_hash,expires_at) VALUES($1,$2,now()+interval '1 day')", [second, "1".repeat(64)]);
      await q("INSERT INTO vynvori_composition.compositions(id,guest_draft_id,product_family,print_profile_id,print_profile_version,lifecycle_state,draft_scene,draft_scene_sha256) VALUES($1,$1,'f','p','1','guest_draft','{}',$2)", [second, "b".repeat(64)]);
      await assert.rejects(q("UPDATE vynvori_composition.compositions SET current_version_id=$2, lifecycle_state='editable_scene' WHERE id=$1", [second, version]), /foreign key|violates/i);
    });
    await t.test("rollback script refuses while customer data exists and drops cleanly when empty", async () => {
      const down = readFileSync(new URL("../composition-migrations/rollback/0001_composition_scene.down.sql", import.meta.url), "utf8");
      await assert.rejects(q(down), /refusing rollback/);
      await client.end();
      const second = await freshComposition();
      try {
        // freshComposition() applies the full plan, so 0002 must be rolled back first (F8 repair, ADR-0022 C3a).
        const down0002 = readFileSync(new URL("../composition-migrations/rollback/0002_asset_access_and_limits.down.sql", import.meta.url), "utf8");
        await second.query(down0002);
        await second.query(down);
        assert.equal((await second.query("SELECT to_regnamespace('vynvori_composition') AS ns")).rows[0].ns, null);
      }
      finally { await second.end(); }
    });
    await t.test("a missing identity prerequisite aborts before any DDL", async () => {
      const lone = await freshComposition();
      try {
        await lone.query("DROP SCHEMA vynvori_composition CASCADE; DROP SCHEMA vynvori_composition_migrations CASCADE; ALTER SCHEMA vynvori_identity RENAME TO vynvori_identity_renamed");
        await assert.rejects(applyCompositionMigrations(lone, expected), (e: unknown) => e instanceof CompositionMigrationError && e.code === "PREREQUISITE_MISSING");
        assert.equal((await lone.query("SELECT to_regnamespace('vynvori_composition') AS ns")).rows[0].ns, null);
      } finally { await lone.query("DROP SCHEMA IF EXISTS vynvori_identity_renamed CASCADE").catch(() => {}); await lone.end(); }
    });
  } finally { await client.end().catch(() => {}); }
});
