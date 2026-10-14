import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "design/reference/package.json"));
const { chromium } = require("playwright");
const axe = await fs.readFile(require.resolve("axe-core/axe.min.js"), "utf8");
const output = process.env.M0_EVIDENCE_DIR ?? await fs.mkdtemp(path.join(os.tmpdir(), "VYNVORI-M0-browser-"));
if (path.resolve(output).startsWith(root + path.sep)) throw new Error("Browser evidence must be outside the checkout.");
await fs.mkdir(output, { recursive: true });
const socket = net.createServer();
await new Promise(resolve => socket.listen(0, "127.0.0.1", resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, [path.join(root, "scripts/web.mjs"), "start", "--port", String(port), "--hostname", "127.0.0.1"], { cwd: root, env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" }, stdio: ["ignore", "pipe", "pipe"] });
let serverLog = "";
child.stdout.on("data", bytes => { serverLog += bytes; });
child.stderr.on("data", bytes => { serverLog += bytes; });
const result = { date: new Date().toISOString(), mode: "Next.js production build", base, browser: "", checks: [], screenshots: [], errors: [], externalRequests: [], failedAssets: [] };
async function check(name, fn) {
  try { await fn(); result.checks.push({ name, status: "PASSED" }); console.log(`PASS ${name}`); }
  catch (error) { result.checks.push({ name, status: "FAILED", error: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
}
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${serverLog}`);
    try { const response = await fetch(base + "/api/health"); if (response.ok) { ready = true; break; } } catch { /* process may still be starting */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert(ready, "Production startup timed out");
  await check("HTTP health is minimal, uncached process liveness", async () => {
    const response = await fetch(base + "/api/health");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
    assert.match(response.headers.get("cache-control"), /no-store/);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  });
  browser = await chromium.launch(process.env.M0_BROWSER === "chromium" ? { headless: true } : { headless: true, channel: "chrome" });
  result.browser = await browser.version();
  const context = await browser.newContext();
  await context.route("**/*", async route => {
    if (new URL(route.request().url()).origin !== base) { result.externalRequests.push(route.request().url()); await route.abort(); }
    else await route.continue();
  });
  const page = await context.newPage();
  page.on("pageerror", error => result.errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") result.errors.push(message.text()); });
  page.on("response", response => { if (response.status() >= 400 && /\/_next\/|\/assets\//.test(response.url())) result.failedAssets.push(response.url()); });
  const routes = [["/", "WEAR WHAT"], ["/studio", "A COLLECTION"], ["/customize", "YOUR ART"], ["/products/black-oversized-tshirt", "THE BLACK"], ["/gallery", "PERSONAL FIRST"]];
  const viewports = [[320,480],[320,640],[390,568],[390,844],[768,1024],[1440,900],[1920,1080],[2560,1440],[3440,1440]];
  for (const [width,height] of viewports) {
    await page.setViewportSize({ width,height });
    for (const [route,heading] of routes) {
      await check(`Route, layout, assets and WCAG axe ${route} ${width}x${height}`, async () => {
        const response = await page.goto(base + route, { waitUntil: "networkidle" });
        assert.equal(response.status(), 200);
        await page.getByRole("heading", { level: 1 }).filter({ hasText: heading }).waitFor();
        await page.evaluate(() => document.fonts.ready);
        await page.waitForFunction(() => [...document.images].every(img => img.complete && img.naturalWidth > 0));
        const layout = await page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
          font: document.fonts.check('16px "' + getComputedStyle(document.body).fontFamily.split(',')[0].replaceAll('"','') + '"'),
          images: [...document.querySelectorAll("img")].every(img => img.complete && img.naturalWidth > 0),
        }));
        assert.equal(layout.overflow, false); assert(layout.font); assert(layout.images);
        if (width>=1440) {
          const framing = await page.evaluate(() => {
            const frame = selector => { const r=document.querySelector(selector).getBoundingClientRect(); return {left:r.left,width:r.width}; };
            const mark=document.querySelector(".wordmark")?.getBoundingClientRect();
            const media=document.querySelector(".campaign > img")?.getBoundingClientRect();
            return {frames:["main",".site-header",".preview-strip",".site-footer"].map(frame),wordmarkRatio:mark ? mark.width/mark.height : null,campaignRight:media?.right};
          });
          assert(framing.frames.every(frame=>Math.abs(frame.left)<1&&Math.abs(frame.width-width)<1),"Desktop site is boxed inside a centered frame");
          if (route==="/") { assert(Math.abs(framing.wordmarkRatio-2286.82/320)<0.01); assert(Math.abs(framing.campaignRight-width)<1); }
        }
        await page.addScriptTag({ content: axe });
        const audit = await page.evaluate(async () => window.axe.run(document, { runOnly: { type: "tag", values: ["wcag2a","wcag2aa","wcag21aa","wcag22aa"] } }));
        assert.deepEqual(audit.violations.map(v => ({ id:v.id, nodes:v.nodes.map(n => n.target) })), []);
        const filename = `${route === "/" ? "home" : route.split("/").at(-1)}-${width}x${height}.png`;
        await page.screenshot({ path: path.join(output, filename), fullPage: true });
        result.screenshots.push(filename);
      });
    }
  }
  await check("Keyboard mobile menu opens, navigates, closes and restores Escape focus", async () => {
    await page.setViewportSize({ width:320,height:480 }); await page.goto(base, { waitUntil:"networkidle" });
    await page.keyboard.press("Tab"); assert.equal(await page.locator(":focus").innerText(), "Skip to content");
    const focus = await page.locator(":focus").evaluate(el => ({ style:getComputedStyle(el).outlineStyle,width:getComputedStyle(el).outlineWidth }));
    assert.notEqual(focus.style,"none"); assert.equal(focus.width,"3px");
    await page.keyboard.press("Enter"); assert.equal(await page.locator(":focus").getAttribute("id"),"main");
    const menu = page.getByRole("button", { name:"Menu",exact:true });
    await menu.focus(); await page.keyboard.press("Enter"); assert.equal(await menu.getAttribute("aria-expanded"),"true");
    await page.keyboard.press("Tab"); assert.equal(await page.locator(":focus").innerText(),"Shop");
    await page.keyboard.press("Escape"); assert.equal(await menu.getAttribute("aria-expanded"),"false"); assert(await menu.evaluate(el=>el===document.activeElement));
    for (const [label,route] of [["Shop","/products/black-oversized-tshirt"],["AI Design Studio","/studio"],["Customize","/customize"],["Community","/gallery"],["Account","/account"]]) {
      await menu.click(); await page.getByRole("navigation",{name:"Main navigation"}).getByRole("link",{name:label,exact:true}).click();
      await page.waitForURL(base+route); assert.equal(await menu.getAttribute("aria-expanded"),"false");
    }
    await page.getByRole("link",{name:/Cart — unavailable/}).click(); await page.waitForURL(base+"/cart");
    assert.match(await page.locator("main").innerText(), /No selections, prices, payments or orders/);
  });
  await check("Studio/BYO are independent and all unavailable operations stay disabled", async () => {
    await page.goto(base+"/studio");
    assert(await page.getByRole("button",{name:/Guide Me/}).isDisabled());
    assert(await page.getByRole("button",{name:/Create Freely/}).isDisabled());
    await page.locator("main").getByRole("link",{name:/Bring Your Own Art/}).click(); await page.waitForURL(base+"/customize");
    assert(await page.getByRole("button",{name:/Upload artwork/}).isDisabled());
    assert.equal(await page.locator('input[type="file"]').count(),0);
    assert.match(await page.locator("main").innerText(),/No AI credits required/);
    await page.goto(base+"/gallery"); assert(await page.getByRole("button",{name:"Publishing unavailable"}).isDisabled());
    await page.goto(base+"/products/black-oversized-tshirt"); assert(await page.getByRole("button",{name:"Purchasing unavailable"}).isDisabled());
  });
  await check("Reduced motion and 200% text remain usable at 320px", async () => {
    await page.emulateMedia({ reducedMotion:"reduce" });
    for (const [route] of routes) {
      await page.goto(base+route,{waitUntil:"networkidle"});
      await page.evaluate(() => {
        const elements = [...document.querySelectorAll("h1,h2,p,a,button,dt,dd,summary,figcaption,span")];
        const sizes = elements.map(el => parseFloat(getComputedStyle(el).fontSize));
        elements.forEach((el,index) => { el.style.fontSize = `${sizes[index]*2}px`; });
      });
      const overflow = await page.evaluate(() => ({ width:innerWidth, scroll:document.documentElement.scrollWidth, elements:[...document.querySelectorAll("body *")].filter(el => el.getBoundingClientRect().right > innerWidth+1).map(el => ({ tag:el.tagName, class:el.className,text:el.textContent.slice(0,60) })) }));
      assert(overflow.scroll <= overflow.width+1, `${route}: ${JSON.stringify(overflow)}`);
      assert.equal(await page.locator(".button").first().evaluate(el=>getComputedStyle(el).transitionDuration),"0s");
    }
  });
  await check("Missing route and unknown product return real 404 states", async () => {
    for (const route of ["/not-a-page","/products/not-a-product"]) {
      const response = await fetch(base+route); assert.equal(response.status,404);
      assert.match(await response.text(),/THIS PAGE IS NOT HERE/);
    }
  });
  await check("No fatal runtime errors, missing assets or external requests", async () => {
    assert.deepEqual(result.errors,[]); assert.deepEqual(result.failedAssets,[]); assert.deepEqual(result.externalRequests,[]);
  });
} catch (error) { result.checks.push({ name:"Harness startup",status:"FAILED",error:error.message }); console.error(error); }
finally {
  await browser?.close();
  child.kill("SIGTERM");
  await fs.writeFile(path.join(output,"server.log"),serverLog);
  await fs.writeFile(path.join(output,"results.json"),JSON.stringify(result,null,2)+"\n");
  const passed = result.checks.filter(c=>c.status==="PASSED").length;
  console.log(`${passed}/${result.checks.length} checks passed. Evidence: ${output}`);
  if (passed !== result.checks.length) process.exitCode = 1;
}
