import "./zod-jitless";
import {
  SYNTHETIC_PREVIEW_PROFILE, LICENSED_FONTS, quantizeMm, rotatedBounds, normalizeScene,
  type CompositionSceneV1, type EditorLayerV1, type EditorPageV1,
} from "@vynvori/contracts";

/** Pure editor state transitions. No React, no DOM: the same scene shape the server validates and hashes. */
/** Server scan lifecycle (ADR-0022 D3/C5). Absent on an asset the browser added and has not uploaded yet. */
export type ScanStatus = "pending" | "clean" | "quarantined" | "unknown";
/**
 * `url` is either a `data:` URL of bytes this browser already holds (a local preview, founder ruling QB) or the server asset
 * route. A server URL is drawn only once the asset is `clean`; see `previewHref`.
 */
export type EditorAsset = Readonly<{ assetId: string; sha256: string; widthPx: number; heightPx: number; name: string; url: string; persisted: boolean; scanStatus?: ScanStatus }>;
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
/** Keyboard nudge distances in mm. One source for the behaviour and for the help text screen-reader users hear. */
export const KEY_STEP_MM = { fine: 0.1, normal: 1, coarse: 10 } as const;
export const KEY_HELP = `Arrow keys move the focused layer ${KEY_STEP_MM.normal} mm. Shift with an arrow key moves ${KEY_STEP_MM.coarse} mm, Alt moves ${KEY_STEP_MM.fine} mm. Delete removes the layer.`;
export const keyStep = (event: { shiftKey: boolean; altKey: boolean }) => (event.shiftKey ? KEY_STEP_MM.coarse : event.altKey ? KEY_STEP_MM.fine : KEY_STEP_MM.normal);
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

/**
 * How the editor reads an API failure (ADR-0022 C4). Pure so it can be tested without a browser. `rate_limited` is a 429 (wait, then
 * one retry), `not_configured` is the closed-capability 503 (never retried), `capacity` is the global guest-draft cap (503, retryable
 * by the person, never automatically). The numbers shown come from the server's own `retryAfterSeconds`; there is no local default.
 */
export type ApiFailureKind = "rate_limited" | "not_configured" | "capacity" | "other";
export type ApiFailure = Readonly<{ kind: ApiFailureKind; retryAfterSeconds: number | null }>;
/** Engineering constant, not policy: the longest delay a browser timer can hold (2^31 - 1 ms), so a bad hint cannot overflow `setTimeout`. */
export const MAX_RETRY_AFTER_SECONDS = 2_147_483;
export function classifyApiFailure(status: number, data: unknown): ApiFailure {
  const error = data && typeof data === "object" && "error" in data && data.error && typeof data.error === "object" ? (data.error as Record<string, unknown>) : {};
  const code = typeof error.code === "string" ? error.code : "";
  const wait = typeof error.retryAfterSeconds === "number" && Number.isSafeInteger(error.retryAfterSeconds) && error.retryAfterSeconds > 0 ? Math.min(error.retryAfterSeconds, MAX_RETRY_AFTER_SECONDS) : null;
  if (status === 429 || code === "COMPOSITION_RATE_LIMITED") return { kind: "rate_limited", retryAfterSeconds: wait };
  if (code === "COMPOSITION_LIMITS_NOT_CONFIGURED") return { kind: "not_configured", retryAfterSeconds: null };
  if (code === "COMPOSITION_GUEST_CAPACITY") return { kind: "capacity", retryAfterSeconds: null };
  return { kind: "other", retryAfterSeconds: null };
}
/** Status-line text for a rate-limited save (automatic single retry) or a rate-limited action the person started (manual retry). */
export function describeRateLimited(retryAfterSeconds: number | null, retry: "automatic" | "manual"): string {
  // With no wait from the server no timer is armed, so an "automatic" message must not promise one.
  if (retryAfterSeconds === null) return retry === "automatic" ? "Too many requests. Your edits are still here. Press Save to try again." : "Too many requests. Your edits are still here. Try again shortly.";
  const when = `in about ${plural(retryAfterSeconds, "second")}`;
  return retry === "automatic" ? `Too many requests. Your edits are still here and saving will try again ${when}.` : `Too many requests. Your edits are still here. Try again ${when}.`;
}
export const describeNotConfigured = (what: "saving" | "artwork upload") => `${what === "saving" ? "Saving" : "Artwork upload"} is not set up yet. Your work stays in this tab only.`;
export const describeGuestCapacity = () => "Saved guest drafts are full right now. Your work stays in this tab only. Try again later or sign in.";

// --- accessibility helpers (pure; the announcements and names the editor exposes to assistive technology)
/** The list label of a layer. Image names are the uploaded file name (never a path or an id). */
export const layerTitle = (layer: EditorLayerV1, imageName?: string) => layer.kind === "text" ? `Text · ${layer.text.slice(0, 24)}` : `Image · ${imageName ?? "missing"}`;
/** 1-based position counted from the top of the stack (the order of the Layers list), or null if the layer is not in the zone. */
export function stackPosition(scene: CompositionSceneV1, zoneId: string, layerId: string): number | null {
  const ordered = layersOf(scene, zoneId), index = ordered.findIndex(layer => layer.layerId === layerId);
  return index < 0 ? null : ordered.length - index;
}
/** Per-layer action names stay unique because they carry the stack position: "Move up: Text · A, layer 2 of 3". */
export const layerActionName = (action: string, title: string, position: number, total: number) => `${action}: ${title}, layer ${position} of ${total}`;
/** The layer that should receive focus once `layerId` is deleted: the one below it in the list, else the one above, else null. */
export function neighbourAfterDelete(scene: CompositionSceneV1, zoneId: string, layerId: string): string | null {
  const ordered = layersOf(scene, zoneId), index = ordered.findIndex(layer => layer.layerId === layerId);
  if (index < 0) return null;
  return (ordered[index - 1] ?? ordered[index + 1])?.layerId ?? null;
}
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const describeLayerCount = (n: number) => n === 0 ? "No layers" : plural(n, "layer");
/** One short sentence instead of re-reading the whole issue list. `info` entries (the always-present preview-only note) are not counted. */
export function summarizeIssues(issues: readonly { severity: string }[]): string {
  const problems = issues.filter(issue => issue.severity === "hard_error").length, warnings = issues.filter(issue => issue.severity === "warning").length;
  if (problems + warnings === 0) return "Preview checks: no problems or warnings.";
  return `Preview checks: ${[problems ? plural(problems, "problem") : "", warnings ? plural(warnings, "warning") : ""].filter(Boolean).join(" and ")}.`;
}
export const describeMove = (xMm: number, yMm: number) => `Moved to x ${xMm} mm, y ${yMm} mm.`;

// --- artwork safety check (ADR-0022 C5). The server is authoritative; these only decide what the editor draws and says.
const SCAN_STATUSES: readonly ScanStatus[] = ["pending", "clean", "quarantined", "unknown"];
/** An unrecognised or missing status from the server is treated as `pending`: never as clean. */
export const parseScanStatus = (value: unknown): ScanStatus => (SCAN_STATUSES as readonly unknown[]).includes(value) ? (value as ScanStatus) : "pending";
const isLocalPreview = (url: string) => url.startsWith("data:");
/**
 * What the canvas may draw for an asset: bytes the browser already holds (ruling QB: unchanged local preview), or server pixels
 * only when the server says `clean`. Anything else is a placeholder, so pending, unknown and quarantined pixels never load.
 */
export function previewHref(asset: Pick<EditorAsset, "url" | "scanStatus">): string | null {
  if (isLocalPreview(asset.url)) return asset.url;
  return asset.scanStatus === "clean" ? asset.url : null;
}
/** Short state added to a layer's name, or null when nothing needs saying (clean, or not uploaded yet). */
export function scanLabel(status: ScanStatus | undefined): string | null {
  switch (status) {
    case "pending": return "safety check pending";
    case "unknown": return "safety check did not finish";
    case "quarantined": return "blocked by the safety check";
    default: return null;
  }
}
/** Whether the person can ask for another check: only for an uploaded asset whose check is pending or did not finish. */
export const canRequestScan = (asset: Pick<EditorAsset, "persisted" | "scanStatus"> | undefined) => !!asset?.persisted && (asset.scanStatus === "pending" || asset.scanStatus === "unknown");
/** The sentence announced after an upload or a check. Never names a scanner, a reason code or evidence. */
export function describeScanOutcome(name: string, status: ScanStatus): string {
  switch (status) {
    case "clean": return `${name}: safety check passed.`;
    case "pending": return `${name}: safety check in progress. Choose Check again in a moment.`;
    case "unknown": return `${name}: the safety check could not finish. Choose Check again to try once more.`;
    case "quarantined": return `${name}: this artwork did not pass the safety check and cannot be used. Remove it from the design.`;
  }
}

// --- download the unchanged original (ADR-0022 D4, C6). The server is authoritative: it mints only for a `clean` asset it owns.
/** Offered only for an uploaded asset the server reports `clean`; never for pending, unknown, quarantined or a local-only asset. */
export const canDownloadOriginal = (asset: Pick<EditorAsset, "persisted" | "scanStatus"> | undefined) => !!asset?.persisted && asset.scanStatus === "clean";
const GRANT_TOKEN = /^[A-Za-z0-9_-]{43}$/;
/**
 * Where and how to redeem, from a mint response, or null. The path must be exactly this composition's and asset's download route with
 * no query string, and the token one well-formed grant: a malformed or foreign answer can never send the request elsewhere. The token
 * is sent in a header, never in a URL (founder decision 2026-11-27: logs never carry the link code).
 */
export function downloadTargetFrom(data: unknown, compositionId: string, assetId: string): { path: string; token: string } | null {
  if (!data || typeof data !== "object") return null;
  const { downloadUrl, grantToken } = data as { downloadUrl?: unknown; grantToken?: unknown };
  const path = `/api/v1/compositions/${compositionId}/assets/${assetId}/download`;
  return downloadUrl === path && typeof grantToken === "string" && GRANT_TOKEN.test(grantToken) ? { path, token: grantToken } : null;
}
/** What the person hears when a download cannot start. Never names a token, a grant id or an internal reason. */
export function describeDownloadFailure(status: number, data: unknown): string {
  const failure = classifyApiFailure(status, data);
  if (failure.kind === "rate_limited") return failure.retryAfterSeconds === null ? "Too many download requests. Try again shortly." : `Too many download requests. Try again in about ${plural(failure.retryAfterSeconds, "second")}.`;
  const code = data && typeof data === "object" && "error" in data && data.error && typeof data.error === "object" ? (data.error as { code?: unknown }).code : undefined;
  if (code === "COMPOSITION_ASSET_NOT_AVAILABLE") return "This artwork cannot be downloaded until it passes its safety check.";
  if (failure.kind === "not_configured" || code === "COMPOSITION_DOWNLOAD_UNAVAILABLE") return "Downloading originals is not set up yet.";
  return "The download could not be started. Try again.";
}
export const describeDownloadStarted = (name: string) => `${name}: download started.`;
/** The server-generated filename from the download response, accepted only in its exact shape (`original-<sha12>.<ext>`), else null. */
export function downloadFileName(disposition: string | null): string | null {
  const match = /^attachment; filename="(original-[0-9a-f]{12}\.(?:png|jpg|webp))"$/.exec(disposition ?? "");
  return match ? match[1]! : null;
}
