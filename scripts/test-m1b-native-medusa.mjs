// Native framework/module integration in an isolated local database. No npm, live credentials or image build.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { randomUUID, randomBytes } from "node:crypto";
const exec = promisify(execFile), root = fileURLToPath(new URL("..", import.meta.url));
const { Client } = createRequire(new URL("../packages/db/package.json", import.meta.url))("pg");
const name = "vynvori-m1b-native-" + randomUUID(), label = "vynvori.m1b-native-test";
const browserTest = process.argv.includes("--browser");
assert.ok(process.argv.slice(2).every(value => value === "--browser"));
async function docker(args) { return (await exec("docker", ["--context", "default", ...args], { cwd: root, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 })).stdout.trim(); }
let created = false, owner, destination, stage = "compile";
try {
  const built = await exec(process.execPath, ["scripts/test-m1b-medusa-build.mjs"], { cwd: root, windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024 });
  const build = JSON.parse(built.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(build.status, "PASS_COMPILER_AND_COMPILED_DISABLED_PROVIDER"); destination = build.output;
  const backend = join(destination, "apps", "medusa", ".medusa", "server");
  const ctx = JSON.parse(await docker(["context", "inspect", "default"]));
  assert.equal(ctx.length, 1); assert.match(ctx[0].Endpoints.docker.Host, /^(?:npipe:\/\/|unix:\/\/)/);
  assert.equal(await docker(["image", "inspect", "--format", "{{.Os}}", "postgres:16-alpine"]), "linux");
  stage = "disposable-native-database";
  await docker(["run", "-d", "--pull=never", "--name", name, "--label", `${label}=${name}`, "-p", "127.0.0.1::5432", "-e", "POSTGRES_USER=synthetic", "-e", "POSTGRES_PASSWORD=synthetic-local-only", "-e", "POSTGRES_DB=vynvori_medusa_staging", "postgres:16-alpine"]);
  created = true;
  const binding = await docker(["port", name, "5432/tcp"]); assert.match(binding, /^127\.0\.0\.1:\d+$/);
  const connection = `postgresql://synthetic:synthetic-local-only@${binding}/vynvori_medusa_staging`;
  stage = "disposable-database-readiness";
  let connectionCode = "NOT_ATTEMPTED";
  for (let i = 0; i < 30; i++) {
    const candidate = new Client({ connectionString: connection, connectionTimeoutMillis: 1000 }); candidate.on("error", () => {});
    try { await candidate.connect(); owner = candidate; break; } catch (error) { connectionCode = typeof error?.code === "string" ? error.code : "UNAVAILABLE"; await candidate.end(); await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  if (!owner) { console.error(`Disposable PostgreSQL readiness code: ${connectionCode}`); throw new Error("Disposable database unavailable"); }
  let browserDatabase;
  if (browserTest) {
    await owner.query("CREATE DATABASE vynvori_m1b_browser");
    const creativeOwner = new Client({ connectionString: connection.replace("/vynvori_medusa_staging", "/vynvori_m1b_browser") });
    await creativeOwner.connect();
    try {
      for (const file of ["0001_identity_state.sql", "0002_commerce_mappings.sql", "0003_customer_credentials.sql", "0004_revocation_reconciliation.sql"])
        await creativeOwner.query(await readFile(join(root, "packages/db/auth-migrations", file), "utf8"));
      const role = "synthetic_browser_runtime_" + randomUUID().replaceAll("-", "");
      await creativeOwner.query(`CREATE ROLE ${role} LOGIN PASSWORD 'synthetic-browser-only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT;
        REVOKE CREATE,TEMPORARY ON DATABASE vynvori_m1b_browser FROM PUBLIC; REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        GRANT CONNECT ON DATABASE vynvori_m1b_browser TO ${role}; GRANT USAGE ON SCHEMA vynvori_identity TO ${role};
        GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA vynvori_identity TO ${role}`);
      const url = new URL(connection); url.pathname = "/vynvori_m1b_browser"; url.username = role; url.password = "synthetic-browser-only"; browserDatabase = url.toString();
    } finally { await creativeOwner.end(); }
  }
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, NODE_ENV: "production", MEDUSA_DISABLE_TELEMETRY: "true",
    XDG_CONFIG_HOME: join(destination, "private-cli-config"), XDG_CACHE_HOME: join(destination, "private-cli-cache"),
    M2_ENV: "local", M2_MEDUSA_DATABASE_URL: connection, M2_MEDUSA_DATABASE_NAME: "vynvori_medusa_staging",
    M2_MEDUSA_JWT_SECRET: randomBytes(32).toString("hex"), M2_MEDUSA_COOKIE_SECRET: randomBytes(32).toString("hex"),
    M2_MEDUSA_STORE_CORS: "http://localhost:3000", M2_MEDUSA_ADMIN_CORS: "http://localhost:9000", M2_MEDUSA_AUTH_CORS: "http://localhost:9000" };
  Object.assign(env, { M1B_MEDUSA_BRIDGE_ENABLED: "true", M1B_MEDUSA_ORIGIN: "http://127.0.0.1:9000", M1B_MEDUSA_PROJECT_ID: "synthetic-private-project",
    M1B_CENTRAL_CLIENT_ID: "tcm_" + "a".repeat(32), M1B_CENTRAL_CLIENT_SECRET: "synthetic-private-only-service-secret-32chars",
    M1B_BRIDGE_PROOF_KEY_ID: "synthetic", M1B_BRIDGE_PROOF_KEYS_JSON: JSON.stringify({ synthetic: Buffer.alloc(32, 31).toString("base64") }) });
  if (browserTest) Object.assign(env, { M1B_BROWSER_FIXTURE_ROOT: root, M1B_TEST_CREATIVE_URL: browserDatabase });
  const cli = join(root, "node_modules", "@medusajs", "cli", "cli.js");
  async function command(args, name) {
    try {
      const result = await exec(process.execPath, [cli, ...args], { cwd: backend, env, windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
      await writeFile(join(destination, name + ".stdout.private.log"), result.stdout, { flag: "wx" });
      await writeFile(join(destination, name + ".stderr.private.log"), result.stderr, { flag: "wx" });
      return result.stdout;
    } catch (error) {
      await writeFile(join(destination, name + ".stdout.private.log"), typeof error?.stdout === "string" ? error.stdout : "", { flag: "wx" });
      await writeFile(join(destination, name + ".stderr.private.log"), typeof error?.stderr === "string" ? error.stderr : "", { flag: "wx" });
      throw new Error("Native test command failed");
    }
  }
  stage = "native-migrations";
  console.log("Migrating native Medusa modules in disposable loopback PostgreSQL; no live database");
  await command(["db:migrate"], "native-migrations");
  const indexes = await owner.query("SELECT tablename,indexdef FROM pg_indexes WHERE tablename IN ('provider_identity','customer')");
  assert.ok(indexes.rows.some(row => row.tablename === "provider_identity" && row.indexdef.includes("UNIQUE") && row.indexdef.includes("entity_id") && row.indexdef.includes("provider")));
  assert.ok(indexes.rows.some(row => row.tablename === "customer" && row.indexdef.includes("UNIQUE") && row.indexdef.includes("email") && row.indexdef.includes("has_account")));
  stage = "native-provider-and-workflows";
  await cp(join(root, "apps", "medusa", "scripts", "m1b-native-probe.cjs"), join(backend, "m1b-native-probe.cjs"));
  const output = await command(["exec", "./m1b-native-probe.cjs"], "native-probe");
  const marker = output.split(/\r?\n/).find(line => line.startsWith("M1B_NATIVE_RECEIPT ")); assert.ok(marker);
  const receipt = { ...JSON.parse(marker.slice("M1B_NATIVE_RECEIPT ".length)), nativeUniqueIndexes: "VERIFIED_PHYSICAL_POSTGRES", database: "DISPOSABLE_LOOPBACK_ONLY", postgres: (await owner.query("SHOW server_version")).rows[0].server_version, output: destination, deployment: false, liveRegistration: false };
  await writeFile(join(destination, "native-receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify(receipt));
} catch (error) {
  console.error(`M1b native Medusa test failed at ${stage}; code: ${typeof error?.code === "string" ? error.code : "UNAVAILABLE"}; private diagnostics: ${destination ?? "compile output"}`); process.exitCode = 1;
  if (created && destination) {
    try { await writeFile(join(destination, "postgres-startup.private.log"), await docker(["logs", name]), { flag: "wx" }); } catch { /* Preserve the original failure; cleanup still verifies the label. */ }
  }
} finally {
  if (owner) await owner.end();
  if (created) {
    try { assert.equal(await docker(["inspect", "--format", `{{index .Config.Labels "${label}"}}`, name]), name); await docker(["rm", "-f", name]); console.log("Disposable labeled native Medusa database removed"); }
    catch { console.error("Native test container cleanup needs attention"); process.exitCode = 1; }
  }
}
