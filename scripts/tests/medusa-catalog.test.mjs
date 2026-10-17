import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { bindGrantProposal, catalogConnection, collectCatalog, catalogQueries, runtimeRole, migrationRole } from "../medusa-catalog.mjs";
const env = { M2_ENV: "local", M2_MEDUSA_DATABASE_URL: `postgres://${runtimeRole}:synthetic@127.0.0.1/vynvori_medusa_staging` };
const identity = { database: "vynvori_medusa_staging", login: runtimeRole, actor: runtimeRole, read_only: "on" };
test("catalog connection accepts only scoped runtime and verified direct staging TLS", () => {
  assert.equal(catalogConnection(env).ssl, false);
  const staging = { M2_ENV: "staging", M2_MEDUSA_DATABASE_HOST: "ep-synthetic.us-east-1.aws.neon.tech",
    M2_MEDUSA_DATABASE_URL: `postgres://${runtimeRole}:synthetic@ep-synthetic.us-east-1.aws.neon.tech/vynvori_medusa_staging?sslmode=verify-full` };
  const config = catalogConnection(staging);
  assert.deepEqual(config.ssl, { rejectUnauthorized: true });
  assert.doesNotMatch(config.connectionString, /sslmode/);
  for (const patch of [{ M2_ENV: "production" }, { M2_MEDUSA_DATABASE_HOST: "wrong.neon.tech" },
    { M2_AUTHORIZE_MEDUSA_MIGRATION: "vynvori_medusa_staging" }, { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    { VYNVORI_PAYMENTS_LIVE: "true" },
    ...["sslmode=require", "sslmode=no-verify", "sslmode=verify-full&options=bad"].map(query => ({ M2_MEDUSA_DATABASE_URL: staging.M2_MEDUSA_DATABASE_URL.split("?")[0] + "?" + query })),
    { M2_MEDUSA_DATABASE_URL: staging.M2_MEDUSA_DATABASE_URL.replace(runtimeRole, migrationRole) },
    { M2_MEDUSA_DATABASE_URL: staging.M2_MEDUSA_DATABASE_URL.replace("/vynvori_medusa_staging", "/vynvori_creative_staging") },
    { M2_MEDUSA_DATABASE_URL: staging.M2_MEDUSA_DATABASE_URL.replace("ep-synthetic.", "ep-synthetic-pooler.") }]) {
    assert.throws(() => catalogConnection({ ...staging, ...patch }));
  }
});
function fake(identityRows = [identity], failure) {
  const calls = [];
  return { calls, async query(sql) {
    calls.push(sql);
    if (sql === failure) throw new Error("synthetic SQL failure");
    return { rows: sql === catalogQueries.identity ? identityRows : [] };
  } };
}
test("collection has one read-only snapshot, no domain reads, and rollback on success", async () => {
  const client = fake();
  const report = await collectCatalog(client);
  assert.equal(report.status, "REVIEW_REQUIRED");
  assert.equal(client.calls[0], "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.equal(client.calls.at(-1), "ROLLBACK");
  assert.equal(client.calls.length, 7);
  assert.deepEqual(report.objects, []);
});
test("wrong actual identity, writable transaction, query error and truncated catalog fail with rollback", async () => {
  for (const rows of [[], [{ ...identity, actor: migrationRole }], [{ ...identity, database: "other" }], [{ ...identity, read_only: "off" }]]) {
    const client = fake(rows);
    await assert.rejects(collectCatalog(client), /CATALOG_IDENTITY_INVALID/);
    assert.equal(client.calls.at(-1), "ROLLBACK");
  }
  const failed = fake([identity], catalogQueries.objects);
  await assert.rejects(collectCatalog(failed));
  assert.equal(failed.calls.at(-1), "ROLLBACK");
  const overflow = fake(Array(10001).fill(identity));
  await assert.rejects(collectCatalog(overflow), /CATALOG_LIMIT_EXCEEDED/);
});
test("grant binding rejects absent, foreign, duplicate and incorrectly linked sequences", () => {
  const table = { schema: "public", name: "synthetic_domain", kind: "table", owner: migrationRole };
  const sequence = { ...table, kind: "sequence", name: "synthetic_domain_id_seq", table: table.name };
  const catalog = { version: 1, status: "REVIEW_REQUIRED", objects: [table, { ...sequence, tables: [table.name] }] };
  assert.deepEqual(bindGrantProposal([table, sequence], catalog), [table, sequence]);
  for (const objects of [[{ ...table, name: "invented" }], [{ ...table, owner: runtimeRole }], [{ ...sequence, table: "wrong" }]]) {
    assert.throws(() => bindGrantProposal(objects, catalog));
  }
  assert.throws(() => bindGrantProposal([table], { ...catalog, objects: [table, table] }));
  assert.throws(() => bindGrantProposal([], catalog));
});

test("operator CLI emits only a sanitized failure for invalid targets and connection errors", () => {
  for (const url of ["postgres://owner:synthetic-private-marker@127.0.0.1/other",
    `postgres://${runtimeRole}:synthetic-private-marker@127.0.0.1:1/vynvori_medusa_staging`]) {
    const result = spawnSync(process.execPath, ["scripts/medusa-catalog-cli.mjs"], {
      cwd: new URL("../..", import.meta.url), encoding: "utf8", timeout: 10000,
      env: { ...process.env, M2_ENV: "local", M2_MEDUSA_DATABASE_URL: url, M2_AUTHORIZE_MEDUSA_MIGRATION: "" },
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.deepEqual(JSON.parse(result.stderr), { version: 1, status: "FAILED", code: "CATALOG_COLLECTION_FAILED" });
    assert.doesNotMatch(result.stderr, /synthetic-private-marker|postgres:|127\.0\.0\.1/);
  }
});

test("real PostgreSQL catalog records effective ACLs, sequence lineage and callable functions without reading domain rows", {
  skip: !process.env.M2_CATALOG_TEST_ADMIN_URL,
}, async () => {
  const url = new URL(process.env.M2_CATALOG_TEST_ADMIN_URL);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
  assert.equal(url.pathname, "/vynvori_medusa_staging");
  const require = createRequire(new URL("../../packages/db/package.json", import.meta.url));
  const { Client } = require("pg");
  const admin = new Client({ connectionString: url.toString() });
  await admin.connect();
  try {
    // Requires a NEW disposable local database. Never aimed at Neon or reused DBs.
    await admin.query(`CREATE ROLE ${migrationRole} NOLOGIN;
      CREATE ROLE ${runtimeRole} LOGIN PASSWORD 'synthetic-catalog-only';
      REVOKE TEMP ON DATABASE vynvori_medusa_staging FROM PUBLIC;
      GRANT CREATE ON SCHEMA public TO ${migrationRole};
      SET ROLE ${migrationRole};
      CREATE TABLE public.synthetic_domain (id SERIAL PRIMARY KEY, private_value text);
      INSERT INTO public.synthetic_domain(private_value) VALUES ('PRIVATE_ROW_MUST_NOT_APPEAR');
      CREATE TABLE public.script_migrations (id SERIAL PRIMARY KEY);
      CREATE FUNCTION public.synthetic_function() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1';
      GRANT SELECT ON public.synthetic_domain TO ${runtimeRole};
      RESET ROLE;`);
    url.username = runtimeRole; url.password = "synthetic-catalog-only";
    const runtime = new Client(catalogConnection({ M2_ENV: "local", M2_MEDUSA_DATABASE_URL: url.toString() }));
    await runtime.connect();
    try {
      const report = await collectCatalog(runtime);
      assert.equal(report.identity[0].schema_create, false);
      assert.equal(report.identity[0].temp, false);
      assert.deepEqual(report.objects.find(o => o.name === "synthetic_domain").privileges, ["SELECT"]);
      assert.deepEqual(report.objects.find(o => o.name === "synthetic_domain_id_seq").tables, ["synthetic_domain"]);
      assert.deepEqual(report.objects.find(o => o.name === "script_migrations").privileges, []);
      assert.equal(report.functions.find(f => f.name === "synthetic_function").security_definer, true);
      assert.equal(report.functions.find(f => f.name === "synthetic_function").executable, true);
      assert.doesNotMatch(JSON.stringify(report), /PRIVATE_ROW_MUST_NOT_APPEAR|synthetic-catalog-only/);
      await runtime.query("BEGIN READ ONLY");
      await assert.rejects(runtime.query("DELETE FROM public.synthetic_domain"));
      await runtime.query("ROLLBACK");
    } finally { await runtime.end(); }
  } finally { await admin.end(); }
});
