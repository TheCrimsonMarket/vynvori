// Disposable loopback PostgreSQL integration; never loads .env or cloud credentials.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const { Client } = createRequire(new URL("../packages/db/package.json", import.meta.url))("pg");
const name = `vynvori-m2-creative-${randomUUID()}`;
const label = "vynvori.m2-creative-test";
const runtime = "vynvori_creative_runtime_scoped";
async function docker(args) { return (await exec("docker", args, { cwd: root, windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 })).stdout.trim(); }
let created = false;
let owner;
try {
  await docker(["run", "-d", "--name", name, "--label", `${label}=${name}`, "-p", "127.0.0.1::5432", "-e", "POSTGRES_USER=synthetic", "-e", "POSTGRES_PASSWORD=synthetic-local-only", "-e", "POSTGRES_DB=vynvori_creative_staging", "postgres:17.6-bookworm"]);
  created = true;
  const binding = await docker(["port", name, "5432/tcp"]);
  assert.match(binding, /^127\.0\.0\.1:\d+$/);
  const url = `postgresql://synthetic:synthetic-local-only@${binding}/vynvori_creative_staging`;
  for (let i = 0; i < 30; i++) {
    const candidate = new Client({ connectionString: url, connectionTimeoutMillis: 1000 });
    candidate.on("error", () => {});
    try { await candidate.connect(); owner = candidate; break; }
    catch { await candidate.end(); await new Promise(resolve => setTimeout(resolve, 300)); }
  }
  assert.ok(owner, "local PostgreSQL did not become ready");
  // Explicit allowlist; cloud URLs and flags are not inherited by the migration.
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP,
    M2_ENV: "local", M2_CREATIVE_DATABASE_URL: url, M2_APPLY_MIGRATIONS: "vynvori-creative-staging" };
  for (let i = 0; i < 2; i++) await exec(process.execPath, ["--conditions=react-server", "--import", "tsx", "packages/db/src/migrate.ts"], { cwd: root, env, windowsHide: true, timeout: 30000 });
  assert.equal((await owner.query("SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations")).rows[0].n, 1);
  await owner.query(`CREATE ROLE ${runtime} LOGIN PASSWORD 'synthetic-local-runtime-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT CONNECTION LIMIT 3`);
  await owner.query(`REVOKE CREATE,TEMPORARY ON DATABASE vynvori_creative_staging FROM PUBLIC;
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    GRANT CONNECT ON DATABASE vynvori_creative_staging TO ${runtime};
    GRANT USAGE ON SCHEMA vynvori_infrastructure TO ${runtime};
    GRANT SELECT,INSERT ON vynvori_infrastructure.synthetic_probes TO ${runtime}`);
  const runtimeUrl = new URL(url); runtimeUrl.username = runtime; runtimeUrl.password = "synthetic-local-runtime-only";
  const client = new Client({ connectionString: runtimeUrl.toString(), statement_timeout: 3000 });
  await client.connect();
  let negatives = 0;
  try {
    for (const sql of ["CREATE SCHEMA forbidden", "CREATE TABLE public.forbidden(id int)", "CREATE TEMP TABLE forbidden(id int)",
      "TRUNCATE vynvori_infrastructure.synthetic_probes", "UPDATE vynvori_infrastructure.synthetic_probes SET fixture=fixture",
      "DELETE FROM vynvori_infrastructure.synthetic_probes", "SELECT * FROM drizzle.__drizzle_migrations", "SET ROLE synthetic"]) {
      await assert.rejects(client.query(sql), { code: "42501" }); negatives++;
    }
    const flags = (await client.query("SELECT rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
    assert.ok(Object.values(flags).every(value => value === false));
    assert.equal((await client.query("SELECT count(*)::int AS n FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)")).rows[0].n, 0);
  } finally { await client.end(); }
  const tests = await exec(process.execPath, ["--conditions=react-server", "--import", "tsx", "--test", "packages/db/tests/postgres.test.ts"], { cwd: root, env: { ...env, M2_CREATIVE_DATABASE_URL: runtimeUrl.toString() }, windowsHide: true, timeout: 30000 });
  assert.match(tests.stdout, /# pass 1/);
  assert.equal((await owner.query("SELECT count(*)::int AS n FROM vynvori_infrastructure.synthetic_probes")).rows[0].n, 0);
  console.log(JSON.stringify({ status: "PASS", scope: "local-disposable-postgres-only", postgres: "17.6", migrations: 2,
    migrationHistoryRows: 1, runtimeNegativeChecks: negatives, privilegedAttributes: false, ownerMembership: false,
    syntheticRowsAfterRollback: 0, realNeonAcceptance: "NOT_RUN" }));
} finally {
  await owner?.end();
  if (created) {
    assert.equal(await docker(["inspect", "--format", `{{ index .Config.Labels "${label}" }}`, name]), name);
    await docker(["rm", "-f", name]);
  }
}
