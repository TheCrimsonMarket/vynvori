// Local synthetic integration only. No cloud SDK, registry push or remote URL.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import { appendFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
const image = process.env.MEDUSA_TEST_IMAGE || "vynvori-medusa-local:readiness";
const id = `vynvori-medusa-${randomBytes(5).toString("hex")}`;
const db = `${id}-pg`;
const app = `${id}-app`;
const port = 19001;
const evidence = await fs.mkdtemp(path.join(os.tmpdir(), "VYNVORI-medusa-container-"));
const envFile = path.join(evidence, "synthetic.env");
const password = randomBytes(24).toString("hex");
const jwt = randomBytes(32).toString("hex");
const cookie = randomBytes(32).toString("hex");
const userPassword = randomBytes(24).toString("hex");
const databaseUrl = `postgres://synthetic:${password}@127.0.0.1:5432/vynvori_medusa_staging`;
const env = { M2_ENV: "local", M2_MEDUSA_DATABASE_URL: databaseUrl, M2_MEDUSA_DATABASE_NAME: "vynvori_medusa_staging",
  M2_MEDUSA_JWT_SECRET: jwt, M2_MEDUSA_COOKIE_SECRET: cookie,
  M2_MEDUSA_STORE_CORS: "http://localhost:3000", M2_MEDUSA_ADMIN_CORS: `http://localhost:${port}`, M2_MEDUSA_AUTH_CORS: `http://localhost:${port}` };
await fs.writeFile(envFile, Object.entries(env).map(([key, value]) => `${key}=${value}`).join("\n"), { mode: 0o600 });
let task = 0;
function docker(args, timeout = 180000) {
  if (args[0] === "run" && args.includes("--rm")) args = ["run", "--name", `${id}-task-${++task}`, "--label", `vynvori.test=${id}`, ...args.slice(1)];
  try { return execFileSync("docker", args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch (error) {
    appendFileSync(path.join(evidence, "docker-errors.log"), redact(`${error.stdout || ""}\n${error.stderr || ""}\n`));
    throw new Error(`Local Docker command failed (${args[0]}); inspect private local evidence`);
  }
}
function redact(text) {
  for (const secret of [password, jwt, cookie, userPassword, databaseUrl]) text = text.split(secret).join("[REDACTED]");
  return text;
}
async function request(route, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { ...options, signal: AbortSignal.timeout(10000), redirect: "error", headers: { connection: "close", ...options.headers } });
  const text = await response.text();
  return { status: response.status, text, json: () => JSON.parse(text) };
}
async function health() {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    try { if ((await request("/health")).status === 200) return; } catch { /* bounded */ }
    if (docker(["inspect", "--format", "{{.State.Running}}", app]) !== "true") throw new Error("Medusa exited before health passed");
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("Medusa health timed out");
}
const runBase = ["run", "--rm", "--network", `container:${db}`, "--env-file", envFile];
// AbortSignal.timeout is unref'd. Keep the harness alive through fetch/socket cleanup.
const keepAlive = setInterval(() => {}, 1000);
try {
  docker(["run", "-d", "--name", db, "--label", `vynvori.test=${id}`, "-p", `127.0.0.1:${port}:8080`,
    "-e", `POSTGRES_PASSWORD=${password}`, "-e", "POSTGRES_USER=synthetic", "-e", "POSTGRES_DB=vynvori_medusa_staging", "postgres:17.6-bookworm"]);
  let pgReady = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { docker(["exec", db, "pg_isready", "-h", "127.0.0.1", "-U", "synthetic", "-d", "vynvori_medusa_staging"]); pgReady = true; break; } catch { /* synthetic boot only */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(pgReady, "Local PostgreSQL must start");
  // Generate an ephemeral local certificate; no private key leaves the owned PG container.
  docker(["exec", db, "sh", "-c", "openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/test-server.key -out /tmp/test-server.crt -days 1 -subj /CN=localhost -addext subjectAltName=DNS:localhost,IP:127.0.0.1 >/dev/null 2>&1 && chown postgres:postgres /tmp/test-server.key /tmp/test-server.crt && chmod 600 /tmp/test-server.key"]);
  for (const sql of ["ALTER SYSTEM SET ssl = 'on'", "ALTER SYSTEM SET ssl_cert_file = '/tmp/test-server.crt'", "ALTER SYSTEM SET ssl_key_file = '/tmp/test-server.key'", "SELECT pg_reload_conf()"]) {
    docker(["exec", db, "psql", "-U", "synthetic", "-d", "vynvori_medusa_staging", "-v", "ON_ERROR_STOP=1", "-c", sql]);
  }
  const ca = Buffer.from(docker(["exec", db, "cat", "/tmp/test-server.crt"])).toString("base64");
  const tlsTest = `const assert = require('node:assert/strict'); const {Client} = require('@medusajs/deps/pg');
    (async () => {
      const ca = Buffer.from(process.env.M2_TEST_CA_BASE64, 'base64').toString();
      for (const mode of ['trusted', 'untrusted', 'wrong-host']) {
        const client = new Client({connectionString: process.env.M2_MEDUSA_DATABASE_URL,
          connectionTimeoutMillis: 5000, ssl: {rejectUnauthorized: true,
          ...(mode !== 'untrusted' ? {ca} : {}), ...(mode === 'wrong-host' ? {servername: 'wrong.example.invalid'} : {})}});
        try {
          if (mode === 'trusted') {
            await client.connect();
            const result = await client.query('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()');
            assert.equal(result.rows[0].ssl, true);
          } else { await assert.rejects(client.connect(), error => /CERT|SELF_SIGNED/.test(error.code)); }
        } finally { await client.end(); }
      }
      console.log('PASS real Medusa pg TLS: trusted certificate, rejected untrusted CA and wrong hostname');
    })().catch(() => { console.error('TLS consumer test failed'); process.exitCode = 1; });`;
  const tlsOutput = docker([...runBase, "-e", `M2_TEST_CA_BASE64=${ca}`, "--entrypoint", "node", image, "-e", tlsTest]);
  await fs.writeFile(path.join(evidence, "tls.log"), tlsOutput);
  assert.throws(() => docker([...runBase, image, "migrate"]), "Migration must require explicit authorization");
  for (let replay = 0; replay < 2; replay++) {
    const output = docker([...runBase, "-e", "M2_AUTHORIZE_MEDUSA_MIGRATION=vynvori_medusa_staging", image, "migrate"], 600000);
    await fs.writeFile(path.join(evidence, `migration-${replay}.log`), redact(output));
  }
  docker([...runBase, "--entrypoint", "node", image, "/app/node_modules/@medusajs/cli/cli.js", "user", "--email", "synthetic@example.invalid", "--password", userPassword]);
  const started = Date.now();
  docker(["run", "-d", "--name", app, "--label", `vynvori.test=${id}`, "--network", `container:${db}`, "--env-file", envFile, "--cpus=1", "--memory=2g", image]);
  await health();
  const coldStartMs = Date.now() - started;
  assert.equal(docker(["exec", app, "id", "-u"]), "1000");
  const anonymous = await request("/admin/m2-readiness");
  assert.equal(anonymous.status, 401);
  const login = await request("/auth/user/emailpass", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "synthetic@example.invalid", password: userPassword }) });
  assert.equal(login.status, 200);
  const { token } = login.json();
  assert.equal(typeof token, "string");
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  assert.equal((await request("/admin/m2-readiness", { headers })).status, 200);
  const keyResponse = await request("/admin/api-keys", { method: "POST", headers, body: JSON.stringify({ title: "synthetic container boundary", type: "publishable" }) });
  assert.equal(keyResponse.status, 200);
  const publishable = keyResponse.json().api_key.token;
  for (const route of ["/store/carts", "/STORE/carts", "/store/customers", "/auth/customer/emailpass", "/auth/customer/emailpass/register"]) {
    assert.equal((await request(route, { method: "POST", headers: { ...headers, "x-publishable-api-key": publishable }, body: "{}" })).status, 403, route);
  }
  assert.equal((await request("/store/customers/me", { headers: { ...headers, "x-publishable-api-key": publishable } })).status, 401);
  const samples = [];
  const latencies = [];
  for (let batch = 0; batch < 5; batch++) {
    await Promise.all(Array.from({ length: 8 }, async () => {
      const start = Date.now();
      assert.equal((await request("/admin/m2-readiness", { headers })).status, 200);
      latencies.push(Date.now() - start);
    }));
    samples.push(docker(["stats", "--no-stream", "--format", "{{.MemUsage}} | {{.CPUPerc}}", app]));
  }
  docker(["pause", db]);
  try {
    assert.equal((await request("/health")).status, 200, "Liveness must not depend on DB");
    const start = Date.now();
    const failed = await request("/admin/m2-readiness", { headers });
    assert.equal(failed.status, 503);
    assert.ok(Date.now() - start < 8000, "Readiness failure must be bounded");
    assert.equal(failed.json().code, "DEPENDENCY_UNAVAILABLE");
  } finally { docker(["unpause", db]); }
  assert.equal((await request("/admin/m2-readiness", { headers })).status, 200, "Dependency recovery");
  docker(["restart", "--time", "10", app]);
  await health();
  assert.equal((await request("/admin/m2-readiness", { headers })).status, 200, "Admin identity persists after restart");
  latencies.sort((a, b) => a - b);
  await fs.writeFile(path.join(evidence, "results.json"), JSON.stringify({ image, coldStartMs, requests: latencies.length, concurrency: 8,
    p95Ms: latencies[Math.ceil(latencies.length * 0.95) - 1], samples, cpuLimit: 1, memoryLimit: "2g", tls: "trusted/untrusted/wrong-host", result: "PASS_LOCAL_SYNTHETIC_ONLY" }, null, 2));
  console.log(`PASS container migration replay, non-root compiled runtime, Admin boundary, outage/recovery, restart and 1 CPU/2 GiB smoke. Evidence: ${evidence}`);
} finally {
  try {
    // Include transient migration containers if a timed-out Docker client left one running.
    const owned = docker(["ps", "-a", "--filter", `label=vynvori.test=${id}`, "--format", "{{.Names}}"]);
    for (const name of owned.split(/\r?\n/).filter(Boolean)) {
      try {
        assert.equal(docker(["inspect", "--format", '{{index .Config.Labels "vynvori.test"}}', name]), id);
        try { docker(["unpause", name]); } catch { /* may not be paused */ }
        try {
          const logs = docker(["logs", name]);
          await fs.writeFile(path.join(evidence, `${name}.log`), redact(logs));
        } finally { docker(["rm", "-f", "-v", name]); }
      } catch { console.error(`Cleanup could not be verified for owned container ${name}`); process.exitCode = 1; }
    }
  } finally {
    try { await fs.unlink(envFile); } finally { clearInterval(keepAlive); }
  }
  console.log(`Local container evidence: ${evidence}`);
}
