import test from "node:test";
import assert from "node:assert/strict";
import { credentialVault } from "../src/auth-vault";
import { revocationReconciler, type RevocationStore } from "../src/revocation-reconciliation";

const config = { enabled: true, issuer: "https://identity.example.invalid", clientId: "synthetic-client", deployment: "staging" };
const vault = credentialVault("synthetic", { synthetic: new Uint8Array(32).fill(7) });
function fixture(options: { fail?: boolean; settle?: boolean; attempt?: number; corrupt?: boolean; status?: "active" | "revoked" } = {}) {
  let claims = 0, revokes = 0;
  const settlements: unknown[][] = [];
  const cipher = vault.seal(JSON.stringify({ issuer: config.issuer, subject: "synthetic-subject", refreshToken: "synthetic-refresh-token" }),
    { ...config, ownerId: options.corrupt ? "other-owner" : "synthetic-id", generation: 2, purpose: "session-credentials" });
  const store: RevocationStore = {
    async claimCentralRevocation(cohort) {
      assert.deepEqual(cohort, { issuer: config.issuer, clientId: config.clientId, deployment: config.deployment });
      claims++; return claims > 1 ? null : { id: "synthetic-id", issuer: config.issuer, subject: "synthetic-subject", generation: 2, status: options.status ?? "revoked", credentialsCipher: cipher, lease: "synthetic-lease", attempts: options.attempt ?? 1 };
    },
    async settleCentralRevocation(...args) { settlements.push(args); return options.settle ?? true; },
  };
  const authority = { async revoke(token: string) { assert.equal(token, "synthetic-refresh-token"); revokes++; if (options.fail) throw new Error("synthetic-private-error"); } };
  return { store, authority, settlements, counts: () => ({ claims, revokes }), service: revocationReconciler(config, store, authority, vault) };
}
test("disabled reconciliation performs no claims or authority requests", async () => {
  const f = fixture(); assert.deepEqual(await revocationReconciler({ ...config, enabled: false }, f.store, f.authority, vault).run(), { attempted: 0, confirmed: 0, pending: 0, manualReview: 0 });
  assert.deepEqual(f.counts(), { claims: 0, revokes: 0 });
});
test("reconciliation accepts only a bounded explicit batch", async () => {
  const f = fixture(); for (const limit of [0, -1, 6, Infinity, 1.5]) await assert.rejects(f.service.run(limit), /unavailable/);
  assert.deepEqual(f.counts(), { claims: 0, revokes: 0 });
});
test("definite authority success and lease acknowledgement confirm, exposing only counts", async () => {
  const f = fixture(); assert.deepEqual(await f.service.run(), { attempted: 1, confirmed: 1, pending: 0, manualReview: 0 });
  assert.deepEqual(f.settlements, [["synthetic-id", "synthetic-lease", true, 60000]]);
});
test("uncertain revoke remains pending with exponential backoff and no refresh", async () => {
  const f = fixture({ fail: true, attempt: 4 }); assert.deepEqual(await f.service.run(), { attempted: 1, confirmed: 0, pending: 1, manualReview: 0 });
  assert.deepEqual(f.settlements, [["synthetic-id", "synthetic-lease", false, 480000]]); assert.equal(f.counts().revokes, 1);
});
test("copied ciphertext or a live-session claim cannot trigger central revocation", async () => {
  for (const options of [{ corrupt: true }, { status: "active" as const }]) {
    const f = fixture(options); assert.equal((await f.service.run()).pending, 1); assert.equal(f.counts().revokes, 0);
  }
});
test("lost local acknowledgement stops the batch, retaining uncertainty", async () => {
  const f = fixture({ settle: false }); assert.deepEqual(await f.service.run(), { attempted: 1, confirmed: 0, pending: 1, manualReview: 0 });
  assert.deepEqual(f.counts(), { claims: 1, revokes: 1 });
});
test("eighth unsuccessful attempt reports manual review with one-hour maximum delay", async () => {
  const f = fixture({ fail: true, attempt: 8 }); assert.equal((await f.service.run()).manualReview, 1);
  assert.deepEqual(f.settlements, [["synthetic-id", "synthetic-lease", false, 3600000]]);
});
