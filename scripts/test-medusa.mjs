import { startProcess, stopProcess, waitProcess } from "./process-lifecycle.mjs";
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const cwd = fileURLToPath(new URL("../apps/medusa", import.meta.url));
const cli = fileURLToPath(new URL("../node_modules/@medusajs/cli/cli.js", import.meta.url));
const env = {
  ...process.env, NODE_ENV: "test", MEDUSA_DISABLE_TELEMETRY: "true", M2_ENV: "local", PORT: "19000",
  M2_MEDUSA_DATABASE_URL: process.env.M2_MEDUSA_DATABASE_URL,
  M2_MEDUSA_DATABASE_NAME: "vynvori_medusa_staging",
  M2_MEDUSA_JWT_SECRET: randomBytes(32).toString("hex"), M2_MEDUSA_COOKIE_SECRET: randomBytes(32).toString("hex"),
  M2_MEDUSA_STORE_CORS: "http://localhost:3000", M2_MEDUSA_ADMIN_CORS: "http://localhost:19000", M2_MEDUSA_AUTH_CORS: "http://localhost:19000",
};
const evidence = await fs.mkdtemp(path.join(os.tmpdir(), "VYNVORI-M2-medusa-"));
let log = "";
function capture(child) {
  child.stdout.on("data", bytes => { log += bytes; });
  child.stderr.on("data", bytes => { log += bytes; });
}
if (!env.M2_MEDUSA_DATABASE_URL) throw new Error("Local Medusa database required");
async function command(args) {
  const processHandle = startProcess(process.execPath, [cli, ...args], { cwd, env });
  capture(processHandle.child);
  try { await waitProcess(processHandle, 120000, `Medusa ${args[0]}`); }
  finally {
    await stopProcess(processHandle);
    await fs.writeFile(path.join(evidence, "runtime.log"), log);
  }
}
await command(["db:migrate"]);
const email = `synthetic-${randomUUID()}@example.invalid`;
const password = randomBytes(32).toString("hex");
await command(["user", "--email", email, "--password", password]);
const serverHandle = startProcess(process.execPath, [cli, "start", "--port", "19000"], { cwd: path.join(cwd, ".medusa/server"), env: { ...env, NODE_ENV: "production" } });
const server = serverHandle.child;
capture(server);
// Drain every response and close HTTP connections before requesting server shutdown.
async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(5000), redirect: "error", headers: { ...options.headers, connection: "close" } });
  const text = await response.text();
  return { status: response.status, json: async () => JSON.parse(text) };
}
let failure;
try {
  let ready = false;
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline && !serverHandle.closed) {
    try { ready = (await request("http://127.0.0.1:19000/health")).status === 200; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.ok(ready, "Medusa must boot against isolated PostgreSQL");
  const login = await request("http://127.0.0.1:19000/auth/user/emailpass", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  assert.equal(typeof token, "string");
  const keyResponse = await request("http://127.0.0.1:19000/admin/api-keys", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ title: "M2 synthetic boundary fixture", type: "publishable" }) });
  assert.equal(keyResponse.status, 200);
  const { api_key: apiKey } = await keyResponse.json();
  assert.equal(typeof apiKey.token, "string");
  const dependencyReady = await request("http://127.0.0.1:19000/admin/m2-readiness", { headers: { authorization: `Bearer ${token}` } });
  assert.equal(dependencyReady.status, 200);
  assert.equal((await dependencyReady.json()).status, "ready");
  for (const [path, method, expected] of [
    ["/admin/users/me", "GET", 401], ["/admin/m2-readiness", "GET", 401], ["/store/customers/me", "GET", 401],
    ["/auth/customer/emailpass/register", "POST", 403], ["/auth/customer/emailpass", "POST", 403],
    ["/store/customers", "POST", 403], ["/store/carts", "POST", 403], ["/STORE/carts", "POST", 403],
  ]) {
    const response = await request(`http://127.0.0.1:19000${path}`, { method, headers: { "content-type": "application/json", "x-publishable-api-key": apiKey.token }, ...(method === "POST" ? { body: "{}" } : {}) });
    assert.equal(response.status, expected, `${method} ${path}`);
    console.log(`PASS actual Medusa boundary ${method} ${path}: ${expected}`);
  }
  const wrongActor = await request("http://127.0.0.1:19000/store/customers/me", { headers: { "x-publishable-api-key": apiKey.token, authorization: `Bearer ${token}` } });
  assert.equal(wrongActor.status, 401, "Admin bearer cannot impersonate customer");
  console.log("PASS actual Medusa synthetic Admin login/key and wrong-actor rejection; no customer provisioned");
} catch (error) { failure = error; }
finally {
  try {
    await stopProcess(serverHandle);
    await assert.rejects(request("http://127.0.0.1:19000/health"), "Medusa port must be closed after cleanup");
  } catch (error) {
    failure = failure ? new AggregateError([failure, error], "Medusa assertions and cleanup failed") : error;
  }
  await fs.writeFile(path.join(evidence, "runtime.log"), log);
  console.log(`Medusa local evidence: ${evidence}`);
}
if (failure) throw failure;
