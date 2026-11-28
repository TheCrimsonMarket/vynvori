// C7b: visual accessibility sweep of the /customize editor for scripts/browser-web.mjs. Flags OFF only, no product-code seam.
// For every state the editor can reach with all flags OFF (and at 1280, 390 and 320 CSS px) it checks, in the running engine:
//   reduced motion, target size (SC 2.5.8), reflow at 320 px (SC 1.4.10), text at 200 % (SC 1.4.4), the non-text colours the editor
//   draws (SC 1.4.11), a visible keyboard focus ring on canvas layers (SC 2.4.7), and axe on the states that carry notices.
// States that need a server-backed page (an uploaded, pending, clean or quarantined asset, the scan caption, Check again, Download original,
// the saved/conflict/frozen notices) are NOT reachable here (founder ruling QA). Handler tests, the static palette test and the B4 manual
// screen-reader pass cover them. These checks do not replace B4, and Playwright's WebKit is not Safari.
import assert from "node:assert/strict";
import { EDITOR_VIEWPORTS, AXE_TAGS, until } from "./browser-editor-scenarios.mjs";

const MIN_TARGET_PX = 24; // WCAG 2.2 SC 2.5.8 (AA)

// ---- in-page audits (serialised into the page, so they may not close over anything)

/** Elements anywhere on the page that would animate, transition or smooth-scroll right now. */
function motionOffenders() {
  const moving = value => value.split(",").some(part => parseFloat(part) > 0);
  const offenders = [];
  for (const element of document.querySelectorAll("*")) {
    for (const pseudo of [null, "::before", "::after"]) {
      const style = getComputedStyle(element, pseudo);
      if (moving(style.transitionDuration) || (moving(style.animationDuration) && style.animationName !== "none")) offenders.push(`${element.tagName.toLowerCase()}.${String(element.getAttribute("class") ?? "").split(" ")[0]}${pseudo ?? ""}`);
    }
  }
  for (const element of [document.documentElement, document.body]) if (getComputedStyle(element).scrollBehavior !== "auto") offenders.push(`${element.tagName.toLowerCase()} scroll-behavior`);
  return offenders;
}

/** HTML controls smaller than the minimum, and canvas layers (exempt) that lack an equivalent list button. */
function targetSizes(min) {
  const ed = document.querySelector(".ed");
  const small = [];
  for (const el of ed.querySelectorAll('button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="tab"]')) {
    if (el.closest("svg") || el.classList.contains("ed-sr-only")) continue;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const own = el.getBoundingClientRect();
    if (!own.width && !own.height) continue;
    const label = el.labels?.[0]?.getBoundingClientRect(); // a checkbox is activated through its label: the label is the target
    const width = Math.max(own.width, label?.width ?? 0), height = Math.max(own.height, label?.height ?? 0);
    if (width < min || height < min) small.push(`${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40)}" ${Math.round(width)}x${Math.round(height)}`);
  }
  // Canvas layers are drawn at their real print size, which is the information they carry (SC 2.5.8 "essential"), and every one has an
  // equivalent control on the same page: its list button selects it and the numeric fields move and resize it (SC 2.5.8 "equivalent").
  const layers = [...ed.querySelectorAll('svg.ed-canvas g[role="button"]')];
  const withoutEquivalent = layers.filter(layer => {
    const row = ed.querySelector(`[data-row-id="${layer.getAttribute("data-layer-id")}"] button.ed-layer-name`);
    const box = row?.getBoundingClientRect();
    return !box || box.width < min || box.height < min;
  }).map(layer => layer.getAttribute("data-layer-id"));
  return { small, layers: layers.length, withoutEquivalent };
}

/** Anything of the editor that sticks out of the viewport (SC 1.4.10 allows no horizontal scroll at 320 px). */
function reflow() {
  const ed = document.querySelector(".ed"), width = document.documentElement.clientWidth, outside = [];
  for (const el of ed.querySelectorAll("*")) {
    if (el.parentElement?.closest("svg")) continue; // inside the canvas: the nested zone <svg> clips its out-of-bounds layers, but its reported box does not
    if (el.classList.contains("ed-sr-only")) continue;
    const box = el.getBoundingClientRect();
    if (box.width && (box.right > width + 1 || box.left < -1)) outside.push(`${el.tagName.toLowerCase()}.${String(el.getAttribute("class") ?? "").split(" ")[0]} ${Math.round(box.left)}..${Math.round(box.right)}`);
  }
  return { page: document.documentElement.scrollWidth - width, outside };
}

/** Text at 200 %: every font on the page doubled in place (the browser's text-only zoom is not scriptable). Then look for loss. */
function textLoss() {
  const nodes = [...document.querySelectorAll("body *")].filter(el => !el.closest("svg"));
  const sizes = nodes.map(el => parseFloat(getComputedStyle(el).fontSize));
  nodes.forEach((el, index) => el.style.setProperty("font-size", `${sizes[index] * 2}px`, "important"));
  const ed = document.querySelector(".ed"), found = { page: document.documentElement.scrollWidth - document.documentElement.clientWidth, clipped: [], truncated: [], overlapping: [] };
  for (const el of ed.querySelectorAll("*")) {
    if (el.closest("svg") || el.classList.contains("ed-sr-only")) continue;
    const style = getComputedStyle(el);
    const label = `${el.tagName.toLowerCase()}.${String(el.getAttribute("class") ?? "").split(" ")[0]} "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30)}"`;
    if (style.textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth + 1) found.truncated.push(label);
    const hidesOverflow = style.overflowX !== "visible" || style.overflowY !== "visible";
    // A free-text input scrolls its own value, which is normal. A number must show whole, and nothing else may be cut.
    const isFreeText = el.tagName === "INPUT" && el.getAttribute("inputmode") !== "decimal";
    if ((hidesOverflow || el.tagName === "INPUT" || el.tagName === "BUTTON") && !isFreeText && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1)) found.clipped.push(`${label} ${el.scrollWidth}x${el.scrollHeight} in ${el.clientWidth}x${el.clientHeight}`);
  }
  const controls = [...ed.querySelectorAll('button, a[href], input:not([type="hidden"]), select, textarea, [role="tab"]')].filter(el => el.getBoundingClientRect().width && !el.classList.contains("ed-sr-only"));
  for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < controls.length; j++) {
    const a = controls[i].getBoundingClientRect(), b = controls[j].getBoundingClientRect();
    const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left), overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    if (overlapX > 1 && overlapY > 1 && !controls[i].contains(controls[j]) && !controls[j].contains(controls[i])) found.overlapping.push(`${(controls[i].getAttribute("aria-label") ?? controls[i].textContent).trim().slice(0, 25)} / ${(controls[j].getAttribute("aria-label") ?? controls[j].textContent).trim().slice(0, 25)}`);
  }
  return found;
}

/** WCAG contrast ratios of the colours the editor draws and of the controls axe skips (aria-disabled, disabled). */
function colours() {
  const parse = value => { const m = /rgba?\(([^)]+)\)/.exec(value); if (!m) return null; const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r, g, b, a }; };
  const lum = ({ r, g, b }) => { const [x, y, z] = [r, g, b].map(v => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * x + 0.7152 * y + 0.0722 * z; };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((p, q) => q - p); return (hi + 0.05) / (lo + 0.05); };
  const solid = value => { const c = typeof value === "string" ? parse(value) : value; return c && c.a > 0 ? c : null; };
  const backdropOf = el => { for (let node = el; node; node = node.parentElement) { const c = solid(getComputedStyle(node).backgroundColor); if (c) return c; } return { r: 255, g: 255, b: 255, a: 1 }; };
  const results = [];
  const add = (name, foreground, background, minimum) => {
    const f = solid(foreground), b = solid(background);
    results.push(f && b ? { name, ratio: Math.round(ratio(f, b) * 100) / 100, minimum } : { name, ratio: 0, minimum, unreadable: `${JSON.stringify(foreground)} on ${JSON.stringify(background)}` });
  };
  const svg = document.querySelector("svg.ed-canvas"), rects = [...svg.querySelectorAll(":scope > rect")];
  const zoneFill = getComputedStyle(rects[1]).fill;
  add("canvas: print-zone edge on the frame", getComputedStyle(rects[1]).stroke, zoneFill, 3);
  add("canvas: safe-margin line on the frame", getComputedStyle(rects[2]).stroke, zoneFill, 3);
  const selected = svg.querySelector('g[aria-pressed="true"]');
  if (selected) {
    const parts = [...selected.querySelectorAll(":scope > rect")];
    const ring = parts.filter(rect => rect.classList.contains("ed-focus-ring")).map(rect => getComputedStyle(rect));
    add("canvas: selection outline on the frame", getComputedStyle(parts.find(rect => !rect.classList.contains("ed-focus-ring") && rect.getAttribute("fill") === "transparent")).stroke, zoneFill, 3);
    if (ring.length === 2) {
      add("canvas: focus ring on the frame", ring[1].stroke, zoneFill, 3);
      add("canvas: focus ring on its dark underlay", ring[1].stroke, ring[0].stroke, 3);
    } else results.push({ name: "canvas: the selected layer has no two-part focus ring", ratio: 0, minimum: 3 });
  }
  for (const input of document.querySelectorAll(".ed .ed-field input")) { // the border is the only thing that marks a field (SC 1.4.11)
    add(`field border "${input.getAttribute("aria-label") ?? input.type}"`, getComputedStyle(input).borderTopColor, backdropOf(input.parentElement), 3);
  }
  for (const el of document.querySelectorAll('.ed [aria-disabled="true"], .ed :disabled')) {
    add(`disabled control text "${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30)}"`, getComputedStyle(el).color, backdropOf(el), 4.5);
  }
  for (const el of document.querySelectorAll(".ed .muted, .ed .notice, .ed .ed-status, .ed .ed-field-error")) {
    if (!(el.textContent ?? "").trim()) continue;
    add(`text "${el.textContent.trim().slice(0, 30)}"`, getComputedStyle(el).color, backdropOf(el), 4.5);
  }
  return results;
}

/** Compares two PNGs (base64) of the canvas and counts the pixels the focus ring added. Decoded in a blank page: no extra dependency. */
async function ringPixels({ withRing, without }) {
  const decode = async data => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
    const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext("2d"); context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height);
  };
  const [a, b] = [await decode(withRing), await decode(without)];
  if (a.width !== b.width || a.height !== b.height) return { changed: -1, light: -1 };
  let changed = 0, light = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const delta = Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]);
    if (delta > 60) { changed++; if (a.data[i] > 200 && a.data[i + 1] > 200 && a.data[i + 2] > 190) light++; }
  }
  return { changed, light };
}

export async function runVisualScenarios({ page, base, check, result, axe }) {
  const layers = () => page.locator('svg.ed-canvas g[role="button"]');
  const field = label => page.getByLabel(label, { exact: true });
  const count = (locator, expected, describe) => until(async () => (await locator.count()) === expected, `${describe} = ${expected}`);
  async function open(width, height, motion = "reduce") {
    await page.emulateMedia({ reducedMotion: motion });
    await page.setViewportSize({ width, height });
    await page.goto(`${base}/customize`, { waitUntil: "networkidle" });
    await page.getByRole("region", { name: "Garment composition editor" }).waitFor();
    await page.waitForFunction(() => { const b = [...document.querySelectorAll("button")].find(e => e.textContent === "Add text"); return !!b && Object.keys(b).some(k => k.startsWith("__reactProps")); });
    await count(layers(), 0, "initial layers");
  }
  const addText = async (text, expected) => {
    await page.getByRole("button", { name: "Add text", exact: true }).click();
    await count(layers(), expected, "canvas layers");
    if (text) { await field("Text content").fill(text); await until(async () => (await field("Text content").inputValue()) === text, "text content applied"); }
  };
  const commitNumber = async (label, text) => { await field(label).fill(text); await field(label).press("Enter"); };
  async function focusLayerByTab() {
    await page.getByRole("tab", { name: "FRONT", exact: true }).focus();
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press("Tab");
      if (await page.evaluate(() => document.activeElement?.closest?.("svg.ed-canvas") !== null && document.activeElement?.getAttribute("role") === "button")) return;
    }
    throw new Error("Tab never reached a canvas layer");
  }
  const noItems = (found, what) => assert.deepEqual(found, [], `${what}: ${JSON.stringify(found)}`);
  const LONG_TITLE = "A LONG LAYER TITLE THAT GOES ON AND ON AND ON";

  // Every state the editor reaches with flags OFF. Each starts from a fresh page, so one failure never cascades.
  const states = [
    ["empty editor (upload unavailable and saving not enabled notices)", async () => { await page.getByText("Artwork upload is not enabled in this preview.", { exact: false }).waitFor(); }, { axe: true }],
    ["one text layer selected", async () => { await addText("ALPHA", 1); }, {}],
    ["long title, two layers, one hidden, one out of bounds, issue listed", async () => {
      await addText(LONG_TITLE, 1); await addText("BRAVO", 2);
      await page.getByRole("list", { name: "Layers, top first" }).getByRole("listitem").filter({ hasText: LONG_TITLE.slice(0, 20) }).getByRole("button", { name: /^Hide layer:/ }).click(); await count(layers(), 1, "visible layers");
      await commitNumber("X (mm)", "-50"); await page.getByText("Preview checks: 1 problem", { exact: false }).waitFor();
    }, { axe: true }],
    ["numeric field with an inline error", async () => { await addText("ALPHA", 1); await commitNumber("Y (mm)", "abc"); await page.getByText("Y: enter a number.").waitFor(); }, { axe: true }],
    ["back side with a layer", async () => { await page.getByRole("tab", { name: "BACK", exact: true }).click(); await addText("BACKONLY", 1); }, {}],
    ["layer focused by keyboard", async () => { await addText("ALPHA", 1); await focusLayerByTab(); }, {}],
  ];

  for (const [width, height] of EDITOR_VIEWPORTS) {
    for (const [name, setup, options] of states) {
      await check(`Editor visual sweep ${width}x${height}: ${name}`, async () => {
        await open(width, height);
        await setup();
        // Every section runs even when an earlier one fails, so one report lists everything wrong in the state.
        const problems = [];
        const section = async (title, run) => { try { await run(); } catch (error) { problems.push(`[${title}] ${error.message}`); } };
        await section("reduced motion", async () => noItems(await page.evaluate(motionOffenders), "elements still move under prefers-reduced-motion"));
        await section("target size", async () => {
          const sizes = await page.evaluate(targetSizes, MIN_TARGET_PX);
          noItems(sizes.small, `controls under ${MIN_TARGET_PX}x${MIN_TARGET_PX} CSS px`);
          noItems(sizes.withoutEquivalent, "canvas layers without an equivalent list button of at least the minimum size");
        });
        await section("reflow", async () => {
          const flow = await page.evaluate(reflow);
          assert(flow.page <= 1, `page scrolls horizontally by ${flow.page}px`);
          noItems(flow.outside, "editor parts outside the viewport");
        });
        await section("colour", async () => {
          const ratios = await page.evaluate(colours);
          assert(ratios.length >= 4, `colour audit found only ${ratios.length} items`);
          noItems(ratios.filter(r => r.unreadable || r.ratio < r.minimum).map(r => `${r.name}: ${r.unreadable ?? r.ratio} < ${r.minimum}`), "colour contrast below the minimum");
        });
        if (options.axe) await section("axe", async () => { // where a notice, a status or an error is on screen (the C5/C6 states are not reachable with flags OFF)
          if ((await page.evaluate(() => typeof window.axe)) === "undefined") await page.addScriptTag({ content: axe });
          const audit = await page.evaluate(async tags => window.axe.run({ include: [[".ed"]] }, { runOnly: { type: "tag", values: tags } }), AXE_TAGS);
          assert.deepEqual(audit.violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })), [], `axe violations in ${name}`);
        });
        await section("text at 200 %", async () => { // last, because it rewrites font sizes in place
          const loss = await page.evaluate(textLoss);
          assert(loss.page <= 1, `page scrolls horizontally by ${loss.page}px at 200 % text`);
          noItems(loss.truncated, "text cut off with an ellipsis at 200 %");
          noItems(loss.clipped, "controls or boxes that hide part of their content at 200 %");
          noItems(loss.overlapping, "controls overlapping at 200 %");
        });
        assert(problems.length === 0, `${problems.length} visual accessibility problem(s):\n${problems.join("\n")}`);
      });
    }
  }

  await check("Editor visual sweep: the audit sees motion when motion is allowed (control for the reduced-motion check)", async () => {
    await open(1280, 900, "no-preference");
    assert((await page.evaluate(motionOffenders)).length > 0, "no element transitions with motion allowed, so the reduced-motion check would pass vacuously");
    await open(1280, 900, "reduce");
    noItems(await page.evaluate(motionOffenders), "elements still move under prefers-reduced-motion");
  });

  for (const [width, height] of EDITOR_VIEWPORTS) {
    await check(`Editor visual sweep ${width}x${height}: a keyboard-focused canvas layer gets a visible ring in this engine`, async () => {
      await open(width, height);
      await addText("ALPHA", 1);
      await page.getByRole("button", { name: "Add text", exact: true }).focus(); // the layer stays selected, so the selection outline is in both shots
      const canvas = page.locator("svg.ed-canvas");
      await canvas.scrollIntoViewIfNeeded();
      const shoot = async () => (await canvas.screenshot({ animations: "disabled", caret: "hide" })).toString("base64");
      const without = await shoot();
      await focusLayerByTab();
      assert.equal(await page.evaluate(() => document.activeElement?.matches(":focus-visible")), true, "the layer matches :focus-visible after Tab");
      const display = await page.evaluate(() => [...document.querySelectorAll("svg.ed-canvas g:focus-visible .ed-focus-ring")].map(el => getComputedStyle(el).display));
      assert.deepEqual(display, ["inline", "inline"], "both ring rects are shown for the focused layer");
      assert.equal(await page.evaluate(() => [...document.querySelectorAll("svg.ed-canvas g:not(:focus-visible) .ed-focus-ring")].every(el => getComputedStyle(el).display === "none")), true, "no ring on an unfocused layer");
      const withRing = await shoot();
      const box = await page.evaluate(() => { const r = document.querySelector("svg.ed-canvas g:focus-visible rect.ed-focus-ring").getBoundingClientRect(); return { w: r.width, h: r.height }; });
      const blank = await page.context().newPage();
      try {
        const pixels = await blank.evaluate(ringPixels, { withRing, without });
        const perimeter = 2 * (box.w + box.h);
        assert(pixels.changed > perimeter, `focus changed ${pixels.changed} pixels, fewer than the ${Math.round(perimeter)} px layer outline: no ring was drawn in ${result.engine}`);
        assert(pixels.light > perimeter, `the ring added ${pixels.light} light pixels, fewer than the ${Math.round(perimeter)} px layer outline`);
      } finally { await blank.close(); }
    });
  }
}
