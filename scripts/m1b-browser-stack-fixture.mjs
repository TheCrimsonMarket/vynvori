// Called only by the native disposable test. Real browser/BFF/SQL/SDK/native services; synthetic central authority.
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { centralIdentityClient } from "../packages/commerce/src/central-identity.ts";
import { credentialVault, authSecretHash, opaqueAuthSecret } from "../packages/commerce/src/auth-vault.ts";
import { loginTransactions } from "../packages/commerce/src/login-transactions.ts";
import { authSessionService } from "../packages/commerce/src/auth-sessions.ts";
import { authHttpHandlers, authCookies } from "../packages/commerce/src/auth-http.ts";
import { commerceIdentityCoordinator } from "../packages/commerce/src/commerce-identity.ts";
import { privateMedusaClient } from "../packages/commerce/src/medusa-private.ts";
import { revocationReconciler } from "../packages/commerce/src/revocation-reconciliation.ts";
import { identityStateStore } from "../packages/db/src/auth-state.ts";
import { commerceMappingStore } from "../packages/db/src/commerce-mappings.ts";

const root = fileURLToPath(new URL("..", import.meta.url)), output = await mkdtemp(join(tmpdir(), "VYNVORI-M1b-connected-browser-"));
const { Pool } = createRequire(new URL("../packages/db/package.json", import.meta.url))("pg");
const { chromium } = createRequire(new URL("../design/reference/package.json", import.meta.url))("playwright");
const target = new URL(process.env.M1B_TEST_CREATIVE_URL ?? "");
assert.equal(target.hostname, "127.0.0.1"); assert.equal(target.pathname, "/vynvori_m1b_browser"); assert.match(target.username, /^synthetic_browser_runtime_[a-f0-9]{32}$/);
const native = new URL(process.env.M1B_TEST_MEDUSA_ORIGIN ?? ""); assert.equal(native.hostname, "127.0.0.1"); assert.equal(native.protocol, "http:");
const pool = new Pool({ connectionString: target.toString(), max: 4, statement_timeout: 5000, connectionTimeoutMillis: 2000 });
const issuer = "https://dev.portal.raum.au", clientId = process.env.M1B_CENTRAL_CLIENT_ID, secret = process.env.M1B_CENTRAL_CLIENT_SECRET;
assert.match(clientId, /^tcm_[a-f0-9]{32}$/); assert.ok(secret?.startsWith("synthetic-"));
const codes = new Map(), tokens = new Map(), families = new Set(), secrets = new Set();
const control = { subject: "A", failRevoke: false, loseRefreshResponse: false, exchanges: 0, refreshes: 0, revocations: 0 };
let browser, web, authorityServer, appOrigin, handlers, authorityOrigin, stage = "init", readyResolve;
const ready = new Promise(resolve => { readyResolve = resolve; });
const random = () => randomBytes(32).toString("base64url");
function mint(family) {
  family.accessToken = "synthetic-browser-access-" + random(); family.refreshToken = "synthetic-browser-refresh-" + random(); family.exp = Math.floor(Date.now() / 1000) + 300;
  tokens.set(family.accessToken, family); tokens.set(family.refreshToken, family); secrets.add(family.accessToken); secrets.add(family.refreshToken);
  return { access_token: family.accessToken, refresh_token: family.refreshToken, expires_in: 300, token_type: "Bearer", scope: "profile email" };
}
function authorize(address) {
  const query = new URL(address).searchParams;
  assert.equal(query.get("client_id"), clientId); assert.equal(query.get("redirect_uri"), appOrigin + "/auth/tcm/callback");
  assert.equal(query.get("response_type"), "code");
  assert.equal(query.get("code_challenge_method"), "S256"); assert.equal(query.get("scope"), "profile email");
  const code = random(); codes.set(code, { subject: control.subject, challenge: query.get("code_challenge"), callback: query.get("redirect_uri") });
  return query.get("redirect_uri") + "?" + new URLSearchParams({ state: query.get("state"), code });
}
try {
  stage = "synthetic-authority";
  authorityServer = http.createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    const send = (status, body) => { res.statusCode = status; res.end(JSON.stringify(body)); };
    try {
      if (req.url === "/_fixture/ready" && req.method === "POST") { readyResolve(true); return send(200, {}); }
      const expected = Buffer.from(new URLSearchParams({ v: clientId }).toString().slice(2) + ":" + new URLSearchParams({ v: secret }).toString().slice(2)).toString("base64");
      assert.equal(req.headers.authorization, "Basic " + expected); assert.equal(req.method, "POST");
      let raw = ""; for await (const part of req) { raw += part; assert.ok(raw.length < 16384); }
      const body = new URLSearchParams(raw), operation = req.url.split("/").at(-1);
      if (operation === "token") {
        if (body.get("grant_type") === "authorization_code") {
          const transaction = codes.get(body.get("code")); codes.delete(body.get("code"));
          if (!transaction || transaction.callback !== body.get("redirect_uri") || transaction.challenge !== createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url")) return send(400, { error: "invalid_grant" });
          control.exchanges++; const family = { subject: transaction.subject, revoked: false }; families.add(family); return send(200, mint(family));
        }
        const family = tokens.get(body.get("refresh_token"));
        if (!family || family.revoked || family.refreshToken !== body.get("refresh_token")) return send(400, { error: "invalid_grant" });
        control.refreshes++; const rotated = mint(family);
        if (control.loseRefreshResponse) return res.destroy();
        return send(200, rotated);
      }
      const family = tokens.get(body.get("token"));
      if (operation === "revoke") {
        control.revocations++; if (control.failRevoke) return send(503, {});
        if (family) family.revoked = true; return send(200, {});
      }
      const active = family && !family.revoked && family.accessToken === body.get("token") && family.exp > Date.now() / 1000;
      if (!active) return send(operation === "profile" ? 401 : 200, operation === "profile" ? {} : { active: false });
      const bound = { iss: issuer, sub: "synthetic-browser-subject-" + family.subject, client_id: clientId, aud: "urn:vynvori:staging" };
      return send(200, operation === "profile" ? { ...bound, email: "browser-" + family.subject.toLowerCase() + "@example.invalid", email_verified: false }
        : { ...bound, active: true, exp: family.exp, verified_at: Math.floor(Date.now() / 1000) });
    } catch { send(500, { error: "synthetic_fixture_failure" }); }
  });
  await new Promise(resolve => authorityServer.listen(0, "127.0.0.1", resolve)); authorityOrigin = "http://127.0.0.1:" + authorityServer.address().port;
  console.log("M1B_BROWSER_AUTHORITY " + authorityOrigin);
  const handshakeTimer = setTimeout(() => readyResolve(false), 10000); const acknowledged = await ready; clearTimeout(handshakeTimer); assert.equal(acknowledged, true);
  stage = "local-test-certificate";
  const keyPath = join(output, "synthetic-test-key.pem"), certPath = join(output, "synthetic-test-cert.pem");
  await promisify(execFile)("C:\\Program Files\\Git\\usr\\bin\\openssl.exe", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", keyPath, "-out", certPath], { timeout: 15000, windowsHide: true });
  stage = "actual-react-and-bff";
  const bundle = await build({ stdin: { contents: 'import {createRoot} from "react-dom/client"; import {AuthPanel} from "./apps/web/src/components/auth-panel"; createRoot(document.getElementById("root")).render(<AuthPanel/>);', loader: "tsx", resolveDir: root },
    tsconfig: join(root, "apps/web/tsconfig.json"), bundle: true, write: false, jsx: "automatic", platform: "browser", format: "iife", define: { "process.env.NODE_ENV": '"production"' } });
  const routes = { "/api/auth/csrf": "csrf", "/api/auth/session": "session", "/api/auth/tcm/start": "start", "/auth/tcm/callback": "callback", "/api/auth/tcm/refresh": "refresh", "/api/auth/logout": "logout", "/api/auth/commerce": "commerce", "/api/auth/guest/claim": "claimGuest", "/api/account/profile": "profile", "/api/account/orders": "orders", "/api/account/cart": "cart" };
  web = https.createServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, async (req, res) => {
    try {
      const path = new URL(req.url, appOrigin).pathname;
      if (path === "/bundle.js") { res.setHeader("content-type", "text/javascript"); return res.end(bundle.outputFiles[0].text); }
      if (path === "/account" || path === "/") { res.setHeader("content-type", "text/html"); res.setHeader("cache-control", "no-store"); return res.end('<!doctype html><html lang="en"><meta charset="utf-8"><title>Synthetic connected account</title><meta name="viewport" content="width=device-width,initial-scale=1"><body><main id="root"></main><script src="/bundle.js"></script></body></html>'); }
      const operation = routes[path]; if (!operation) { res.statusCode = 404; return res.end(); }
      const chunks = []; for await (const part of req) chunks.push(part);
      const response = await handlers[operation](new Request(appOrigin + req.url, { method: req.method, headers: req.headers,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) }));
      res.statusCode = response.status;
      response.headers.forEach((value, name) => { if (name !== "set-cookie") res.setHeader(name, value); });
      if (response.headers.getSetCookie().length) res.setHeader("set-cookie", response.headers.getSetCookie());
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.statusCode = 500; res.end("Synthetic fixture boundary failed"); }
  });
  await new Promise(resolve => web.listen(0, "127.0.0.1", resolve)); appOrigin = "https://127.0.0.1:" + web.address().port;
  const config = { enabled: true, deployment: "staging", issuer, appOrigin, clientId, clientSecret: secret, apiBase: issuer + "/mana", audience: "urn:vynvori:staging", callback: appOrigin + "/auth/tcm/callback" };
  const vault = credentialVault("synthetic", { synthetic: Buffer.alloc(32, 14) }), store = identityStateStore(pool);
  const authority = centralIdentityClient(config, (input, init) => { const url = new URL(String(input)); assert.equal(url.origin, issuer); return fetch(authorityOrigin + url.pathname, init); });
  const transactions = loginTransactions(config, store, vault);
  const privateClient = privateMedusaClient({ enabled: true, deployment: "local", origin: native.origin, projectId: process.env.M1B_MEDUSA_PROJECT_ID,
    proofKeyId: "synthetic", proofKeys: { synthetic: Buffer.alloc(32, 31) } }, async () => "synthetic-service-identity");
  const commerce = commerceIdentityCoordinator({ ...config, projectId: process.env.M1B_MEDUSA_PROJECT_ID }, commerceMappingStore(pool), privateClient, vault);
  const service = authSessionService(config, store, authority, transactions, vault, Date.now, commerce, privateClient);
  handlers = authHttpHandlers(config, service, transactions);
  const reconciler = revocationReconciler(config, store, authority, vault);
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  const checks = [], errors = [], leakedHeaders = [], payloads = [], observations = [];
  let lastCallback;
  async function session(letter) {
    control.subject = letter;
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } });
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.origin === issuer && url.pathname === "/oauth/authorize") { lastCallback = authorize(url); return route.fulfill({ status: 302, headers: { location: lastCallback } }); }
      if (url.origin !== appOrigin) { errors.push("unexpected-external-request"); return route.abort(); }
      const headers = await route.request().allHeaders(); if (headers.authorization || headers["x-serverless-authorization"] || headers["x-vynvori-bridge"] || headers["x-vynvori-customer-bearer"]) leakedHeaders.push("server-credential-header");
      return route.continue();
    });
    const page = await context.newPage(); page.on("pageerror", error => errors.push(error.name));
    page.on("response", response => { if (response.url().startsWith(appOrigin + "/api/")) observations.push(response.text().then(value => payloads.push(value)).catch(() => {})); });
    await page.goto(appOrigin + "/account"); await page.getByRole("button", { name: "Continue with TCM" }).click();
    await page.getByRole("button", { name: "Set up shopping profile" }).click();
    await page.getByText("browser-" + letter.toLowerCase() + "@example.invalid", { exact: true }).waitFor();
    await page.getByText("You have no orders yet.").waitFor(); return { context, page };
  }
  const post = (page, path, payload) => page.evaluate(async ({ path, payload }) => {
    const csrf = await (await fetch("/api/auth/csrf", { cache: "no-store" })).json();
    const result = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-vynvori-csrf": csrf.csrfToken }, body: JSON.stringify(payload), cache: "no-store" });
    return { status: result.status, value: await result.json() };
  }, { path, payload });
  stage = "browser-A-PKCE-native-customer";
  const a = await session("A"); checks.push("BROWSER_PKCE_CALLBACK_NATIVE_CUSTOMER_PROFILE_ORDERS");
  const cookies = await a.context.cookies(), appCookie = cookies.find(cookie => cookie.name === authCookies.session);
  assert.ok(appCookie?.httpOnly && appCookie.secure && appCookie.sameSite === "Lax"); assert.match(appCookie.value, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!cookies.some(cookie => cookie.name === authCookies.transaction)); assert.equal(await a.page.evaluate(() => document.cookie), "");
  assert.deepEqual(await a.page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]); checks.push("CHROME_SECURE_HTTPONLY_LAX_COOKIE_NO_TOKEN_STORAGE");
  assert.equal((await a.context.request.get(lastCallback, { maxRedirects: 0 })).status(), 400); assert.equal(control.exchanges, 1); checks.push("CALLBACK_REPLAY_NO_SECOND_EXCHANGE");
  const rowA = (await pool.query("SELECT id,generation,credentials_cipher,commerce_cipher FROM vynvori_identity.sessions WHERE token_hash=$1", [authSecretHash(appCookie.value)])).rows[0];
  assert.ok(rowA.commerce_cipher); assert.ok(rowA.credentials_cipher.startsWith("v1.synthetic."));
  stage = "refresh-and-session-generation";
  assert.equal((await post(a.page, "/api/auth/tcm/refresh", {})).status, 200); assert.equal(control.refreshes, 1);
  const rotated = (await pool.query("SELECT generation,commerce_cipher FROM vynvori_identity.sessions WHERE id=$1", [rowA.id])).rows[0];
  assert.equal(rotated.generation, 1); assert.equal(rotated.commerce_cipher, null);
  const profileAfterRefresh = await a.context.request.get(appOrigin + "/api/account/profile"); assert.equal(profileAfterRefresh.status(), 200);
  assert.equal((await profileAfterRefresh.json()).profile.email, "browser-a@example.invalid");
  assert.ok((await pool.query("SELECT commerce_cipher FROM vynvori_identity.sessions WHERE id=$1 AND generation=1", [rowA.id])).rows[0].commerce_cipher);
  const reloadedOrders = a.page.waitForResponse(response => response.url() === appOrigin + "/api/account/orders" && response.status() === 200);
  await a.page.getByRole("button", { name: "Reload details" }).click(); await reloadedOrders; checks.push("ONE_REFRESH_FENCES_GENERATION_AND_REPLACES_NATIVE_CREDENTIAL");
  stage = "browser-B-isolation-and-guest-claim";
  const b = await session("B"); assert.equal(await b.page.getByText("browser-a@example.invalid", { exact: true }).count(), 0);
  assert.equal((await b.context.request.get(appOrigin + "/api/account/profile?customerId=foreign")).status(), 400);
  const draft = randomUUID(), capability = opaqueAuthSecret(); await store.createGuestDraft(draft, authSecretHash(capability), new Date(Date.now() + 600000));
  assert.equal((await post(a.page, "/api/auth/guest/claim", { draftId: draft, capability })).status, 200);
  assert.equal((await post(b.page, "/api/auth/guest/claim", { draftId: draft, capability })).status, 403);
  assert.equal((await a.context.request.post(appOrigin + "/api/auth/logout", { data: {} })).status(), 403); checks.push("TWO_BROWSER_ACCOUNTS_GUEST_OWNERSHIP_AND_CSRF");
  stage = "logout-outage-and-reconciliation";
  control.failRevoke = true; await a.page.getByRole("button", { name: "Sign out", exact: true }).click(); await a.page.getByRole("button", { name: "Continue with TCM" }).waitFor();
  assert.ok(!(await a.context.cookies()).some(cookie => cookie.name === authCookies.session));
  assert.equal((await a.context.request.get(appOrigin + "/api/auth/session", { headers: { cookie: authCookies.session + "=" + appCookie.value } })).status(), 401);
  control.failRevoke = false; const reconciled = await reconciler.run(); assert.equal(reconciled.confirmed, 1);
  assert.equal((await b.context.request.get(appOrigin + "/api/account/profile")).status(), 200); checks.push("LOGOUT_OUTAGE_CLEARS_COOKIE_DENIES_OLD_COOKIE_RECONCILES_ONLY_OWN_SESSION");
  stage = "central-revocation-with-cached-native-token";
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM vynvori_identity.sessions WHERE commerce_cipher IS NOT NULL AND status='active'")).rows[0].n, 1);
  for (const family of families) if (family.subject === "B") family.revoked = true;
  await b.page.getByRole("button", { name: "Reload details" }).click(); await b.page.getByRole("button", { name: "Continue with TCM" }).waitFor(); checks.push("CENTRAL_REVOCATION_DENIES_CACHED_NATIVE_CREDENTIAL");
  await b.page.screenshot({ path: join(output, "revoked-account-mobile.png"), fullPage: true });
  stage = "lost-committed-refresh-response";
  const c = await session("C"), refreshBefore = control.refreshes; control.loseRefreshResponse = true;
  assert.equal((await post(c.page, "/api/auth/tcm/refresh", {})).status, 401); control.loseRefreshResponse = false;
  assert.equal(control.refreshes, refreshBefore + 1);
  await c.page.getByRole("button", { name: "Reload details" }).click(); await c.page.getByRole("button", { name: "Continue with TCM" }).waitFor();
  assert.equal((await reconciler.run()).confirmed, 1);
  assert.ok([...families].filter(family => family.subject === "C").every(family => family.revoked));
  assert.equal(control.refreshes, refreshBefore + 1); checks.push("LOST_COMMITTED_REFRESH_DENIES_SESSION_NO_RETRY_REVOKES_WITH_SPENT_TOKEN");
  stage = "browser-credential-leak-check";
  await Promise.all(observations); assert.deepEqual(errors, []); assert.deepEqual(leakedHeaders, []);
  for (const value of payloads) { for (const token of secrets) assert.ok(!value.includes(token)); assert.ok(!/"(?:access_token|refresh_token|credentialsCipher|customerToken|authIdentityId)"\s*:/.test(value)); }
  checks.push("NO_CENTRAL_NATIVE_OR_SERVICE_CREDENTIAL_IN_BROWSER_RESPONSES_OR_HEADERS");
  await a.context.close(); await b.context.close(); await c.context.close();
  const receipt = { status: "PASS_CONNECTED_LOCAL_BROWSER_BFF_AND_NATIVE_MEDUSA", checks, browser: await browser.version(), centralAuthority: "SYNTHETIC_PKCE_ROTATION_AND_REVOCATION_SERVER", web: "ACTUAL_REACT_COMPONENTS_AND_AUTH_HTTP_SOURCE_IN_LOCAL_HTTPS_FIXTURE", nextProductionBootstrap: "NOT_TESTED", native: "ACTUAL_SDK_ROUTER_PROVIDER_WORKFLOWS_AND_POSTGRES", creativeRuntime: "RESTRICTED_SELECT_INSERT_UPDATE_ONLY", localTls: "EPHEMERAL_SELF_SIGNED_CERT_BROWSER_IGNORE_ERRORS_LOCAL_FIXTURE_ONLY", actualIam: "NOT_TESTED", livePortal: false, deployment: false, output };
  await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n"); console.log("M1B_BROWSER_RECEIPT " + JSON.stringify(receipt));
} catch (error) { console.error("Synthetic connected browser failed at " + stage + "; code=" + (typeof error?.code === "string" ? error.code : "FIXTURE_FAILURE")); process.exitCode = 1; }
finally {
  if (browser) await browser.close();
  if (web) await new Promise(resolve => web.close(resolve));
  if (authorityServer) await new Promise(resolve => authorityServer.close(resolve));
  await pool.end();
}
