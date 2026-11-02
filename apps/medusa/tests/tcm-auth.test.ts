import test from "node:test";
import assert from "node:assert/strict";
import { MedusaError } from "@medusajs/framework/utils";
import type { AuthIdentityDTO, AuthIdentityProviderService } from "@medusajs/framework/types";
import TcmAuthProvider, { centralEntityId } from "../src/modules/tcm-auth/service";
import { checkAuthSource } from "../scripts/check-auth-source.mjs";

const config = { enabled: true, issuer: "https://identity.example.invalid", apiBase: "https://identity.example.invalid/mana", clientId: "synthetic-client", clientSecret: "synthetic-secret", audience: "urn:vynvori:staging" };
function fixture(options: { lostCreate?: boolean; subject?: string; staff?: boolean; metadataConflict?: boolean; offline?: boolean } = {}) {
  const rows = new Map<string, AuthIdentityDTO>(); let creates = 0, requests = 0;
  const service: AuthIdentityProviderService = {
    async retrieve({ entity_id }) {
      const auth = rows.get(entity_id);
      if (!auth) throw new MedusaError(MedusaError.Types.NOT_FOUND, "synthetic missing identity");
      return auth;
    },
    async create(input) {
      if (rows.has(input.entity_id)) throw new MedusaError(MedusaError.Types.DUPLICATE_ERROR, "synthetic native unique conflict");
      creates++;
      const auth: AuthIdentityDTO = { id: "auth_synthetic", app_metadata: options.staff ? { user_id: "user_synthetic" } : {}, provider_identities: [{ id: "provider_synthetic", provider: "tcm", entity_id: input.entity_id,
        provider_metadata: options.metadataConflict ? { issuer: config.issuer, subject: "other" } : input.provider_metadata }] };
      rows.set(input.entity_id, auth);
      if (options.lostCreate) throw new Error("synthetic lost insert acknowledgement");
      return auth;
    },
    async update() { throw new Error("Unexpected identity update"); },
    async setState() { throw new Error("Unexpected state write"); }, async getState() { return null; },
  };
  const transport: typeof fetch = async (url, init) => {
    requests++;
    if (options.offline) throw new Error("private upstream details");
    assert.equal(String(url), config.apiBase + "/oauth/strict/v1/introspect");
    assert.equal(String(init?.body), "token=synthetic-access");
    return Response.json({ active: true, iss: config.issuer, sub: options.subject ?? "synthetic-subject", client_id: config.clientId, aud: config.audience, exp: Math.floor(Date.now() / 1000) + 300, verified_at: Math.floor(Date.now() / 1000) });
  };
  return { rows, service, transport, provider: new TcmAuthProvider({}, config, transport), counts: () => ({ creates, requests }) };
}
const input = () => ({ headers: { authorization: "Bearer synthetic-access" } });
test("standalone backend protocol is identical to the canonical web core", async () => { await checkAuthSource(); });
test("provider creates one issuer+subject identity without email or staff inference", async () => {
  const f = fixture(); const result = await f.provider.authenticate(input(), f.service);
  assert.equal(result.success, true); assert.equal(result.authIdentity?.id, "auth_synthetic");
  assert.deepEqual(result.authIdentity?.provider_identities?.[0]?.provider_metadata, { issuer: config.issuer, subject: "synthetic-subject" });
  assert.equal((await f.provider.authenticate(input(), f.service)).authIdentity?.id, result.authIdentity?.id);
  assert.equal(f.counts().creates, 1); assert.equal(f.counts().requests, 4);
});
test("raced logins and lost identity-create responses reconcile without a second create", async () => {
  const f = fixture({ lostCreate: true });
  const results = await Promise.all(Array.from({ length: 12 }, () => f.provider.authenticate(input(), f.service)));
  assert.ok(results.every(result => result.success)); assert.equal(f.rows.size, 1); assert.equal(f.counts().creates, 1);
});
test("identity metadata conflict and a staff-linked identity fail closed", async () => {
  for (const options of [{ staff: true }, { metadataConflict: true }]) {
    const f = fixture(options); const result = await f.provider.authenticate(input(), f.service);
    assert.equal(result.success, false); assert.equal(result.error, "Authentication failed");
  }
});
test("caller email/roles/customer IDs, browser cookies and duplicate credential headers are rejected", async () => {
  const f = fixture();
  for (const data of [{ ...input(), body: { email: "synthetic@example.invalid" } }, { ...input(), body: { customer_id: "cus_other" } },
    { headers: { ...input().headers, cookie: "synthetic" } }, { headers: { ...input().headers, Origin: "https://app.example.invalid" } },
    { headers: { ...input().headers, Authorization: "Bearer other" } }]) assert.equal((await f.provider.authenticate(data, f.service)).success, false);
  assert.deepEqual(f.counts(), { creates: 0, requests: 0 });
});
test("provider disabled mode makes no authority or identity request", async () => {
  const f = fixture(); const provider = new TcmAuthProvider({}, { ...config, enabled: false }, f.transport);
  assert.deepEqual(await provider.authenticate(input(), f.service), { success: false, error: "Authentication disabled" });
  assert.deepEqual(f.counts(), { creates: 0, requests: 0 });
});
test("upstream outage is sanitized and cannot create a local identity", async () => {
  const f = fixture({ offline: true });
  assert.deepEqual(await f.provider.authenticate(input(), f.service), { success: false, error: "Authentication unavailable" });
  assert.equal(f.counts().creates, 0);
});
test("bounded entity IDs distinguish issuer/subject partitions", () => {
  assert.match(centralEntityId(config.issuer, "subject"), /^vynvori:v1:[a-f0-9]{64}$/);
  assert.notEqual(centralEntityId("https://a.invalid", "b:c"), centralEntityId("https://a.invalid/b", "c"));
  assert.notEqual(centralEntityId(config.issuer, "subject"), centralEntityId("https://other.invalid", "subject"));
});
