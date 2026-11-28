/**
 * The colours the editor draws inside its SVG canvas. They sit on the dark preview frame in every site theme, so they do
 * not follow the CSS tokens. One source: `editor.tsx` paints with these values and `apps/web/tests/editor-visual-a11y.test.ts`
 * computes their WCAG contrast from the same constants (non-text parts need 3:1 against what they are drawn on, SC 1.4.11).
 */
export const CANVAS_PALETTE = {
  backdrop: "#0b0b0a",
  zoneFill: "#161614",
  zoneEdge: "#939187",
  safeMargin: "#939187",
  selection: "#f1efe9",
  /** Keyboard focus ring: a light line on a dark underlay, so it reads on the frame and on any layer colour. */
  focusRing: "#f1efe9",
  focusUnderlay: "#0b0b0a",
  placeholderFill: "#49483f",
  placeholderEdge: "#939187",
  quarantineFill: "#3a1f1b",
  quarantineEdge: "#c9614f",
} as const;
