import test from "node:test";
import assert from "node:assert/strict";
import { medusaEnvironment } from "../src/config";
const env = {
  M2_ENV: "local", M2_MEDUSA_DATABASE_URL: "postgres://synthetic:synthetic@127.0.0.1/vynvori_medusa_staging", M2_MEDUSA_DATABASE_NAME: "vynvori_medusa_staging",
  M2_MEDUSA_JWT_SECRET: "synthetic-jwt-only-000000000000000000", M2_MEDUSA_COOKIE_SECRET: "synthetic-cookie-only-0000000000000",
  M2_MEDUSA_STORE_CORS: "http://localhost:3000", M2_MEDUSA_ADMIN_CORS: "http://localhost:9000", M2_MEDUSA_AUTH_CORS: "http://localhost:9000",
};
test("Medusa configuration isolates commerce and disables customer providers", () => {
  const config = medusaEnvironment(env);
  assert.deepEqual(config.http.authMethodsPerActor, { user: ["emailpass"], customer: [] });
  for (const overrides of [{ NODE_TLS_REJECT_UNAUTHORIZED: "0" }, { M2_MEDUSA_JWT_SECRET: "short" }, { M2_MEDUSA_STORE_CORS: "*" }, { M2_MEDUSA_STORE_CORS: "http://localhost:3000/path" }, { M2_ENV: "production" }, { M2_MEDUSA_DATABASE_NAME: "vynvori_creative_staging" }, { M2_CREATIVE_DATABASE_URL: env.M2_MEDUSA_DATABASE_URL }]) assert.throws(() => medusaEnvironment({ ...env, ...overrides }));
});

test("the resolved Medusa config keeps the default Medusa Cloud plugin out and the admin disabled (ADR-0024)", async () => {
  const saved = { ...process.env };
  try {
    for (const key of Object.keys(process.env)) if (key.startsWith("M1B_") || key.startsWith("M2_")) delete process.env[key];
    Object.assign(process.env, env);
    const loaded = await import("../medusa-config");
    const config = (loaded.default ?? loaded) as { plugins?: Array<string | { resolve: string }>; admin?: { disable?: boolean } };
    const names = (config.plugins ?? []).map(plugin => typeof plugin === "string" ? plugin : plugin.resolve);
    assert.ok(!names.includes("@medusajs/cloud"), names.join(","));
    assert.ok(names.includes("@medusajs/draft-order"), "other default plugins still resolve");
    assert.equal(config.admin?.disable, true);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});
