import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readiness, databaseUrl, scope, serviceOrigin } from "../src/infrastructure";
test("operator CLI runs without dependencies and returns nonzero unconfigured diagnostics", () => {
  const script = fileURLToPath(new URL("../../../scripts/staging-smoke.ts", import.meta.url));
  const result = spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", script], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, M2_ENV: "local" }, encoding: "utf8" });
  assert.equal(result.status, 1);
  const checks = JSON.parse(result.stdout);
  assert.equal(checks.length, 4);
  assert.ok(checks.every((check: { status: string }) => check.status === "unconfigured"));
  assert.equal(result.stderr, "");
});
test("diagnostics redact upstream credentials and distinguish unconfigured", async () => {
  assert.equal((await readiness("storage", undefined)).status, "unconfigured");
  assert.deepEqual(await readiness("database", async () => { throw new Error("postgres://private:secret@internal"); }), { version: 1, service: "database", status: "unavailable", code: "DEPENDENCY_UNAVAILABLE" });
  assert.equal((await readiness("medusa", async () => {})).code, "OK");
});
test("environment, origin and database isolation fail closed", () => {
  for (const env of [{}, { M2_ENV: "production" }, { M2_ENV: "staging", VERCEL_ENV: "production" }, { M2_ENV: "local", NEXT_PUBLIC_M2_TOKEN: "secret" }, { M2_ENV: "local", VYNVORI_PAYMENTS_LIVE: "true" }]) assert.throws(() => scope(env));
  for (const origin of ["http://example.com", "https://localhost", "https://user:pass@valid.example", "https://valid.example/path", "https://valid.example?token=x"]) assert.throws(() => serviceOrigin(origin, "staging"));
  const local = { M2_ENV: "local", M2_CREATIVE_DATABASE_URL: "postgres://synthetic:synthetic@127.0.0.1/vynvori_creative_staging" };
  assert.equal(databaseUrl(local, "CREATIVE").pathname, "/vynvori_creative_staging");
  for (const url of ["postgres://u:p@127.0.0.1/medusa", "postgres://u:p@external/vynvori_creative_staging", "https://u:p@127.0.0.1/vynvori_creative_staging"]) assert.throws(() => databaseUrl({ ...local, M2_CREATIVE_DATABASE_URL: url }, "CREATIVE"));
  assert.throws(() => databaseUrl({ ...local, M2_MEDUSA_DATABASE_URL: local.M2_CREATIVE_DATABASE_URL }, "CREATIVE"));
  const staging = { M2_ENV: "staging", M2_CREATIVE_DATABASE_HOST: "ep-synthetic-pooler.us-east-1.aws.neon.tech", M2_CREATIVE_DATABASE_URL: "postgres://u:p@ep-synthetic-pooler.us-east-1.aws.neon.tech/vynvori_creative_staging?sslmode=verify-full" };
  assert.doesNotThrow(() => databaseUrl(staging, "CREATIVE"));
  assert.throws(() => databaseUrl({ ...staging, M2_CREATIVE_DATABASE_HOST: "another.neon.tech" }, "CREATIVE"));
});
