import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { identityStateStore } from "../src/auth-state";
import { authSessionService } from "../../commerce/src/auth-sessions";
import { credentialVault, opaqueAuthSecret, authSecretHash } from "../../commerce/src/auth-vault";
import { centralIdentityClient } from "../../commerce/src/central-identity";
import { loginTransactions } from "../../commerce/src/login-transactions";
import { commerceMappingStore } from "../src/commerce-mappings";
import { commerceIdentityCoordinator, CommerceIdentityError, type NativeCustomerProvisioner } from "../../commerce/src/commerce-identity";
import { centralEntityId } from "../../commerce/src/central-identity";
import { authHttpHandlers, authCookies } from "../../commerce/src/auth-http";
import type { PrivateCustomerTransport } from "../../commerce/src/customer-access";
import { revocationReconciler, type RevocationStore } from "../../commerce/src/revocation-reconciliation";

const connection = process.env.M1B_TEST_POSTGRES_URL;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
test("durable identity state in disposable loopback PostgreSQL", { skip: !connection }, async t => {
  const url = new URL(connection!);
  assert.equal(url.protocol, "postgresql:"); assert.equal(url.hostname, "127.0.0.1"); assert.equal(url.pathname, "/vynvori_m1b_test");
  const pool = new Pool({ connectionString: url.toString(), max: 6, connectionTimeoutMillis: 2000, statement_timeout: 5000 });
  let time = Date.now();
  const store = identityStateStore(pool, () => time);
  const issuer = "https://identity.example.invalid";
  async function session(subject: string) {
    const userId = await store.ensureProfile(issuer, subject), id = randomUUID(), tokenHash = hash(randomUUID());
    await store.createSession({ id, tokenHash, userId, credentialsCipher: "synthetic-encrypted-fixture", familyExpiresAt: time + 28800000, clientId: "synthetic-manual-client", deployment: "staging" });
    return { id, tokenHash, userId };
  }
  function composed(override: Partial<ReturnType<typeof identityStateStore>> = {}, native?: NativeCustomerProvisioner, customer?: PrivateCustomerTransport) {
    const clientId = `synthetic-composed-${randomUUID()}`, subject = `synthetic-composed-${randomUUID()}`;
    const callback = "https://app.example.invalid/auth/tcm/callback";
    const config = { enabled: true, deployment: "staging", issuer, clientId, audience: "urn:vynvori:staging", appOrigin: "https://app.example.invalid" };
    const vault = credentialVault("synthetic", { synthetic: new Uint8Array(32).fill(17) });
    let access = "synthetic-access-0", refresh = "synthetic-refresh-0", revision = 0, expiration = Math.floor(time / 1000) + 300;
    const control = { exchangeCalls: 0, refreshCalls: 0, revokeCalls: 0, identityReads: 0, revoked: false, failRefresh: false, failRevoke: false, missingContact: false, contactEmail: "synthetic@example.invalid", onRefresh: async () => {} };
    const transport: typeof fetch = async (url, init) => {
      const operation = String(url).split("/").at(-1);
      if (operation === "introspect") control.identityReads++;
      const form = new URLSearchParams(String(init?.body));
      if (operation === "token") {
        if (form.get("grant_type") === "authorization_code") control.exchangeCalls++;
        if (form.get("grant_type") === "refresh_token") {
          control.refreshCalls++; await control.onRefresh();
          if (control.failRefresh) throw new Error("synthetic-lost-response");
          if (control.revoked || form.get("refresh_token") !== refresh) return Response.json({ error: "invalid_grant" }, { status: 400 });
          revision++; access = `synthetic-access-${revision}`; refresh = `synthetic-refresh-${revision}`;
        }
        expiration = Math.floor(time / 1000) + 300;
        return Response.json({ access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 300, scope: "profile email" });
      }
      if (operation === "revoke") {
        control.revokeCalls++;
        if (control.failRevoke) throw new Error("synthetic-revoke-outage");
        control.revoked = true; return Response.json({});
      }
      if (control.revoked || form.get("token") !== access) return operation === "introspect" ? Response.json({ active: false }) : Response.json({}, { status: 401 });
      if (operation === "profile" && control.missingContact) return Response.json({ error: "contact_required" }, { status: 409 });
      const bound = { iss: issuer, sub: subject, client_id: clientId, aud: "urn:vynvori:staging" };
      return Response.json(operation === "profile" ? { ...bound, email: control.contactEmail, email_verified: false } : { ...bound, active: true, exp: expiration, verified_at: Math.floor(time / 1000) });
    };
    const authority = centralIdentityClient({ ...config, apiBase: issuer + "/mana", clientSecret: "synthetic-private-only", audience: "urn:vynvori:staging", callback }, transport, () => time);
    const transactions = loginTransactions(config, store, vault, () => time);
    const commerce = native ? commerceIdentityCoordinator({ ...config, projectId: "synthetic-medusa-project" }, commerceMappingStore(pool), native, vault) : undefined;
    const service = authSessionService(config, { ...store, ...override }, authority, transactions, vault, () => time, commerce, customer);
    async function login() {
      const start = await transactions.begin("/studio"); const state = new URL(start.authorizeUrl).searchParams.get("state")!;
      return service.completeLogin(state, start.browserBinding, "synthetic-code");
    }
    const reconciliation = (changes: Partial<RevocationStore> = {}) => revocationReconciler(config, { ...store, ...changes }, authority, vault);
    return { service, login, control, config, reconciler: reconciliation(), reconciliation, http: authHttpHandlers(config, service, transactions, () => time) };
  }
  function customerFixture(onMint: () => Promise<void> = async () => {}, onRead: () => Promise<void> = async () => {}) {
    const authIdentityId = "authid_" + randomUUID().replaceAll("-", ""), customerId = "cus_" + randomUUID().replaceAll("-", "");
    let mints = 0, reads = 0;
    const native: NativeCustomerProvisioner = { async ensure(input) { return { state: "ready", projectId: input.projectId, operationId: input.operationId, entityId: centralEntityId(input.identity.issuer, input.identity.subject), authIdentityId, customerId }; } };
    const customer: PrivateCustomerTransport = {
      async exchange(input) { mints++; await onMint(); return { token: `synthetic-private-customer-${mints}`, expiresAt: Math.min(time + 60000, input.identity.expiresAt) }; },
      async owned(input) { reads++; await onRead(); return { kind: "customer", customer: { id: input.mapping.customerId, email: "synthetic@example.invalid", firstName: "Synthetic", lastName: null } }; },
    };
    return { ...composed({}, native, customer), counts: () => ({ mints, reads }) };
  }
  try {
    await t.test("raced issuer+subject creates one profile; another issuer stays separate", async () => {
      const ids = await Promise.all(Array.from({ length: 12 }, () => store.ensureProfile(issuer, "synthetic-shared")));
      assert.equal(new Set(ids).size, 1);
      assert.notEqual(await store.ensureProfile("https://other.example.invalid", "synthetic-shared"), ids[0]);
    });
    await t.test("durable browser-bound callback consume has exactly one winner", async () => {
      const id = randomUUID(), stateHash = hash("synthetic-state"), browserHash = hash("synthetic-browser");
      await store.createLogin({ id, stateHash, browserHash, verifierCipher: "synthetic-encrypted-verifier", callback: "https://app.example.invalid/auth/tcm/callback", returnPath: "/studio" });
      assert.equal(await store.consumeLogin(id, stateHash, hash("wrong-browser")), null);
      const results = await Promise.all(Array.from({ length: 12 }, () => store.consumeLogin(id, stateHash, browserHash)));
      assert.equal(results.filter(Boolean).length, 1);
      assert.equal(await store.consumeLogin(id, stateHash, browserHash), null);
    });
    await t.test("expired login transaction is rejected", async () => {
      const id = randomUUID(), stateHash = hash(randomUUID()), browserHash = hash(randomUUID());
      await store.createLogin({ id, stateHash, browserHash, verifierCipher: "synthetic", callback: "https://app.example.invalid/auth/tcm/callback", returnPath: "/account" });
      time += 600000;
      assert.equal(await store.consumeLogin(id, stateHash, browserHash), null);
    });
    await t.test("idle expiration cannot be revived; touches never extend absolute family expiry", async () => {
      const s = await session("synthetic-idle");
      const initial = (await store.readSession(s.tokenHash))!;
      time += 1799000;
      assert.equal(await store.touchSession(s.id, 0), true);
      const updated = (await store.readSession(s.tokenHash))!;
      assert.equal(updated.expiresAt.getTime(), initial.expiresAt.getTime());
      time += 1800000;
      assert.equal(await store.readSession(s.tokenHash), null);
      assert.equal(await store.touchSession(s.id, 0), false);
    });
    await t.test("logout wins over a delayed refresh and cannot be resurrected", async () => {
      const s = await session("synthetic-logout");
      const leases = await Promise.all([store.claimRefresh(s.id, 0), store.claimRefresh(s.id, 0)]);
      assert.equal(leases.filter(Boolean).length, 1);
      await store.revokeSession(s.tokenHash);
      assert.equal(await store.finishRefresh(s.id, 0, leases.find(Boolean)!, "synthetic-new-cipher"), false);
      assert.equal(await store.readSession(s.tokenHash), null);
      assert.equal(await store.touchSession(s.id, 0), false);
    });
    await t.test("expired refresh lease cannot be stolen or committed; reauth is required", async () => {
      const s = await session("synthetic-lost-rotation"); const lease = (await store.claimRefresh(s.id, 0))!;
      time += 15001;
      assert.equal(await store.finishRefresh(s.id, 0, lease, "synthetic-new-cipher"), false);
      assert.equal(await store.claimRefresh(s.id, 0), null);
      await store.requireReauth(s.id, 0, lease);
      assert.equal(await store.readSession(s.tokenHash), null);
    });
    await t.test("refresh generation fences stale writers and stops at96 rotations", async () => {
      const s = await session("synthetic-rotation-limit");
      for (let generation = 0; generation < 96; generation++) {
        const lease = (await store.claimRefresh(s.id, generation))!; assert.ok(lease);
        assert.equal(await store.finishRefresh(s.id, generation, lease, `synthetic-generation-${generation + 1}`), true);
        assert.equal(await store.finishRefresh(s.id, generation, lease, "synthetic-stale"), false);
      }
      assert.equal((await store.readSession(s.tokenHash))?.generation, 96);
      assert.equal(await store.claimRefresh(s.id, 96), null);
    });
    await t.test("guest claim needs capability+active session; competing accounts cannot steal ownership", async () => {
      const a = await session("synthetic-guest-a"), b = await session("synthetic-guest-b"), id = randomUUID(), capability = hash(randomUUID());
      await store.createGuestDraft(id, capability, new Date(time + 600000));
      assert.equal(await store.claimGuestDraft(id, hash("wrong"), a.id, 0), false);
      const results = await Promise.all([store.claimGuestDraft(id, capability, a.id, 0), store.claimGuestDraft(id, capability, b.id, 0)]);
      assert.equal(results.filter(Boolean).length, 1);
      const winner = results[0] ? a : b, loser = results[0] ? b : a;
      assert.equal(await store.claimGuestDraft(id, capability, winner.id, 0), true);
      assert.equal(await store.claimGuestDraft(id, capability, loser.id, 0), false);
      await store.revokeSession(winner.tokenHash);
      assert.equal(await store.claimGuestDraft(id, capability, winner.id, 0), false);
    });
    await t.test("composed login encrypts credentials, verifies current identity, rotates and claims a guest", async () => {
      const f = composed(); const login = await f.login();
      assert.deepEqual(Object.keys(login).sort(), ["cookieSecret", "expiresAt", "returnPath"]);
      const first = await f.service.verify(login.cookieSecret);
      assert.equal(first.generation, 0); assert.equal((await f.service.contact(login.cookieSecret)).emailVerified, false);
      const stored = (await store.lookupSession(authSecretHash(login.cookieSecret)))!;
      assert.ok(!stored.credentialsCipher.includes("synthetic-access")); assert.ok(!stored.credentialsCipher.includes("synthetic-refresh"));
      const refreshed = await f.service.refresh(login.cookieSecret);
      assert.equal(refreshed.generation, 1); assert.equal(refreshed.userId, first.userId); assert.equal(f.control.refreshCalls, 1);
      const draft = randomUUID(), capability = opaqueAuthSecret();
      await store.createGuestDraft(draft, authSecretHash(capability), new Date(time + 600000));
      await f.service.claimGuest(login.cookieSecret, draft, capability);
      await assert.rejects(f.service.claimGuest(login.cookieSecret, draft, opaqueAuthSecret()), /forbidden/);
      assert.deepEqual(await f.service.logout(login.cookieSecret), { localRevoked: true, upstream: "confirmed" });
      await assert.rejects(f.service.verify(login.cookieSecret), /reauth_required/);
      assert.equal((await pool.query("SELECT central_revoke_state FROM vynvori_identity.sessions WHERE id=$1", [first.sessionId])).rows[0].central_revoke_state, "confirmed");
    });
    await t.test("lost refresh response permanently requires reauth without another rotation attempt", async () => {
      const f = composed(); const login = await f.login(); f.control.failRefresh = true;
      await assert.rejects(f.service.refresh(login.cookieSecret), /reauth_required/);
      await assert.rejects(f.service.refresh(login.cookieSecret), /reauth_required/);
      await assert.rejects(f.service.verify(login.cookieSecret), /reauth_required/);
      assert.equal(f.control.refreshCalls, 1);
    });
    await t.test("missing commerce contact does not block login, current identity or guest ownership", async () => {
      const f = composed(); f.control.missingContact = true;
      const login = await f.login(); await f.service.verify(login.cookieSecret);
      await assert.rejects(f.service.contact(login.cookieSecret), /contact_required/);
      const draft = randomUUID(), capability = opaqueAuthSecret();
      await store.createGuestDraft(draft, authSecretHash(capability), new Date(time + 600000));
      await f.service.claimGuest(login.cookieSecret, draft, capability);
    });
    await t.test("logout outage is durably pending and local session stays revoked", async () => {
      const f = composed(); const login = await f.login(); const verified = await f.service.verify(login.cookieSecret);
      f.control.failRevoke = true;
      assert.deepEqual(await f.service.logout(login.cookieSecret), { localRevoked: true, upstream: "pending" });
      await assert.rejects(f.service.verify(login.cookieSecret), /reauth_required/);
      assert.equal((await pool.query("SELECT central_revoke_state FROM vynvori_identity.sessions WHERE id=$1", [verified.sessionId])).rows[0].central_revoke_state, "pending");
      f.control.failRevoke = false;
      assert.deepEqual(await f.service.logout(login.cookieSecret), { localRevoked: true, upstream: "confirmed" });
      assert.deepEqual(await f.service.logout(opaqueAuthSecret()), { localRevoked: true, upstream: "unconfirmed" });
    });
    await t.test("lost database acknowledgement after refresh commit still revokes local session", async () => {
      const f = composed({ async finishRefresh(...args) { await store.finishRefresh(...args); throw new Error("synthetic-lost-commit-acknowledgement"); } });
      const login = await f.login();
      await assert.rejects(f.service.refresh(login.cookieSecret), /reauth_required/);
      await assert.rejects(f.service.verify(login.cookieSecret), /reauth_required/);
      const row = (await store.lookupSession(authSecretHash(login.cookieSecret)))!;
      assert.equal(row.generation, 1); assert.equal(row.status, "revoked"); assert.equal(f.control.refreshCalls, 1);
    });
    await t.test("composed logout during an in-flight refresh cannot resurrect session", async () => {
      const f = composed(); const login = await f.login();
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const proceed = new Promise<void>(resolve => { release = resolve; });
      f.control.onRefresh = async () => { entered(); await proceed; };
      const renewing = f.service.refresh(login.cookieSecret);
      const outcome = assert.rejects(renewing, /reauth_required/);
      await started;
      await assert.rejects(f.service.verify(login.cookieSecret), /unavailable/);
      assert.deepEqual(await f.service.logout(login.cookieSecret), { localRevoked: true, upstream: "confirmed" });
      release(); await outcome;
      await assert.rejects(f.service.verify(login.cookieSecret), /reauth_required/);
      assert.equal(f.control.refreshCalls, 1);
    });
    await t.test("concurrent first-commerce requests reserve one native dispatch and preserve ready mapping", async () => {
      let calls = 0;
      const native: NativeCustomerProvisioner = { async ensure(input) {
        calls++; assert.equal(input.mode, "create");
        return { state: "ready", projectId: input.projectId, operationId: input.operationId, entityId: centralEntityId(input.identity.issuer, input.identity.subject), authIdentityId: "authid_mapping_race", customerId: "cus_mapping_race" };
      } };
      const f = composed({}, native), login = await f.login();
      const results = await Promise.all(Array.from({ length: 12 }, () => f.service.ensureCommerce(login.cookieSecret)));
      assert.ok(results.some(result => result.state === "ready")); assert.equal(calls, 1);
      const again = await f.service.ensureCommerce(login.cookieSecret); assert.equal(again.state, "ready"); assert.equal(calls, 1);
      f.control.missingContact = true;
      assert.equal((await f.service.ensureCommerce(login.cookieSecret)).state, "ready");
      assert.equal((await f.service.existingCommerce(login.cookieSecret))?.state, "ready");
      const current = await f.service.verify(login.cookieSecret);
      const row = (await commerceMappingStore(pool).get(current.userId, "synthetic-medusa-project"))!;
      assert.ok(!row.requestCipher.includes("synthetic@example.invalid"));
    });
    await t.test("unknown customer-create outcome reconciles original encrypted contact without another create", async () => {
      let creates = 0, reconciles = 0;
      const native: NativeCustomerProvisioner = { async ensure(input) {
        if (input.mode === "create") { creates++; throw new Error("synthetic-response-lost-after-native-create"); }
        reconciles++; assert.equal(input.originalEmail, "synthetic@example.invalid");
        return { state: "ready", projectId: input.projectId, operationId: input.operationId, entityId: centralEntityId(input.identity.issuer, input.identity.subject), authIdentityId: "authid_mapping_recovered", customerId: "cus_mapping_recovered" };
      } };
      const f = composed({}, native), login = await f.login();
      assert.equal((await f.service.ensureCommerce(login.cookieSecret)).state, "reconcile_required");
      assert.equal((await f.service.ensureCommerce(login.cookieSecret)).state, "reconcile_required");
      f.control.contactEmail = "changed@example.invalid";
      assert.equal((await f.service.reconcileCommerce(login.cookieSecret)).state, "ready");
      assert.equal(creates, 1); assert.equal(reconciles, 1);
    });
    await t.test("native result for another operation cannot establish a mapping", async () => {
      const native: NativeCustomerProvisioner = { async ensure(input) {
        return { state: "ready", projectId: input.projectId, operationId: randomUUID(), entityId: centralEntityId(input.identity.issuer, input.identity.subject), authIdentityId: "authid_wrong_operation", customerId: "cus_wrong_operation" };
      } };
      const f = composed({}, native), login = await f.login();
      assert.equal((await f.service.ensureCommerce(login.cookieSecret)).state, "conflict");
    });
    await t.test("known local failure before HTTP dispatch releases reservation without retrying a customer create", async () => {
      let unavailable = true, creates = 0;
      const native: NativeCustomerProvisioner = { async ensure(input) {
        if (unavailable) throw new CommerceIdentityError("not_started");
        creates++; return { state: "ready", projectId: input.projectId, operationId: input.operationId, entityId: centralEntityId(input.identity.issuer, input.identity.subject), authIdentityId: "authid_preflight_recovered", customerId: "cus_preflight_recovered" };
      } };
      const f = composed({}, native), login = await f.login(), user = (await f.service.verify(login.cookieSecret)).userId;
      assert.equal((await f.service.ensureCommerce(login.cookieSecret)).state, "unavailable");
      const first = (await commerceMappingStore(pool).get(user, "synthetic-medusa-project"))!; assert.equal(first.state, "reserved"); assert.equal(creates, 0);
      unavailable = false; assert.equal((await f.service.ensureCommerce(login.cookieSecret)).state, "ready"); assert.equal(creates, 1);
      assert.equal((await commerceMappingStore(pool).get(user, "synthetic-medusa-project"))!.operationId, first.operationId);
    });
    await t.test("a failed reconciliation cannot reset an earlier uncertain create to reserved", async () => {
      let creates = 0;
      const native: NativeCustomerProvisioner = { async ensure(input) {
        if (input.mode === "create") { creates++; throw new Error("synthetic-unknown-create"); }
        throw new CommerceIdentityError("not_started");
      } };
      const f = composed({}, native), login = await f.login(), user = (await f.service.verify(login.cookieSecret)).userId;
      assert.equal((await f.service.ensureCommerce(login.cookieSecret)).state, "reconcile_required");
      await pool.query("UPDATE vynvori_identity.commerce_mappings SET state='dispatching' WHERE user_id=$1 AND project_id=$2", [user, "synthetic-medusa-project"]);
      assert.equal((await f.service.reconcileCommerce(login.cookieSecret)).state, "unavailable");
      assert.equal((await commerceMappingStore(pool).get(user, "synthetic-medusa-project"))!.state, "reconcile_required");
      assert.equal((await f.service.ensureCommerce(login.cookieSecret)).state, "reconcile_required"); assert.equal(creates, 1);
    });
    await t.test("two identities cannot share one native customer mapping in the same project", async () => {
      const native: NativeCustomerProvisioner = { async ensure(input) {
        return { state: "ready", projectId: input.projectId, operationId: input.operationId, entityId: centralEntityId(input.identity.issuer, input.identity.subject), authIdentityId: "authid_mapping_same", customerId: "cus_mapping_same" };
      } };
      const a = composed({}, native), b = composed({}, native), loginA = await a.login(), loginB = await b.login();
      assert.equal((await a.service.ensureCommerce(loginA.cookieSecret)).state, "ready");
      assert.equal((await b.service.ensureCommerce(loginB.cookieSecret)).state, "reconcile_required");
      const userB = (await b.service.verify(loginB.cookieSecret)).userId;
      assert.notEqual((await commerceMappingStore(pool).get(userB, "synthetic-medusa-project"))?.state, "ready");
    });
    await t.test("customer credentials are encrypted, cached as credentials only, and invalidated by refresh/logout", async () => {
      const f = customerFixture(), login = await f.login(); await f.service.ensureCommerce(login.cookieSecret);
      const first = await f.service.customer(login.cookieSecret, { action: "read_customer" }); assert.equal(first.kind, "customer");
      const active = await f.service.verify(login.cookieSecret), cached = (await store.readCustomerCredential(active.sessionId, 0, "synthetic-medusa-project"))!;
      assert.ok(cached); assert.ok(!cached.cipher.includes("synthetic-private-customer"));
      const before = f.control.identityReads;
      await f.service.customer(login.cookieSecret, { action: "read_customer" }); assert.deepEqual(f.counts(), { mints: 1, reads: 2 }); assert.ok(f.control.identityReads >= before + 2);
      time += 60001;
      await f.service.customer(login.cookieSecret, { action: "read_customer" }); assert.equal(f.counts().mints, 2);
      await f.service.refresh(login.cookieSecret);
      assert.equal(await store.readCustomerCredential(active.sessionId, 1, "synthetic-medusa-project"), null);
      assert.equal(await store.cacheCustomerCredential(active.sessionId, 0, { ...cached, expiresAt: new Date(time + 1000) }), false);
      await f.service.customer(login.cookieSecret, { action: "read_customer" }); assert.equal(f.counts().mints, 3);
      await f.service.logout(login.cookieSecret);
      assert.equal((await pool.query("SELECT commerce_cipher FROM vynvori_identity.sessions WHERE id=$1", [active.sessionId])).rows[0].commerce_cipher, null);
    });
    await t.test("copied ciphertext and foreign mapping IDs cannot cross app-session ownership", async () => {
      const a = customerFixture(), b = customerFixture(), la = await a.login(), lb = await b.login();
      await a.service.ensureCommerce(la.cookieSecret); await b.service.ensureCommerce(lb.cookieSecret);
      await a.service.customer(la.cookieSecret, { action: "read_customer" }); await b.service.customer(lb.cookieSecret, { action: "read_customer" });
      const sa = await a.service.verify(la.cookieSecret), sb = await b.service.verify(lb.cookieSecret);
      const ca = (await store.readCustomerCredential(sa.sessionId, 0, "synthetic-medusa-project"))!, cb = (await store.readCustomerCredential(sb.sessionId, 0, "synthetic-medusa-project"))!;
      assert.equal(await store.cacheCustomerCredential(sa.sessionId, 0, cb), false);
      await pool.query("UPDATE vynvori_identity.sessions SET commerce_cipher=$2 WHERE id=$1", [sb.sessionId, ca.cipher]);
      const reads = b.counts().reads;
      await assert.rejects(b.service.customer(lb.cookieSecret, { action: "read_customer" }), /unavailable|reauth_required/); assert.equal(b.counts().reads, reads);
    });
    await t.test("logout during customer-token mint prevents a late cache write or data read", async () => {
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; }), proceed = new Promise<void>(resolve => { release = resolve; });
      const f = customerFixture(async () => { entered(); await proceed; }), login = await f.login(); await f.service.ensureCommerce(login.cookieSecret);
      const pending = f.service.customer(login.cookieSecret, { action: "read_customer" }), denied = assert.rejects(pending, /reauth_required/);
      await started; await f.service.logout(login.cookieSecret); release(); await denied; assert.equal(f.counts().reads, 0);
    });
    await t.test("central revocation during owned read suppresses the resulting data", async () => {
      const f = customerFixture(async () => {}, async () => { f.control.revoked = true; }), login = await f.login(); await f.service.ensureCommerce(login.cookieSecret);
      await assert.rejects(f.service.customer(login.cookieSecret, { action: "read_customer" }), /reauth_required/);
    });
    await t.test("HTTP login/cookie/callback/renewal/logout composes actual durable state without exposing tokens", async () => {
      const f = composed(), origin = "https://app.example.invalid", jar = new Map<string, string>();
      function remember(response: Response) {
        for (const header of response.headers.getSetCookie()) {
          const pair = header.split(";")[0]!, at = pair.indexOf("="), name = pair.slice(0, at), value = pair.slice(at + 1);
          if (header.includes("Max-Age=0")) jar.delete(name); else jar.set(name, value);
        }
      }
      function req(path: string, payload?: unknown, extra: Record<string, string> = {}) {
        return new Request(origin + path, { method: payload === undefined ? "GET" : "POST", headers: { cookie: [...jar].map(([key, value]) => `${key}=${value}`).join("; "),
          ...(payload === undefined ? {} : { origin, "content-type": "application/json", "x-vynvori-csrf": jar.get(authCookies.csrf)! }), ...extra }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
      }
      const csrfResponse = await f.http.csrf(req("/api/auth/csrf")); remember(csrfResponse);
      const start = await f.http.start(req("/api/auth/tcm/start", { returnPath: "/account" })); assert.equal(start.status, 200); remember(start);
      const state = new URL((await start.json()).authorizeUrl).searchParams.get("state")!;
      const callbackPath = "/auth/tcm/callback?" + new URLSearchParams({ state, code: "synthetic-code" });
      const originalTransactionCookie = jar.get(authCookies.transaction)!;
      const callback = await f.http.callback(req(callbackPath)); assert.equal(callback.status, 303); remember(callback);
      assert.ok(jar.has(authCookies.session)); assert.ok(!jar.has(authCookies.transaction));
      const opaqueCookie = jar.get(authCookies.session)!;
      assert.equal((await f.http.session(req("/api/auth/session"))).status, 200);
      const replay = await f.http.callback(req(callbackPath, undefined, { cookie: `${authCookies.transaction}=${originalTransactionCookie}` }));
      assert.equal(replay.status, 401); assert.equal(f.control.exchangeCalls, 1);
      time = (await f.service.verify(opaqueCookie)).identity.expiresAt;
      const expired = await f.http.session(req("/api/auth/session")); assert.equal(expired.status, 401); assert.equal((await expired.json()).error.code, "AUTH_RENEW_REQUIRED");
      assert.equal((await f.http.refresh(req("/api/auth/tcm/refresh", {}, { origin: "https://evil.invalid" }))).status, 403);
      assert.equal(f.control.refreshCalls, 0);
      assert.equal((await f.http.refresh(req("/api/auth/tcm/refresh", {}))).status, 200); assert.equal(f.control.refreshCalls, 1);
      const current = await f.http.session(req("/api/auth/session")); assert.deepEqual(await current.json(), { authenticated: true });
      const logout = await f.http.logout(req("/api/auth/logout", {})); assert.equal(logout.status, 200); assert.deepEqual(await logout.clone().json(), { localRevoked: true, upstream: "confirmed" }); remember(logout);
      assert.ok(!jar.has(authCookies.session));
      const stolen = await f.http.session(req("/api/auth/session", undefined, { cookie: `${authCookies.session}=${opaqueCookie}` })); assert.equal(stolen.status, 401);
    });
    await t.test("pending logout is reconciled once under competing workers, without restoring access", async () => {
      const f = composed(), login = await f.login(); f.control.failRevoke = true;
      await f.service.logout(login.cookieSecret); const before = f.control.revokeCalls; f.control.failRevoke = false;
      const results = await Promise.all([f.reconciler.run(), f.reconciler.run()]);
      assert.equal(results.reduce((total, r) => total + r.attempted, 0), 1);
      assert.equal(results.reduce((total, r) => total + r.confirmed, 0), 1);
      assert.equal(f.control.revokeCalls, before + 1); assert.equal(f.control.refreshCalls, 0);
      const row = (await store.lookupSession(authSecretHash(login.cookieSecret)))!;
      assert.equal(row.status, "revoked"); await assert.rejects(f.service.verify(login.cookieSecret), /reauth_required/);
      assert.equal((await f.reconciler.run()).attempted, 0);
    });
    await t.test("revocation queue enforces backoff, eight-attempt ceiling and exact cohort", async () => {
      const f = composed(), login = await f.login(); f.control.failRevoke = true; await f.service.logout(login.cookieSecret);
      assert.equal(await store.claimCentralRevocation({ ...f.config, clientId: "other-client" }), null);
      assert.equal(await store.claimCentralRevocation({ ...f.config, deployment: "other-deployment" }), null);
      assert.equal(await store.claimCentralRevocation({ ...f.config, issuer: "https://other.example.invalid" }), null);
      for (let attempt = 1; attempt <= 8; attempt++) {
        const outcome = await f.reconciler.run(); assert.equal(outcome.attempted, 1); assert.equal(outcome.pending, 1);
        assert.equal(outcome.manualReview, attempt === 8 ? 1 : 0);
        assert.equal((await f.reconciler.run()).attempted, 0);
        time += Math.min(3600000, 60000 * 2 ** (attempt - 1));
      }
      assert.equal((await f.reconciler.run()).attempted, 0);
      assert.equal(f.control.revokeCalls, 9); assert.equal(f.control.refreshCalls, 0);
      const row = (await pool.query("SELECT status,revoke_attempts,central_revoke_state FROM vynvori_identity.sessions WHERE token_hash=$1", [authSecretHash(login.cookieSecret)])).rows[0];
      assert.equal(row.status, "revoked"); assert.equal(row.revoke_attempts, 8); assert.equal(row.central_revoke_state, "pending");
    });
    await t.test("expired revocation lease is recoverable but its old worker cannot settle", async () => {
      const f = composed(), login = await f.login(); f.control.failRevoke = true; await f.service.logout(login.cookieSecret);
      const first = (await store.claimCentralRevocation(f.config))!; assert.ok(first);
      assert.equal(await store.claimCentralRevocation(f.config), null); time += 30001;
      const second = (await store.claimCentralRevocation(f.config))!; assert.notEqual(second.lease, first.lease);
      assert.equal(await store.settleCentralRevocation(first.id, first.lease, true, 60000), false);
      assert.equal(await store.settleCentralRevocation(second.id, second.lease, true, 60000), true);
      assert.equal(await store.claimCentralRevocation(f.config), null);
    });
    await t.test("idle expiry and abandoned refresh close locally before central reconciliation", async () => {
      for (const kind of ["idle", "refresh"]) {
        const f = composed(), login = await f.login(), live = await f.service.verify(login.cookieSecret);
        assert.equal(await store.claimCentralRevocation(f.config), null);
        if (kind === "refresh") { assert.ok(await store.claimRefresh(live.sessionId, live.generation)); time += 15001; }
        else time += 1800001;
        const claimed = (await store.claimCentralRevocation(f.config))!; assert.ok(claimed); assert.equal(claimed.status, "revoked");
        await assert.rejects(f.service.verify(login.cookieSecret), /reauth_required/);
        assert.equal(f.control.refreshCalls, 0);
      }
    });
    await t.test("lost revocation commit acknowledgement remains uncertain without repeating a confirmed operation", async () => {
      const f = composed(), login = await f.login(); f.control.failRevoke = true; await f.service.logout(login.cookieSecret); f.control.failRevoke = false;
      const uncertain = f.reconciliation({ async settleCentralRevocation(...args) { await store.settleCentralRevocation(...args); throw new Error("synthetic-lost-ack"); } });
      assert.equal((await uncertain.run()).pending, 1); const before = f.control.revokeCalls;
      assert.equal((await f.reconciler.run()).attempted, 0); assert.equal(f.control.revokeCalls, before);
      await assert.rejects(f.service.verify(login.cookieSecret), /reauth_required/);
    });
    await t.test("expiry reconciliation clears the private customer credential cache before upstream work", async () => {
      const f = customerFixture(), login = await f.login(); await f.service.ensureCommerce(login.cookieSecret);
      await f.service.customer(login.cookieSecret, { action: "read_customer" });
      assert.ok((await pool.query("SELECT commerce_cipher FROM vynvori_identity.sessions WHERE token_hash=$1", [authSecretHash(login.cookieSecret)])).rows[0].commerce_cipher);
      time += 1800001; const claimed = (await store.claimCentralRevocation(f.config))!; assert.ok(claimed);
      const row = (await pool.query("SELECT status,commerce_cipher FROM vynvori_identity.sessions WHERE id=$1", [claimed.id])).rows[0];
      assert.equal(row.status, "revoked"); assert.equal(row.commerce_cipher, null);
      assert.equal(f.control.revokeCalls, 0);
    });
    await t.test("missing historical session cohort is retained and never automatically selected", async () => {
      const f = composed(), login = await f.login(); f.control.failRevoke = true; await f.service.logout(login.cookieSecret);
      await pool.query("UPDATE vynvori_identity.sessions SET authority_client_id=NULL,deployment=NULL WHERE token_hash=$1", [authSecretHash(login.cookieSecret)]);
      assert.equal((await f.reconciler.run()).attempted, 0);
      assert.equal((await store.lookupSession(authSecretHash(login.cookieSecret)))!.status, "revoked");
    });
    await t.test("runtime has no DDL, destructive cleanup or role escalation privileges", async () => {
      for (const sql of ["CREATE SCHEMA forbidden", "CREATE TABLE public.forbidden(id int)", "TRUNCATE vynvori_identity.sessions", "DELETE FROM vynvori_identity.sessions", "SET ROLE synthetic"]) await assert.rejects(pool.query(sql), { code: "42501" });
    });
  } finally { await pool.end(); }
});
