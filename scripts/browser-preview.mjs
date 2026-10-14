import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const require = createRequire(path.join(root,"design/reference/package.json"));
const { chromium } = require("playwright");
const url = new URL(process.argv[2]);
if (url.protocol !== "https:" || !url.hostname.endsWith(".vercel.app") || url.pathname !== "/") throw new Error("Provide the exact owned Preview origin.");
const base = url.origin;
const token = process.env.VERCEL_OIDC_TOKEN;
if (!token) throw new Error("Run with vercel env run to supply a short-lived development OIDC token.");
const output = await fs.mkdtemp(path.join(os.tmpdir(),"VYNVORI-M0-preview-browser-"));
const result = { url:base,date:new Date().toISOString(),checks:[],errors:[],externalRequests:[],failedAssets:[],screenshots:[] };
let browser;
try {
  // Never follow redirects or forward authentication to a different origin.
  const health = await fetch(base+"/api/health",{redirect:"manual",headers:{"x-vercel-trusted-oidc-idp-token":token}});
  assert.equal(health.status,200,"Protected Preview health did not return application HTTP 200.");
  assert.deepEqual(await health.json(),{status:"ok"});
  assert.match(health.headers.get("cache-control"),/no-store/);
  result.checks.push({name:"Authenticated remote health",status:"PASSED"});
  browser = await chromium.launch({headless:true,channel:"chrome"});
  const context = await browser.newContext();
  await context.route("**/*",async route => {
    if (new URL(route.request().url()).origin !== base) { result.externalRequests.push(new URL(route.request().url()).origin); await route.abort(); }
    else await route.continue({headers:{...route.request().headers(),"x-vercel-trusted-oidc-idp-token":token}});
  });
  const page = await context.newPage();
  page.on("pageerror",error=>result.errors.push(error.message));
  page.on("console",message=>{if(message.type()==="error")result.errors.push(message.text());});
  page.on("response",response=>{if(response.status()>=400)result.failedAssets.push({path:new URL(response.url()).pathname,status:response.status()});});
  const routes = ["/","/studio","/customize","/products/black-oversized-tshirt","/gallery"];
  for (const [width,height] of [[1440,900],[390,844]]) {
    await page.setViewportSize({width,height});
    for (const route of routes) {
      const response = await page.goto(base+route,{waitUntil:"networkidle"});
      assert.equal(response.status(),200);
      await page.evaluate(()=>document.fonts.ready);
      await page.waitForFunction(()=>[...document.images].every(img=>img.complete&&img.naturalWidth>0));
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      assert.match(await page.locator("body").evaluate(el=>getComputedStyle(el).fontFamily),/archivo/i);
      assert(await page.evaluate(()=>[...document.fonts].some(font=>font.status==="loaded")));
      assert(!(await page.content()).includes(token),"Authentication token appeared in rendered source.");
      if (route==="/studio") { assert(await page.getByRole("button",{name:/Guide Me/}).isDisabled()); assert(await page.getByRole("button",{name:/Create Freely/}).isDisabled()); }
      if (route==="/customize") { assert(await page.getByRole("button",{name:/Upload artwork/}).isDisabled()); assert.equal(await page.locator('input[type="file"]').count(),0); }
      if (route==="/gallery") assert(await page.getByRole("button",{name:"Publishing unavailable"}).isDisabled());
      if (route.includes("/products/")) assert(await page.getByRole("button",{name:"Purchasing unavailable"}).isDisabled());
      const file=`${route==="/"?"home":route.split("/").at(-1)}-${width}x${height}.png`;
      await page.screenshot({path:path.join(output,file),fullPage:true});result.screenshots.push(file);
      result.checks.push({name:`Remote route/font/assets/disabled state ${route} ${width}x${height}`,status:"PASSED"});
      console.log(`PASS remote ${route} ${width}x${height}`);
    }
  }
  assert.deepEqual(result.errors,[]);assert.deepEqual(result.externalRequests,[]);assert.deepEqual(result.failedAssets,[]);
  result.checks.push({name:"No runtime errors, failed assets or external requests",status:"PASSED"});
} catch (error) { result.checks.push({name:"Remote verification",status:"FAILED",error:error.message});process.exitCode=1; }
finally { await browser?.close(); await fs.writeFile(path.join(output,"results.json"),JSON.stringify(result,null,2)+"\n");console.log(`Remote evidence: ${output}`); }
