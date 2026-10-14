import assert from "node:assert/strict";
import { test } from "node:test";
import { parseServerConfig } from "../src/server";
import { publicConfig } from "../src/public";

test("local and production defaults disable every operational feature", () => {
  for (const env of [{}, { NODE_ENV: "production" }, { NODE_ENV: "test" }]) {
    const config = parseServerConfig(env);
    assert(Object.values(config.features).every(value => value === false));
    assert(Object.isFrozen(config)); assert(Object.isFrozen(config.features));
  }
  assert.equal(parseServerConfig({}).environment, "development");
});
test("every activation attempt and malformed boolean fails closed", () => {
  for (const feature of Object.keys(publicConfig.features)) {
    const key = `VYNVORI_${feature.replaceAll(".", "_").toUpperCase()}`;
    assert.doesNotThrow(() => parseServerConfig({ [key]: "false" }));
    for (const value of ["true", "1", "FALSE", "", "yes"]) {
      assert.throws(() => parseServerConfig({ [key]: value }), /activation is unavailable/);
    }
  }
});
test("invalid environment, misspelled flags and public environment variables are rejected", () => {
  assert.throws(() => parseServerConfig({ NODE_ENV: "live" }), /Invalid NODE_ENV/);
  assert.throws(() => parseServerConfig({ VYNVORI_CHECKOT: "false" }), /Unknown/);
  assert.throws(() => parseServerConfig({ NEXT_PUBLIC_SECRET: "synthetic-sensitive-value" }), /Public environment/);
});
test("documented Vercel public metadata is tolerated but never included in configuration", () => {
  const config = parseServerConfig({ VERCEL:"1", VERCEL_ENV:"preview", NEXT_PUBLIC_VERCEL_URL:"synthetic-preview.vercel.app", NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA:"synthetic-sha", NEXT_PUBLIC_VERCEL_OBSERVABILITY_CLIENT_CONFIG:"synthetic-unused-platform-metadata" });
  assert(!JSON.stringify(config).includes("synthetic-preview"));
  assert(!JSON.stringify(publicConfig).includes("synthetic-sha"));
  assert(!JSON.stringify(config).includes("synthetic-unused-platform-metadata"));
  assert.throws(() => parseServerConfig({ NEXT_PUBLIC_VERCEL_SECRET:"synthetic-sensitive-value" }), /Public environment/);
});
test("public projection and validation errors cannot leak unrelated server values", () => {
  const secret = "synthetic-sensitive-value";
  const config = parseServerConfig({ PRIVATE_TEST_SECRET: secret });
  assert(!JSON.stringify(config).includes(secret));
  assert.deepEqual(Object.keys(publicConfig).sort(), ["features", "release"]);
  assert.throws(() => parseServerConfig({ VYNVORI_PAYMENTS_LIVE: secret }), error =>
    error instanceof Error && !error.message.includes(secret));
});
test("Vercel Preview and Production have separate validated contexts with no operational activation", () => {
  for (const deployment of ["preview", "production", "development"] as const) {
    const config = parseServerConfig({ NODE_ENV: "production", VERCEL: "1", VERCEL_ENV: deployment });
    assert.equal(config.deployment, deployment);
    assert(Object.values(config.features).every(value => value === false));
    assert.throws(() => parseServerConfig({ VERCEL_ENV: deployment, VYNVORI_COMMERCE_CHECKOUT_LIVE: "true" }), /activation is unavailable/);
  }
  assert.throws(() => parseServerConfig({ VERCEL: "1" }), /VERCEL_ENV is required/);
  assert.throws(() => parseServerConfig({ VERCEL_ENV: "staging" }), /Invalid VERCEL_ENV/);
});
