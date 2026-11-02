/**
 * M3 versioned composition scene: physical-mm geometry, canonicalisation and preview-only
 * preflight. Builds on (does not redefine) the ED-01/02/03 layer contracts in ./editor.
 * Source: docs/technical/04-domain-database-model.md §Versioned composition scene JSON;
 * docs/technical/07-garment-composition-editor.md §Coordinate spaces / §Scene format;
 * docs/technical/22-canonical-state-machines.md Plane D.
 *
 * Pure module: no Node/browser APIs, so the editor, the API and the tests share ONE definition.
 * Hashing lives with the server (packages/commerce) because the scene hash is authoritative there.
 *
 * Coordinate convention (all persisted geometry): millimetres, origin at the TOP-LEFT of the
 * print zone, x to the right, y downward. `xMm,yMm` is the top-left of the UNROTATED layer box;
 * `rotationDeg` rotates clockwise about the box centre. CSS pixels are display-only and are
 * never persisted.
 */
import { z } from "zod";
import { EditorPageV1Schema, type EditorLayerV1, type EditorPageV1 } from "./editor";
import { HashSha256Schema } from "./ids";

export const SCENE_SCHEMA_VERSION = "composition-scene.v1" as const;
/** Persisted geometry is quantised to 1 micrometre so reload/serialisation can never drift. */
export const MM_QUANTUM = 1000;
export const quantizeMm = (value: number): number => Math.round(value * MM_QUANTUM) / MM_QUANTUM;

/**
 * Print profile contract. `status` intentionally has NO approved member and `printReleaseEligible`
 * / `supplierApproved` are literal `false`: M3 can only describe preview-only profiles. A real
 * supplier profile (M5, doc 08/15) requires a new schema version, not a flag flip.
 */
export const PrintProfileV1Schema = z.object({
  schemaVersion: z.literal("print-profile.v1"),
  profileId: z.string().min(1),
  version: z.string().min(1),
  status: z.enum(["synthetic_unapproved", "draft_unapproved"]),
  supplierApproved: z.literal(false),
  printReleaseEligible: z.literal(false),
  label: z.string().min(1),
  productFamily: z.string().min(1),
  zones: z.array(z.object({
    zoneId: z.string().min(1),
    widthMm: z.number().positive().max(2000),
    heightMm: z.number().positive().max(2000),
    safeMarginMm: z.number().nonnegative(),
    bleedMm: z.number().nonnegative(),
  }).strict()).min(1),
  limits: z.object({
    maxLayersPerZone: z.number().int().positive(),
    maxTextChars: z.number().int().positive(),
    /** PROVISIONAL (doc 07: 300 PPI is a target, not confirmed). Preview warnings only. */
    provisionalMinEffectivePpi: z.number().positive(),
  }).strict(),
}).strict().superRefine((profile, ctx) => {
  if (new Set(profile.zones.map(zone => zone.zoneId)).size !== profile.zones.length) ctx.addIssue({ code: "custom", message: "duplicate zoneId" });
});
export type PrintProfileV1 = z.infer<typeof PrintProfileV1Schema>;

export const CompositionSceneV1Schema = z.object({
  schemaVersion: z.literal(SCENE_SCHEMA_VERSION),
  productFamily: z.string().min(1),
  printProfileId: z.string().min(1),
  printProfileVersion: z.string().min(1),
  pages: z.array(EditorPageV1Schema).min(1).max(8),
}).strict().superRefine((scene, ctx) => {
  const zones = new Set<string>(), layers = new Set<string>();
  for (const page of scene.pages) {
    if (zones.has(page.zoneId)) ctx.addIssue({ code: "custom", message: "duplicate zoneId" });
    zones.add(page.zoneId);
    for (const layer of page.layers) {
      if (layers.has(layer.layerId)) ctx.addIssue({ code: "custom", message: "duplicate layerId" });
      layers.add(layer.layerId);
    }
  }
});
export type CompositionSceneV1 = z.infer<typeof CompositionSceneV1Schema>;

/** Hard structural ceilings applied on every persist, independent of any profile. */
export const SCENE_LIMITS = Object.freeze({
  maxAbsPositionMm: 5000, maxSizeMm: 5000, maxLayersPerScene: 64, maxTextChars: 2000, maxRotationAbsDeg: 360,
});

export class SceneLimitError extends Error {
  constructor(readonly code: "SCENE_LIMIT_EXCEEDED", detail: string) { super(`${code}: ${detail}`); this.name = "SceneLimitError"; }
}

function finite(value: number, label: string) {
  if (!Number.isFinite(value)) throw new SceneLimitError("SCENE_LIMIT_EXCEEDED", `${label} is not finite`);
}
/** Throws SceneLimitError on out-of-range geometry/oversized text. Zod already guarantees shape. */
export function assertSceneLimits(scene: CompositionSceneV1): void {
  let count = 0;
  for (const page of scene.pages) for (const layer of page.layers) {
    count += 1;
    for (const [label, value] of [["x", layer.xMm], ["y", layer.yMm], ["w", layer.widthMm], ["h", layer.heightMm], ["rot", layer.rotationDeg]] as const) finite(value, label);
    if (Math.abs(layer.xMm) > SCENE_LIMITS.maxAbsPositionMm || Math.abs(layer.yMm) > SCENE_LIMITS.maxAbsPositionMm) throw new SceneLimitError("SCENE_LIMIT_EXCEEDED", "position");
    if (layer.widthMm > SCENE_LIMITS.maxSizeMm || layer.heightMm > SCENE_LIMITS.maxSizeMm) throw new SceneLimitError("SCENE_LIMIT_EXCEEDED", "size");
    if (Math.abs(layer.rotationDeg) > SCENE_LIMITS.maxRotationAbsDeg) throw new SceneLimitError("SCENE_LIMIT_EXCEEDED", "rotation");
    if (layer.kind === "text" && layer.text.length > SCENE_LIMITS.maxTextChars) throw new SceneLimitError("SCENE_LIMIT_EXCEEDED", "text length");
  }
  if (count > SCENE_LIMITS.maxLayersPerScene) throw new SceneLimitError("SCENE_LIMIT_EXCEEDED", "layer count");
}

// --- canonical form ----------------------------------------------------------------------------
function quantizeLayer(layer: EditorLayerV1): EditorLayerV1 {
  return { ...layer, xMm: quantizeMm(layer.xMm), yMm: quantizeMm(layer.yMm), widthMm: quantizeMm(layer.widthMm), heightMm: quantizeMm(layer.heightMm), rotationDeg: quantizeMm(layer.rotationDeg) };
}
/**
 * Deterministic form: geometry quantised to 1 µm, zones sorted by id, layers by (zIndex, layerId).
 * Sorting is safe because z-order IS `zIndex`; array order carries no meaning.
 */
export function normalizeScene(scene: CompositionSceneV1): CompositionSceneV1 {
  const pages: EditorPageV1[] = [...scene.pages]
    .sort((a, b) => (a.zoneId < b.zoneId ? -1 : a.zoneId > b.zoneId ? 1 : 0))
    .map(page => ({ zoneId: page.zoneId, layers: page.layers.map(quantizeLayer).sort((a, b) => a.zIndex - b.zIndex || (a.layerId < b.layerId ? -1 : a.layerId > b.layerId ? 1 : 0)) }));
  return { ...scene, pages };
}
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys((value as Record<string, unknown>)[key])]));
  return value;
}
/** Canonical JSON bytes-as-text over the normalised scene; the sole input to the scene hash. */
export function canonicalSceneJson(scene: CompositionSceneV1): string {
  return JSON.stringify(sortKeys(normalizeScene(scene)));
}
/** Every content hash a scene version pins (images + fonts), sorted and de-duplicated. */
export function sceneSourceHashes(scene: CompositionSceneV1): { assets: string[]; fonts: string[] } {
  const assets = new Set<string>(), fonts = new Set<string>();
  for (const page of scene.pages) for (const layer of page.layers) {
    if (layer.kind === "image") assets.add(layer.sourceAssetSha256); else fonts.add(layer.fontFileSha256);
  }
  return { assets: [...assets].sort(), fonts: [...fonts].sort() };
}

// --- geometry ----------------------------------------------------------------------------------
type Box = Pick<EditorLayerV1, "xMm" | "yMm" | "widthMm" | "heightMm" | "rotationDeg">;
/** Axis-aligned bounds of the rotated layer in zone mm. */
export function rotatedBounds(box: Box): { minX: number; minY: number; maxX: number; maxY: number } {
  const cx = box.xMm + box.widthMm / 2, cy = box.yMm + box.heightMm / 2, angle = (box.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const xs: number[] = [], ys: number[] = [];
  for (const [dx, dy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    const px = (dx * box.widthMm) / 2, py = (dy * box.heightMm) / 2;
    xs.push(cx + px * cos - py * sin); ys.push(cy + px * sin + py * cos);
  }
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}
export type ZoneDimensions = Readonly<{ widthMm: number; heightMm: number }>;
/** Reproducible mm <-> 0..1 zone conversion (doc 07). Normalised values are derived, never stored. */
export function toNormalized(zone: ZoneDimensions, box: Box) {
  return { x: box.xMm / zone.widthMm, y: box.yMm / zone.heightMm, w: box.widthMm / zone.widthMm, h: box.heightMm / zone.heightMm, rotationDeg: box.rotationDeg };
}
export function fromNormalized(zone: ZoneDimensions, n: { x: number; y: number; w: number; h: number; rotationDeg: number }) {
  return { xMm: quantizeMm(n.x * zone.widthMm), yMm: quantizeMm(n.y * zone.heightMm), widthMm: quantizeMm(n.w * zone.widthMm), heightMm: quantizeMm(n.h * zone.heightMm), rotationDeg: quantizeMm(n.rotationDeg) };
}
/** Effective raster PPI of an image layer: source pixels / printed inches (doc 07). */
export function effectivePpi(pixels: { widthPx: number; heightPx: number }, layer: { widthMm: number; heightMm: number }): number {
  return Math.min(pixels.widthPx / (layer.widthMm / 25.4), pixels.heightPx / (layer.heightMm / 25.4));
}

// --- licensed fonts (typed config; exact text requires a registered, licensed font file) --------
export const LicensedFontV1Schema = z.object({
  fontAssetId: z.string().min(1), family: z.string().min(1),
  fileSha256: HashSha256Schema, licenseVersion: z.string().min(1),
}).strict();
export type LicensedFontV1 = z.infer<typeof LicensedFontV1Schema>;

// --- preview-only preflight --------------------------------------------------------------------
export const PreflightIssueSchema = z.object({
  code: z.enum([
    "PROFILE_MISMATCH", "ZONE_UNKNOWN", "TOO_MANY_LAYERS", "TEXT_TOO_LONG", "LAYER_OUT_OF_BOUNDS", "LAYER_OUTSIDE_SAFE_MARGIN",
    "ASSET_MISSING", "ASSET_HASH_MISMATCH", "FONT_UNLICENSED", "LOW_EFFECTIVE_PPI", "PRINT_PROFILE_UNAPPROVED",
  ]),
  severity: z.enum(["hard_error", "warning", "info"]),
  zoneId: z.string().optional(), layerId: z.string().optional(), detail: z.string().optional(),
}).strict();
export type PreflightIssue = z.infer<typeof PreflightIssueSchema>;
export type AssetFacts = Readonly<{ sha256: string; widthPx: number; heightPx: number }>;
export type PreflightResult = Readonly<{
  /** M3 can never produce `passed_pending_human_qa`: no approved profile exists. */
  state: "preview_only" | "blocked";
  issues: readonly PreflightIssue[];
  printProfileVersion: string;
}>;

export function runPreviewPreflight(
  scene: CompositionSceneV1, profile: PrintProfileV1,
  assets: ReadonlyMap<string, AssetFacts>, fonts: ReadonlyMap<string, LicensedFontV1>,
): PreflightResult {
  const issues: PreflightIssue[] = [];
  const add = (issue: PreflightIssue) => { issues.push(issue); };
  if (scene.printProfileId !== profile.profileId || scene.printProfileVersion !== profile.version || scene.productFamily !== profile.productFamily) {
    add({ code: "PROFILE_MISMATCH", severity: "hard_error" });
    return { state: "blocked", issues, printProfileVersion: profile.version };
  }
  const zones = new Map(profile.zones.map(zone => [zone.zoneId, zone]));
  for (const page of scene.pages) {
    const zone = zones.get(page.zoneId);
    if (!zone) { add({ code: "ZONE_UNKNOWN", severity: "hard_error", zoneId: page.zoneId }); continue; }
    if (page.layers.length > profile.limits.maxLayersPerZone) add({ code: "TOO_MANY_LAYERS", severity: "hard_error", zoneId: page.zoneId });
    for (const layer of page.layers) {
      if (!layer.visible) continue;
      const bounds = rotatedBounds(layer), eps = 1 / MM_QUANTUM;
      if (bounds.minX < -eps || bounds.minY < -eps || bounds.maxX > zone.widthMm + eps || bounds.maxY > zone.heightMm + eps) {
        add({ code: "LAYER_OUT_OF_BOUNDS", severity: "hard_error", zoneId: page.zoneId, layerId: layer.layerId });
      } else if (bounds.minX < zone.safeMarginMm - eps || bounds.minY < zone.safeMarginMm - eps ||
                 bounds.maxX > zone.widthMm - zone.safeMarginMm + eps || bounds.maxY > zone.heightMm - zone.safeMarginMm + eps) {
        add({ code: "LAYER_OUTSIDE_SAFE_MARGIN", severity: "warning", zoneId: page.zoneId, layerId: layer.layerId });
      }
      if (layer.kind === "image") {
        const asset = assets.get(layer.sourceAssetId);
        if (!asset) add({ code: "ASSET_MISSING", severity: "hard_error", zoneId: page.zoneId, layerId: layer.layerId });
        else if (asset.sha256 !== layer.sourceAssetSha256) add({ code: "ASSET_HASH_MISMATCH", severity: "hard_error", zoneId: page.zoneId, layerId: layer.layerId });
        else if (effectivePpi(asset, layer) < profile.limits.provisionalMinEffectivePpi) {
          add({ code: "LOW_EFFECTIVE_PPI", severity: "hard_error", zoneId: page.zoneId, layerId: layer.layerId, detail: `provisional minimum ${profile.limits.provisionalMinEffectivePpi} PPI` });
        }
      } else {
        const font = fonts.get(layer.fontAssetId);
        if (!font || font.fileSha256 !== layer.fontFileSha256 || font.licenseVersion !== layer.fontLicenseVersion) add({ code: "FONT_UNLICENSED", severity: "hard_error", zoneId: page.zoneId, layerId: layer.layerId });
        if (layer.text.length > profile.limits.maxTextChars) add({ code: "TEXT_TOO_LONG", severity: "hard_error", zoneId: page.zoneId, layerId: layer.layerId });
      }
    }
  }
  add({ code: "PRINT_PROFILE_UNAPPROVED", severity: "info", detail: profile.status });
  return { state: issues.some(issue => issue.severity === "hard_error") ? "blocked" : "preview_only", issues, printProfileVersion: profile.version };
}

// --- the single synthetic preview profile + licensed fonts shipped in M3 -------------------------
/**
 * SYNTHETIC preview coordinate frame. The 200 x 260 mm figure is the approved Design Release 1.1.1
 * simulation's illustrative zone ("Illustrative 200 by 260 mm zone"); it is NOT a supplier print
 * area, bleed or safety specification. Real supplier values arrive with M5 under their own approval.
 */
export const SYNTHETIC_PREVIEW_PROFILE: PrintProfileV1 = Object.freeze(PrintProfileV1Schema.parse({
  schemaVersion: "print-profile.v1", profileId: "profile_synthetic_preview", version: "synthetic-1", status: "synthetic_unapproved",
  supplierApproved: false, printReleaseEligible: false, label: "SYNTHETIC PREVIEW FRAME — NOT A SUPPLIER PRINT AREA",
  productFamily: "black-oversized-tee",
  zones: [
    { zoneId: "front", widthMm: 200, heightMm: 260, safeMarginMm: 10, bleedMm: 0 },
    { zoneId: "back", widthMm: 200, heightMm: 260, safeMarginMm: 10, bleedMm: 0 },
  ],
  limits: { maxLayersPerZone: 16, maxTextChars: 280, provisionalMinEffectivePpi: 150 },
}));
export const EMPTY_SYNTHETIC_SCENE = (): CompositionSceneV1 => ({
  schemaVersion: SCENE_SCHEMA_VERSION, productFamily: SYNTHETIC_PREVIEW_PROFILE.productFamily,
  printProfileId: SYNTHETIC_PREVIEW_PROFILE.profileId, printProfileVersion: SYNTHETIC_PREVIEW_PROFILE.version,
  pages: SYNTHETIC_PREVIEW_PROFILE.zones.map(zone => ({ zoneId: zone.zoneId, layers: [] })),
});

/** The only font M3 may reference: the already-bundled, OFL-1.1 Archivo variable file (apps/web/src/fonts). */
export const LICENSED_FONTS: readonly LicensedFontV1[] = Object.freeze([
  Object.freeze(LicensedFontV1Schema.parse({
    fontAssetId: "font_archivo_variable_v1", family: "Archivo",
    fileSha256: "0e094a7d3c7c4c25cf1310c4b30014f1dae9332220b1c2c88f4fa996f0b05053", licenseVersion: "OFL-1.1",
  })),
]);
