// Real React account components with synthetic BFF responses. No Portal, Medusa or deployed browser session.
import assert from "node:assert/strict";
import http from "node:http";
import { createRequire } from "node:module";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const root = fileURLToPath(new URL("..", import.meta.url));
const { chromium } = createRequire(new URL("../design/reference/package.json", import.meta.url))("playwright");
const output = await mkdtemp(join(tmpdir(), "VYNVORI-M1b-account-ui-"));
const bundle = await build({ stdin: { contents: 'import {createRoot} from "react-dom/client"; import {AuthPanel} from "./apps/web/src/components/auth-panel"; createRoot(document.getElementById("root")).render(<AuthPanel/>);', loader: "tsx", resolveDir: root },
  tsconfig: join(root, "apps/web/tsconfig.json"), bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
let mode = "ready", ready = false, calls = [], delayed, release;
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/bundle.js") { response.setHeader("content-type", "text/javascript"); return response.end(bundle.outputFiles[0].text); }
  if (url.pathname === "/") { response.setHeader("content-type", "text/html"); return response.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local synthetic account test</title><body><main id="root"></main><script src="/bundle.js"></script></body></html>'); }
  calls.push({ path: url.pathname, method: request.method });
  response.setHeader("content-type", "application/json"); response.setHeader("cache-control", "no-store");
  const send = (status, value) => { response.statusCode = status; response.end(JSON.stringify(value)); };
  if (url.pathname === "/api/auth/session") return send(mode === "signed-out" ? 401 : 200, { authenticated: mode !== "signed-out" });
  if (url.pathname === "/api/auth/csrf") return send(200, { csrfToken: "s".repeat(43) });
  if (url.pathname === "/api/auth/tcm/start") return send(200, { authorizeUrl: "https://unexpected.invalid/oauth/authorize" });
  if (url.pathname === "/api/auth/logout") { release?.(); return send(200, { localRevoked: true, upstream: "confirmed" }); }
  if (url.pathname === "/api/account/profile") {
    if (mode === "late") { delayed?.(); await new Promise(resolve => { release = resolve; }); }
    if (mode === "expired") return send(401, { error: { code: "AUTH_REAUTH_REQUIRED" } });
    if (mode === "unavailable") return send(503, { error: { code: "AUTH_UNAVAILABLE" } });
    if (["setup", "contact", "conflict"].includes(mode) && !ready) return send(409, { error: { code: "AUTH_COMMERCE_SETUP_REQUIRED" } });
    return send(200, { profile: { email: "synthetic@example.invalid", firstName: "Synthetic", lastName: "Account" } });
  }
  if (url.pathname === "/api/account/orders") return send(200, { orders: [], hasMore: false });
  if (url.pathname === "/api/auth/commerce") {
    let body = ""; for await (const part of request) body += part;
    const data = JSON.parse(body); calls.at(-1).action = data.action;
    if (mode === "contact") return send(409, { error: { code: "AUTH_CONTACT_REQUIRED" } });
    if (mode === "conflict") return send(409, { state: "conflict" });
    if (data.action === "ensure") return send(202, { state: "reconcile_required" });
    assert.equal(data.action, "reconcile"); ready = true; return send(200, { state: "ready" });
  }
  send(404, {});
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const checks = [], errors = [], external = [];
  async function scenario(name, run) {
    mode = name; ready = false; calls = []; release = undefined;
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route("**/*", route => { if (new URL(route.request().url()).origin !== origin) { external.push("UNEXPECTED_EXTERNAL"); return route.abort(); } return route.continue(); });
    const page = await context.newPage(); page.on("pageerror", error => errors.push(error.name));
    try { await page.goto(origin); await run(page); checks.push(name); }
    finally { release?.(); await context.close(); }
  }
  await scenario("ready", async page => {
    await page.getByText("synthetic@example.invalid", { exact: true }).waitFor();
    await page.getByText("You have no orders yet.").waitFor();
    assert.equal(calls.filter(c => c.path === "/api/auth/commerce").length, 0);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByRole("button", { name: "Continue with TCM" }).waitFor();
    assert.equal(await page.getByText("synthetic@example.invalid", { exact: true }).count(), 0);
    await page.screenshot({ path: join(output, "signed-out-mobile.png") });
  });
  await scenario("setup", async page => {
    await page.getByRole("button", { name: "Set up shopping profile" }).waitFor();
    assert.equal(calls.filter(c => c.path === "/api/auth/commerce").length, 0);
    await page.getByRole("button", { name: "Set up shopping profile" }).click();
    await page.getByRole("button", { name: "Check setup status" }).click();
    await page.getByText("You have no orders yet.").waitFor();
    assert.deepEqual(calls.filter(c => c.path === "/api/auth/commerce").map(c => c.action), ["ensure", "reconcile"]);
    await page.screenshot({ path: join(output, "profile-ready-mobile.png"), fullPage: true });
  });
  await scenario("contact", async page => {
    await page.getByRole("button", { name: "Set up shopping profile" }).click();
    await page.getByText("Add a contact email", { exact: false }).waitFor();
    await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
  });
  await scenario("conflict", async page => {
    await page.getByRole("button", { name: "Set up shopping profile" }).click();
    await page.getByText("We could not safely connect", { exact: false }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Check setup status" }).count(), 0);
  });
  await scenario("unavailable", async page => { await page.getByRole("button", { name: "Reload details" }).waitFor(); });
  await scenario("expired", async page => {
    await page.getByRole("button", { name: "Continue with TCM" }).waitFor();
    assert.equal(await page.getByRole("region", { name: "Account details" }).count(), 0);
  });
  await scenario("signed-out", async page => {
    await page.getByRole("button", { name: "Continue with TCM" }).click();
    await page.getByText("Sign-in is temporarily unavailable.", { exact: false }).waitFor();
    assert.equal(page.url(), origin + "/");
  });
  const waiting = new Promise(resolve => { delayed = resolve; });
  await scenario("late", async page => {
    await waiting;
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByRole("button", { name: "Continue with TCM" }).waitFor();
    assert.equal(await page.getByText("synthetic@example.invalid", { exact: true }).count(), 0);
    assert.equal(calls.filter(c => c.path === "/api/account/orders").length, 0);
  });
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  const receipt = { status: "PASS_REACT_COMPONENTS_SYNTHETIC_BFF", scenarios: checks, browser: await browser.version(), realOAuth: false, realBackend: false, deployment: false, output };
  await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n"); console.log(JSON.stringify(receipt));
} finally { release?.(); if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
