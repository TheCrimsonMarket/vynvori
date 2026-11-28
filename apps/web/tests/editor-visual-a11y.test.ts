/**
 * M3 C7b: the parts of the editor's visual accessibility that need no browser. The colours the canvas draws, as WCAG ratios, and static
 * checks that the CSS and markup the browser sweep relies on are present. The engine-level checks (focus ring pixels, 200 % text,
 * reflow, target size, reduced motion) live in scripts/browser-editor-visual.mjs and count only from the CI `browser` job.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CANVAS_PALETTE as P } from "../src/components/editor/canvas-palette";

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a: string, b: string) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]; return (hi + 0.05) / (lo + 0.05); };
const css = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8"), editor = readFileSync(new URL("../src/components/editor/editor.tsx", import.meta.url), "utf8");

test("ratio helper matches the WCAG reference values", () => {
  assert.equal(ratio("#000000", "#ffffff").toFixed(2), "21.00");
  assert.equal(ratio("#777777", "#ffffff").toFixed(2), "4.48");
  assert.equal(ratio("#ffffff", "#ffffff").toFixed(2), "1.00");
});

test("everything the canvas draws that carries meaning has 3:1 against what it sits on (SC 1.4.11)", () => {
  const pairs: [string, string, string][] = [
    ["print-zone edge on the zone", P.zoneEdge, P.zoneFill], ["print-zone edge on the frame", P.zoneEdge, P.backdrop], ["safe-margin line", P.safeMargin, P.zoneFill],
    ["selection outline", P.selection, P.zoneFill], ["focus ring on the zone", P.focusRing, P.zoneFill], ["focus ring on its underlay", P.focusRing, P.focusUnderlay],
    ["placeholder edge on the zone", P.placeholderEdge, P.zoneFill], ["quarantine edge on the zone", P.quarantineEdge, P.zoneFill], ["quarantine edge on its fill", P.quarantineEdge, P.quarantineFill],
  ];
  for (const [name, a, b] of pairs) assert(ratio(a, b) >= 3, `${name}: ${ratio(a, b).toFixed(2)}:1 is below 3:1`);
});

test("the placeholder fill alone is not enough; its edge is what makes the box visible", () => {
  assert(ratio(P.placeholderFill, P.zoneFill) < 3, "if the fill ever reaches 3:1 this test can be relaxed");
  assert(ratio(P.placeholderEdge, P.zoneFill) >= 3);
});

test("the editor paints only with palette constants", () => {
  for (const [name, value] of Object.entries(P)) assert(!editor.includes(`"${value}"`), `editor.tsx hard-codes ${name} (${value}); use CANVAS_PALETTE`);
});

test("each canvas layer carries a two-part focus ring that CSS shows on :focus-visible only", () => {
  assert.equal((editor.match(/className="ed-focus-ring"/g) ?? []).length, 2);
  assert.match(editor, /vectorEffect="non-scaling-stroke"/);
  assert.match(css, /\.ed-focus-ring \{ display:none; fill:none; pointer-events:none; \}/);
  assert.match(css, /\.ed-canvas g\[role="button"\]:focus-visible \.ed-focus-ring \{ display:inline; \}/);
  assert.match(css, /\.ed-canvas g\[role="button"\] \{ outline:none; \}/);
});

test("layer titles wrap instead of being cut off, and narrow screens stack label over field", () => {
  const rule = /\.ed-layer-name \{[^}]*\}/.exec(css)?.[0] ?? "";
  assert(rule && !/text-overflow|white-space:\s*nowrap/.test(rule), `layer title rule truncates: ${rule}`);
  assert.match(css, /@media\(max-width:480px\) \{ \.ed-field \{ grid-template-columns:minmax\(0,1fr\)/);
});

test("reduced motion switches transitions and animations off for the whole page and for the editor", () => {
  assert.match(css, /@media\(prefers-reduced-motion:reduce\) \{ \*,\*::before,\*::after \{ transition:none!important; animation:none!important; scroll-behavior:auto!important; \} \}/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\) \{ \.ed \* \{ transition:none!important; \} \}/);
});
