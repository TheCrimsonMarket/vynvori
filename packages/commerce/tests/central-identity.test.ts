import test from "node:test";
import assert from "node:assert/strict";
import { centralIdentityClient, type CentralIdentityConfig } from "../src/central-identity";

const config: CentralIdentityConfig = { enabled: true, issuer: "https://identity.example.invalid", apiBase: "https://identity.example.invalid/mana", clientId: "synthetic-client", clientSecret: "synthetic-test-only", audience: "urn:vynvori:staging" };
const time = 1800000000000;
const identity = { active: true, iss: config.issuer, sub: "synthetic-subject", client_id: config.clientId, aud: config.audience, exp: time / 1000 + 300, verified_at: time / 1000 };
const contact = { ...identity, email: "synthetic@example.invalid", email_verified: false, name: "Synthetic" };
const json = (body: unknown, status = 200) => Response.json(body, { status });

test("disabled adapter performs no requests or configuration discovery", async () => {
  let calls = 0;
  const client = centralIdentityClient({ ...config, enabled: false, apiBase: "" }, async () => { calls++; throw new Error(); });
  await assert.rejects(client.verifyContact("synthetic-token"), /disabled/);
  assert.equal(calls, 0);
});
test("pins transport and current identity; profile is contact only; no authorization cache", async () => {
  const paths: string[] = [];
  const client = centralIdentityClient(config, async (url, init) => {
    paths.push(String(url));
    assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error"); assert.equal(init?.cache, "no-store"); assert.equal(init?.credentials, "omit"); assert.ok(init?.signal);
    const headers = new Headers(init?.headers);
    assert.ok(headers.get("authorization")?.startsWith("Basic ")); assert.equal(headers.get("cookie"), null); assert.equal(headers.get("origin"), null);
    assert.equal(String(init?.body), "token=synthetic-token");
    return json(String(url).endsWith("/profile") ? contact : identity);
  }, () => time);
  const result = await client.verifyContact("synthetic-token");
  assert.equal(result.subject, identity.sub); assert.equal(result.emailVerified, false); assert.ok(Object.isFrozen(result));
  await client.verifyContact("synthetic-token");
  assert.equal(paths.length, 6);
  assert.deepEqual(paths.slice(0, 3).map(p => p.split("/").at(-1)), ["introspect", "profile", "introspect"]);
});
for (const [field, value] of Object.entries({ iss: "https://attacker.invalid", aud: "other", client_id: "other", sub: "", active: false, exp: time / 1000, verified_at: time / 1000 - 31 })) {
  test(`rejects invalid central ${field}`, async () => {
    await assert.rejects(centralIdentityClient(config, async () => json({ ...identity, [field]: value }), () => time).verifyContact("synthetic-token"), /reauth_required/);
  });
}
test("revocation during profile read fails the final state check", async () => {
  let count = 0;
  await assert.rejects(centralIdentityClient(config, async () => json(++count === 1 ? identity : count === 2 ? contact : { active: false }), () => time).verifyContact("synthetic-token"), /reauth_required/);
  assert.equal(count, 3);
});
test("profile for another subject is rejected", async () => {
  await assert.rejects(centralIdentityClient(config, async url => json(String(url).endsWith("/profile") ? { ...contact, sub: "other" } : identity), () => time).verifyContact("synthetic-token"), /reauth_required/);
});
test("transport errors are sanitized and never retried", async () => {
  let count = 0;
  await assert.rejects(centralIdentityClient(config, async () => { count++; throw new Error("private upstream detail"); }).verifyContact("synthetic-token"), /^CentralIdentityError: unavailable$/);
  assert.equal(count, 1);
});
test("oversized upstream response fails closed", async () => {
  await assert.rejects(centralIdentityClient(config, async () => json({ padding: "x".repeat(17000) })).verifyContact("synthetic-token"), /unavailable/);
});
for (const [status, code] of [[401, "reauth_required"], [403, "insufficient_scope"], [409, "contact_required"], [503, "unavailable"]] as const) {
  test(`preserves sanitized profile failure ${status}`, async () => {
    await assert.rejects(centralIdentityClient(config, async url => String(url).endsWith("/profile") ? json({ private: "not exposed" }, status) : json(identity), () => time).verifyContact("synthetic-token"), new RegExp(`^CentralIdentityError: ${code}$`));
  });
}
test("caller configuration mutation cannot change the trusted destination", async () => {
  const mutable = { ...config };
  const client = centralIdentityClient(mutable, async url => {
    assert.ok(String(url).startsWith(config.apiBase + "/oauth/strict/v1/"));
    return json(String(url).endsWith("/profile") ? contact : identity);
  }, () => time);
  mutable.apiBase = "https://attacker.invalid/mana";
  await client.verifyContact("synthetic-token");
});
for (const patch of [{ apiBase: "https://other.invalid/mana" }, { issuer: config.issuer + "/" }, { apiBase: config.apiBase + "?secret=x" }, { clientId: "bad:id" }]) {
  test(`rejects unsafe configuration ${Object.keys(patch)[0]} ${Object.values(patch)[0]}`, () => {
    assert.throws(() => centralIdentityClient({ ...config, ...patch }), /invalid_configuration/);
  });
}
const tokenResponse = { access_token: "synthetic-access", refresh_token: "synthetic-refresh", expires_in: 300, token_type: "Bearer", scope: "profile email" };
test("code exchange pins callback/S256 verifier and correctly form-encodes Basic credentials", async () => {
  const callback = "https://app.example.invalid/auth/tcm/callback";
  const secret = "synthetic+secret:%/=";
  const client = centralIdentityClient({ ...config, callback, clientSecret: secret }, async (url, init) => {
    assert.equal(String(url), config.apiBase + "/oauth/strict/v1/token");
    const headers = new Headers(init?.headers);
    const basic = Buffer.from(headers.get("authorization")!.slice(6), "base64").toString();
    const separator = basic.indexOf(":");
    assert.equal(decodeURIComponent(basic.slice(separator + 1).replace(/\+/g, " ")), secret);
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get("grant_type"), "authorization_code"); assert.equal(body.get("redirect_uri"), callback);
    assert.equal(body.get("code_verifier"), "x".repeat(43)); assert.equal(body.get("client_secret"), null);
    return json(tokenResponse);
  }, () => time);
  assert.equal((await client.exchange("synthetic-code", "x".repeat(43), callback)).expiresAt, time + 300000);
  await assert.rejects(client.exchange("synthetic-code", "x".repeat(43), "https://other.invalid/auth/tcm/callback"), /invalid_configuration/);
});
test("refresh has no automatic retry when the upstream outcome is unknown", async () => {
  let calls = 0;
  const client = centralIdentityClient(config, async () => { calls++; throw new Error("private rotation outcome"); });
  await assert.rejects(client.refresh("synthetic-refresh"), /^CentralIdentityError: outcome_unknown$/);
  assert.equal(calls, 1);
});
for (const patch of [{ expires_in: 301 }, { scope: "profile" }, { token_type: "other" }, { refresh_token: "synthetic-access" }]) {
  test(`invalid token response requires reauthentication without retry ${Object.keys(patch)[0]}`, async () => {
    let calls = 0;
    await assert.rejects(centralIdentityClient(config, async () => { calls++; return json({ ...tokenResponse, ...patch }); }).refresh("synthetic-refresh"), /outcome_unknown/);
    assert.equal(calls, 1);
  });
}
test("revoke uses only fixed server transport and never treats an outage as confirmed", async () => {
  const urls: string[] = [];
  await centralIdentityClient(config, async (url, init) => { urls.push(String(url)); assert.equal(String(init?.body), "token=synthetic-refresh"); return json({}); }).revoke("synthetic-refresh");
  assert.deepEqual(urls, [config.apiBase + "/oauth/strict/v1/revoke"]);
  await assert.rejects(centralIdentityClient(config, async () => json({}, 503)).revoke("synthetic-refresh"), /outcome_unknown/);
});
