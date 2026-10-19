import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { bridgeRequestProof } from "../src/medusa-proof-core";
import { centralIdentityClient, centralEntityId } from "../src/central-identity";
import { privateMedusaClient, type PrivateMedusaConfig } from "../src/medusa-private";

const keys = { synthetic: new Uint8Array(32).fill(23) };
test("bridge proof binds body, credential, path, project and time; never accepts a stale signature", () => {
  let now = 1800000000000;
  const config = { origin: "https://synthetic.run.app", projectId: "synthetic-project", keyId: "synthetic", keys };
  const proof = bridgeRequestProof(config, () => now), body = { mode: "create", operationId: randomUUID(), originalEmail: "synthetic@example.invalid" };
  const signed = proof.sign("/auth/customer/tcm/provision", body, "synthetic-access");
  assert.equal(proof.verify(signed, "/auth/customer/tcm/provision", body, "synthetic-access"), true);
  assert.equal(proof.verify(signed, "/auth/customer/tcm/provision", { ...body, mode: "reconcile" }, "synthetic-access"), false);
  assert.equal(proof.verify(signed, "/auth/customer/tcm/provision", body, "other-access"), false);
  assert.equal(proof.verify(signed, "/auth/customer/tcm/exchange", body, "synthetic-access"), false);
  assert.equal(bridgeRequestProof({ ...config, projectId: "other-project" }, () => now).verify(signed, "/auth/customer/tcm/provision", body, "synthetic-access"), false);
  now += 31000; assert.equal(proof.verify(signed, "/auth/customer/tcm/provision", body, "synthetic-access"), false);
});
async function fixture(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) {
  const server = createServer((req, res) => { void handler(req, res).catch(() => { res.statusCode = 500; res.end("synthetic test failure"); }); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const config: PrivateMedusaConfig = { enabled: true, deployment: "local", origin: `http://127.0.0.1:${address.port}`, projectId: "synthetic-project", proofKeyId: "synthetic", proofKeys: keys };
  const authority = { issuer: "https://identity.example.invalid", apiBase: "https://identity.example.invalid/mana", clientId: "synthetic-client", clientSecret: "synthetic-private-only", audience: "urn:vynvori:staging", enabled: true };
  const identity = await centralIdentityClient(authority, async url => Response.json(String(url).endsWith("/profile")
    ? { iss: authority.issuer, sub: "synthetic-subject", client_id: authority.clientId, aud: authority.audience, email: "synthetic@example.invalid", email_verified: false }
    : { active: true, iss: authority.issuer, sub: "synthetic-subject", client_id: authority.clientId, aud: authority.audience, exp: Math.floor(Date.now() / 1000) + 300, verified_at: Math.floor(Date.now() / 1000) })).verifyContact("synthetic-access");
  return { config, identity, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
test("actual SDK sends only fixed private transport with service identity/proof and validates result", async () => {
  let calls = 0, operationId = "";
  const f = await fixture(async (req, res) => {
    calls++; assert.equal(req.method, "POST"); assert.equal(req.url, "/auth/customer/tcm/provision");
    assert.equal(req.headers.authorization, "Bearer synthetic-access"); assert.equal(req.headers["x-serverless-authorization"], "Bearer synthetic-service-identity"); assert.equal(req.headers.cookie, undefined);
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()); operationId = body.operationId;
    assert.equal(bridgeRequestProof({ origin: f.config.origin, projectId: f.config.projectId, keyId: "synthetic", keys }).verify(String(req.headers["x-vynvori-bridge"]), "/auth/customer/tcm/provision", body, "synthetic-access"), true);
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ state: "ready", projectId: f.config.projectId, operationId, entityId: centralEntityId(f.identity.issuer, f.identity.subject), authIdentityId: "authid_synthetic", customerId: "cus_synthetic" }));
  });
  try {
    const client = privateMedusaClient(f.config, async audience => { assert.equal(audience, f.config.origin); return "synthetic-service-identity"; });
    const result = await client.ensure({ mode: "create", projectId: f.config.projectId, operationId: randomUUID(), identity: f.identity, originalEmail: f.identity.email, accessToken: "synthetic-access" });
    assert.equal(result.state, "ready"); assert.equal(calls, 1); assert.equal(result.operationId, operationId);
  } finally { await f.close(); }
});
test("SDK upstream failure is sanitized and never retried", async () => {
  let calls = 0;
  const f = await fixture(async (_req, res) => { calls++; res.statusCode = 503; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ message: "private-upstream-detail" })); });
  try {
    const client = privateMedusaClient(f.config, async () => "synthetic-service-identity");
    await assert.rejects(client.ensure({ mode: "create", projectId: f.config.projectId, operationId: randomUUID(), identity: f.identity, originalEmail: f.identity.email, accessToken: "synthetic-access" }), /^CommerceIdentityError: unavailable$/);
    assert.equal(calls, 1);
  } finally { await f.close(); }
});
test("disabled SDK transport and wrong project perform no requests or service-token lookup", async () => {
  let lookups = 0;
  const f = await fixture(async (_req, res) => { res.statusCode = 500; res.end(); });
  try {
    const disabled = privateMedusaClient({ ...f.config, enabled: false }, async () => { lookups++; return "synthetic"; });
    const value = { mode: "create" as const, projectId: f.config.projectId, operationId: randomUUID(), identity: f.identity, originalEmail: f.identity.email, accessToken: "synthetic-access" };
    await assert.rejects(disabled.ensure(value), /disabled/);
    await assert.rejects(privateMedusaClient(f.config, async () => { lookups++; return "synthetic"; }).ensure({ ...value, projectId: "other-project" }), /conflict/);
    assert.equal(lookups, 0);
  } finally { await f.close(); }
});
test("a missing local service credential is distinguished from an uncertain dispatched request", async () => {
  let calls = 0;
  const f = await fixture(async (_req, res) => { calls++; res.statusCode = 500; res.end(); });
  try {
    const client = privateMedusaClient(f.config, async () => { throw new Error("private missing credential"); });
    await assert.rejects(client.ensure({ mode: "create", projectId: f.config.projectId, operationId: randomUUID(), identity: f.identity, originalEmail: f.identity.email, accessToken: "synthetic-access" }), /^CommerceIdentityError: not_started$/);
    assert.equal(calls, 0);
  } finally { await f.close(); }
});
test("private SDK checks customer actor/expiry consistency and strips unexpected owned fields", async () => {
  let role = "customer", wrongProfile = false;
  const f = await fixture(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/exchange")) {
      const expiresAt = Math.floor(f.identity.expiresAt / 1000) * 1000;
      // Private-channel response fixture. This tests consistency, not signature verification.
      const token = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url") + "." + Buffer.from(JSON.stringify({ actor_type: role, actor_id: "cus_sdk", auth_identity_id: "authid_sdk", auth_provider: "tcm", app_metadata: { customer_id: "cus_sdk" }, iss: f.config.origin, aud: "urn:vynvori:medusa:staging", exp: expiresAt / 1000 })).toString("base64url") + ".synthetic-signature";
      res.end(JSON.stringify({ token, expiresAt, customerId: "cus_sdk", authIdentityId: "authid_sdk", projectId: f.config.projectId }));
    } else res.end(JSON.stringify({ kind: "customer", customer: { id: wrongProfile ? "cus_other" : "cus_sdk", email: "synthetic@example.invalid", firstName: null, lastName: null, privateField: "never-forward" }, token: "never-forward-token" }));
  });
  try {
    const client = privateMedusaClient(f.config, async () => "synthetic-service-identity"), mapping = { userId: "synthetic-user", projectId: f.config.projectId, authIdentityId: "authid_sdk", customerId: "cus_sdk" };
    const value = { mapping, identity: f.identity, accessToken: "synthetic-access" };
    const credential = await client.exchange(value); assert.ok(credential.token);
    const profile = await client.owned({ ...value, customerToken: credential.token, request: { action: "read_customer" } });
    assert.deepEqual(profile, { kind: "customer", customer: { id: "cus_sdk", email: "synthetic@example.invalid", firstName: null, lastName: null } });
    role = "user"; await assert.rejects(client.exchange(value), /unavailable/);
    wrongProfile = true; await assert.rejects(client.owned({ ...value, customerToken: credential.token, request: { action: "read_customer" } }), /unavailable/);
  } finally { await f.close(); }
});
