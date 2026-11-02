import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { authHttpHandlers, authCookies } from "../src/auth-http";
import { AuthSessionError, type AuthenticatedSession } from "../src/auth-sessions";

const origin = "https://app.example.invalid", time = 1800000000000, csrf = "c".repeat(43), session = "s".repeat(43), binding = "b".repeat(43);
function request(path: string, method = "GET", payload?: unknown, extra: Record<string, string> = {}) {
  return new Request(origin + path, { method, headers: { ...(method === "POST" ? { origin, "content-type": "application/json", "x-vynvori-csrf": csrf } : {}), cookie: `${authCookies.csrf}=${csrf}; ${authCookies.session}=${session}; ${authCookies.transaction}=${binding}`, ...extra }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
}
function fixture() {
  const calls = { begin: 0, consume: 0, complete: 0, verify: 0, refresh: 0, logout: 0, guest: 0 };
  const errors: { verify?: Error; refresh?: Error; logout?: Error } = {};
  let consumed = false;
  const sessions = {
    async completeLogin() { calls.complete++; if (consumed) throw new AuthSessionError("reauth_required"); consumed = true; return { cookieSecret: session, returnPath: "/account", expiresAt: time + 28800000 }; },
    async verify() { calls.verify++; if (errors.verify) throw errors.verify; return { sessionId: "private-session-id", userId: "private-user-id", identity: { accessToken: "private-central-token" } } as unknown as AuthenticatedSession; },
    async refresh() { calls.refresh++; if (errors.refresh) throw errors.refresh; return {} as AuthenticatedSession; },
    async logout() { calls.logout++; if (errors.logout) throw errors.logout; return { localRevoked: true as const, upstream: "pending" as const }; },
    async claimGuest() { calls.guest++; },
    async customer() { return { kind: "customer" as const, customer: { id: "private-customer", email: "synthetic@example.invalid", firstName: null, lastName: null } }; },
    async ensureCommerce() { return { state: "ready" as const, userId: "private-user", projectId: "private-project", authIdentityId: "private-auth", customerId: "private-customer" }; },
    async reconcileCommerce() { return { state: "reconcile_required" as const }; },
  };
  const transactions = {
    async begin() { calls.begin++; return { transactionId: randomUUID(), authorizeUrl: "https://identity.example.invalid/oauth/authorize?state=synthetic-state", browserBinding: binding, expiresAt: time + 600000 }; },
    async consume() { calls.consume++; return { transactionId: "synthetic-id", verifier: "v".repeat(43), callback: origin + "/auth/tcm/callback", returnPath: "/account" }; },
  };
  return { calls, errors, http: authHttpHandlers({ enabled: true, appOrigin: origin }, sessions, transactions, () => time) };
}
test("disabled HTTP handlers need no dependencies and expose no session or credentials", async () => {
  const http = authHttpHandlers({ enabled: false, appOrigin: "" });
  for (const handler of Object.values(http)) {
    const response = await handler(new Request(origin)); assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "AUTH_DISABLED"); assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  }
});
test("CSRF endpoint issues a no-store host-only Secure HttpOnly Strict cookie", async () => {
  const response = await fixture().http.csrf(request("/api/auth/csrf"));
  assert.equal(response.status, 200); assert.match((await response.json()).csrfToken, /^[A-Za-z0-9_-]{43}$/);
  const cookie = response.headers.get("set-cookie")!;
  for (const attribute of ["__Host-vynvori_csrf=", "Path=/", "Secure", "HttpOnly", "SameSite=Strict"]) assert.ok(cookie.includes(attribute));
  assert.ok(!cookie.includes("Domain=")); assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal((await fixture().http.csrf(request("/api/auth/csrf", "GET", undefined, { "sec-fetch-site": "cross-site" }))).status, 403);
});
test("missing/foreign origin or mismatched CSRF prevents login state creation", async () => {
  const f = fixture();
  for (const changed of [{ origin: "" }, { origin: "https://evil.invalid" }, { "x-vynvori-csrf": "x".repeat(43) }, { "sec-fetch-site": "cross-site" }]) {
    assert.equal((await f.http.start(request("/api/auth/tcm/start", "POST", { returnPath: "/account" }, changed))).status, 403);
  }
  assert.equal(f.calls.begin, 0);
});
test("start rejects open redirects, identity overrides, duplicate cookies and oversized JSON", async () => {
  const f = fixture();
  for (const data of [{ returnPath: "//evil.invalid" }, { returnPath: "/account", userId: "other" }, { returnPath: "x".repeat(3000) }]) assert.equal((await f.http.start(request("/api/auth/tcm/start", "POST", data))).status, 400);
  const duplicated = `${authCookies.csrf}=${csrf}; ${authCookies.csrf}=${csrf}`;
  assert.equal((await f.http.start(request("/api/auth/tcm/start", "POST", { returnPath: "/account" }, { cookie: duplicated }))).status, 400);
  assert.equal(f.calls.begin, 0);
});
test("successful start stores browser binding only in a secure transaction cookie", async () => {
  const f = fixture(), response = await f.http.start(request("/api/auth/tcm/start", "POST", { returnPath: "/studio" }));
  assert.equal(response.status, 200); assert.deepEqual(Object.keys(await response.json()), ["authorizeUrl"]);
  assert.match(response.headers.get("set-cookie")!, /__Host-vynvori_login=.*HttpOnly; Secure; SameSite=Lax; Max-Age=600/);
});
test("callback issues opaque session cookie and rejects replay without another session", async () => {
  const f = fixture(), path = "/auth/tcm/callback?state=synthetic-state&code=synthetic-code";
  const response = await f.http.callback(request(path));
  assert.equal(response.status, 303); assert.equal(response.headers.get("location"), origin + "/account");
  const cookies = response.headers.getSetCookie();
  assert.ok(cookies.some(value => value.startsWith(`${authCookies.session}=${session};`) && value.includes("Max-Age=28800")));
  assert.ok(cookies.some(value => value.startsWith(`${authCookies.transaction}=;`) && value.includes("Max-Age=0")));
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  const replay = await f.http.callback(request(path)); assert.equal(replay.status, 401);
  assert.ok(replay.headers.getSetCookie().every(value => !value.startsWith(authCookies.session + "=")));
});
test("callback rejects duplicate query fields, wrong host and missing browser binding before exchange", async () => {
  const f = fixture();
  for (const path of ["/auth/tcm/callback?state=a&state=b&code=x", "/auth/tcm/callback?state=a&code=b&code=c", "/auth/tcm/callback?state=a&code=b&error=denied"]) assert.equal((await f.http.callback(request(path))).status, 400);
  assert.equal((await f.http.callback(request("/auth/tcm/callback?state=a&code=b", "GET", undefined, { cookie: "" }))).status, 400);
  assert.equal((await f.http.callback(new Request("https://evil.invalid/auth/tcm/callback?state=a&code=b"))).status, 400);
  assert.equal(f.calls.complete, 0);
});
test("denied consent consumes the transaction and never reflects upstream descriptions", async () => {
  const f = fixture(), response = await f.http.callback(request("/auth/tcm/callback?state=a&error=access_denied&error_description=private-upstream-detail"));
  assert.equal(response.status, 303); assert.equal(response.headers.get("location"), origin + "/account?auth=cancelled");
  assert.equal(f.calls.consume, 1); assert.equal(f.calls.complete, 0); assert.ok(!(await response.text()).includes("private-upstream-detail"));
});
test("session response exposes only sanitized account status, and renewal retains the opaque cookie", async () => {
  const f = fixture(), response = await f.http.session(request("/api/auth/session"));
  assert.deepEqual(await response.json(), { authenticated: true });
  f.errors.verify = new AuthSessionError("renew_required");
  const expired = await f.http.session(request("/api/auth/session")); assert.equal(expired.status, 401);
  assert.equal((await expired.json()).error.code, "AUTH_RENEW_REQUIRED"); assert.equal(expired.headers.get("set-cookie"), null);
});
test("refresh rejects caller fields and performs one deliberate server operation", async () => {
  const f = fixture(); assert.equal((await f.http.refresh(request("/api/auth/tcm/refresh", "POST", { refresh_token: "caller-override" }))).status, 400);
  assert.equal(f.calls.refresh, 0); assert.equal((await f.http.refresh(request("/api/auth/tcm/refresh", "POST", {}))).status, 200); assert.equal(f.calls.refresh, 1);
});
test("logout clears local browser access only after confirmed durable local revocation", async () => {
  const f = fixture(), response = await f.http.logout(request("/api/auth/logout", "POST", {}));
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { localRevoked: true, upstream: "pending" });
  assert.ok(response.headers.getSetCookie().some(value => value.startsWith(authCookies.session + "=;") && value.includes("Max-Age=0")));
  f.errors.logout = new Error("private-database-error");
  const failed = await f.http.logout(request("/api/auth/logout", "POST", {})); assert.equal(failed.status, 503);
  assert.equal(failed.headers.get("set-cookie"), null); assert.ok(!(await failed.text()).includes("private-database-error"));
});
test("commerce status omits internal mappings and pending reconciliation is explicit", async () => {
  const f = fixture();
  const ready = await f.http.commerce(request("/api/auth/commerce", "POST", { action: "ensure" })); assert.deepEqual(await ready.json(), { state: "ready" });
  const pending = await f.http.commerce(request("/api/auth/commerce", "POST", { action: "reconcile" })); assert.equal(pending.status, 202); assert.deepEqual(await pending.json(), { state: "reconcile_required" });
});
test("owned profile omits native identifiers and cart lookup rejects caller ownership overrides", async () => {
  const f = fixture();
  const profile = await f.http.profile(request("/api/account/profile"));
  assert.deepEqual(await profile.json(), { profile: { email: "synthetic@example.invalid", firstName: null, lastName: null } });
  assert.equal((await f.http.profile(request("/api/account/profile?customerId=other"))).status, 400);
  assert.equal((await f.http.cart(request("/api/account/cart?cartId=cart_a&cartId=cart_b"))).status, 400);
  assert.equal((await f.http.cart(request("/api/account/cart?cartId=cart_a&userId=other"))).status, 400);
});
