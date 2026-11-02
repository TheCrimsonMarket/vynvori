import test from "node:test";
import assert from "node:assert/strict";
import { bridgeSettings } from "../src/auth/bridge-settings";
const env = { M1B_MEDUSA_BRIDGE_ENABLED: "true", M2_ENV: "staging", M1B_MEDUSA_ORIGIN: "https://synthetic.run.app", M1B_MEDUSA_PROJECT_ID: "synthetic-project",
  M1B_CENTRAL_CLIENT_ID: "tcm_" + "a".repeat(32), M1B_CENTRAL_CLIENT_SECRET: "synthetic-private-only-service-secret-32chars", M1B_BRIDGE_PROOF_KEY_ID: "synthetic",
  M1B_BRIDGE_PROOF_KEYS_JSON: JSON.stringify({ synthetic: Buffer.alloc(32, 31).toString("base64") }) };
test("backend private bridge stays absent unless explicitly enrolled in isolated staging/local context", () => {
  assert.deepEqual(bridgeSettings({}), { enabled: false });
  assert.equal(bridgeSettings(env).enabled, true);
  assert.equal(bridgeSettings({ ...env, M2_ENV: "local", M1B_MEDUSA_ORIGIN: "http://127.0.0.1:9000" }).enabled, true);
  for (const patch of [{ NODE_TLS_REJECT_UNAUTHORIZED: "0" }, { M2_ENV: "production" }, { M2_ENV: "local" }, { M1B_MEDUSA_ORIGIN: "https://public.invalid" }, { M1B_MEDUSA_BRIDGE_ENABLED: "TRUE" }, { M1B_BRIDGE_PROOF_KEYS_JSON: "private-malformed" }]) {
    assert.throws(() => bridgeSettings({ ...env, ...patch }), /^Error: Invalid private Medusa bridge configuration$/);
  }
});
