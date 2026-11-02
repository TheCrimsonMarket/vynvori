import test from "node:test";
import assert from "node:assert/strict";
import { privateMedusaSettings } from "../src/server/medusa-settings";
const origin = "https://synthetic-medusa.run.app", context = { enabled: true as const, deployment: "staging" as const };
function token(aud = origin, exp = Math.floor(Date.now() / 1000) + 300) {
  // Metadata-filter fixture only; no Google signature is asserted by this application.
  return Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url") + "." + Buffer.from(JSON.stringify({ aud, exp })).toString("base64url") + ".synthetic-signature";
}
const env = { M1B_MEDUSA_TRANSPORT_ENABLED: "true", M1B_MEDUSA_ORIGIN: origin, M1B_MEDUSA_PROJECT_ID: "synthetic-project", M1B_BRIDGE_PROOF_KEY_ID: "synthetic",
  M1B_BRIDGE_PROOF_KEYS_JSON: JSON.stringify({ synthetic: Buffer.alloc(32, 31).toString("base64") }), M1B_MEDUSA_SERVICE_ID_TOKEN: token() };
test("private Medusa transport is absent by default and pins an isolated service origin", async () => {
  assert.equal(privateMedusaSettings({}, context), null);
  const result = privateMedusaSettings(env, context); assert.ok(result);
  assert.equal(result.config.origin, origin); assert.equal(await result.serviceIdentity(origin), env.M1B_MEDUSA_SERVICE_ID_TOKEN);
  await assert.rejects(result.serviceIdentity("https://other.run.app"), /Private service identity unavailable/);
});
test("private service credential filtering rejects stale, wrong-audience and malformed input", async () => {
  for (const value of ["private-not-a-jwt", token("https://other.run.app"), token(origin, Math.floor(Date.now() / 1000))]) {
    const result = privateMedusaSettings({ ...env, M1B_MEDUSA_SERVICE_ID_TOKEN: value }, context); assert.ok(result);
    await assert.rejects(result.serviceIdentity(origin), /^Error: Private service identity unavailable$/);
  }
});
test("unsafe origin or malformed proof keys fail before any transport is constructed", () => {
  for (const patch of [{ M1B_MEDUSA_ORIGIN: "http://synthetic-medusa.run.app" }, { M1B_MEDUSA_ORIGIN: origin + "/path" }, { M1B_MEDUSA_ORIGIN: "https://public.example.invalid" }, { M1B_BRIDGE_PROOF_KEYS_JSON: "private-marker" }]) {
    assert.throws(() => privateMedusaSettings({ ...env, ...patch }, context), /^Error: Invalid private Medusa transport configuration$/);
  }
});
