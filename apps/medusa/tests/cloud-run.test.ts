import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { medusaEnvironment } from "../src/config";
import { GET } from "../src/api/admin/m2-readiness/route";
import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
const require = createRequire(import.meta.url);
// Use the real pg consumer installed for Medusa, not a hand-written URL parser.
const { Client } = require("@medusajs/deps/pg");
const { load } = require("js-yaml");
const env = {
  M2_ENV: "staging", M2_MEDUSA_DATABASE_HOST: "ep-synthetic.us-east-1.aws.neon.tech",
  M2_MEDUSA_DATABASE_URL: "postgres://vynvori_medusa_app:synthetic@ep-synthetic.us-east-1.aws.neon.tech/vynvori_medusa_staging?sslmode=verify-full",
  M2_MEDUSA_DATABASE_NAME: "vynvori_medusa_staging",
  M2_MEDUSA_JWT_SECRET: "synthetic-jwt-only-000000000000000000", M2_MEDUSA_COOKIE_SECRET: "synthetic-cookie-only-0000000000000",
  M2_MEDUSA_STORE_CORS: "https://synthetic.example.invalid", M2_MEDUSA_ADMIN_CORS: "https://operator.example.invalid", M2_MEDUSA_AUTH_CORS: "https://operator.example.invalid",
};
test("Medusa pg consumer preserves verified TLS and bounded pool with shared mode", () => {
  const config = medusaEnvironment(env);
  const client = new Client({ connectionString: config.databaseUrl, ...config.databaseDriverOptions.connection });
  assert.deepEqual(client.connectionParameters.ssl, { rejectUnauthorized: true });
  assert.equal(client.connectionParameters.database, "vynvori_medusa_staging");
  assert.equal(client.connectionParameters.user, "vynvori_medusa_app");
  assert.equal(config.workerMode, "shared");
  assert.equal(config.databaseDriverOptions.pool.min, 0);
  assert.equal(config.databaseDriverOptions.pool.max, 5);
  assert.equal(new URL(config.databaseUrl).search, "");
});
test("unverified pooling, TLS downgrade, wrong role/database/host and URL overrides fail closed", () => {
  for (const value of [env.M2_MEDUSA_DATABASE_URL.replace("ep-synthetic.", "ep-synthetic-pooler."),
    env.M2_MEDUSA_DATABASE_URL.replace("verify-full", "require"),
    env.M2_MEDUSA_DATABASE_URL + "&sslcert=untrusted", env.M2_MEDUSA_DATABASE_URL + "&options=untrusted",
    env.M2_MEDUSA_DATABASE_URL.replace("vynvori_medusa_app", "neondb_owner"),
    env.M2_MEDUSA_DATABASE_URL.replace("ep-synthetic.", "ep-other.")]) {
    assert.throws(() => medusaEnvironment({ ...env, M2_MEDUSA_DATABASE_URL: value }));
  }
  assert.throws(() => medusaEnvironment({ ...env, M2_MEDUSA_DATABASE_NAME: "other" }));
});
test("proposed migration owner requires an explicit migration invocation", () => {
  const migrationUrl = env.M2_MEDUSA_DATABASE_URL.replace("vynvori_medusa_app", "vynvori_medusa_migrator");
  assert.throws(() => medusaEnvironment({ ...env, M2_MEDUSA_DATABASE_URL: migrationUrl }));
  const authorized = { ...env, M2_AUTHORIZE_MEDUSA_MIGRATION: "vynvori_medusa_staging" };
  assert.throws(() => medusaEnvironment(authorized));
  assert.ok(medusaEnvironment({ ...authorized, M2_MEDUSA_DATABASE_URL: migrationUrl }));
});
test("protected dependency handler releases request listeners and sanitizes real connection failure", async () => {
    const req = Object.assign(new EventEmitter(), { scope: { resolve: () => ({ projectConfig: {
      databaseUrl: "postgres://synthetic:private-detail@127.0.0.1:9/vynvori_medusa_staging",
      databaseDriverOptions: { connection: { ssl: false } },
    } }) } }) as unknown as MedusaRequest;
    let status = 200;
    const res = Object.assign(new EventEmitter(), { setHeader: () => {}, status: (code: number) => { status = code; return res; }, json: (body: unknown) => {
      assert.ok(!JSON.stringify(body).includes("private"));
      return body;
    } }) as unknown as MedusaResponse;
    await GET(req, res);
    assert.equal(status, 503);
    assert.equal(req.listenerCount("aborted"), 0);
    assert.equal(res.listenerCount("close"), 0);
});
test("deployment template keeps single private service, bounded resources and pinned secret references", () => {
  const service = load(readFileSync(new URL("../../../deploy/medusa/service.yaml", import.meta.url), "utf8"));
  assert.equal(service.kind, "Service");
  assert.equal(service.metadata.annotations["run.googleapis.com/invoker-iam-disabled"], "false");
  assert.equal(service.metadata.annotations["run.googleapis.com/maxScale"], "1");
  const template = service.spec.template;
  assert.equal(template.metadata.annotations["autoscaling.knative.dev/minScale"], "0");
  assert.equal(template.metadata.annotations["autoscaling.knative.dev/maxScale"], "1");
  assert.equal(template.metadata.annotations["run.googleapis.com/cpu-throttling"], "true");
  assert.equal(template.spec.containers.length, 1);
  assert.equal(template.spec.serviceAccountName, "vynvori-medusa-runtime@lucky-little-devil.iam.gserviceaccount.com");
  const container = template.spec.containers[0];
  assert.deepEqual(container.resources.limits, { cpu: "1", memory: "2Gi" });
  assert.equal(container.startupProbe.httpGet.path, "/health");
  assert.equal(container.livenessProbe.httpGet.path, "/health");
  const secrets = container.env.filter((entry: { valueFrom?: unknown }) => entry.valueFrom);
  assert.equal(secrets.length, 3);
  for (const secret of secrets) assert.equal(secret.valueFrom.secretKeyRef.key, "REPLACE_NUMERIC_SECRET_VERSION");
  assert.ok(!container.env.some((entry: { name: string; value?: string }) => /REDIS|MIGRATION/.test(entry.name) || entry.name.startsWith("VYNVORI_") && entry.value !== "false"));
});
