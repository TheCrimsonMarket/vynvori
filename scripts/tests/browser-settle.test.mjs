import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { loadLazyImages } from "../browser-settle.mjs";

// M3 C1c. Needs Chromium through the repository's Playwright (not wired into an npm script: package.json is outside C1c).
// Run: node --test scripts/tests/browser-settle.test.mjs
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { chromium } = createRequire(path.join(root, "design/reference/package.json"))("playwright");
// 1x1 transparent GIF, served from memory: no network, no files.
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const HTML = `<!doctype html><body style="margin:0"><div style="height:60000px"></div><img id="far" loading="lazy" src="/pixel.gif" width="40" height="40" alt=""></body>`;

async function withPage(run) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.route("**/*", route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/pixel.gif") return route.fulfill({ status: 200, contentType: "image/gif", body: PIXEL });
      return route.fulfill({ status: 200, contentType: "text/html", body: HTML });
    });
    await page.setViewportSize({ width: 320, height: 480 });
    await page.goto("http://lazy.test/");
    return await run(page);
  } finally { await browser.close(); }
}
const loaded = page => page.evaluate(() => { const i = document.getElementById("far"); return i.complete && i.naturalWidth > 0; });

test("control: a lazy image far below the fold does not load by itself (the wait in the harness would time out)", async () => {
  await withPage(async page => {
    await page.waitForTimeout(500);
    assert.equal(await loaded(page), false);
  });
});

test("loadLazyImages loads it, returns to the top, and leaves the assertion unchanged", async () => {
  await withPage(async page => {
    await loadLazyImages(page);
    await page.waitForFunction(() => [...document.images].every(img => img.complete && img.naturalWidth > 0), undefined, { timeout: 5000 });
    assert.equal(await loaded(page), true);
    assert.equal(await page.evaluate(() => scrollY), 0);
  });
});
