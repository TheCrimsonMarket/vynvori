import test from "node:test";
import assert from "node:assert/strict";
import { authSecretHash, credentialVault, opaqueAuthSecret, type CredentialBinding } from "../src/auth-vault";
const context: CredentialBinding = { deployment: "staging", issuer: "https://identity.example.invalid", clientId: "synthetic", ownerId: "synthetic-session", generation: 0, purpose: "session-credentials" };
const key = () => new Uint8Array(32).fill(7);
test("AES-GCM uses random IVs, authenticated context, key version and encrypted payload", () => {
  const vault = credentialVault("test-key", { "test-key": key() });
  const first = vault.seal("synthetic-private-credential", context), second = vault.seal("synthetic-private-credential", context);
  assert.notEqual(first, second); assert.ok(!first.includes("synthetic-private-credential"));
  assert.equal(vault.open(first, context), "synthetic-private-credential");
  for (const changed of [{ ownerId: "other" }, { deployment: "other" }, { issuer: "https://other.invalid" }, { clientId: "other" }, { generation: 1 }, { purpose: "login-verifier" as const }]) {
    assert.throws(() => vault.open(first, { ...context, ...changed }), /Credential unavailable/);
  }
  assert.throws(() => vault.open(first.slice(0, -3) + "xxx", context), /Credential unavailable/);
});
test("vault copies keys; old key remains readable during explicit key rotation", () => {
  const bytes = key(); const old = credentialVault("old", { old: bytes });
  const sealed = old.seal("synthetic", context); bytes.fill(0);
  assert.equal(old.open(sealed, context), "synthetic");
  const rotated = credentialVault("new", { old: key(), new: new Uint8Array(32).fill(8) });
  assert.equal(rotated.open(sealed, context), "synthetic");
  assert.ok(rotated.seal("synthetic", context).startsWith("v1.new."));
  assert.throws(() => credentialVault("new", { new: key() }).open(sealed, context), /Credential unavailable/);
});
test("opaque secrets have256bits and hash without storing raw browser credentials", () => {
  const first = opaqueAuthSecret(), second = opaqueAuthSecret();
  assert.match(first, /^[A-Za-z0-9_-]{43}$/); assert.notEqual(first, second);
  assert.match(authSecretHash(first), /^[a-f0-9]{64}$/);
  assert.throws(() => authSecretHash("short"));
});
test("malformed envelopes and invalid keys fail safely", () => {
  assert.throws(() => credentialVault("unknown", { valid: key() }));
  assert.throws(() => credentialVault("valid", { valid: new Uint8Array(8) }));
  const vault = credentialVault("valid", { valid: key() });
  for (const input of ["", "v2.valid.a.b.c", "v1.valid.a.b.c", "x".repeat(25000)]) assert.throws(() => vault.open(input, context), /Credential unavailable/);
});
