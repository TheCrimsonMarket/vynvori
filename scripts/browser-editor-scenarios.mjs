// Interactive /customize editor scenarios for scripts/browser-web.mjs.
// Flags-OFF only: no cookies, identity, save, upload, freeze or restore is exercised, and no product-code seam is used.
// Every scenario starts from a freshly loaded page so a failure never cascades into the next one.
import assert from "node:assert/strict";
import path from "node:path";

export const EDITOR_VIEWPORTS = [[1280, 900], [390, 844], [320, 640]];
const near = (a, b) => Math.abs(a - b) < 0.0005;
export async function until(read, describe, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try { last = await read(); if (last === true) return; } catch (error) { last = error.message; }
    if (Date.now() > deadline) throw new Error(`Timed out: ${describe} (last: ${String(last)})`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

export const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]; // WCAG 2.0 to 2.2, levels A and AA

export async function runEditorScenarios({ page, base, check, output, result, axe }) {
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
  const announcer = () => page.locator("#ed-announce");
  const announced = () => announcer().evaluate(el => (el.textContent ?? "").replace(/\u00A0/g, " ").trim());
  const announcedMatches = (pattern, describe) => until(async () => pattern.test(await announced()), `announcer says ${describe}`);
  const active = () => page.evaluate(() => {
    const a = document.activeElement;
    return { id: a?.id ?? "", tag: a?.tagName ?? "", label: a?.getAttribute?.("aria-label") ?? "", text: (a?.textContent ?? "").trim(), layerId: a?.getAttribute?.("data-layer-id") ?? "", action: a?.getAttribute?.("data-action") ?? "", row: a?.closest?.("[data-row-id]")?.getAttribute("data-row-id") ?? "", className: a?.getAttribute?.("class") ?? "", disabled: a?.getAttribute?.("aria-disabled") ?? "" };
  });
  const accessibleName = a => a.label || a.text;
  const hasActive = (predicate, describe) => until(async () => predicate(await active()), `focus is on ${describe}`);
  /** Presses Tab (or Shift+Tab) until the focused control's accessible name matches; fails if it is never reached. */
  async function tabTo(name, { back = false, max = 30 } = {}) {
    const visited = [];
    for (let i = 0; i < max; i++) {
      await page.keyboard.press(back ? "Shift+Tab" : "Tab");
      const a = await active(), label = accessibleName(a);
      visited.push(label);
      if (name instanceof RegExp ? name.test(label) : label === name) return a;
    }
    throw new Error(`Tab never reached ${String(name)}; visited ${JSON.stringify(visited)}`);
  }
  async function axeScan(where) {
    await page.emulateMedia({ reducedMotion: "reduce" }); // no colour transition can be caught half-way by the contrast rule
    if ((await page.evaluate(() => typeof window.axe)) === "undefined") await page.addScriptTag({ content: axe });
    // Scoped to the editor: the site header and footer are covered by the route-level scans above.
    const audit = await page.evaluate(async tags => window.axe.run({ include: [[".ed"]] }, { runOnly: { type: "tag", values: tags } }), AXE_TAGS);
    assert.deepEqual(audit.violations.map(v => ({ state: where, id: v.id, nodes: v.nodes.map(n => n.target) })), [], `axe violations in ${where}`);
  }
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
      assert.match(await page.locator("p.ed-status").innerText(), /^\s*$/); // nothing is claimed saved
      assert.match(await announced(), /^$/);
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
    // ---- C7a: editor core accessibility (keyboard, focus, names, roles, live regions)
    ["axe: WCAG 2.0-2.2 A/AA on every interactive state", async () => {
      await axeScan("empty editor");
      await addText("ALPHA", 1);
      await axeScan("one text layer selected");
      await addText("BRAVO WITH A LONGER LABEL", 2);
      await rowFor("ALPHA").getByRole("button", { name: /^Hide layer:/ }).click(); await count(layers(), 1, "visible canvas layers");
      await field("X (mm)").fill("-50"); await field("X (mm)").press("Enter"); await value("X (mm)", -50);
      await announcedMatches(/X set to -50 mm/, "X committed");
      await page.getByText("Preview checks: 1 problem", { exact: false }).waitFor();
      await axeScan("two layers, one hidden, one out of bounds, issue listed");
      await field("Y (mm)").fill("abc"); await field("Y (mm)").press("Enter"); await page.getByText("Y: enter a number.").waitFor();
      await axeScan("numeric field with inline error");
      await page.getByRole("tab", { name: "BACK", exact: true }).click(); await count(rows(), 0, "back rows");
      await axeScan("back side, empty");
      await addText("BACKONLY", 1);
      await axeScan("back side with a layer");
    }],
    ["Zone tablist: roving tabindex, arrows, Home/End and tabpanel", async () => {
      const front = page.getByRole("tab", { name: "FRONT", exact: true }), back = page.getByRole("tab", { name: "BACK", exact: true }), panel = page.getByRole("tabpanel");
      assert.equal(await front.getAttribute("tabindex"), "0"); assert.equal(await back.getAttribute("tabindex"), "-1");
      assert.equal(await front.getAttribute("aria-controls"), "ed-tabpanel"); assert.equal(await panel.getAttribute("id"), "ed-tabpanel");
      assert.equal(await panel.getAttribute("aria-labelledby"), "ed-tab-front"); assert.equal(await panel.getByRole("group", { name: /front print zone/ }).count(), 1);
      await front.focus(); await page.keyboard.press("ArrowRight");
      await hasActive(a => a.id === "ed-tab-back", "the BACK tab after ArrowRight");
      assert.equal(await back.getAttribute("aria-selected"), "true"); assert.equal(await back.getAttribute("tabindex"), "0"); assert.equal(await front.getAttribute("tabindex"), "-1");
      assert.equal(await panel.getAttribute("aria-labelledby"), "ed-tab-back"); assert.equal(await panel.getByRole("group", { name: /back print zone/ }).count(), 1);
      await announcedMatches(/^Back side\. No layers\.$/, "back side and layer count");
      await page.keyboard.press("ArrowRight"); await hasActive(a => a.id === "ed-tab-front", "the FRONT tab (wraps)");
      await page.keyboard.press("End"); await hasActive(a => a.id === "ed-tab-back", "the BACK tab after End");
      await page.keyboard.press("Home"); await hasActive(a => a.id === "ed-tab-front", "the FRONT tab after Home");
      await page.keyboard.press("ArrowLeft"); await hasActive(a => a.id === "ed-tab-back", "the BACK tab after ArrowLeft (wraps)");
      await page.keyboard.press("Tab"); // leaves the tablist: the unselected tab is not a tab stop
      assert(!(await active()).id.startsWith("ed-tab-"), "focus left the tablist");
    }],
    ["Accessibility tree: landmark, tablist, tabpanel, layer list, selected-layer group, unique action names", async () => {
      await addText("ALPHA", 1); await addText("BRAVO", 2); await addText("CHARLIE", 3);
      const snapshot = await page.getByRole("region", { name: "Garment composition editor" }).ariaSnapshot();
      for (const expected of [/^- region "Garment composition editor":/m, /- tablist "Garment side":/, /- tab "FRONT" \[selected\]/, /- tab "BACK"/, /- tabpanel "FRONT":/, /- list "Layers, top first":/, /- group "Selected layer":/, /- region "Preview checks":/, /- list "Preview checks, front side":/])
        assert.match(snapshot, expected, `aria snapshot lacks ${expected}\n${snapshot}`);
      assert.equal((snapshot.match(/- listitem:/g) ?? []).length >= 3, true, "layer list has three items");
      const names = [...snapshot.matchAll(/button "((?:Move up|Move down|Hide layer|Show layer): [^"]*)"/g)].map(match => match[1]);
      assert.equal(names.length, 9, `nine per-layer actions expected, found ${JSON.stringify(names)}`);
      assert.equal(new Set(names).size, names.length, `per-layer action names repeat: ${JSON.stringify(names)}`);
      assert(names.includes("Move up: Text · CHARLIE, layer 1 of 3") && names.includes("Hide layer: Text · ALPHA, layer 3 of 3"), `names carry title and position: ${JSON.stringify(names)}`);
      const labels = await layers().evaluateAll(items => items.map(item => item.getAttribute("aria-label")));
      assert(labels.every(label => !/arrow|shift|alt/i.test(label)), `canvas layer labels repeat the key help: ${JSON.stringify(labels)}`);
      const help = await layers().evaluateAll(items => items.map(item => document.getElementById(item.getAttribute("aria-describedby") ?? "")?.textContent ?? ""));
      assert(help.length === 3 && help.every(text => text === help[0] && /Arrow keys move the focused layer 1 mm\. Shift with an arrow key moves 10 mm, Alt moves 0\.1 mm\. Delete removes the layer\./.test(text)), `one shared description expected: ${JSON.stringify(help)}`);
      assert.equal(await page.locator("ul.ed-issues[aria-live], [aria-live] ul.ed-issues").count(), 0, "the issue list is not a live region");
    }],
    ["Keyboard only (no pointer events): add, edit, duplicate, delete, reorder, hide, switch side, undo", async () => {
      await page.evaluate(() => { window.__pointer = 0; for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "touchstart"]) window.addEventListener(type, () => { window.__pointer++; }, true); });
      await page.getByRole("tab", { name: "FRONT", exact: true }).focus(); // arrival point; the skip-link route into the page is covered by the route checks
      await tabTo("Add text");
      await page.keyboard.press("Enter"); await count(layers(), 1, "layers after Enter on Add text");
      await announcedMatches(/^Text layer added and selected\. 1 layer on the front side\.$/, "the add announcement");
      assert.equal((await active()).id, "ed-add-text", "focus stays on Add text so another layer can be added");
      await page.keyboard.press("Enter"); await count(layers(), 2, "layers after a second Enter");
      await tabTo("X (mm)"); await page.keyboard.press("ControlOrMeta+A"); await page.keyboard.type("20"); await page.keyboard.press("Enter");
      await value("X (mm)", 20); await announcedMatches(/^X set to 20 mm\./, "the numeric commit");
      assert.equal((await active()).label, "X (mm)", "focus stays in the numeric field after Enter");
      await tabTo("Text content"); await page.keyboard.press("ControlOrMeta+A"); await page.keyboard.type("BRAVO");
      await tabTo("Duplicate"); await page.keyboard.press("Enter"); await count(layers(), 3, "layers after Duplicate");
      await announcedMatches(/^Layer duplicated\. The copy is selected\. 3 layers on the front side\.$/, "the duplicate announcement");
      assert.equal((await active()).text, "Duplicate", "focus stays on Duplicate");
      await tabTo("Delete"); await page.keyboard.press("Enter"); await count(layers(), 2, "layers after Delete");
      await announcedMatches(/^Deleted Text · BRAVO\. 2 layers left\.$/, "the delete announcement");
      await hasActive(a => a.className.includes("ed-layer-name") && a.row !== "", "a layer row button (focus restored to the neighbour)");
      await tabTo(/^Move down: Text · BRAVO, layer 1 of 2$/); await page.keyboard.press("Enter");
      await announcedMatches(/^Moved down\. Now layer 2 of 2\.$/, "the reorder announcement");
      await hasActive(a => a.action === "down" && /layer 2 of 2$/.test(a.label), "the same Move down button after it moved");
      await tabTo(/^Hide layer: /); await page.keyboard.press("Enter"); await count(layers(), 1, "visible canvas layers after Hide");
      await announcedMatches(/ hidden\.$/, "the hide announcement");
      await hasActive(a => a.action === "visibility" && /^Show layer: /.test(a.label), "the visibility button, now named Show layer");
      await tabTo("FRONT", { back: true }); await page.keyboard.press("ArrowRight");
      await hasActive(a => a.id === "ed-tab-back", "the BACK tab"); await count(layers(), 0, "back layers"); await page.keyboard.press("ArrowLeft"); await hasActive(a => a.id === "ed-tab-front", "the FRONT tab");
      await tabTo("Undo"); await page.keyboard.press("Enter"); await announcedMatches(/^Undone\./, "the undo announcement");
      assert.equal(await page.evaluate(() => window.__pointer), 0, "the journey used no pointer, mouse or touch events");
    }],
    ["Focus is restored after delete, undo and reorder (never to <body>)", async () => {
      await addText("ALPHA", 1); await addText("BRAVO", 2);
      await focusFirstLayerByTab(); // the lowest layer, ALPHA (layer_1)
      assert.equal((await active()).layerId, "layer_1");
      await page.keyboard.press("Delete"); await count(layers(), 1, "canvas layers");
      await hasActive(a => a.layerId === "layer_2", "the remaining canvas layer");
      await page.keyboard.press("Delete"); await count(layers(), 0, "canvas layers");
      await hasActive(a => a.id === "ed-add-text", "Add text when no layer is left");
      await addText("ONE", 1); await addText("TWO", 2); // ids restart at layer_1 once every layer is gone
      await page.getByRole("button", { name: "Delete", exact: true }).focus(); await page.keyboard.press("Enter"); await count(layers(), 1, "canvas layers");
      await hasActive(a => a.row === "layer_1" && a.className.includes("ed-layer-name"), "the neighbouring row button after panel Delete");
      await page.getByRole("button", { name: "Add text", exact: true }).click(); await count(layers(), 2, "canvas layers");
      await rowFor("YOUR TEXT").getByRole("button", { name: /^Move up:/ }).focus(); await page.keyboard.press("Enter"); // the new layer is on top already
      await announcedMatches(/^Already the top layer\.$/, "the boundary announcement");
      await hasActive(a => a.action === "up" && a.disabled === "true", "the Move up button (aria-disabled, still focused)");
      const undo = page.getByRole("button", { name: "Undo", exact: true });
      await undo.focus();
      for (let i = 0; i < 80 && (await undo.getAttribute("aria-disabled")) !== "true"; i++) await page.keyboard.press("Enter");
      assert.equal(await undo.getAttribute("aria-disabled"), "true"); assert.equal((await active()).text, "Undo", "focus stays on Undo after the last undo");
      await announcedMatches(/^Undone\. Nothing more to undo\.$/, "the final undo announcement");
    }],
    ["Live regions: nudges are announced once per burst; the issue list is summarised, not re-read", async () => {
      await addText(null, 1);
      const x0 = await num("X (mm)"), y0 = await num("Y (mm)");
      assert.match(await page.locator("p.ed-issue-summary").innerText(), /^Preview checks: no problems or warnings\.$/);
      await page.evaluate(() => { window.__announcements = []; const el = document.getElementById("ed-announce"); new MutationObserver(() => window.__announcements.push((el.textContent ?? "").replace(/ /g, " ").trim())).observe(el, { childList: true, characterData: true, subtree: true }); });
      await focusFirstLayerByTab();
      for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
      await value("X (mm)", x0 + 3);
      await announcedMatches(new RegExp(`^Moved to x ${x0 + 3} mm, y ${y0} mm\\.$`), "the debounced nudge sentence");
      await new Promise(resolve => setTimeout(resolve, 900));
      const spoken = (await page.evaluate(() => window.__announcements)).filter(Boolean);
      // Three presses normally land inside one debounce window and yield one sentence; a slow runner may split them, but never into one sentence per key press.
      assert(spoken.length >= 1 && spoken.length <= 2 && spoken.every(text => /^Moved to x [\d.]+ mm, y [\d.]+ mm\.$/.test(text)) && spoken.at(-1) === `Moved to x ${x0 + 3} mm, y ${y0} mm.`, `quick key presses are announced as a burst: ${JSON.stringify(spoken)}`);
      // moving the layer 3 mm to the right puts it inside the safety margin: one warning, summarised, not re-read as a list
      await until(async () => (await page.locator("p.ed-issue-summary").innerText()) === "Preview checks: 1 warning.", "issue summary names the warning");
      await field("X (mm)").fill("-50"); await field("X (mm)").press("Enter");
      await until(async () => /^Preview checks: 1 problem/.test(await page.locator("p.ed-issue-summary").innerText()), "issue summary names the problem");
      assert.equal(await page.locator("p.ed-issue-summary").getAttribute("aria-live"), null, "the visible summary is plain text");
      assert.equal(await page.locator("#ed-issue-live").getAttribute("aria-live"), "polite");
      await until(async () => /^Preview checks: 1 problem/.test(await page.locator("#ed-issue-live").innerText()), "the live mirror follows, debounced");
      assert.equal(await page.locator("ul.ed-issues").getAttribute("aria-live"), null);
      await field("X (mm)").fill(String(x0)); await field("X (mm)").press("Enter");
      await until(async () => /no problems or warnings/.test(await page.locator("p.ed-issue-summary").innerText()), "issue summary clears");
    }],
    ["Numeric fields: inline validation text tied to the field, focus kept, no shared-status noise", async () => {
      await addText(null, 1);
      const x = field("X (mm)"); await x.focus();
      await x.fill("abc"); await x.press("Enter");
      const alert = page.locator(".ed-field-error[role=alert]").filter({ hasText: "X: enter a number." });
      await alert.waitFor();
      assert.equal(await x.getAttribute("aria-invalid"), "true");
      const describedBy = await x.getAttribute("aria-describedby");
      assert(describedBy && (await page.locator(`[id="${describedBy}"]`).innerText()) === "X: enter a number.", "the field is described by its error");
      assert.equal((await active()).label, "X (mm)", "focus stays in the field");
      assert.match(await page.locator("p.ed-status").innerText(), /^\s*$/, "the shared status line is not used for field errors");
      await page.keyboard.press("Tab"); // leaving the field without typing clears its stale error
      await count(page.locator(".ed-field-error"), 0, "field errors after leaving the field");
      const y = field("Y (mm)"); await y.focus(); await y.fill("1.234567"); await y.press("Enter"); // too many decimals is rejected by the same rule
      await page.getByText("Y: enter a number.").waitFor(); await count(page.getByText("X: enter a number."), 0, "the earlier field's error (one error at a time)");
      await y.fill("40"); await count(page.locator(".ed-field-error"), 0, "field errors after editing again");
      await y.press("Enter"); await value("Y (mm)", 40); assert.equal(await y.getAttribute("aria-invalid"), null);
      // a refused value is reported, and a clamped value is announced as applied, not as typed
      const width = field("Width (mm)"); await width.fill("0"); await width.press("Enter");
      await page.getByText("Width: that value is not accepted.").waitFor();
      const xField = field("X (mm)"); await xField.fill("6000"); await xField.press("Enter"); await value("X (mm)", 5000);
      await announcedMatches(/^X set to 5000 mm\./, "the applied (clamped) value");
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
