import test from "node:test";
import assert from "node:assert/strict";
import { identitySettings } from "../src/server/identity-settings";
import { createIdentityRuntime } from "../src/server/auth-runtime";
const env = {
  VYNVORI_IDENTITY_CENTRAL_SSO: "true", M1B_DEPLOYMENT: "staging", VERCEL: "1", VERCEL_ENV: "preview", M1B_APP_ORIGIN: "https://staging.vynvori.com",
  M1B_ISOLATED_STAGING_PROJECT_ID: "prj_synthetic_private", VERCEL_PROJECT_ID: "prj_synthetic_private", M1B_CENTRAL_CLIENT_ID: "tcm_" + "a".repeat(32), M1B_CENTRAL_CLIENT_SECRET: "synthetic-private-only-credential-32chars",
  M1B_CURRENT_KEY_ID: "synthetic", M1B_CREDENTIAL_KEYS_JSON: JSON.stringify({ synthetic: Buffer.alloc(32, 29).toString("base64") }),
  M1B_CREATIVE_DATABASE_HOST: "ep-synthetic-pooler.us-east-1.aws.neon.tech", M1B_CREATIVE_DATABASE_URL: "postgresql://vynvori_identity_runtime_scoped:synthetic@ep-synthetic-pooler.us-east-1.aws.neon.tech/vynvori_creative_staging?sslmode=verify-full",
};
test("disabled web runtime requires no identity keys/client/database and performs no initialization", async () => {
  assert.deepEqual(identitySettings({}), { enabled: false });
  const runtime = createIdentityRuntime({}); assert.equal(runtime.enabled, false);
  const response = await runtime.http.session(new Request("https://staging.vynvori.com/api/auth/session"));
  assert.equal(response.status, 503); assert.equal((await response.json()).error.code, "AUTH_DISABLED"); await runtime.close();
});
test("private settings pin the owner-approved identifiers and dedicated creative role", () => {
  const settings = identitySettings(env); assert.equal(settings.enabled, true);
  if (!settings.enabled) throw new Error("Expected synthetic enabled settings");
  assert.equal(settings.issuer, "https://dev.portal.raum.au"); assert.equal(settings.audience, "urn:vynvori:staging");
  assert.equal(settings.callback, "https://staging.vynvori.com/auth/tcm/callback"); assert.equal(settings.keys.synthetic?.length, 32);
});
test("malformed keys, broad database roles and unsafe connection options fail without leaking values", () => {
  for (const patch of [{ NODE_TLS_REJECT_UNAUTHORIZED: "0" }, { M1B_CENTRAL_CLIENT_SECRET: "short-private-marker" }, { M1B_CREDENTIAL_KEYS_JSON: "private-not-json-marker" }, { M1B_CURRENT_KEY_ID: "missing" },
    { M1B_CREATIVE_DATABASE_URL: env.M1B_CREATIVE_DATABASE_URL.replace("vynvori_identity_runtime_scoped", "owner") },
    { M1B_CREATIVE_DATABASE_URL: env.M1B_CREATIVE_DATABASE_URL + "&sslmode=disable" }, { M1B_CREATIVE_DATABASE_HOST: "other.neon.tech" }]) {
    assert.throws(() => identitySettings({ ...env, ...patch }), error => error instanceof Error && error.message === "Invalid private identity configuration");
  }
});
