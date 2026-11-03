// Interactive /customize editor scenarios for scripts/browser-web.mjs.
// Flags-OFF only: no cookies, identity, save, upload, freeze or restore is exercised, and no product-code seam is used.
// Every scenario starts from a freshly loaded page so a failure never cascades into the next one.
import assert from "node:assert/strict";
import path from "node:path";

export const EDITOR_VIEWPORTS = [[1280, 900], [390, 844], [320, 640]];
const near = (a, b) => Math.abs(a - b) < 0.0005;
async function until(read, describe, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try { last = await read(); if (last === true) return; } catch (error) { last = error.message; }
    if (Date.now() > deadline) throw new Error(`Timed out: ${describe} (last: ${String(last)})`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

export async function runEditorScenarios({ page, base, check, output, result }) {
  const layers = () => page.locator('svg.ed-canvas g[role="button"]');
  const rows = () => page.getByRole("list", { name: "Layers, top first" }).getByRole("listitem");
  const field = label => page.getByLabel(label, { exact: true });
  const num = async label => Number(await field(label).inputValue());
  const count = (locator, expected, describe) => until(async () => (await locator.count()) === expected, `${describe} = ${expected}`);
  const value = (label, expected) => until(async () => near(await num(label), expected), `${label} = ${expected}`);
  const rowFor = text => rows().filter({ hasText: text });
  const noOverflow = async where => {
    const o = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth }));
    assert(o.scroll <= o.width + 1, `${where}: horizontal overflow ${o.scroll} > ${o.width}`);
  };
  async function open(width, height) {
    await page.setViewportSize({ width, height });
    await page.goto(`${base}/customize`, { waitUntil: "networkidle" });
    await page.getByRole("region", { name: "Garment composition editor" }).waitFor();
    // Wait for React hydration by inspecting the DOM node React attaches props to; nothing in product code is involved.
    await page.waitForFunction(() => { const b = [...document.querySelectorAll("button")].find(e => e.textContent === "Add text"); return !!b && Object.keys(b).some(k => k.startsWith("__reactProps")); });
    await count(layers(), 0, "initial layers");
  }
  const addText = async (text, expectedLayers) => {
    await page.getByRole("button", { name: "Add text", exact: true }).click();
    await count(layers(), expectedLayers, "canvas layers");
    if (text) { await field("Text content").fill(text); await until(async () => (await field("Text content").inputValue()) === text, "text content applied"); }
  };
  async function focusFirstLayerByTab() {
    await page.getByRole("tab", { name: "BACK", exact: true }).focus();
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press("Tab");
      if (await page.evaluate(() => document.activeElement?.closest?.("svg.ed-canvas") !== null && document.activeElement?.getAttribute("role") === "button")) return;
    }
    throw new Error("Tab never reached a canvas layer");
  }

  const scenarios = [
    ["Flags OFF: upload and saving are unavailable and say so", async () => {
      assert(await page.getByRole("button", { name: /Upload artwork — unavailable/ }).isDisabled());
      assert.equal(await page.locator('input[type="file"]').count(), 0);
      await page.getByText("Artwork upload is not enabled in this preview.", { exact: false }).waitFor();
      await page.getByRole("heading", { name: "Preview checks" }).waitFor();
      assert.match(await page.getByRole("status").innerText(), /^\s*$/); // nothing is claimed saved
    }],
    ["Add text layer shows it on canvas, in the list and selected", async () => {
      await addText(null, 1);
      assert.match(await layers().first().getAttribute("aria-label"), /^Text layer: YOUR TEXT, x /);
      await count(rows(), 1, "list rows");
      await page.getByRole("group", { name: "Selected layer" }).waitFor();
      assert.equal(await layers().first().getAttribute("aria-pressed"), "true");
    }],
    ["Tab reaches a layer; arrow, Shift and Alt nudge by 1, 10 and 0.1 mm with coordinates read back", async () => {
      await addText(null, 1);
      const x0 = await num("X (mm)"), y0 = await num("Y (mm)");
      await focusFirstLayerByTab();
      await page.keyboard.press("ArrowRight"); await value("X (mm)", x0 + 1);
      assert.match(await layers().first().getAttribute("aria-label"), new RegExp(`x ${x0 + 1} y ${y0} millimetres`));
      await page.keyboard.press("Shift+ArrowRight"); await value("X (mm)", x0 + 11);
      await page.keyboard.press("Alt+ArrowRight"); await value("X (mm)", x0 + 11.1);
      await page.keyboard.press("ArrowDown"); await value("Y (mm)", y0 + 1);
      await page.keyboard.press("Shift+ArrowUp"); await value("Y (mm)", y0 - 9);
      await page.keyboard.press("Alt+ArrowDown"); await value("Y (mm)", y0 - 8.9);
      await value("X (mm)", x0 + 11.1);
    }],
    ["Numeric X, Y, Width, Height and Rotation edits keep 1 micrometre precision", async () => {
      await addText(null, 1);
      for (const [label, typed, expected] of [["X (mm)", "12.345", 12.345], ["Y (mm)", "30.0004", 30], ["Width (mm)", "40.5", 40.5], ["Height (mm)", "20.0006", 20.001], ["Rotation (°)", "15", 15], ["X (mm)", "12,3456", 12.346]]) {
        await field(label).fill(typed); await field(label).press("Enter");
        await value(label, expected);
      }
      await field("X (mm)").fill("abc"); await field("X (mm)").press("Enter");
      await value("X (mm)", 12.346); // invalid input is rejected and the previous value restored
      await page.getByText("X: enter a number.").waitFor();
    }],
    ["Reorder up/down changes list order", async () => {
      await addText("ALPHA", 1); await addText("BRAVO", 2);
      const order = () => rows().evaluateAll(items => items.map(item => item.querySelector(".ed-layer-name")?.textContent ?? ""));
      assert.match((await order())[0], /BRAVO/); assert.match((await order())[1], /ALPHA/);
      await rowFor("BRAVO").getByRole("button", { name: "Move down" }).click();
      await until(async () => /ALPHA/.test((await order())[0]), "ALPHA on top");
      await rowFor("BRAVO").getByRole("button", { name: "Move up" }).click();
      await until(async () => /BRAVO/.test((await order())[0]), "BRAVO on top again");
    }],
    ["Hide and show a layer", async () => {
      await addText("ALPHA", 1); await addText("BRAVO", 2);
      await rowFor("BRAVO").getByRole("button", { name: "Hide layer" }).click();
      await count(layers(), 1, "visible canvas layers"); await count(rows(), 2, "list rows");
      await rowFor("BRAVO").getByRole("button", { name: "Show layer" }).click();
      await count(layers(), 2, "visible canvas layers");
    }],
    ["Duplicate offsets by 5 mm and selects the copy; delete removes it", async () => {
      await addText("ALPHA", 1);
      const x0 = await num("X (mm)"), y0 = await num("Y (mm)");
      await page.getByRole("button", { name: "Duplicate", exact: true }).click();
      await count(layers(), 2, "canvas layers");
      await value("X (mm)", x0 + 5); await value("Y (mm)", y0 + 5);
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      await count(layers(), 1, "canvas layers");
      await count(page.getByRole("group", { name: "Selected layer" }), 0, "selected-layer panel");
    }],
    ["Undo and redo step through add, edit and delete", async () => {
      const undo = page.getByRole("button", { name: "Undo", exact: true }), redo = page.getByRole("button", { name: "Redo", exact: true });
      assert(await undo.isDisabled()); assert(await redo.isDisabled());
      await addText(null, 1);
      const x0 = await num("X (mm)");
      await field("X (mm)").fill("77"); await field("X (mm)").press("Enter"); await value("X (mm)", 77);
      await page.getByRole("button", { name: "Delete", exact: true }).click(); await count(layers(), 0, "canvas layers");
      await undo.click(); await count(layers(), 1, "canvas layers after undo of delete");
      await page.getByRole("button", { name: /^Text · / }).click(); await value("X (mm)", 77);
      await undo.click(); await page.getByRole("button", { name: /^Text · / }).click(); await value("X (mm)", x0);
      await undo.click(); await count(layers(), 0, "canvas layers after undo of add");
      assert(await undo.isDisabled());
      await redo.click(); await redo.click(); await redo.click(); await count(layers(), 0, "canvas layers after redo of delete");
      assert(await redo.isDisabled());
    }],
    ["Front and back sides hold independent layers", async () => {
      await addText("FRONTONLY", 1);
      await page.getByRole("tab", { name: "BACK", exact: true }).click();
      await until(async () => (await page.getByRole("tab", { name: "BACK", exact: true }).getAttribute("aria-selected")) === "true", "BACK selected");
      await count(layers(), 0, "back canvas layers"); await page.getByText("No layers yet.").waitFor();
      await addText("BACKONLY", 1);
      await page.getByRole("tab", { name: "FRONT", exact: true }).click();
      await count(layers(), 1, "front canvas layers"); await count(rowFor("FRONTONLY"), 1, "front row"); await count(rowFor("BACKONLY"), 0, "back row hidden");
      await page.getByRole("tab", { name: "BACK", exact: true }).click();
      await count(rowFor("BACKONLY"), 1, "back row"); await count(rowFor("FRONTONLY"), 0, "front row hidden");
    }],
    ["Out-of-bounds layer is reported in Preview checks and clears when moved back", async () => {
      await addText(null, 1);
      const issues = page.getByRole("heading", { name: "Preview checks" }).locator("xpath=..").locator("ul.ed-issues");
      await count(issues.getByText("Layer extends outside the zone."), 0, "out-of-bounds issues");
      const x0 = await num("X (mm)");
      await field("X (mm)").fill("-50"); await field("X (mm)").press("Enter"); await value("X (mm)", -50);
      await count(issues.getByText("Layer extends outside the zone."), 1, "out-of-bounds issues");
      assert.match(await page.locator(".ed-layer-name").first().innerText(), /⚠/);
      await field("X (mm)").fill(String(x0)); await field("X (mm)").press("Enter"); await value("X (mm)", x0);
      await count(issues.getByText("Layer extends outside the zone."), 0, "out-of-bounds issues");
    }],
    ["No horizontal overflow with several layers, a selected layer and an issue", async () => {
      await addText("ALPHA", 1); await addText("BRAVO WITH A LONGER LABEL", 2);
      await field("X (mm)").fill("-50"); await field("X (mm)").press("Enter"); await value("X (mm)", -50);
      await noOverflow("editor with layers");
      await page.getByRole("tab", { name: "BACK", exact: true }).click(); await noOverflow("back side");
    }],
  ];

  for (const [width, height] of EDITOR_VIEWPORTS) {
    for (const [name, run] of scenarios) {
      await check(`Editor (flags OFF) ${width}x${height}: ${name}`, async () => {
        await open(width, height);
        await run();
        await noOverflow(`${width}x${height}`);
      });
    }
    await check(`Editor (flags OFF) ${width}x${height}: evidence screenshot`, async () => {
      await open(width, height); await addText("EVIDENCE", 1);
      const filename = `editor-${width}x${height}.png`;
      await page.screenshot({ path: path.join(output, filename), fullPage: true });
      result.screenshots.push(filename);
    });
  }
}
