import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ENGINES, launchEngine, resolveEngine } from "../browser-engine.mjs";

const harness = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../browser-web.mjs");

test("unset selects the chrome channel; the four known engines resolve", () => {
  assert.equal(resolveEngine(undefined).launch.channel, "chrome");
  for (const name of ["chrome", "chromium", "firefox", "webkit"]) assert.equal(resolveEngine(name).name, name);
  assert.equal(resolveEngine("chromium").launch.channel, undefined);
  assert.deepEqual(Object.keys(ENGINES), ["chrome", "chromium", "firefox", "webkit"]);
});

test("any other value is rejected, never defaulted", () => {
  for (const bad of ["", "Chrome", "chromium ", "edge", "safari", "msedge", "constructor", "__proto__", "all", "0"]) {
    assert.throws(() => resolveEngine(bad), /Unsupported M0_BROWSER/, JSON.stringify(bad));
  }
});

test("launchEngine uses the matching Playwright launcher", async () => {
  const calls = [];
  const fake = Object.fromEntries(["chromium", "firefox", "webkit"].map(type => [type, { launch: async options => { calls.push([type, options]); return {}; } }]));
  await launchEngine(fake, resolveEngine("firefox"));
  await launchEngine(fake, resolveEngine("webkit"));
  await launchEngine(fake, resolveEngine("chrome"));
  assert.deepEqual(calls, [["firefox", { headless: true }], ["webkit", { headless: true }], ["chromium", { headless: true, channel: "chrome" }]]);
});

test("the harness exits non-zero before starting a server when the engine is unknown", () => {
  const run = spawnSync(process.execPath, [harness], { env: { ...process.env, M0_BROWSER: "netscape" }, encoding: "utf8", timeout: 30_000 });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Unsupported M0_BROWSER "netscape"/);
});
