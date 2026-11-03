import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { applyLedgerMigrations, ledgerMigrationPlan, LedgerMigrationError } from "../src/ledger-migrations";
import { assertDisposableTarget, assertServerIsLoopbackSynthetic, databaseFor, dropLedger, freshLedger, ledgerPool, ledgerTarget, resolveLedgerTestUrl, POOL_CAPS, poolBudget } from "./ledger-fixture";

const planDir = new URL("../ledger-migrations", import.meta.url).pathname;
const code = (c: string) => (e: unknown) => e instanceof LedgerMigrationError && e.code === c;

test("ledger plan loads, pins the reviewed SQL and has exactly the schema-only migration", () => {
  const plan = ledgerMigrationPlan();
  assert.equal(plan.migrations.length, 1); assert.equal(plan.migrations[0]!.file, "0001_ledger_schema.sql");
  assert.match(plan.digest, /^[a-f0-9]{64}$/); assert.deepEqual(plan.plan.requires, ["vynvori_identity"]);
});

// Golden digests: ANY change to plan.json or the pinned SQL forces a visible edit here (the planSha256 argument alone is circular).
const GOLDEN_PLAN_JSON_SHA256 = "8342b026886194e48e9819dc5a7afc4c07b914630f703eba9a450ca780ce17d9";
const GOLDEN_0001_SQL_SHA256 = "a8273f3fac59de2d0c2f1a661a852d22b9a360c9d9c83e672bd7f0d25d74ef4e";
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
test("golden digests pin plan.json and 0001_ledger_schema.sql independently of the loader", () => {
  assert.equal(sha(join(planDir, "plan.json")), GOLDEN_PLAN_JSON_SHA256);
  assert.equal(sha(join(planDir, "0001_ledger_schema.sql")), GOLDEN_0001_SQL_SHA256);
  assert.equal(ledgerMigrationPlan().digest, GOLDEN_PLAN_JSON_SHA256);
  assert.equal(ledgerMigrationPlan().migrations[0]!.sha256, GOLDEN_0001_SQL_SHA256);
});

test("plan validation: requires must be exactly the identity schema; files unique and strictly increasing", () => {
  const variant = (mutate: (plan: Record<string, unknown>) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-plan-")); cpSync(planDir, dir, { recursive: true });
    const plan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8")); mutate(plan); writeFileSync(join(dir, "plan.json"), JSON.stringify(plan));
    cpSync(join(dir, "0001_ledger_schema.sql"), join(dir, "0002_second_step.sql"));
    return dir;
  };
  const entry = (file: string) => ({ file, sha256: GOLDEN_0001_SQL_SHA256 });
  assert.ok(ledgerMigrationPlan(variant(() => undefined)), "baseline copy loads");
  for (const requires of [[], ["vynvori_identity", "extra"], ["other"], "vynvori_identity"]) assert.throws(() => ledgerMigrationPlan(variant(p => { p["requires"] = requires; })), code("PLAN_INVALID"), JSON.stringify(requires));
  assert.throws(() => ledgerMigrationPlan(variant(p => { p["migrations"] = [entry("0001_ledger_schema.sql"), entry("0001_ledger_schema.sql")]; })), code("PLAN_INVALID"), "duplicate");
  assert.throws(() => ledgerMigrationPlan(variant(p => { p["migrations"] = [entry("0002_second_step.sql"), entry("0001_ledger_schema.sql")]; })), code("PLAN_INVALID"), "decreasing");
  assert.ok(ledgerMigrationPlan(variant(p => { p["migrations"] = [entry("0001_ledger_schema.sql"), entry("0002_second_step.sql")]; })).migrations.length === 2, "increasing is accepted");
});

test("tampered SQL, plan or file name is PLAN_INVALID", () => {
  const dir = mkdtempSync(join(tmpdir(), "ledger-plan-")); cpSync(planDir, dir, { recursive: true });
  writeFileSync(join(dir, "0001_ledger_schema.sql"), readFileSync(join(dir, "0001_ledger_schema.sql"), "utf8") + "\nCREATE TABLE vynvori_ledger.x();");
  assert.throws(() => ledgerMigrationPlan(dir), code("PLAN_INVALID"));
  const other = mkdtempSync(join(tmpdir(), "ledger-plan-")); cpSync(planDir, other, { recursive: true });
  const raw = JSON.parse(readFileSync(join(other, "plan.json"), "utf8")); raw.purpose = "other";
  writeFileSync(join(other, "plan.json"), JSON.stringify(raw)); assert.throws(() => ledgerMigrationPlan(other), code("PLAN_INVALID"));
  raw.purpose = "vynvori-credit-ledger"; raw.migrations[0].file = "../0001_ledger_schema.sql";
  writeFileSync(join(other, "plan.json"), JSON.stringify(raw)); assert.throws(() => ledgerMigrationPlan(other), code("PLAN_INVALID"));
  assert.throws(() => ledgerMigrationPlan(mkdtempSync(join(tmpdir(), "ledger-empty-"))), code("PLAN_INVALID"));
});

test("every non-allow-listed, non-loopback or non-synthetic target is TARGET_REJECTED before any statement", async () => {
  const digest = ledgerMigrationPlan().digest;
  const remote = new Client({ host: "db.example.neon.tech", ssl: true });
  const local = new Client({ host: "127.0.0.1" });
  const base = { role: "synthetic", planSha256: digest };
  for (const database of ["vynvori_creative_staging", "production", "vynvori_m3_migration_test", "vynvori_m7__test", "vynvori_m7_x_test; DROP", "vynvori_m7_UPPER_test", "vynvori_m7_x", "vynvori_m7_1abc_test", "vynvori_m7__abc_test", "vynvori_m7_ab_test", "vynvori_m7_" + "a".repeat(26) + "_test"]) {
    await assert.rejects(applyLedgerMigrations(remote, { ...base, database }), code("TARGET_REJECTED"));
    await assert.rejects(applyLedgerMigrations(local, { ...base, database }), code("TARGET_REJECTED"));
  }
  const good = databaseFor("migrations");
  await assert.rejects(applyLedgerMigrations(remote, { ...base, database: good }), code("TARGET_REJECTED"), "non-loopback host");
  await assert.rejects(applyLedgerMigrations(local, { database: good, role: "vynvori_staging_app", planSha256: digest }), code("TARGET_REJECTED"), "non-synthetic role");
  await assert.rejects(applyLedgerMigrations(local, { database: good, role: "synthetic", planSha256: "0".repeat(64) }), code("TARGET_REJECTED"), "wrong plan digest");
  await assert.rejects(applyLedgerMigrations({} as Client, { database: good, ...base }), code("TARGET_REJECTED"), "not a pg Client");
});

test("SQL is additive: schema only, no grants, drops, table DDL or identity alterations", () => {
  const sql = readFileSync(join(planDir, "0001_ledger_schema.sql"), "utf8").replace(/--.*$/gm, "");
  assert.doesNotMatch(sql, /\b(GRANT|REVOKE|DROP|TRUNCATE|ALTER|CREATE\s+(TABLE|FUNCTION|TRIGGER|ROLE|EXTENSION)|vynvori_identity)\b/i);
  assert.match(sql, /CREATE\s+SCHEMA\s+vynvori_ledger\s*;/i);
});

test("fixture decision covers URL present, absent, and absent with CI_REQUIRE_PG_TESTS=1", () => {
  assert.deepEqual(resolveLedgerTestUrl({ M7_TEST_POSTGRES_URL: "postgres://a" }), { url: "postgres://a", required: false, skip: false });
  assert.deepEqual(resolveLedgerTestUrl({ M2_CREATIVE_DATABASE_URL: "postgres://b" }).url, "postgres://b");
  assert.equal(resolveLedgerTestUrl({ M7_TEST_POSTGRES_URL: "postgres://a", M2_CREATIVE_DATABASE_URL: "postgres://b" }).url, "postgres://a");
  assert.deepEqual(resolveLedgerTestUrl({}), { url: undefined, required: false, skip: true });
  assert.deepEqual(resolveLedgerTestUrl({ CI_REQUIRE_PG_TESTS: "1" }), { url: undefined, required: true, skip: false });
  assert.equal(resolveLedgerTestUrl({ CI_REQUIRE_PG_TESTS: "true" }).required, false);
});

test("fixture refuses non-loopback, non-synthetic and non-allow-listed targets and has the D15 caps", () => {
  const name = databaseFor("migrations");
  assert.ok(assertDisposableTarget("postgres://synthetic:x@127.0.0.1:5432/postgres", name, {}));
  for (const url of ["postgres://synthetic:x@127.0.0.1/postgres", "postgres://synthetic:x@127.0.0.1:5433/postgres", "postgres://synthetic:x@127.0.0.1:6543/postgres"])
    assert.throws(() => assertDisposableTarget(url, name, {}), /non-disposable/, "explicit CI port required: " + url);
  assert.ok(assertDisposableTarget("postgres://synthetic:x@127.0.0.1:5433/postgres", name, { M7_TEST_POSTGRES_PORT_ACK: "5433" }), "explicit acknowledgement names the port");
  assert.throws(() => assertDisposableTarget("postgres://synthetic:x@127.0.0.1:5434/postgres", name, { M7_TEST_POSTGRES_PORT_ACK: "5433" }), /non-disposable/, "acknowledgement must match exactly");
  assert.throws(() => assertDisposableTarget("postgres://synthetic:x@127.0.0.1/postgres", name, { M7_TEST_POSTGRES_PORT_ACK: "" }), /non-disposable/, "no port is never acceptable");
  for (const url of ["postgres://synthetic:x@db.neon.tech/postgres", "postgres://localhost/postgres", "postgres://postgres:x@127.0.0.1/postgres", "postgres://synthetic:x@localhost/postgres"])
    assert.throws(() => assertDisposableTarget(url, name), /non-disposable/);
  for (const bad of ["vynvori_m7_other_test", "vynvori_creative_staging", "postgres"]) assert.throws(() => assertDisposableTarget("postgres://synthetic:x@127.0.0.1:5432/postgres", bad), /non-disposable/);
  const sneaky = ["?host=prod.example.com", "?user=app", "?port=5433", "?options=-c%20x", "?sslmode=require", "#frag"].map(q => "postgres://synthetic:x@127.0.0.1:5432/postgres" + q);
  for (const url of [...sneaky, "not a url with secret-password"]) assert.throws(() => assertDisposableTarget(url, name), (e: unknown) => e instanceof Error && e.message === "Refusing non-disposable database", url);
  assert.deepEqual(poolBudget(250, "concurrency"), { max: 110, degraded: false });
  assert.deepEqual(poolBudget(250, "standard"), { max: 5, degraded: false });
  assert.deepEqual(poolBudget(100, "concurrency"), { max: 97, degraded: true });
  assert.deepEqual(poolBudget(6, "standard"), { max: 3, degraded: true });
  assert.deepEqual(poolBudget(1, "standard"), { max: 1, degraded: true });
  assert.deepEqual({ ...POOL_CAPS }, { concurrency: 110, standard: 5 });
});

test("ledger migration journal: apply, replay, drift, rollback guard, up-down-up in disposable PostgreSQL", { skip: ledgerTarget.skip }, async t => {
  assert.ok(ledgerTarget.url, "CI_REQUIRE_PG_TESTS=1 requires M7_TEST_POSTGRES_URL or M2_CREATIVE_DATABASE_URL");
  let client = await freshLedger("migrations");
  const closeAll = async () => { await client.end().catch(() => undefined); await dropLedger("migrations"); };
  const plan = ledgerMigrationPlan(), expected = { database: databaseFor("migrations"), role: "synthetic", planSha256: plan.digest };
  const down = readFileSync(join(planDir, "rollback/0001_ledger_schema.down.sql"), "utf8");
  const schemas = async () => (await client.query("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'vynvori_ledger%' ORDER BY 1")).rows.map(r => r.nspname);
  try {
    await t.test("fresh apply created only the empty ledger schema and its journal", async () => {
      assert.deepEqual(await schemas(), ["vynvori_ledger", "vynvori_ledger_migrations"]);
      assert.equal((await client.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='vynvori_ledger'")).rows[0].n, 0);
      assert.equal((await client.query("SELECT sha256 FROM vynvori_ledger_migrations.applied")).rows[0].sha256, plan.migrations[0]!.sha256);
    });
    await t.test("replay applies nothing; journal drift is HISTORY_OR_SCHEMA_DRIFT", async () => {
      assert.equal((await applyLedgerMigrations(client, expected)).applied, 0);
      await client.query("UPDATE vynvori_ledger_migrations.applied SET sha256='0'||substr(sha256,2)");
      await assert.rejects(applyLedgerMigrations(client, expected), code("HISTORY_OR_SCHEMA_DRIFT"));
      await client.query("UPDATE vynvori_ledger_migrations.applied SET sha256=$1", [plan.migrations[0]!.sha256]);
    });
    await t.test("rollback refuses while a relation exists, then up -> down -> up succeeds", async () => {
      await client.query("CREATE TABLE vynvori_ledger.synthetic_probe(id int)");
      await assert.rejects(client.query(down), /refusing rollback/);
      assert.equal((await schemas()).length, 2, "a refused rollback leaves both schemas intact");
      await client.query("DROP TABLE vynvori_ledger.synthetic_probe");
      await client.query(down);
      assert.deepEqual(await schemas(), []);
      assert.equal((await applyLedgerMigrations(client, expected)).applied, 1);
      assert.deepEqual(await schemas(), ["vynvori_ledger", "vynvori_ledger_migrations"]);
      await client.query(down); await assert.rejects(client.query(down), /schema not present/);
      assert.equal((await applyLedgerMigrations(client, expected)).applied, 1);
    });
    await t.test("the in-transaction identity check rejects a different database or role than expected", async () => {
      await assert.rejects(applyLedgerMigrations(client, { ...expected, database: databaseFor("fixture") }), code("TARGET_REJECTED"));
      const role = "m7_probe_" + randomBytes(6).toString("hex"); // roles are cluster-global: never a fixed name
      await client.query(`CREATE ROLE ${role} NOLOGIN`); await client.query(`SET ROLE ${role}`);
      try { await assert.rejects(applyLedgerMigrations(client, expected), code("TARGET_REJECTED")); } finally { await client.query("RESET ROLE"); await client.query(`DROP ROLE ${role}`); }
      await assert.rejects(assertServerIsLoopbackSynthetic({ query: async () => ({ rows: [{ u: "postgres", addr: "127.0.0.1" }] }) }), /non-disposable server/);
      await assert.rejects(assertServerIsLoopbackSynthetic({ query: async () => ({ rows: [{ u: "synthetic", addr: "10.0.0.5" }] }) }), /non-disposable server/);
      await assert.rejects(assertServerIsLoopbackSynthetic({ query: async () => ({ rows: [{ u: "synthetic", addr: null }] }) }), /non-disposable server/);
      await assertServerIsLoopbackSynthetic(client);
    });
    await t.test("half state (schema without journal) is HISTORY_OR_SCHEMA_DRIFT", async () => {
      await client.query("DROP SCHEMA vynvori_ledger_migrations CASCADE");
      await assert.rejects(applyLedgerMigrations(client, expected), code("HISTORY_OR_SCHEMA_DRIFT"));
      await client.end(); client = await freshLedger("migrations");
    });
    await t.test("the identity prerequisite is enforced and the pool honours the D15 cap", async () => {
      await client.query(down); await client.query("DROP SCHEMA vynvori_identity CASCADE");
      await assert.rejects(applyLedgerMigrations(client, expected), code("PREREQUISITE_MISSING"));
      const { pool, max, serverMax, degraded } = await ledgerPool("migrations", "standard");
      try { assert.ok(max <= POOL_CAPS.standard); assert.equal(degraded, serverMax - 3 < POOL_CAPS.standard); } finally { await pool.end(); }
    });
  } finally { await closeAll(); }
});
