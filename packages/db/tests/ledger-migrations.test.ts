import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { applyLedgerMigrations, ledgerMigrationPlan, LedgerMigrationError } from "../src/ledger-migrations";
import { assertDisposableTarget, assertServerIsDisposableSynthetic, databaseFor, dropLedger, freshLedger, ledgerPool, ledgerTarget, resolveLedgerTestUrl, POOL_CAPS, poolBudget } from "./ledger-fixture";

const planDir = new URL("../ledger-migrations", import.meta.url).pathname;
const code = (c: string) => (e: unknown) => e instanceof LedgerMigrationError && e.code === c;

test("ledger plan loads, pins the reviewed SQL and lists 0001 (schema only) then 0002 (wallet + ledger)", () => {
  const plan = ledgerMigrationPlan();
  assert.deepEqual(plan.migrations.map(m => m.file), ["0001_ledger_schema.sql", "0002_wallet_ledger.sql"]);
  assert.match(plan.digest, /^[a-f0-9]{64}$/); assert.deepEqual(plan.plan.requires, ["vynvori_identity"]);
});

// Golden digests: ANY change to plan.json or the pinned SQL forces a visible edit here (the planSha256 argument alone is circular).
const GOLDEN_PLAN_JSON_SHA256 = "0b0abf7ba52c0905fba08ba6ae1eb85793d5e9a08ebcaf046fcc24cc64900c92";
const GOLDEN_0001_SQL_SHA256 = "a8273f3fac59de2d0c2f1a661a852d22b9a360c9d9c83e672bd7f0d25d74ef4e";
const GOLDEN_0002_SQL_SHA256 = "474b12f4394258ce8e83723d5340c404a926dac5c63361f2ab925bb266f075e4";
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
test("golden digests pin plan.json, 0001 and 0002 independently of the loader", () => {
  assert.equal(sha(join(planDir, "plan.json")), GOLDEN_PLAN_JSON_SHA256);
  assert.equal(sha(join(planDir, "0001_ledger_schema.sql")), GOLDEN_0001_SQL_SHA256);
  assert.equal(ledgerMigrationPlan().digest, GOLDEN_PLAN_JSON_SHA256);
  assert.equal(ledgerMigrationPlan().migrations[0]!.sha256, GOLDEN_0001_SQL_SHA256);
  assert.equal(sha(join(planDir, "0002_wallet_ledger.sql")), GOLDEN_0002_SQL_SHA256);
  assert.equal(ledgerMigrationPlan().migrations[1]!.sha256, GOLDEN_0002_SQL_SHA256);
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

test("0001 is additive: schema only, no grants, drops, table DDL or identity alterations", () => {
  const sql = readFileSync(join(planDir, "0001_ledger_schema.sql"), "utf8").replace(/--.*$/gm, "");
  assert.doesNotMatch(sql, /\b(GRANT|REVOKE|DROP|TRUNCATE|ALTER|CREATE\s+(TABLE|FUNCTION|TRIGGER|ROLE|EXTENSION)|vynvori_identity)\b/i);
  assert.match(sql, /CREATE\s+SCHEMA\s+vynvori_ledger\s*;/i);
});

test("0002 is additive: ledger-schema objects only; exactly one SECURITY DEFINER; only function-level REVOKE FROM PUBLIC; no grants, roles, owners, rows, identity alteration or Medusa", () => {
  const original = readFileSync(join(planDir, "0002_wallet_ledger.sql"), "utf8").replace(/--.*$/gm, "");
  const sql = original.replace(/'[^']*'/g, "''");
  const revokes = [...sql.matchAll(/REVOKE\s+ALL\s+ON\s+FUNCTION\s+(vynvori_ledger\.\w+\(\))\s+FROM\s+PUBLIC\s*;/gi)].map(m => m[1]!);
  const functions = [...sql.matchAll(/CREATE\s+FUNCTION\s+(vynvori_ledger\.\w+\(\))/gi)].map(m => m[1]!);
  assert.ok(functions.length >= 5);
  assert.deepEqual([...revokes].sort(), [...functions].sort(), "every created function is revoked from PUBLIC, and nothing else is revoked");
  const rest = sql.replace(/REVOKE\s+ALL\s+ON\s+FUNCTION\s+vynvori_ledger\.\w+\(\)\s+FROM\s+PUBLIC\s*;/gi, "");
  assert.doesNotMatch(rest, /\b(GRANT|REVOKE|DROP|ALTER|OWNER\s+TO|CREATE\s+(SCHEMA|ROLE|EXTENSION|USER)|INSERT\s+INTO|DELETE\s+FROM|medusa)\b/i);
  assert.equal([...rest.matchAll(/SECURITY\s+DEFINER/gi)].length, 1, "exactly one SECURITY DEFINER function");
  assert.match(rest, /CREATE\s+FUNCTION\s+vynvori_ledger\.ledger_entries_apply_to_wallet\(\)[^$]*SECURITY\s+DEFINER\s+SET\s+search_path\s*=\s*pg_catalog,\s*pg_temp\s+AS/i, "the definer is the apply function and pins search_path with pg_temp last");
  for (const fn of rest.matchAll(/CREATE\s+FUNCTION[^$]*?AS\s+\$fn\$/gi)) assert.match(fn[0], /SET\s+search_path\s*=\s*pg_catalog,\s*pg_temp\s+AS/i, "every function pins search_path");
  assert.doesNotMatch(rest, /\bEXECUTE\s+(format|'|\$)/i, "no dynamic SQL");
  // Every created object is schema-qualified into vynvori_ledger; the identity schema is only ever the target of a foreign key.
  for (const match of sql.matchAll(/CREATE\s+(?:TABLE|FUNCTION)\s+([\w.]+)/gi)) assert.match(match[1]!, /^vynvori_ledger\./);
  for (const match of sql.matchAll(/vynvori_identity[\w.]*/g)) assert.equal(match[0], "vynvori_identity.profiles");
  for (const match of sql.matchAll(/REFERENCES\s+(\S+?)\s*\(/g)) assert.match(match[1]!, /^vynvori_(ledger|identity)\./);
  assert.match(original, /CONSTRAINT\s+ledger_entries_s2_grant_only\s+CHECK\s*\(entry_kind = 'grant'\)/, "temporary S5-droppable constraint present");
  assert.match(original, /current_user::pg_catalog\.regrole::pg_catalog\.oid\s*<>\s*\(SELECT c\.relowner FROM pg_catalog\.pg_class c WHERE c\.oid = TG_RELID\)/, "wallet guard requires the table owner");
  assert.doesNotMatch(readFileSync(join(planDir, "rollback/0002_wallet_ledger.down.sql"), "utf8").replace(/--.*$/gm, ""), /\b(CASCADE|TRUNCATE|DELETE\s+FROM\s+vynvori_ledger\.)/i);
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

test("ledger migration journal: apply, replay, drift, rollback guards, up-down-up in disposable PostgreSQL", { skip: ledgerTarget.skip }, async t => {
  assert.ok(ledgerTarget.url, "CI_REQUIRE_PG_TESTS=1 requires M7_TEST_POSTGRES_URL or M2_CREATIVE_DATABASE_URL");
  let client = await freshLedger("migrations");
  const closeAll = async () => { await client.end().catch(() => undefined); await dropLedger("migrations"); };
  const plan = ledgerMigrationPlan(), expected = { database: databaseFor("migrations"), role: "synthetic", planSha256: plan.digest };
  const down1 = readFileSync(join(planDir, "rollback/0001_ledger_schema.down.sql"), "utf8");
  const down2 = readFileSync(join(planDir, "rollback/0002_wallet_ledger.down.sql"), "utf8");
  const schemas = async () => (await client.query("SELECT nspname FROM pg_namespace WHERE nspname LIKE 'vynvori_ledger%' ORDER BY 1")).rows.map(r => r.nspname);
  const relations = async () => (await client.query("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='vynvori_ledger'")).rows[0].n as number;
  const functions = async () => (await client.query("SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='vynvori_ledger'")).rows[0].n as number;
  try {
    await t.test("fresh apply created the ledger schema, its tables and the journal, and registered no grant source", async () => {
      assert.deepEqual(await schemas(), ["vynvori_ledger", "vynvori_ledger_migrations"]);
      assert.ok(await relations() > 0);
      assert.deepEqual((await client.query("SELECT file, sha256 FROM vynvori_ledger_migrations.applied ORDER BY file")).rows, plan.migrations.map(m => ({ file: m.file, sha256: m.sha256 })));
      assert.equal((await client.query("SELECT count(*)::int AS n FROM vynvori_ledger.ledger_grant_sources")).rows[0].n, 0, "0002 registers no grant source");
    });
    await t.test("replay applies nothing; journal drift is HISTORY_OR_SCHEMA_DRIFT", async () => {
      assert.equal((await applyLedgerMigrations(client, expected)).applied, 0);
      await client.query("UPDATE vynvori_ledger_migrations.applied SET sha256='0'||substr(sha256,2) WHERE file='0002_wallet_ledger.sql'");
      await assert.rejects(applyLedgerMigrations(client, expected), code("HISTORY_OR_SCHEMA_DRIFT"));
      await client.query("UPDATE vynvori_ledger_migrations.applied SET sha256=$1 WHERE file='0002_wallet_ledger.sql'", [plan.migrations[1]!.sha256]);
    });
    await t.test("0002 rollback refuses while any ledger table holds a row, and while a later migration is journaled", async () => {
      const seed: Record<string, string> = {
        wallets: "INSERT INTO vynvori_identity.profiles(id,issuer,subject) VALUES('00000000-0000-4000-8000-000000000001','https://synthetic.invalid','rollback-probe'); INSERT INTO vynvori_ledger.wallets(user_id) VALUES('00000000-0000-4000-8000-000000000001')",
        ledger_commands: "INSERT INTO vynvori_identity.profiles(id,issuer,subject) VALUES('00000000-0000-4000-8000-000000000001','https://synthetic.invalid','rollback-probe'); INSERT INTO vynvori_ledger.ledger_commands(command_id,scope,idempotency_key,request_sha256,user_id,command_kind,outcome) VALUES('00000000-0000-4000-8000-0000000000c1','00000000-0000-4000-8000-000000000001:probe','probe-key-0123456789',repeat('a',64),'00000000-0000-4000-8000-000000000001','probe','applied')",
        ledger_grant_sources: "INSERT INTO vynvori_ledger.ledger_grant_sources(grant_source_id,kind,label) VALUES('00000000-0000-4000-8000-0000000000a1','synthetic_test','probe')",
        ledger_entries: "INSERT INTO vynvori_identity.profiles(id,issuer,subject) VALUES('00000000-0000-4000-8000-000000000001','https://synthetic.invalid','rollback-probe'); INSERT INTO vynvori_ledger.wallets(user_id) VALUES('00000000-0000-4000-8000-000000000001'); INSERT INTO vynvori_ledger.ledger_commands(command_id,scope,idempotency_key,request_sha256,user_id,command_kind,outcome) VALUES('00000000-0000-4000-8000-0000000000c1','00000000-0000-4000-8000-000000000001:probe','probe-key-0123456789',repeat('a',64),'00000000-0000-4000-8000-000000000001','probe','applied'); INSERT INTO vynvori_ledger.ledger_grant_sources(grant_source_id,kind,label) VALUES('00000000-0000-4000-8000-0000000000a1','synthetic_test','probe'); INSERT INTO vynvori_ledger.ledger_entries(entry_id,user_id,command_id,entry_kind,delta_available,delta_reserved,delta_held,delta_consumed,delta_external,grant_source_id,source_ref,cause_kind,cause_ref) VALUES('00000000-0000-4000-8000-0000000000e1','00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-0000000000c1','grant',5,0,0,0,-5,'00000000-0000-4000-8000-0000000000a1','probe','grant','00000000-0000-4000-8000-0000000000a1:probe')",
      };
      for (const [table, sql] of Object.entries(seed)) {
        await client.query("BEGIN");
        try { await client.query(sql); await assert.rejects(client.query(down2), /refusing rollback: rows exist/, table); } finally { await client.query("ROLLBACK"); }
      }
      assert.ok(await relations() > 0, "refused rollbacks leave the tables intact");
      await client.query("INSERT INTO vynvori_ledger_migrations.applied(file,sha256) VALUES('0003_future_step.sql', repeat('b',64))");
      await assert.rejects(client.query(down2), /later ledger migration is applied/);
      await client.query("DELETE FROM vynvori_ledger_migrations.applied WHERE file='0003_future_step.sql'");
    });
    await t.test("up -> down -> up on an empty ledger: 0002 down removes tables and functions; 0001 down then removes both schemas", async () => {
      await client.query(down2);
      assert.equal(await relations(), 0); assert.equal(await functions(), 0);
      assert.deepEqual((await client.query("SELECT file FROM vynvori_ledger_migrations.applied")).rows.map(r => r.file), ["0001_ledger_schema.sql"]);
      await assert.rejects(client.query(down2), /not applied/);
      await client.query("CREATE TABLE vynvori_ledger.synthetic_probe(id int)");
      await assert.rejects(client.query(down1), /refusing rollback/);
      assert.equal((await schemas()).length, 2, "a refused rollback leaves both schemas intact");
      await client.query("DROP TABLE vynvori_ledger.synthetic_probe");
      await client.query(down1);
      assert.deepEqual(await schemas(), []);
      assert.equal((await applyLedgerMigrations(client, expected)).applied, 2);
      assert.deepEqual(await schemas(), ["vynvori_ledger", "vynvori_ledger_migrations"]);
      await client.query(down2); await client.query(down1); await assert.rejects(client.query(down1), /schema not present/);
      assert.equal((await applyLedgerMigrations(client, expected)).applied, 2);
    });
    await t.test("the in-transaction identity check rejects a different database or role than expected", async () => {
      await assert.rejects(applyLedgerMigrations(client, { ...expected, database: databaseFor("fixture") }), code("TARGET_REJECTED"));
      const role = "m7_probe_" + randomBytes(6).toString("hex"); // roles are cluster-global: never a fixed name
      await client.query(`CREATE ROLE ${role} NOLOGIN`); await client.query(`SET ROLE ${role}`);
      try { await assert.rejects(applyLedgerMigrations(client, expected), code("TARGET_REJECTED")); } finally { await client.query("RESET ROLE"); await client.query(`DROP ROLE ${role}`); }
      const fake = (u: string, su: string) => ({ query: async () => ({ rows: [{ u, su }] }) });
      await assert.rejects(assertServerIsDisposableSynthetic(fake("postgres", "on")), /non-disposable server/, "wrong user");
      await assert.rejects(assertServerIsDisposableSynthetic(fake("app", "on")), /non-disposable server/, "wrong user");
      await assert.rejects(assertServerIsDisposableSynthetic(fake("synthetic", "off")), /non-disposable server/, "not a superuser");
      await assert.rejects(assertServerIsDisposableSynthetic({ query: async () => ({ rows: [] }) }), /non-disposable server/, "no row");
      await assertServerIsDisposableSynthetic(fake("synthetic", "on"));
      await assertServerIsDisposableSynthetic(client);
    });
    await t.test("half state (schema without journal) is HISTORY_OR_SCHEMA_DRIFT", async () => {
      await client.query("DROP SCHEMA vynvori_ledger_migrations CASCADE");
      await assert.rejects(applyLedgerMigrations(client, expected), code("HISTORY_OR_SCHEMA_DRIFT"));
      await client.end(); client = await freshLedger("migrations");
    });
    await t.test("the identity prerequisite is enforced and the pool honours the D15 cap", async () => {
      await client.query(down2); await client.query(down1); await client.query("DROP SCHEMA vynvori_identity CASCADE");
      await assert.rejects(applyLedgerMigrations(client, expected), code("PREREQUISITE_MISSING"));
      const { pool, max, serverMax, degraded } = await ledgerPool("migrations", "standard");
      try { assert.ok(max <= POOL_CAPS.standard); assert.equal(degraded, serverMax - 3 < POOL_CAPS.standard); } finally { await pool.end(); }
    });
  } finally { await closeAll(); }
});
