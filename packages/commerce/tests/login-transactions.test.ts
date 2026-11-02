import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { loginTransactions, type LoginTransactionStore } from "../src/login-transactions";
import { credentialVault } from "../src/auth-vault";
const config = { enabled: true, deployment: "staging", issuer: "https://identity.example.invalid", appOrigin: "https://app.example.invalid", clientId: "synthetic-client" };
function fixture() {
  type Record = Parameters<LoginTransactionStore["createLogin"]>[0];
  const rows = new Map<string, Record>();
  const store: LoginTransactionStore = {
    async createLogin(record) { rows.set(record.id, record); },
    async consumeLogin(id, state, browser) { const row = rows.get(id); if (!row || row.stateHash !== state || row.browserHash !== browser) return null; rows.delete(id); return row; },
  };
  const vault = credentialVault("synthetic", { synthetic: new Uint8Array(32).fill(9) });
  return { rows, store, client: loginTransactions(config, store, vault), vault };
}
test("begin stores hashed state/browser binding and encrypted verifier; URL pins S256/contact scopes", async () => {
  const f = fixture(); const started = await f.client.begin("/studio"); const url = new URL(started.authorizeUrl);
  assert.equal(url.origin, config.issuer); assert.equal(url.pathname, "/oauth/authorize");
  assert.equal(url.searchParams.get("scope"), "profile email"); assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("redirect_uri"), config.appOrigin + "/auth/tcm/callback");
  const row = f.rows.get(started.transactionId)!;
  assert.notEqual(row.browserHash, started.browserBinding); assert.notEqual(row.stateHash, url.searchParams.get("state"));
  const consumed = await f.client.consume(url.searchParams.get("state")!, started.browserBinding);
  assert.equal(createHash("sha256").update(consumed.verifier).digest("base64url"), url.searchParams.get("code_challenge"));
  assert.equal(consumed.returnPath, "/studio");
});
test("parallel callbacks have one winner; replay is rejected", async () => {
  const f = fixture(); const started = await f.client.begin("/account"); const state = new URL(started.authorizeUrl).searchParams.get("state")!;
  const results = await Promise.allSettled([f.client.consume(state, started.browserBinding), f.client.consume(state, started.browserBinding)]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  await assert.rejects(f.client.consume(state, started.browserBinding), /Invalid login transaction/);
});
test("wrong browser cannot consume login and unsafe return URLs fail before persistence", async () => {
  const f = fixture(); const started = await f.client.begin("/account"); const state = new URL(started.authorizeUrl).searchParams.get("state")!;
  await assert.rejects(f.client.consume(state, "x".repeat(43)), /Invalid login transaction/);
  await f.client.consume(state, started.browserBinding);
  for (const path of ["//evil.invalid", "https://evil.invalid", "/account/../evil", "/\\evil", "/account?next=https://evil.invalid"]) await assert.rejects(f.client.begin(path), /Invalid login return path/);
  assert.equal(f.rows.size, 0);
});
test("disabled login is inert", async () => {
  const f = fixture(); const client = loginTransactions({ ...config, enabled: false }, f.store, f.vault);
  await assert.rejects(client.begin("/account"), /Login disabled/); assert.equal(f.rows.size, 0);
});
