// Synthetic local PostgreSQL only. Never reads .env, cloud URLs or live credentials.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const { Client } = createRequire(new URL("../packages/db/package.json", import.meta.url))("pg");
const name = `vynvori-m1b-identity-${randomUUID()}`;
const label = "vynvori.m1b-identity-test";
const runtime = "vynvori_m1b_test_runtime";
assert.ok(process.argv.slice(2).every(value => value === "--postgres18"));
const image = process.argv.includes("--postgres18") ? "postgres:18-alpine" : "postgres:16-alpine";
async function docker(args) { return (await exec("docker", ["--context", "default", ...args], { cwd: root, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 })).stdout.trim(); }
let created = false, owner, stage = "local-engine-preflight";
try {
  const context = JSON.parse(await docker(["context", "inspect", "default"]));
  assert.equal(context.length, 1); assert.match(context[0].Endpoints.docker.Host, /^(?:npipe:\/\/|unix:\/\/)/);
  stage = "cached-image-preflight";
  assert.equal(await docker(["image", "inspect", "--format", "{{.Os}}", image]), "linux");
  const imageId = await docker(["image", "inspect", "--format", "{{.Id}}", image]);
  stage = "disposable-container-start";
  await docker(["run", "-d", "--pull=never", "--name", name, "--label", `${label}=${name}`, "-p", "127.0.0.1::5432", "-e", "POSTGRES_USER=synthetic", "-e", "POSTGRES_PASSWORD=synthetic-local-only", "-e", "POSTGRES_DB=vynvori_m1b_test", image]);
  created = true;
  const binding = await docker(["port", name, "5432/tcp"]); assert.match(binding, /^127\.0\.0\.1:\d+$/);
  const url = `postgresql://synthetic:synthetic-local-only@${binding}/vynvori_m1b_test`;
  for (let i = 0; i < 30; i++) {
    const candidate = new Client({ connectionString: url, connectionTimeoutMillis: 1000 }); candidate.on("error", () => {});
    try { await candidate.connect(); owner = candidate; break; }
    catch { await candidate.end(); await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  assert.ok(owner, "Disposable PostgreSQL did not become ready");
  stage = "synthetic-schema-and-role";
  const postgres = (await owner.query("SHOW server_version")).rows[0].server_version;
  await owner.query("CREATE DATABASE vynvori_m1b_migration_test");
  const migrationUrl = new URL(url); migrationUrl.pathname = "/vynvori_m1b_migration_test";
  await owner.query(await readFile(new URL("../packages/db/auth-migrations/0001_identity_state.sql", import.meta.url), "utf8"));
  await owner.query(await readFile(new URL("../packages/db/auth-migrations/0002_commerce_mappings.sql", import.meta.url), "utf8"));
  await owner.query(await readFile(new URL("../packages/db/auth-migrations/0003_customer_credentials.sql", import.meta.url), "utf8"));
  await owner.query(await readFile(new URL("../packages/db/auth-migrations/0004_revocation_reconciliation.sql", import.meta.url), "utf8"));
  await owner.query(`CREATE ROLE ${runtime} LOGIN PASSWORD 'synthetic-runtime-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
    REVOKE CREATE,TEMPORARY ON DATABASE vynvori_m1b_test FROM PUBLIC;
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    GRANT CONNECT ON DATABASE vynvori_m1b_test TO ${runtime};
    GRANT USAGE ON SCHEMA vynvori_identity TO ${runtime};
    GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA vynvori_identity TO ${runtime}`);
  const restricted = new URL(url); restricted.username = runtime; restricted.password = "synthetic-runtime-only";
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, M1B_TEST_POSTGRES_URL: restricted.toString(), M1B_TEST_MIGRATION_POSTGRES_URL: migrationUrl.toString() };
  stage = "restricted-runtime-tests";
  const result = await exec(process.execPath, ["--conditions=react-server", "--import", "tsx", "--test", "packages/db/tests/auth-state.test.ts", "packages/db/tests/identity-migrations.test.ts"], { cwd: root, env, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
  process.stdout.write(result.stdout);
  stage = "migration-backup-restore";
  await docker(["exec", name, "pg_dump", "-U", "synthetic", "-d", "vynvori_m1b_migration_test", "-Fc", "-f", "/tmp/m1b-migration.dump"]);
  const backupDirectory = await mkdtemp(join(tmpdir(), "VYNVORI-M1b-migration-backup-")), backupPath = join(backupDirectory, "synthetic-migration.dump");
  await docker(["cp", name + ":/tmp/m1b-migration.dump", backupPath]);
  const backup = await readFile(backupPath), backupSha256 = createHash("sha256").update(backup).digest("hex"); assert.ok(backup.length > 0);
  await owner.query("CREATE DATABASE vynvori_m1b_restore_test");
  await docker(["exec", name, "pg_restore", "-U", "synthetic", "-d", "vynvori_m1b_restore_test", "--exit-on-error", "/tmp/m1b-migration.dump"]);
  const restoreUrl = new URL(url); restoreUrl.pathname = "/vynvori_m1b_restore_test";
  const inspected = await exec(process.execPath, ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import {Client} from 'pg';
    import {inspectIdentityMigrations} from './packages/db/src/identity-migrations.ts';
    const results=[];
    for (const [key,name] of [['M1B_TEST_SOURCE','vynvori_m1b_migration_test'],['M1B_TEST_RESTORE','vynvori_m1b_restore_test']]) {
      const url=new URL(process.env[key]); assert.equal(url.hostname,'127.0.0.1');assert.equal(url.pathname,'/'+name);
      const client=new Client({connectionString:url.toString()});await client.connect();
      try {results.push(await inspectIdentityMigrations(client));} finally {await client.end();}
    }
    assert.deepEqual(results[0],results[1]);assert.equal(results[1].applied,4);console.log(JSON.stringify(results[1]));
  `], { cwd: root, env: { ...env, M1B_TEST_SOURCE: migrationUrl.toString(), M1B_TEST_RESTORE: restoreUrl.toString() }, windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
  console.log(JSON.stringify({ status: "PASS", scope: "DISPOSABLE_LOOPBACK_POSTGRES_ONLY", imageId, postgres, migrationRestore: JSON.parse(inspected.stdout.trim()), backupSha256, backupBytes: backup.length, backupPath, liveDatabase: false, registration: false, deployment: false }));
} catch (error) {
  // Test runner output contains synthetic fixtures only; never print process/env/connection objects.
  if (typeof error?.stdout === "string") process.stderr.write(error.stdout);
  console.error(`M1b disposable identity integration failed at ${stage}; no live database operation attempted`); process.exitCode = 1;
} finally {
  if (owner) await owner.end();
  if (created) {
    try {
      assert.equal(await docker(["inspect", "--format", `{{index .Config.Labels "${label}"}}`, name]), name);
      await docker(["rm", "-f", "-v", name]);
      console.log("Disposable labeled identity test container removed");
    } catch { console.error("Disposable container cleanup needs attention"); process.exitCode = 1; }
  }
}
