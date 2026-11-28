import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// M3-F1. Source-level guards for two findings from C7a. The rendered behaviour is proved by the browser job
// (scripts/browser-editor-scenarios.mjs and scripts/browser-web.mjs); these tests fail fast without a browser.
const read = (relative: string) => readFileSync(resolve(import.meta.dirname, "..", relative), "utf8");

test("site header: the brand link's accessible name contains its visible text (WCAG 2.5.3, axe label-content-name-mismatch)", () => {
  const source = read("src/components/site-header.tsx");
  const link = /<Link href="\/" className="brand"[^>]*aria-label="([^"]*)"/.exec(source);
  assert.ok(link, "the brand link still carries an aria-label");
  const visible = /<span>([^<]+)<\/span>\s*<\/Link>/.exec(source)?.[1];
  assert.ok(visible, "the brand link still shows a visible text");
  assert.ok(link[1]!.toLowerCase().includes(visible.trim().toLowerCase()), `label ${JSON.stringify(link[1])} contains ${JSON.stringify(visible)}`);
  assert.match(link[1]!, /VYNVORI home/, "the name still says where the link goes");
});

test("editor: the tabpanel wraps the canvas, the layer list and the fields; the tablist sits outside it", () => {
  const source = read("src/components/editor/editor.tsx");
  const tablist = source.indexOf('role="tablist"'), panel = source.indexOf('role="tabpanel"');
  assert.ok(tablist > 0 && panel > tablist, "the tablist comes before the tabpanel");
  for (const marker of ['className="ed-canvas"', 'aria-label="Layers, top first"', "<legend>Selected layer</legend>", 'className="ed-panel"']) {
    assert.ok(source.indexOf(marker) > panel, `${marker} comes after the tabpanel opens`);
  }
  const panelTag = source.slice(source.lastIndexOf("<div", panel), source.indexOf(">", panel) + 1);
  assert.match(panelTag, /className="ed-grid"/, "the tabpanel is the grid, so it encloses both columns");
  assert.match(panelTag, /aria-labelledby=\{`ed-tab-\$\{zoneId\}`\}/, "it is still labelled by the selected tab");
});
