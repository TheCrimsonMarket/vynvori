import {
  SYNTHETIC_PREVIEW_PROFILE, LICENSED_FONTS, quantizeMm, rotatedBounds, normalizeScene,
  type CompositionSceneV1, type EditorLayerV1, type EditorPageV1,
} from "@vynvori/contracts";

/** Pure editor state transitions. No React, no DOM: the same scene shape the server validates and hashes. */
export type EditorAsset = Readonly<{ assetId: string; sha256: string; widthPx: number; heightPx: number; name: string; url: string; persisted: boolean }>;
export const PT_TO_MM = 25.4 / 72;
export const profile = SYNTHETIC_PREVIEW_PROFILE;
export const font = LICENSED_FONTS[0]!;
export const zoneOf = (zoneId: string) => profile.zones.find(zone => zone.zoneId === zoneId) ?? profile.zones[0]!;

const page = (scene: CompositionSceneV1, zoneId: string) => scene.pages.find(candidate => candidate.zoneId === zoneId);
export const layersOf = (scene: CompositionSceneV1, zoneId: string): readonly EditorLayerV1[] => [...(page(scene, zoneId)?.layers ?? [])].sort((a, b) => a.zIndex - b.zIndex);
function mapPage(scene: CompositionSceneV1, zoneId: string, change: (layers: EditorLayerV1[]) => EditorLayerV1[]): CompositionSceneV1 {
  const pages: EditorPageV1[] = scene.pages.map(candidate => candidate.zoneId === zoneId ? { zoneId, layers: change([...candidate.layers]) } : candidate);
  return { ...scene, pages };
}
function nextLayerId(scene: CompositionSceneV1): string {
  let max = 0;
  for (const candidate of scene.pages) for (const layer of candidate.layers) { const match = /^layer_(\d+)$/.exec(layer.layerId); if (match) max = Math.max(max, Number(match[1])); }
  return `layer_${max + 1}`;
}
const nextZ = (layers: readonly EditorLayerV1[]) => layers.reduce((max, layer) => Math.max(max, layer.zIndex), -1) + 1;
/** z-order is dense 0..n-1 after every operation, so reorder is an exact swap. */
const renumber = (layers: EditorLayerV1[]) => [...layers].sort((a, b) => a.zIndex - b.zIndex).map((layer, index) => ({ ...layer, zIndex: index }));

export function addImageLayer(scene: CompositionSceneV1, zoneId: string, asset: EditorAsset): { scene: CompositionSceneV1; layerId: string } {
  const zone = zoneOf(zoneId), inner = { w: zone.widthMm - 2 * zone.safeMarginMm, h: zone.heightMm - 2 * zone.safeMarginMm };
  const scale = Math.min(inner.w / asset.widthPx, inner.h / asset.heightPx), widthMm = quantizeMm(asset.widthPx * scale), heightMm = quantizeMm(asset.heightPx * scale);
  const layerId = nextLayerId(scene);
  const next = mapPage(scene, zoneId, layers => [...layers, { kind: "image", layerId, sourceAssetId: asset.assetId, sourceAssetSha256: asset.sha256,
    xMm: quantizeMm((zone.widthMm - widthMm) / 2), yMm: quantizeMm((zone.heightMm - heightMm) / 2), widthMm, heightMm, rotationDeg: 0, zIndex: nextZ(layers), visible: true }]);
  return { scene: next, layerId };
}
export function addTextLayer(scene: CompositionSceneV1, zoneId: string, text = "YOUR TEXT"): { scene: CompositionSceneV1; layerId: string } {
  const zone = zoneOf(zoneId), layerId = nextLayerId(scene), fontSizePt = 30, widthMm = quantizeMm(zone.widthMm - 2 * zone.safeMarginMm), heightMm = quantizeMm(fontSizePt * PT_TO_MM * 1.3);
  const next = mapPage(scene, zoneId, layers => [...layers, { kind: "text", layerId, text, fontAssetId: font.fontAssetId, fontFileSha256: font.fileSha256, fontLicenseVersion: font.licenseVersion,
    fontSizePt, color: "#ffffff", xMm: zone.safeMarginMm, yMm: quantizeMm(zone.heightMm / 2 - heightMm / 2), widthMm, heightMm, rotationDeg: 0, zIndex: nextZ(layers), visible: true }]);
  return { scene: next, layerId };
}
export type LayerPatch = Partial<Pick<EditorLayerV1, "xMm" | "yMm" | "widthMm" | "heightMm" | "rotationDeg" | "visible">> & { text?: string; fontSizePt?: number; color?: string };
/** Quantises to 1 µm and refuses non-finite or non-positive sizes (the previous value wins). */
export function updateLayer(scene: CompositionSceneV1, zoneId: string, layerId: string, patch: LayerPatch): CompositionSceneV1 {
  return mapPage(scene, zoneId, layers => layers.map(layer => {
    if (layer.layerId !== layerId) return layer;
    const next = { ...layer } as Record<string, unknown>;
    for (const key of ["xMm", "yMm", "widthMm", "heightMm", "rotationDeg"] as const) {
      const value = patch[key];
      if (value === undefined || !Number.isFinite(value)) continue;
      if ((key === "widthMm" || key === "heightMm") && value <= 0) continue;
      next[key] = quantizeMm(key === "rotationDeg" ? Math.max(-360, Math.min(360, value)) : Math.max(-5000, Math.min(5000, value)));
    }
    if (patch.visible !== undefined) next.visible = patch.visible;
    if (layer.kind === "text") {
      if (patch.text !== undefined) next.text = patch.text.slice(0, profile.limits.maxTextChars);
      if (patch.fontSizePt !== undefined && Number.isFinite(patch.fontSizePt) && patch.fontSizePt > 0) next.fontSizePt = Math.min(500, patch.fontSizePt);
      if (patch.color !== undefined && /^#[0-9a-fA-F]{6}$/.test(patch.color)) next.color = patch.color.toLowerCase();
    }
    return next as EditorLayerV1;
  }));
}
export function nudge(scene: CompositionSceneV1, zoneId: string, layerId: string, dxMm: number, dyMm: number): CompositionSceneV1 {
  const layer = layersOf(scene, zoneId).find(candidate => candidate.layerId === layerId);
  return layer ? updateLayer(scene, zoneId, layerId, { xMm: layer.xMm + dxMm, yMm: layer.yMm + dyMm }) : scene;
}
export function resizeKeepingAspect(scene: CompositionSceneV1, zoneId: string, layerId: string, dimension: "widthMm" | "heightMm", value: number): CompositionSceneV1 {
  const layer = layersOf(scene, zoneId).find(candidate => candidate.layerId === layerId);
  if (!layer || !(value > 0)) return scene;
  const ratio = layer.heightMm / layer.widthMm;
  return updateLayer(scene, zoneId, layerId, dimension === "widthMm" ? { widthMm: value, heightMm: value * ratio } : { heightMm: value, widthMm: value / ratio });
}
export function moveInStack(scene: CompositionSceneV1, zoneId: string, layerId: string, direction: "up" | "down"): CompositionSceneV1 {
  return mapPage(scene, zoneId, layers => {
    const ordered = renumber(layers), index = ordered.findIndex(layer => layer.layerId === layerId), target = direction === "up" ? index + 1 : index - 1;
    if (index < 0 || target < 0 || target >= ordered.length) return ordered;
    const a = ordered[index]!, b = ordered[target]!;
    ordered[index] = { ...a, zIndex: b.zIndex }; ordered[target] = { ...b, zIndex: a.zIndex };
    return ordered;
  });
}
export function deleteLayer(scene: CompositionSceneV1, zoneId: string, layerId: string): CompositionSceneV1 {
  return mapPage(scene, zoneId, layers => renumber(layers.filter(layer => layer.layerId !== layerId)));
}
export function duplicateLayer(scene: CompositionSceneV1, zoneId: string, layerId: string): { scene: CompositionSceneV1; layerId: string | null } {
  const source = layersOf(scene, zoneId).find(layer => layer.layerId === layerId);
  if (!source) return { scene, layerId: null };
  const id = nextLayerId(scene);
  return { scene: mapPage(scene, zoneId, layers => renumber([...layers, { ...source, layerId: id, xMm: quantizeMm(source.xMm + 5), yMm: quantizeMm(source.yMm + 5), zIndex: nextZ(layers) }])), layerId: id };
}
/** Strict decimal parsing for numeric fields: "12", "12.5", "-3,5" ok; "", "1e9x", "NaN" rejected. */
export function parseMm(raw: string): number | null {
  const text = raw.trim().replace(",", ".");
  if (!/^-?\d{1,5}(\.\d{1,4})?$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}
export const keyStep = (event: { shiftKey: boolean; altKey: boolean }) => (event.shiftKey ? 10 : event.altKey ? 0.1 : 1);
export const isOutside = (zoneId: string, layer: EditorLayerV1) => {
  const zone = zoneOf(zoneId), bounds = rotatedBounds(layer);
  return bounds.minX < 0 || bounds.minY < 0 || bounds.maxX > zone.widthMm || bounds.maxY > zone.heightMm;
};
export const sceneKey = (scene: CompositionSceneV1) => JSON.stringify(normalizeScene(scene));

/** Bounded undo/redo over whole-scene snapshots. */
export type History = Readonly<{ past: readonly CompositionSceneV1[]; present: CompositionSceneV1; future: readonly CompositionSceneV1[] }>;
export const startHistory = (scene: CompositionSceneV1): History => ({ past: [], present: scene, future: [] });
export const commit = (history: History, scene: CompositionSceneV1, limit = 100): History =>
  scene === history.present ? history : { past: [...history.past, history.present].slice(-limit), present: scene, future: [] };
export const undo = (history: History): History => history.past.length ? { past: history.past.slice(0, -1), present: history.past.at(-1)!, future: [history.present, ...history.future] } : history;
export const redo = (history: History): History => history.future.length ? { past: [...history.past, history.present], present: history.future[0]!, future: history.future.slice(1) } : history;

/**
 * Client-side upload pre-checks. The numbers come ONLY from the `uploadLimits` prop (parsed server-side from `M3_LIMIT_*`
 * configuration); there is no local copy and no default. These checks only save a round trip: the server stays authoritative.
 */
export type UploadLimits = Readonly<{ maxBytes: number; maxPixels: number; maxSidePx: number }>;
export type UploadCheck = Readonly<{ ok: true }> | Readonly<{ ok: false; reason: "size" | "pixels" | "side"; message: string }>;
const MEBIBYTE = 1024 * 1024;
export const describeBytes = (bytes: number) => bytes >= MEBIBYTE ? `${Number((bytes / MEBIBYTE).toFixed(1))} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
export function checkUploadFileSize(name: string, byteSize: number, limits: UploadLimits): UploadCheck {
  return byteSize > limits.maxBytes ? { ok: false, reason: "size", message: `${name}: that file is too large (${describeBytes(limits.maxBytes)} maximum).` } : { ok: true };
}
export function checkUploadDimensions(name: string, widthPx: number, heightPx: number, limits: UploadLimits): UploadCheck {
  if (Math.max(widthPx, heightPx) > limits.maxSidePx) return { ok: false, reason: "side", message: `${name}: image is too large (longest side ${limits.maxSidePx.toLocaleString("en-US")} pixels maximum).` };
  if (widthPx * heightPx > limits.maxPixels) return { ok: false, reason: "pixels", message: `${name}: image is too large (${limits.maxPixels.toLocaleString("en-US")} pixels in total maximum).` };
  return { ok: true };
}
/** Guest-draft expiry wording derived from the API's `expiresAt`; never a hard-coded duration. */
export function describeExpiry(expiresAt: string | null | undefined, locale?: string, timeZone?: string): string {
  const date = expiresAt ? new Date(expiresAt) : null;
  if (!date || Number.isNaN(date.getTime())) return "until it expires";
  return `until ${new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", ...(timeZone ? { timeZone } : {}) }).format(date)}`;
}
