"use client";
import "./zod-jitless";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { CompositionSceneV1Schema, EMPTY_SYNTHETIC_SCENE, LICENSED_FONTS, runPreviewPreflight, type CompositionSceneV1, type EditorLayerV1, type AssetFacts } from "@vynvori/contracts";
import { Button } from "@/components/ui/button";
import {
  KEY_HELP, PT_TO_MM, addImageLayer, addTextLayer, commit, deleteLayer, describeLayerCount, describeMove, duplicateLayer, font, isOutside, keyStep, layerActionName, layerTitle, layersOf, moveInStack,
  neighbourAfterDelete, nudge, parseMm, profile, redo, resizeKeepingAspect, sceneKey, stackPosition, startHistory, summarizeIssues, undo, updateLayer, zoneOf,
  checkUploadDimensions, checkUploadFileSize, classifyApiFailure, describeExpiry, describeGuestCapacity, describeNotConfigured, describeRateLimited, type ApiFailure, type EditorAsset, type LayerPatch, type UploadLimits,
  canRequestScan, describeScanOutcome, parseScanStatus, previewHref, scanLabel, type ScanStatus,
  canDownloadOriginal, describeDownloadFailure, describeDownloadStarted, downloadPathFrom,
} from "./model";

type ServerState = { compositionId: string | null; revision: number; owner: "guest" | "owner" | null; autosave: "idle" | "pending" | "conflict" | "failed" | "unavailable" | "limited" | "blocked"; lastSavedKey: string | null; expiresAt: string | null; versions: VersionView[]; currentVersionId: string | null };
type VersionView = { versionId: string; versionNo: number; sceneHashSha256: string; frozenAt: string; preflight: { state: "preview_only" | "blocked"; issues: { code: string; severity: string; layerId?: string; zoneId?: string }[] } };
const ACCEPT = "image/png,image/jpeg,image/webp";
const ISSUE_TEXT: Record<string, string> = {
  PROFILE_MISMATCH: "The composition does not match the print profile.", ZONE_UNKNOWN: "Unknown print zone.", TOO_MANY_LAYERS: "Too many layers in this zone.",
  TEXT_TOO_LONG: "Text is too long.", LAYER_OUT_OF_BOUNDS: "Layer extends outside the zone.", LAYER_OUTSIDE_SAFE_MARGIN: "Layer is inside the safety margin.",
  ASSET_MISSING: "Artwork is missing.", ASSET_HASH_MISMATCH: "Artwork changed since it was added.", ASSET_NOT_SCANNED: "Artwork has not passed the safety check.", FONT_UNLICENSED: "Font is not available.",
  LOW_EFFECTIVE_PPI: "Artwork resolution is low at this size (provisional threshold).", PRINT_PROFILE_UNAPPROVED: "Preview only: this profile is not approved for printing.",
};
async function sha256Hex(bytes: ArrayBuffer): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join(""); }
function decodeSize(url: string): Promise<{ w: number; h: number }> {
  return new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve({ w: image.naturalWidth, h: image.naturalHeight }); image.onerror = () => reject(new Error("decode")); image.src = url; });
}
const toDataUrl = (file: Blob) => new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("read")); reader.readAsDataURL(file); });
async function csrfHeaders(): Promise<Record<string, string>> {
  try { const response = await fetch("/api/auth/csrf", { cache: "no-store", credentials: "same-origin" }); const data: unknown = await response.json();
    if (response.ok && data && typeof data === "object" && "csrfToken" in data && typeof data.csrfToken === "string") return { "x-vynvori-csrf": data.csrfToken }; } catch { /* guest or auth unavailable */ }
  return {};
}
// biome-ignore lint/suspicious/noExplicitAny: response payloads are validated by the caller's schema
async function api(path: string, method: string, body?: unknown, raw?: { bytes: ArrayBuffer; type: string }): Promise<{ ok: boolean; status: number; data: any }> {
  const headers: Record<string, string> = method === "GET" ? {} : await csrfHeaders();
  if (body !== undefined) headers["content-type"] = "application/json"; if (raw) headers["content-type"] = raw.type;
  const response = await fetch(path, { method, cache: "no-store", credentials: "same-origin", headers, ...(raw ? { body: raw.bytes } : body === undefined ? {} : { body: JSON.stringify(body) }) });
  let data: unknown = null; try { data = await response.json(); } catch { /* binary or empty */ }
  return { ok: response.ok, status: response.status, data };
}

// Engineering constants (not policy limits): how long to wait for a burst of changes to settle before speaking.
const ANNOUNCE_DEBOUNCE_MS = 400, ISSUE_SUMMARY_DEBOUNCE_MS = 600;
type FocusTarget = { kind: "tab"; zoneId: string } | { kind: "layer"; layerId: string | null } | { kind: "row"; layerId: string | null } | { kind: "action"; layerId: string; action: "up" | "down" };
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => { const timer = setTimeout(() => setSettled(value), ms); return () => clearTimeout(timer); }, [value, ms]);
  return settled;
}
/** Numeric field with a local draft: it commits on blur or Enter, keeps focus on Enter, and reports problems inline next to the field. */
function NumericField({ label, unit, value, error, onApply, onInvalid, onEdit }: Readonly<{ label: string; unit: string; value: number; error: string | null; onApply: (n: number) => void; onInvalid: (text: string) => void; onEdit: () => void }>) {
  const [draft, setDraft] = useState<string | null>(null), errorId = useId();
  const commitDraft = () => {
    if (draft === null) { if (error) onEdit(); return; } setDraft(null); // leaving the field without typing clears a stale error
    const n = parseMm(draft);
    if (n === null) onInvalid(`${label}: enter a number.`); else if (n !== value) onApply(n); else onEdit();
  };
  return (
    <div className="ed-fieldrow">
      <label className="ed-field"><span>{label}</span><span className="ed-num"><input inputMode="decimal" value={draft ?? String(value)} aria-label={`${label} (${unit})`} aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
        onChange={e => { setDraft(e.currentTarget.value); if (error) onEdit(); }} onBlur={commitDraft} onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); commitDraft(); } }} /><small>{unit}</small></span></label>
      {error && <p className="ed-field-error" id={errorId} role="alert">{error}</p>}
    </div>);
}

export function Editor({ compositionId: initialId, artworkUpload, uploadLimits }: Readonly<{ compositionId?: string; artworkUpload: boolean; uploadLimits: UploadLimits | null }>) {
  const canUpload = artworkUpload && uploadLimits !== null;
  const [history, setHistory] = useState(() => startHistory(EMPTY_SYNTHETIC_SCENE()));
  const [assets, setAssets] = useState<ReadonlyMap<string, EditorAsset>>(new Map());
  const [zoneId, setZoneId] = useState("front"), [selected, setSelected] = useState<string | null>(null), [aspectLock, setAspectLock] = useState(true);
  const [message, setMessage] = useState(""), [busy, setBusy] = useState(false);
  const [server, setServer] = useState<ServerState>({ compositionId: initialId ?? null, revision: 0, owner: null, autosave: "idle", lastSavedKey: null, expiresAt: null, versions: [], currentVersionId: null });
  const bytes = useRef(new Map<string, { data: ArrayBuffer; type: string }>()), svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{ layerId: string; startX: number; startY: number; originX: number; originY: number; start: CompositionSceneV1 } | null>(null);
  const scene = history.present, zone = zoneOf(zoneId), layers = layersOf(scene, zoneId), current = layers.find(layer => layer.layerId === selected) ?? null;
  const key = useMemo(() => sceneKey(scene), [scene]), dirty = key !== server.lastSavedKey;

  const edit = useCallback((next: CompositionSceneV1) => setHistory(h => commit(h, next)), []);
  const notify = (text: string) => setMessage(previous => (previous.replace(/\u00A0$/, "") === text && !previous.endsWith("\u00A0") ? `${text}\u00A0` : text)); // a repeated outcome still changes the text node, so it is announced again

  // --- assistive-technology feedback: one polite announcer for editor actions (separate from the visible status line),
  // an inline error per numeric field, and an explicit focus target after any change that removes the focused element.
  const [announcement, setAnnouncement] = useState(""), [fieldError, setFieldError] = useState<{ layerId: string; label: string; text: string } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a field error belongs to the selection it was raised for
  useEffect(() => setFieldError(null), [selected]);
  const announceTimer = useRef<ReturnType<typeof setTimeout> | null>(null), rootRef = useRef<HTMLElement | null>(null), pendingFocus = useRef<FocusTarget | null>(null);
  const speak = (text: string) => setAnnouncement(previous => (previous.replace(/ $/, "") === text && !previous.endsWith(" ") ? `${text} ` : text)); // a repeated sentence still changes the text node
  const announce = (text: string) => { if (announceTimer.current) clearTimeout(announceTimer.current); announceTimer.current = null; speak(text); };
  const announceSoon = (text: string) => { if (announceTimer.current) clearTimeout(announceTimer.current); announceTimer.current = setTimeout(() => { announceTimer.current = null; speak(text); }, ANNOUNCE_DEBOUNCE_MS); };
  useEffect(() => () => { if (announceTimer.current) clearTimeout(announceTimer.current); }, []);
  useEffect(() => { // runs after every commit; acts only when an action asked for focus to move
    const target = pendingFocus.current; if (!target) return; pendingFocus.current = null;
    const root = rootRef.current; if (!root) return;
    const find = (selector: string) => root.querySelector<HTMLElement | SVGElement>(selector), id = (value: string) => CSS.escape(value);
    const element = target.kind === "tab" ? find(`#ed-tab-${id(target.zoneId)}`)
      : target.kind === "action" ? find(`[data-row-id="${id(target.layerId)}"] [data-action="${target.action}"]`)
      : target.layerId === null ? null : (target.kind === "layer" ? find(`[data-layer-id="${id(target.layerId)}"]`) : null) ?? find(`[data-row-id="${id(target.layerId)}"] .ed-layer-name`);
    (element ?? find("#ed-add-text"))?.focus();
  });
  function switchZone(nextZoneId: string, moveFocus: boolean) {
    setZoneId(nextZoneId); setSelected(null); if (moveFocus) pendingFocus.current = { kind: "tab", zoneId: nextZoneId };
    announce(`${nextZoneId === "front" ? "Front" : nextZoneId === "back" ? "Back" : nextZoneId} side. ${describeLayerCount(layersOf(scene, nextZoneId).length)}.`);
  }
  function onTabKeyDown(event: React.KeyboardEvent, index: number) {
    if (event.altKey || event.ctrlKey || event.metaKey) return; // keep browser shortcuts such as Alt+Left (history back)
    const zones = profile.zones, last = zones.length - 1;
    const target = event.key === "ArrowRight" ? (index === last ? 0 : index + 1) : event.key === "ArrowLeft" ? (index === 0 ? last : index - 1) : event.key === "Home" ? 0 : event.key === "End" ? last : null;
    if (target === null) return; event.preventDefault(); switchZone(zones[target]!.zoneId, true);
  }
  function removeLayer(layerId: string, from: "canvas" | "list") { // focus never falls to <body>: it moves to the neighbour, or to "Add text"
    const layer = layers.find(candidate => candidate.layerId === layerId); if (!layer) return;
    const title = layerTitle(layer, layer.kind === "image" ? assets.get(layer.sourceAssetId)?.name : undefined);
    const neighbour = neighbourAfterDelete(scene, zoneId, layerId), remaining = layers.length - 1;
    pendingFocus.current = { kind: from === "canvas" ? "layer" : "row", layerId: neighbour };
    edit(deleteLayer(scene, zoneId, layerId)); setSelected(null);
    announce(`Deleted ${title}. ${remaining === 0 ? "No layers left." : `${describeLayerCount(remaining)} left.`}`);
  }
  function reorder(layerId: string, direction: "up" | "down") {
    const before = stackPosition(scene, zoneId, layerId), next = moveInStack(scene, zoneId, layerId, direction), after = stackPosition(next, zoneId, layerId);
    pendingFocus.current = { kind: "action", layerId, action: direction };
    if (before === null || after === null || before === after) { announce(direction === "up" ? "Already the top layer." : "Already the bottom layer."); return; }
    edit(next); announce(`Moved ${direction}. Now layer ${after} of ${layers.length}.`);
  }

  // --- hydrate: owned route, or resume the last guest draft of this tab (the id is not a secret; the capability is an HttpOnly cookie)
  // biome-ignore lint/correctness/useExhaustiveDependencies: hydrate runs once per route id; notify only sets a message
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let id = initialId ?? null; if (!id) { try { id = sessionStorage.getItem("vynvori.byo.compositionId"); } catch { id = null; } }
      if (!id) return;
      const loaded = await api(`/api/v1/compositions/${id}`, "GET");
      if (cancelled) return;
      if (!loaded.ok) { if (initialId) notify(loaded.status === 503 ? "Saving and restoring are not available in this preview." : "This composition could not be opened. It may have expired or belong to another account."); return; }
      const parsed = CompositionSceneV1Schema.safeParse(loaded.data.scene); if (!parsed.success) return;
      const next = new Map<string, EditorAsset>();
      for (const a of loaded.data.assets as { assetId: string; sha256: string; widthPx: number; heightPx: number; scanStatus?: unknown }[]) next.set(a.assetId, { assetId: a.assetId, sha256: a.sha256, widthPx: a.widthPx, heightPx: a.heightPx, name: "Artwork", url: `/api/v1/compositions/${id}/assets/${a.assetId}`, persisted: true, scanStatus: parseScanStatus(a.scanStatus) }); // server pixels load only once clean (previewHref)
      setAssets(next); setHistory(startHistory(parsed.data));
      setServer({ compositionId: id, revision: loaded.data.draft.draftRevision, owner: loaded.data.draft.ownerKind === "authenticated_owner" ? "owner" : "guest", autosave: "idle", lastSavedKey: sceneKey(parsed.data), expiresAt: loaded.data.expiresAt ?? null, versions: loaded.data.versions, currentVersionId: loaded.data.currentVersionId });
      notify("Draft restored.");
    })().catch(() => {});
    return () => { cancelled = true; };
  }, [initialId]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (dirty && layers.length + scene.pages.reduce((n, p) => n + p.layers.length, 0) > 0) { event.preventDefault(); } };
    window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, layers.length, scene.pages]);

  // --- artwork
  async function addFiles(files: FileList | null) {
    if (!files?.length) return; setBusy(true);
    try {
      let working = scene, last: string | null = null; const next = new Map(assets);
      for (const file of Array.from(files)) {
        if (!ACCEPT.split(",").includes(file.type)) { notify(`${file.name}: use a PNG, JPEG or WebP image.`); continue; }
        if (!uploadLimits) { notify("Artwork upload is not configured yet."); continue; }
        const sizeCheck = checkUploadFileSize(file.name, file.size, uploadLimits);
        if (!sizeCheck.ok) { notify(sizeCheck.message); continue; }
        const data = await file.arrayBuffer(), sha = await sha256Hex(data), url = await toDataUrl(new Blob([data], { type: file.type }));
        let size; try { size = await decodeSize(url); } catch { notify(`${file.name}: this image could not be read.`); continue; }
        const dimensionCheck = checkUploadDimensions(file.name, size.w, size.h, uploadLimits);
        if (!dimensionCheck.ok) { notify(dimensionCheck.message); continue; }
        const existing = [...next.values()].find(asset => asset.sha256 === sha);
        const asset: EditorAsset = existing ?? { assetId: `local_${sha.slice(0, 16)}`, sha256: sha, widthPx: size.w, heightPx: size.h, name: file.name.slice(0, 80), url, persisted: false };
        if (!existing) { next.set(asset.assetId, asset); bytes.current.set(asset.assetId, { data, type: file.type }); }
        const added = addImageLayer(working, zoneId, asset); working = added.scene; last = added.layerId;
      }
      setAssets(next); edit(working); if (last) { setSelected(last); notify("Artwork added to this preview."); }
    } finally { setBusy(false); }
  }
  function patch(layer: EditorLayerV1, change: LayerPatch) { edit(updateLayer(scene, zoneId, layer.layerId, change)); }

  // --- canvas pointer + keyboard (all geometry in mm; pixels are display only)
  function mmPoint(event: React.PointerEvent): { x: number; y: number } | null {
    const svg = svgRef.current, matrix = svg?.getScreenCTM(); if (!svg || !matrix) return null;
    const point = svg.createSVGPoint(); point.x = event.clientX; point.y = event.clientY; const mapped = point.matrixTransform(matrix.inverse()); return { x: mapped.x, y: mapped.y };
  }
  function onPointerDown(event: React.PointerEvent, layer: EditorLayerV1) {
    setSelected(layer.layerId); const at = mmPoint(event); if (!at) return;
    (event.currentTarget as Element).setPointerCapture(event.pointerId); drag.current = { layerId: layer.layerId, startX: at.x, startY: at.y, originX: layer.xMm, originY: layer.yMm, start: scene };
  }
  function onPointerMove(event: React.PointerEvent) {
    const d = drag.current, at = mmPoint(event); if (!d || !at) return;
    setHistory(h => ({ ...h, present: updateLayer(h.present, zoneId, d.layerId, { xMm: d.originX + at.x - d.startX, yMm: d.originY + at.y - d.startY }) }));
  }
  function onPointerUp() { // one undo step per completed drag
    const d = drag.current; drag.current = null; if (!d) return;
    setHistory(h => (h.present === d.start ? h : { past: [...h.past, d.start].slice(-100), present: h.present, future: [] }));
  }
  function onKeyDown(event: React.KeyboardEvent, layer: EditorLayerV1) {
    const step = keyStep(event), moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[event.key]) {
      event.preventDefault(); const [dx, dy] = moves[event.key]!, next = nudge(scene, zoneId, layer.layerId, dx, dy); edit(next);
      const moved = layersOf(next, zoneId).find(candidate => candidate.layerId === layer.layerId); if (moved) announceSoon(describeMove(moved.xMm, moved.yMm)); // one sentence per burst of key presses
    } else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); removeLayer(layer.layerId, "canvas"); }
  }

  // --- server persistence (all optional; the editor is fully usable without it)
  // ADR-0022 C4: a 429 pauses autosave and arms ONE timer from the server's own Retry-After; no hint means no automatic retry at all
  // (the Save button still works, one click per attempt). The closed-capability 503 is never retried. No retry storm either way.
  // A 4xx other than 429 is terminal for the autosave (an expired draft, an artwork quota, a rejected file): retrying it would only repeat
  // the same refusal, and an upload retry would burn the shared upload budget. "blocked" waits for the person (Save, or a reload).
  const terminal = (status: number) => status >= 400 && status < 500 && status !== 429 && status !== 408;
  const uploaded = useRef(new Map<string, { assetId: string; scanStatus: ScanStatus }>()); // `${compositionId}:${local asset id}` -> server asset, kept across attempts so a failed PUT never re-uploads
  const limitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (limitTimer.current) clearTimeout(limitTimer.current); }, []);
  function pauseForRateLimit(failure: ApiFailure) {
    if (limitTimer.current) { clearTimeout(limitTimer.current); limitTimer.current = null; }
    setServer(s => ({ ...s, autosave: "limited" }));
    if (failure.retryAfterSeconds !== null) limitTimer.current = setTimeout(() => { limitTimer.current = null; setServer(s => (s.autosave === "limited" ? { ...s, autosave: "idle" } : s)); }, failure.retryAfterSeconds * 1000);
  }
  async function ensureComposition(): Promise<{ id: string; revision: number } | null> {
    if (server.compositionId) return { id: server.compositionId, revision: server.revision };
    const created = await api("/api/v1/compositions", "POST");
    if (!created.ok) {
      const failure = classifyApiFailure(created.status, created.data);
      if (failure.kind === "rate_limited") { notify(describeRateLimited(failure.retryAfterSeconds, "automatic")); pauseForRateLimit(failure); return null; }
      if (failure.kind === "capacity") { notify(describeGuestCapacity()); setServer(s => ({ ...s, autosave: "failed" })); return null; }
      if (failure.kind === "not_configured") { notify(describeNotConfigured("saving")); setServer(s => ({ ...s, autosave: "unavailable" })); return null; }
      notify(created.status === 503 ? "Saving is not available in this preview. Your work stays in this tab only." : "Could not start a saved draft."); setServer(s => ({ ...s, autosave: created.status === 503 ? "unavailable" : terminal(created.status) ? "blocked" : "failed" })); return null;
    }
    const id = created.data.draft.compositionId as string; try { sessionStorage.setItem("vynvori.byo.compositionId", id); } catch { /* optional */ }
    setServer(s => ({ ...s, compositionId: id, revision: 0, expiresAt: created.data.expiresAt ?? null, owner: created.data.draft.ownerKind === "authenticated_owner" ? "owner" : "guest" }));
    return { id, revision: 0 };
  }
  async function saveDraft(): Promise<boolean> {
    setServer(s => ({ ...s, autosave: "pending" }));
    const target = await ensureComposition(); if (!target) return false;
    let working = scene; const remap = new Map<string, EditorAsset>(assets), scanned: string[] = [];
    for (const asset of assets.values()) {
      if (asset.persisted || !bytes.current.has(asset.assetId)) continue;
      const cacheKey = `${target.id}:${asset.assetId}`, known = uploaded.current.get(cacheKey);
      const stored = bytes.current.get(asset.assetId)!, up = known ? { ok: true as const, status: 200, data: { asset: known } } : await api(`/api/v1/compositions/${target.id}/assets`, "POST", undefined, { bytes: stored.data, type: stored.type });
      if (!up.ok) {
        const failure = classifyApiFailure(up.status, up.data);
        if (failure.kind === "rate_limited") { notify(describeRateLimited(failure.retryAfterSeconds, "automatic")); pauseForRateLimit(failure); return false; }
        if (failure.kind === "not_configured") { notify(describeNotConfigured("artwork upload")); setServer(s => ({ ...s, autosave: "unavailable" })); return false; }
      }
      if (!up.ok) { notify(up.status === 503 ? "Artwork upload is not available in this preview; your work stays in this tab only." : up.status === 415 ? "That file type is not accepted." : "Artwork could not be saved."); setServer(s => ({ ...s, autosave: up.status === 503 ? "unavailable" : terminal(up.status) ? "blocked" : "failed" })); return false; }
      const serverId = up.data.asset.assetId as string, scanStatus = parseScanStatus(up.data.asset.scanStatus); uploaded.current.set(cacheKey, { assetId: serverId, scanStatus });
      // The local data URL stays: this browser already holds these bytes (ruling QB). Only the scan status comes from the server.
      remap.set(serverId, { ...asset, assetId: serverId, persisted: true, scanStatus }); remap.delete(asset.assetId); if (!known) scanned.push(describeScanOutcome(asset.name, scanStatus));
      working = { ...working, pages: working.pages.map(p => ({ ...p, layers: p.layers.map(l => l.kind === "image" && l.sourceAssetId === asset.assetId ? { ...l, sourceAssetId: serverId } : l) })) };
    }
    const saved = await api(`/api/v1/compositions/${target.id}`, "PUT", { expectedRevision: target.revision, scene: working });
    if (saved.status === 409) { setServer(s => ({ ...s, autosave: "conflict" })); notify("This draft changed elsewhere. Reload to continue without losing your copy."); return false; }
    if (!saved.ok) {
      const failure = classifyApiFailure(saved.status, saved.data);
      if (failure.kind === "rate_limited") { notify(describeRateLimited(failure.retryAfterSeconds, "automatic")); pauseForRateLimit(failure); return false; }
      if (failure.kind === "not_configured") { notify(describeNotConfigured("saving")); setServer(s => ({ ...s, autosave: "unavailable" })); return false; }
    }
    if (!saved.ok) { setServer(s => ({ ...s, autosave: terminal(saved.status) ? "blocked" : "failed" })); notify(saved.status === 401 ? "Your draft expired or you were signed out. Start a new draft or sign in." : "Could not save. Your edits are still here."); return false; }
    setAssets(remap); setHistory(h => ({ ...h, present: working }));
    setServer(s => ({ ...s, compositionId: target.id, revision: saved.data.draft.draftRevision, autosave: "idle", lastSavedKey: sceneKey(working), expiresAt: saved.data.expiresAt ?? s.expiresAt, owner: saved.data.draft.ownerKind === "authenticated_owner" ? "owner" : "guest" }));
    notify([saved.data.draft.ownerKind === "authenticated_owner" ? "Saved to your account." : `Draft saved on this device ${describeExpiry(saved.data.expiresAt ?? server.expiresAt)}. Sign in to keep it.`, ...scanned].join(" ")); return true;
  }
  const saveRef = useRef<() => Promise<boolean>>(async () => false);
  useEffect(() => { saveRef.current = saveDraft; });
  // biome-ignore lint/correctness/useExhaustiveDependencies: key is deliberate, each scene change restarts the debounce
  useEffect(() => { // debounced autosave only once a server draft exists; stale timers are cancelled by the cleanup
    if (!server.compositionId || !dirty || server.autosave === "conflict" || server.autosave === "pending" || server.autosave === "limited" || server.autosave === "unavailable" || server.autosave === "blocked") return;
    const timer = setTimeout(() => { void saveRef.current(); }, 1500); return () => clearTimeout(timer);
  }, [key, dirty, server.compositionId, server.autosave]);
  async function freeze() {
    setBusy(true);
    try {
      if (dirty && !(await saveDraft())) return;
      const id = server.compositionId ?? (await ensureComposition())?.id; if (!id) return;
      const state = await api(`/api/v1/compositions/${id}`, "GET"); if (!state.ok) { notify("Could not freeze this version."); return; }
      const response = await api(`/api/v1/compositions/${id}/versions`, "POST", { expectedRevision: state.data.draft.draftRevision });
      if (!response.ok) { const failure = classifyApiFailure(response.status, response.data); notify(failure.kind === "rate_limited" ? describeRateLimited(failure.retryAfterSeconds, "manual") : "Could not freeze this version."); return; }
      const refreshed = await api(`/api/v1/compositions/${id}`, "GET");
      if (refreshed.ok) setServer(s => ({ ...s, versions: refreshed.data.versions, currentVersionId: refreshed.data.currentVersionId, revision: refreshed.data.draft.draftRevision }));
      notify(`Version ${response.data.version.versionNo} frozen. It can no longer change; further edits create a new version.`);
    } finally { setBusy(false); }
  }
  async function restore(versionId: string) {
    if (!server.compositionId) return; setBusy(true);
    try {
      const response = await api(`/api/v1/compositions/${server.compositionId}/restore`, "POST", { expectedRevision: server.revision, versionId });
      if (!response.ok) { const failure = classifyApiFailure(response.status, response.data); notify(failure.kind === "rate_limited" ? describeRateLimited(failure.retryAfterSeconds, "manual") : response.status === 409 ? "This draft changed elsewhere. Reload first." : "Could not restore that version."); return; }
      const parsed = CompositionSceneV1Schema.safeParse(response.data.scene); if (!parsed.success) { notify("Could not restore that version."); return; }
      setHistory(h => commit(h, parsed.data)); setServer(s => ({ ...s, revision: response.data.draft.draftRevision, lastSavedKey: sceneKey(parsed.data) })); setSelected(null);
      notify("Version restored into your draft. The frozen version is unchanged.");
    } finally { setBusy(false); }
  }
  async function claim() {
    if (!server.compositionId) return; setBusy(true);
    try {
      const response = await api(`/api/v1/compositions/${server.compositionId}/claim`, "POST");
      if (response.ok) { setServer(s => ({ ...s, owner: "owner" })); notify("Draft moved to your account."); }
      else { const failure = classifyApiFailure(response.status, response.data); notify(failure.kind === "rate_limited" ? describeRateLimited(failure.retryAfterSeconds, "manual") : response.status === 401 ? "Sign in first, then move this draft to your account." : "This draft could not be moved to your account."); }
    } finally { setBusy(false); }
  }

  /** One explicit safety-check request per press (no automatic retry). The server decides; the client sends no outcome. */
  async function checkAgain(assetId: string) {
    const asset = assets.get(assetId); if (!server.compositionId || !asset || !canRequestScan(asset)) return; setBusy(true);
    try {
      const response = await api(`/api/v1/compositions/${server.compositionId}/assets/${assetId}/scan`, "POST");
      if (!response.ok) { const failure = classifyApiFailure(response.status, response.data); notify(failure.kind === "rate_limited" ? describeRateLimited(failure.retryAfterSeconds, "manual") : response.status === 503 ? "Artwork safety checks are not available yet." : "The safety check could not be requested."); return; }
      const scanStatus = parseScanStatus(response.data?.asset?.scanStatus);
      setAssets(previous => { const found = previous.get(assetId); if (!found) return previous; const next = new Map(previous); next.set(assetId, { ...found, scanStatus }); return next; });
      notify(describeScanOutcome(asset.name, scanStatus));
    } finally { setBusy(false); }
  }

  /**
   * Download the unchanged original (ADR-0022 D4, C6): one explicit press mints one single-use grant, then the browser navigates to
   * it programmatically. There is no rendered link, so nothing can prefetch it. The server re-checks ownership and `clean`.
   */
  async function downloadOriginal(assetId: string) {
    const asset = assets.get(assetId), compositionId = server.compositionId; if (!compositionId || !asset || !canDownloadOriginal(asset)) return; setBusy(true);
    try {
      const response = await api(`/api/v1/compositions/${compositionId}/assets/${assetId}/download-grants`, "POST");
      if (!response.ok) { notify(describeDownloadFailure(response.status, response.data)); return; }
      const path = downloadPathFrom(response.data, compositionId, assetId);
      if (!path) { notify(describeDownloadFailure(response.status, null)); return; }
      window.location.assign(path);
      notify(describeDownloadStarted(asset.name));
    } finally { setBusy(false); }
  }

  // --- preflight (same pure function the server uses at freeze)
  const facts = useMemo(() => new Map<string, AssetFacts>([...assets.values()].map(a => [a.assetId, { sha256: a.sha256, widthPx: a.widthPx, heightPx: a.heightPx, ...(a.persisted && a.scanStatus ? { scanStatus: a.scanStatus } : {}) }])), [assets]);
  const preflight = useMemo(() => runPreviewPreflight(scene, profile, facts, new Map(LICENSED_FONTS.map(f => [f.fontAssetId, f]))), [scene, facts]);
  const issues = preflight.issues.filter(issue => issue.zoneId === undefined || issue.zoneId === zoneId);

  const issueSummary = useDebounced(summarizeIssues(issues), ISSUE_SUMMARY_DEBOUNCE_MS);
  const layerName = (layer: EditorLayerV1) => {
    const asset = layer.kind === "image" ? assets.get(layer.sourceAssetId) : undefined, title = layerTitle(layer, asset?.name), state = scanLabel(asset?.scanStatus);
    return state ? `${title} (${state})` : title;
  };
  /** Applies a validated number, skips a no-op (no empty undo step), and says what changed, including side effects such as the locked aspect ratio. */
  function applyNumber(layer: EditorLayerV1, label: string, unit: string, value: number, read: (layer: EditorLayerV1) => number, apply: (n: number) => CompositionSceneV1) {
    return (n: number) => {
      const next = apply(n);
      if (sceneKey(next) === sceneKey(scene)) { // refused (for example a width of 0): say so instead of snapping back silently
        if (Math.abs(n - value) > 0.0005) setFieldError({ layerId: layer.layerId, label, text: `${label}: that value is not accepted.` }); else setFieldError(null);
        return;
      }
      setFieldError(null); edit(next);
      const changed = layersOf(next, zoneId).find(candidate => candidate.layerId === layer.layerId); // announce what was applied, which can differ from what was typed (clamping, aspect lock)
      announce(changed ? `${label} set to ${read(changed)} ${unit}. Now x ${changed.xMm}, y ${changed.yMm}, width ${changed.widthMm}, height ${changed.heightMm} mm, rotation ${changed.rotationDeg}°.` : `${label} set to ${n} ${unit}.`);
    };
  }
  const numeric = (layer: EditorLayerV1, label: string, value: number, read: (layer: EditorLayerV1) => number, apply: (n: number) => CompositionSceneV1, unit = "mm") => (
    <NumericField key={`${layer.layerId}-${label}`} label={label} unit={unit} value={value} error={fieldError && fieldError.layerId === layer.layerId && fieldError.label === label ? fieldError.text : null}
      onApply={applyNumber(layer, label, unit, value, read, apply)} onInvalid={text => setFieldError({ layerId: layer.layerId, label, text })} onEdit={() => setFieldError(null)} />);

  return (
    <section ref={rootRef} className="atelier ed" aria-label="Garment composition editor">
      <p className="eyebrow">THE INDEPENDENT EDITOR / YOUR ORIGINAL ART</p>
      <h1>{initialId ? "YOUR COMPOSITION." : "YOUR ART. YOUR CANVAS."}</h1>
      <p className="notice" role="note">PREVIEW ONLY. This editor uses a synthetic coordinate frame ({zone.widthMm} × {zone.heightMm} mm), not a manufacturer print area. Nothing here is approved for printing, priced, or ordered. No AI credits required. No account is needed to edit.</p>
      <p className="ed-status" role="status" aria-live="polite">{message || (server.owner === "guest" ? `Guest draft — kept ${describeExpiry(server.expiresAt)} unless you sign in.` : "")}</p>
      <div className="ed-sr-only" id="ed-announce" role="status" aria-live="polite" aria-atomic="true">{announcement}</div>
      <div className="ed-grid">
        <div className="ed-stage">
          <div className="ed-tabs" role="tablist" aria-label="Garment side">
            {profile.zones.map((z, index) => <button key={z.zoneId} id={`ed-tab-${z.zoneId}`} role="tab" aria-selected={z.zoneId === zoneId} aria-controls="ed-tabpanel" tabIndex={z.zoneId === zoneId ? 0 : -1} className="ed-tab"
              onClick={() => switchZone(z.zoneId, false)} onKeyDown={event => onTabKeyDown(event, index)}>{z.zoneId.toUpperCase()}</button>)}
          </div>
          <div id="ed-tabpanel" role="tabpanel" aria-labelledby={`ed-tab-${zoneId}`}>
          <svg ref={svgRef} className="ed-canvas" viewBox={`${-8} ${-8} ${zone.widthMm + 16} ${zone.heightMm + 16}`} role="group" aria-label={`${zoneId} print zone, ${zone.widthMm} by ${zone.heightMm} millimetres, synthetic preview frame`} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
            <rect x={-8} y={-8} width={zone.widthMm + 16} height={zone.heightMm + 16} fill="#0b0b0a" />
            <rect x={0} y={0} width={zone.widthMm} height={zone.heightMm} fill="#161614" stroke="#939187" strokeWidth={0.4} />
            <rect x={zone.safeMarginMm} y={zone.safeMarginMm} width={zone.widthMm - 2 * zone.safeMarginMm} height={zone.heightMm - 2 * zone.safeMarginMm} fill="none" stroke="#939187" strokeWidth={0.3} strokeDasharray="2 2" />
            <svg x={0} y={0} width={zone.widthMm} height={zone.heightMm} viewBox={`0 0 ${zone.widthMm} ${zone.heightMm}`} overflow="hidden">
              {layers.filter(l => l.visible).map(layer => {
                const asset = layer.kind === "image" ? assets.get(layer.sourceAssetId) : null, href = asset ? previewHref(asset) : null, cx = layer.xMm + layer.widthMm / 2, cy = layer.yMm + layer.heightMm / 2, on = layer.layerId === selected;
                return (
                  <g key={layer.layerId} data-layer-id={layer.layerId} transform={`rotate(${layer.rotationDeg} ${cx} ${cy})`} tabIndex={0} role="button" aria-pressed={on} style={{ cursor: "move", touchAction: "none" }}
                    aria-describedby="ed-key-help" aria-label={`${layer.kind === "text" ? `Text layer: ${layer.text}` : `Image layer: ${asset?.name ?? "missing"}${scanLabel(asset?.scanStatus) ? `, ${scanLabel(asset?.scanStatus)}` : ""}`}, x ${layer.xMm} y ${layer.yMm} millimetres`}
                    onPointerDown={e => onPointerDown(e, layer)} onFocus={() => setSelected(layer.layerId)} onKeyDown={e => onKeyDown(e, layer)}>
                    {layer.kind === "image"
                      ? (href ? <image href={href} x={layer.xMm} y={layer.yMm} width={layer.widthMm} height={layer.heightMm} preserveAspectRatio="none" />
                        : <rect data-scan={asset?.scanStatus ?? "missing"} x={layer.xMm} y={layer.yMm} width={layer.widthMm} height={layer.heightMm} fill={asset?.scanStatus === "quarantined" ? "#3a1f1b" : "#49483f"} stroke={asset?.scanStatus === "quarantined" ? "#c9614f" : "none"} strokeWidth={0.4} strokeDasharray="4 2" />)
                      : <text x={layer.xMm} y={layer.yMm} fontSize={layer.fontSizePt * PT_TO_MM} fill={layer.color} style={{ fontFamily: "var(--font-archivo), Archivo, sans-serif" }} dominantBaseline="hanging" aria-hidden="true">{layer.text}</text>}
                    <rect x={layer.xMm} y={layer.yMm} width={layer.widthMm} height={layer.heightMm} fill="transparent" stroke={on ? "#f1efe9" : "transparent"} strokeWidth={0.5} strokeDasharray={on ? "3 2" : undefined} />
                  </g>);
              })}
            </svg>
          </svg>
          <p className="muted ed-caption" id="ed-key-help">{KEY_HELP}</p>
          <p className="muted ed-caption">SYNTHETIC PREVIEW FRAME — coordinates in millimetres, origin top-left. Text shown here is an approximation until the deterministic print renderer exists.</p>
          </div>
        </div>
        <div className="ed-panel">
          <div className="ed-row">
            {canUpload
              ? <label className="button button-primary ed-file"><input type="file" accept={ACCEPT} multiple disabled={busy} onChange={e => { void addFiles(e.currentTarget.files); e.currentTarget.value = ""; }} /><span>Upload artwork</span></label>
              : <Button disabled aria-describedby="ed-upload-off">Upload artwork — unavailable</Button>}
            <Button variant="outline" id="ed-add-text" onClick={() => { const r = addTextLayer(scene, zoneId); edit(r.scene); setSelected(r.layerId); announce(`Text layer added and selected. ${describeLayerCount(layers.length + 1)} on the ${zoneId} side.`); }}>Add text</Button>
          </div>
          <div className="ed-row">
            {/* aria-disabled, not disabled: pressing Undo on the last step must not drop keyboard focus to <body> */}
            <Button variant="outline" aria-disabled={!history.past.length} onClick={() => { if (!history.past.length) return; setHistory(undo); announce(history.past.length === 1 ? "Undone. Nothing more to undo." : "Undone."); }}>Undo</Button>
            <Button variant="outline" aria-disabled={!history.future.length} onClick={() => { if (!history.future.length) return; setHistory(redo); announce(history.future.length === 1 ? "Redone. Nothing more to redo." : "Redone."); }}>Redo</Button>
          </div>
          <h2 className="ed-h">Layers — {zoneId}</h2>
          {layers.length === 0 ? <p className="muted">No layers yet. Upload a PNG, JPEG or WebP, or add text.</p> : (
            <ol className="ed-layers" aria-label="Layers, top first">
              {[...layers].reverse().map((layer, index, top) => { // index 0 is the top of the stack; every action name carries the position so no two are alike
                const title = layerName(layer), name = (action: string) => layerActionName(action, title, index + 1, top.length), outside = isOutside(zoneId, layer);
                return (
                  <li key={layer.layerId} data-row-id={layer.layerId} className={layer.layerId === selected ? "is-selected" : undefined}>
                    <button className="ed-layer-name" aria-pressed={layer.layerId === selected} aria-label={outside ? `${title}, layer ${index + 1} of ${top.length}, extends outside the zone` : `${title}, layer ${index + 1} of ${top.length}`} onClick={() => setSelected(layer.layerId)}>{title}{outside ? " ⚠" : ""}</button>
                    <span className="ed-icons">
                      <button data-action="up" aria-label={name("Move up")} aria-disabled={index === 0} onClick={() => reorder(layer.layerId, "up")}>↑</button>
                      <button data-action="down" aria-label={name("Move down")} aria-disabled={index === top.length - 1} onClick={() => reorder(layer.layerId, "down")}>↓</button>
                      <button data-action="visibility" aria-label={name(layer.visible ? "Hide layer" : "Show layer")} onClick={() => { patch(layer, { visible: !layer.visible }); announce(`${title} ${layer.visible ? "hidden" : "shown"}.`); }}>{layer.visible ? "Hide" : "Show"}</button>
                    </span>
                  </li>);
              })}
            </ol>)}
          {current && (
            <fieldset className="ed-props"><legend>Selected layer</legend>
              {numeric(current, "X", current.xMm, l => l.xMm, n => updateLayer(scene, zoneId, current.layerId, { xMm: n }))}{numeric(current, "Y", current.yMm, l => l.yMm, n => updateLayer(scene, zoneId, current.layerId, { yMm: n }))}
              {numeric(current, "Width", current.widthMm, l => l.widthMm, n => (current.kind === "image" && aspectLock ? resizeKeepingAspect(scene, zoneId, current.layerId, "widthMm", n) : updateLayer(scene, zoneId, current.layerId, { widthMm: n })))}
              {numeric(current, "Height", current.heightMm, l => l.heightMm, n => (current.kind === "image" && aspectLock ? resizeKeepingAspect(scene, zoneId, current.layerId, "heightMm", n) : updateLayer(scene, zoneId, current.layerId, { heightMm: n })))}
              {numeric(current, "Rotation", current.rotationDeg, l => l.rotationDeg, n => updateLayer(scene, zoneId, current.layerId, { rotationDeg: n }), "°")}
              {current.kind === "image" && <label className="ed-check"><input type="checkbox" checked={aspectLock} onChange={e => setAspectLock(e.currentTarget.checked)} /> Lock aspect ratio</label>}
              {current.kind === "image" && scanLabel(assets.get(current.sourceAssetId)?.scanStatus) && (
                <p className="muted ed-caption" id="ed-scan-state">Artwork {scanLabel(assets.get(current.sourceAssetId)?.scanStatus)}. Server copies are shown only after they pass.</p>)}
              {current.kind === "image" && canRequestScan(assets.get(current.sourceAssetId)) && (
                <Button variant="outline" disabled={busy} aria-describedby="ed-scan-state" onClick={() => void checkAgain(current.sourceAssetId)}>Check again</Button>)}
              {current.kind === "image" && canDownloadOriginal(assets.get(current.sourceAssetId)) && (
                <Button variant="outline" disabled={busy} onClick={() => void downloadOriginal(current.sourceAssetId)}>Download original</Button>)}
              {current.kind === "text" && (<>
                <label className="ed-field"><span>Text</span><input value={current.text} maxLength={profile.limits.maxTextChars} onChange={e => patch(current, { text: e.currentTarget.value })} aria-label="Text content" /></label>
                {numeric(current, "Size", current.fontSizePt, l => (l.kind === "text" ? l.fontSizePt : 0), n => updateLayer(scene, zoneId, current.layerId, { fontSizePt: n }), "pt")}
                <label className="ed-field"><span>Colour</span><input type="color" value={current.color} onChange={e => patch(current, { color: e.currentTarget.value })} aria-label="Text colour" /></label>
                <p className="muted ed-caption">Font: {font.family} · licence {font.licenseVersion}</p></>)}
              <div className="ed-row">
                <Button variant="outline" onClick={() => { const r = duplicateLayer(scene, zoneId, current.layerId); edit(r.scene); setSelected(r.layerId); announce(`Layer duplicated. The copy is selected. ${describeLayerCount(layers.length + 1)} on the ${zoneId} side.`); }}>Duplicate</Button>
                <Button variant="outline" onClick={() => removeLayer(current.layerId, "list")}>Delete</Button>
              </div>
            </fieldset>)}
          <section aria-labelledby="ed-checks"><h2 className="ed-h" id="ed-checks">Preview checks</h2>
            <p className="muted">Status: <strong>{preflight.state === "blocked" ? "Blocked — fix the items below" : "Preview only — not approved for print"}</strong></p>
            {/* The summary is the only live text here: the list itself is not announced wholesale on every change. */}
            <p className="muted ed-issue-summary">{summarizeIssues(issues)}</p>
            <div className="ed-sr-only" id="ed-issue-live" role="status" aria-live="polite" aria-atomic="true">{issueSummary}</div>
            <ul className="ed-issues" aria-label={`Preview checks, ${zoneId} side`}>{issues.map((issue, index) => {
              const subject = issue.layerId ? layers.find(layer => layer.layerId === issue.layerId) : undefined;
              return <li key={index} data-severity={issue.severity}>{ISSUE_TEXT[issue.code] ?? issue.code}{subject ? ` (${layerName(subject)})` : ""}</li>;
            })}</ul>
          </section>
          <div className="ed-row">
            <Button onClick={() => void saveDraft()} disabled={busy || server.autosave === "pending" || server.autosave === "unavailable"}>{server.autosave === "pending" ? "Saving…" : dirty ? "Save draft" : "Saved"}</Button>
            <Button variant="outline" onClick={() => void freeze()} disabled={busy || server.autosave === "unavailable" || server.autosave === "conflict"}>Freeze version</Button>
            {server.owner === "guest" && <Button variant="outline" onClick={() => void claim()} disabled={busy}>Keep in my account</Button>}
          </div>
          {!canUpload && <p className="notice" id="ed-upload-off">{artworkUpload ? "Artwork upload is not configured yet: its limits have not been set." : "Artwork upload is not enabled in this preview."} You can still add text; nothing is uploaded or stored.</p>}
          {server.autosave === "unavailable" && <p className="notice">Saving is not enabled in this preview. Edits and previews work, but they are not stored.</p>}
          {server.autosave === "conflict" && <p className="notice" role="alert">This draft changed in another tab or device. <button className="ed-link" onClick={() => location.reload()}>Reload</button> to continue.</p>}
          {server.versions.length > 0 && (
            <section aria-labelledby="ed-versions"><h2 className="ed-h" id="ed-versions">Frozen versions</h2>
              <ol className="ed-versions">{server.versions.map(v => (
                <li key={v.versionId}><span>v{v.versionNo} · {v.preflight.state === "blocked" ? "blocked" : "preview only"} · {v.sceneHashSha256.slice(0, 8)}</span>
                  <span className="ed-icons"><Link href={`/customize/${server.compositionId}/review?versionId=${v.versionId}`}>Review</Link><button onClick={() => void restore(v.versionId)} disabled={busy}>Restore</button></span></li>))}</ol>
            </section>)}
          <p className="muted ed-caption">Checkout and manufacturing approval are separate steps that are not available in this milestone.</p>
        </div>
      </div>
    </section>
  );
}
