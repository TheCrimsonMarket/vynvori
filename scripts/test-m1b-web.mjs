// Checks the real built Next application with all identity/commerce flags OFF.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
const root = fileURLToPath(new URL("..", import.meta.url)), output = await mkdtemp(join(tmpdir(), "VYNVORI-M1b-web-"));
const { chromium } = createRequire(new URL("../design/reference/package.json", import.meta.url))("playwright");
const socket = net.createServer(); await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve)); const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["scripts/web.mjs", "start", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: root, windowsHide: true,
  env: { ...process.env, VYNVORI_IDENTITY_CENTRAL_SSO: "false", NEXT_TELEMETRY_DISABLED: "1" }, stdio: ["ignore", "pipe", "pipe"] });
let logs = "", browser;
child.stdout.on("data", chunk => { logs += chunk; }); child.stderr.on("data", chunk => { logs += chunk; });
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error("Local Next server exited");
    try { if ((await fetch(base + "/api/health")).ok) { ready = true; break; } } catch { /* bounded startup observation */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready);
  const checks = [];
  for (const [path, method] of [["/api/auth/csrf", "GET"], ["/api/auth/session", "GET"], ["/api/auth/tcm/start", "POST"], ["/auth/tcm/callback", "GET"], ["/api/auth/tcm/refresh", "POST"], ["/api/auth/logout", "POST"], ["/api/auth/commerce", "POST"], ["/api/auth/guest/claim", "POST"], ["/api/account/profile", "GET"], ["/api/account/orders", "GET"], ["/api/account/cart", "GET"]]) {
    const response = await fetch(base + path, { method, redirect: "manual" });
    assert.equal(response.status, 503); assert.equal((await response.json()).error.code, "AUTH_DISABLED");
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
    assert.ok(!response.headers.getSetCookie().some(value => value.startsWith("__Host-vynvori_session=")));
    checks.push(path);
  }
  browser = await chromium.launch({ headless: true, channel: "chrome" });
  const context = await browser.newContext(), external = [], errors = [];
  await context.route("**/*", route => { if (new URL(route.request().url()).origin !== base) { external.push("unexpected-external-request"); return route.abort(); } return route.continue(); });
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.name));
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    await page.setViewportSize({ width, height });
    const response = await page.goto(base + "/account", { waitUntil: "networkidle" }); assert.equal(response.status(), 200);
    await page.getByRole("heading", { name: "ACCOUNT, COMING LATER." }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Continue with TCM" }).count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: join(output, `account-disabled-${width}.png`), fullPage: true });
  }
  assert.deepEqual(external, []); assert.deepEqual(errors, []);
  const receipt = { status: "PASS_BUILT_WEB_DISABLED_BOUNDARY", routes: checks, browser: await browser.version(), viewports: 2, activeIdentityBrowserFlow: "NOT_TESTED", deployment: false, output };
  await writeFile(join(output, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n"); console.log(JSON.stringify(receipt));
} finally {
  if (browser) await browser.close(); child.kill("SIGTERM");
  await writeFile(join(output, "server.private.log"), logs);
}
