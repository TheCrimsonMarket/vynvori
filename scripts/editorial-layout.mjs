import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "design/reference/package.json"));
const { chromium } = require("playwright");
const url = new URL(process.argv[2]);
const baseline = process.argv.includes("--baseline");
const remote = url.protocol === "https:" && url.hostname.endsWith(".vercel.app");
if (!remote && !["127.0.0.1", "localhost"].includes(url.hostname)) throw new Error("Use the owned Preview or local production server.");
const token = remote ? process.env.VERCEL_OIDC_TOKEN : undefined;
if (remote && !token) throw new Error("Use vercel env run for protected Preview access.");
const output = await fs.mkdtemp(path.join(os.tmpdir(), baseline ? "VYNVORI-editorial-before-" : "VYNVORI-editorial-after-"));
const result = { mode:baseline ? "deployed M0 baseline" : "corrected production layout", url:url.origin, date:new Date().toISOString(), checks:[], screenshots:[], errors:[], externalRequests:[] };
const browser = await chromium.launch(process.env.M0_BROWSER === "chromium" ? {headless:true} : {headless:true,channel:"chrome"});
try {
  const context = await browser.newContext();
  await context.route("**/*", async route => {
    if (new URL(route.request().url()).origin !== url.origin) { result.externalRequests.push(new URL(route.request().url()).origin); await route.abort(); }
    else await route.continue(token ? {headers:{...route.request().headers(),"x-vercel-trusted-oidc-idp-token":token}} : {});
  });
  const page = await context.newPage();
  page.on("pageerror", error => result.errors.push(error.message));
  const viewports = baseline ? [[2560,1440]] : [[2560,1440],[1920,1080],[1440,900],[3440,1440],[768,1024],[390,844],[320,640]];
  const routes = baseline ? ["/"] : ["/","/studio","/customize","/products/black-oversized-tshirt","/gallery"];
  for (const [width,height] of viewports) {
    await page.setViewportSize({width,height});
    for (const route of routes) {
      const response = await page.goto(url.origin+route,{waitUntil:"networkidle"});
      assert.equal(response.status(),200);
      await page.evaluate(()=>document.fonts.ready);
      await page.waitForFunction(()=>[...document.images].every(img=>img.complete&&img.naturalWidth>0));
      const metrics = await page.evaluate(() => {
        const rect = el => { const r=el.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}; };
        const box = selector => { const el=document.querySelector(selector); return el ? rect(el) : null; };
        return {viewport:innerWidth,scroll:document.documentElement.scrollWidth,main:box("main"),header:box(".site-header"),strip:box(".preview-strip"),footer:box(".site-footer"),wordmark:box(".wordmark"),rail:box(".home-rail"),campaign:box(".campaign > img"),entries:[...document.querySelectorAll(".journey-entry .button")].map(rect),ledeWidths:[...document.querySelectorAll(".lede")].map(el=>el.getBoundingClientRect().width)};
      });
      if (!baseline) {
        assert(metrics.scroll<=width+1, `Overflow on ${route} at ${width}`);
        for (const role of ["main","header","strip","footer"]) {
          assert(Math.abs(metrics[role].left)<1 && Math.abs(metrics[role].width-width)<1, `${role} still boxed on ${route} at ${width}`);
        }
        assert(metrics.ledeWidths.every(w=>w<=661),"Readable text became viewport-wide");
        if (route==="/") {
          assert(Math.abs(metrics.wordmark.width/metrics.wordmark.height-2286.82/320)<0.01,"Wordmark proportions changed");
          if (width>=1440) { assert(Math.abs(metrics.campaign.right-width)<1,"Hero media does not reach the right edge"); assert(metrics.campaign.height>=height*0.45,"Hero media remains too short"); }
          if (width===2560) { assert.equal(metrics.entries.length,2);assert(metrics.entries.every(entry=>entry.bottom<=height),"Primary entry CTA is cut by the founder target viewport");assert(Math.abs(metrics.entries[0].width-metrics.entries[1].width)<1,"AI/BYO entries are unbalanced"); }
        }
      }
      result.checks.push({route,width,height,status:baseline ? "BASELINE_RECORDED" : "PASSED",metrics});
      if (route==="/" || width===2560) {
        const name=`${route==="/"?"home":route.split("/").at(-1)}-${width}x${height}`;
        await page.screenshot({path:path.join(output,name+".png"),fullPage:true});result.screenshots.push(name+".png");
        if (route==="/") { await page.screenshot({path:path.join(output,name+"-viewport.png")});result.screenshots.push(name+"-viewport.png"); }
      }
      console.log(`${baseline?"BASELINE":"PASS"} ${route} ${width}x${height}`);
    }
  }
  assert.deepEqual(result.errors,[]);assert.deepEqual(result.externalRequests,[]);
} catch (error) { result.checks.push({status:"FAILED",error:error.message});process.exitCode=1;console.error(error.message); }
finally { await browser.close();await fs.writeFile(path.join(output,"results.json"),JSON.stringify(result,null,2)+"\n");console.log(`Editorial evidence: ${output}`); }
