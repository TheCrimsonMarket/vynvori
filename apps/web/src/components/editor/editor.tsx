"use client";
import "./zod-jitless";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { CompositionSceneV1Schema, EMPTY_SYNTHETIC_SCENE, LICENSED_FONTS, runPreviewPreflight, type CompositionSceneV1, type EditorLayerV1, type AssetFacts } from "@vynvori/contracts";
import { Button } from "@/components/ui/button";
import {
  PT_TO_MM, addImageLayer, addTextLayer, commit, deleteLayer, duplicateLayer, font, isOutside, keyStep, layersOf, moveInStack, nudge, parseMm, profile,
  redo, resizeKeepingAspect, sceneKey, startHistory, undo, updateLayer, zoneOf, checkUploadDimensions, checkUploadFileSize, describeExpiry, type EditorAsset, type LayerPatch, type UploadLimits,
} from "./model";

type ServerState = { compositionId: string | null; revision: number; owner: "guest" | "owner" | null; autosave: "idle" | "pending" | "conflict" | "failed" | "unavailable"; lastSavedKey: string | null; expiresAt: string | null; versions: VersionView[]; currentVersionId: string | null };
type VersionView = { versionId: string; versionNo: number; sceneHashSha256: string; frozenAt: string; preflight: { state: "preview_only" | "blocked"; issues: { code: string; severity: string; layerId?: string; zoneId?: string }[] } };
const ACCEPT = "image/png,image/jpeg,image/webp";
const ISSUE_TEXT: Record<string, string> = {
  PROFILE_MISMATCH: "The composition does not match the print profile.", ZONE_UNKNOWN: "Unknown print zone.", TOO_MANY_LAYERS: "Too many layers in this zone.",
  TEXT_TOO_LONG: "Text is too long.", LAYER_OUT_OF_BOUNDS: "Layer extends outside the zone.", LAYER_OUTSIDE_SAFE_MARGIN: "Layer is inside the safety margin.",
  ASSET_MISSING: "Artwork is missing.", ASSET_HASH_MISMATCH: "Artwork changed since it was added.", FONT_UNLICENSED: "Font is not available.",
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
async function api(path: string, method: string, body?: unknown, raw?: { bytes: ArrayBuffer; type: string }): Promise<{ ok: boolean; status: number; data: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const headers: Record<string, string> = method === "GET" ? {} : await csrfHeaders();
  if (body !== undefined) headers["content-type"] = "application/json"; if (raw) headers["content-type"] = raw.type;
  const response = await fetch(path, { method, cache: "no-store", credentials: "same-origin", headers, ...(raw ? { body: raw.bytes } : body === undefined ? {} : { body: JSON.stringify(body) }) });
  let data: unknown = null; try { data = await response.json(); } catch { /* binary or empty */ }
  return { ok: response.ok, status: response.status, data };
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
  const notify = (text: string) => setMessage(text);

  // --- hydrate: owned route, or resume the last guest draft of this tab (the id is not a secret; the capability is an HttpOnly cookie)
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
      for (const a of loaded.data.assets as { assetId: string; sha256: string; widthPx: number; heightPx: number }[]) next.set(a.assetId, { assetId: a.assetId, sha256: a.sha256, widthPx: a.widthPx, heightPx: a.heightPx, name: "Artwork", url: `/api/v1/compositions/${id}/assets/${a.assetId}`, persisted: true });
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
    if (moves[event.key]) { event.preventDefault(); const [dx, dy] = moves[event.key]!; edit(nudge(scene, zoneId, layer.layerId, dx, dy)); }
    else if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); edit(deleteLayer(scene, zoneId, layer.layerId)); setSelected(null); }
  }

  // --- server persistence (all optional; the editor is fully usable without it)
  async function ensureComposition(): Promise<{ id: string; revision: number } | null> {
    if (server.compositionId) return { id: server.compositionId, revision: server.revision };
    const created = await api("/api/v1/compositions", "POST");
    if (!created.ok) { notify(created.status === 503 ? "Saving is not available in this preview. Your work stays in this tab only." : "Could not start a saved draft."); setServer(s => ({ ...s, autosave: created.status === 503 ? "unavailable" : "failed" })); return null; }
    const id = created.data.draft.compositionId as string; try { sessionStorage.setItem("vynvori.byo.compositionId", id); } catch { /* optional */ }
    setServer(s => ({ ...s, compositionId: id, revision: 0, expiresAt: created.data.expiresAt ?? null, owner: created.data.draft.ownerKind === "authenticated_owner" ? "owner" : "guest" }));
    return { id, revision: 0 };
  }
  async function saveDraft(): Promise<boolean> {
    setServer(s => ({ ...s, autosave: "pending" }));
    const target = await ensureComposition(); if (!target) return false;
    let working = scene; const remap = new Map<string, EditorAsset>(assets);
    for (const asset of assets.values()) {
      if (asset.persisted || !bytes.current.has(asset.assetId)) continue;
      const stored = bytes.current.get(asset.assetId)!, up = await api(`/api/v1/compositions/${target.id}/assets`, "POST", undefined, { bytes: stored.data, type: stored.type });
      if (!up.ok) { notify(up.status === 503 ? "Artwork upload is not available in this preview; your work stays in this tab only." : up.status === 415 ? "That file type is not accepted." : "Artwork could not be saved."); setServer(s => ({ ...s, autosave: up.status === 503 ? "unavailable" : "failed" })); return false; }
      const serverId = up.data.asset.assetId as string; remap.set(serverId, { ...asset, assetId: serverId, persisted: true, url: `/api/v1/compositions/${target.id}/assets/${serverId}` }); remap.delete(asset.assetId);
      working = { ...working, pages: working.pages.map(p => ({ ...p, layers: p.layers.map(l => l.kind === "image" && l.sourceAssetId === asset.assetId ? { ...l, sourceAssetId: serverId } : l) })) };
    }
    const saved = await api(`/api/v1/compositions/${target.id}`, "PUT", { expectedRevision: target.revision, scene: working });
    if (saved.status === 409) { setServer(s => ({ ...s, autosave: "conflict" })); notify("This draft changed elsewhere. Reload to continue without losing your copy."); return false; }
    if (!saved.ok) { setServer(s => ({ ...s, autosave: "failed" })); notify(saved.status === 401 ? "Your draft expired or you were signed out. Start a new draft or sign in." : "Could not save. Your edits are still here."); return false; }
    setAssets(remap); setHistory(h => ({ ...h, present: working }));
    setServer(s => ({ ...s, compositionId: target.id, revision: saved.data.draft.draftRevision, autosave: "idle", lastSavedKey: sceneKey(working), expiresAt: saved.data.expiresAt ?? s.expiresAt, owner: saved.data.draft.ownerKind === "authenticated_owner" ? "owner" : "guest" }));
    notify(saved.data.draft.ownerKind === "authenticated_owner" ? "Saved to your account." : `Draft saved on this device ${describeExpiry(saved.data.expiresAt ?? server.expiresAt)}. Sign in to keep it.`); return true;
  }
  const saveRef = useRef<() => Promise<boolean>>(async () => false);
  useEffect(() => { saveRef.current = saveDraft; });
  useEffect(() => { // debounced autosave only once a server draft exists; stale timers are cancelled by the cleanup
    if (!server.compositionId || !dirty || server.autosave === "conflict" || server.autosave === "pending") return;
    const timer = setTimeout(() => { void saveRef.current(); }, 1500); return () => clearTimeout(timer);
  }, [key, dirty, server.compositionId, server.autosave]);
  async function freeze() {
    setBusy(true);
    try {
      if (dirty && !(await saveDraft())) return;
      const id = server.compositionId ?? (await ensureComposition())?.id; if (!id) return;
      const state = await api(`/api/v1/compositions/${id}`, "GET"); if (!state.ok) return;
      const response = await api(`/api/v1/compositions/${id}/versions`, "POST", { expectedRevision: state.data.draft.draftRevision });
      if (!response.ok) { notify("Could not freeze this version."); return; }
      const refreshed = await api(`/api/v1/compositions/${id}`, "GET");
      if (refreshed.ok) setServer(s => ({ ...s, versions: refreshed.data.versions, currentVersionId: refreshed.data.currentVersionId, revision: refreshed.data.draft.draftRevision }));
      notify(`Version ${response.data.version.versionNo} frozen. It can no longer change; further edits create a new version.`);
    } finally { setBusy(false); }
  }
  async function restore(versionId: string) {
    if (!server.compositionId) return; setBusy(true);
    try {
      const response = await api(`/api/v1/compositions/${server.compositionId}/restore`, "POST", { expectedRevision: server.revision, versionId });
      if (!response.ok) { notify(response.status === 409 ? "This draft changed elsewhere. Reload first." : "Could not restore that version."); return; }
      const parsed = CompositionSceneV1Schema.safeParse(response.data.scene); if (!parsed.success) return;
      setHistory(h => commit(h, parsed.data)); setServer(s => ({ ...s, revision: response.data.draft.draftRevision, lastSavedKey: sceneKey(parsed.data) })); setSelected(null);
      notify("Version restored into your draft. The frozen version is unchanged.");
    } finally { setBusy(false); }
  }
  async function claim() {
    if (!server.compositionId) return; setBusy(true);
    try {
      const response = await api(`/api/v1/compositions/${server.compositionId}/claim`, "POST");
      if (response.ok) { setServer(s => ({ ...s, owner: "owner" })); notify("Draft moved to your account."); }
      else notify(response.status === 401 ? "Sign in first, then move this draft to your account." : "This draft could not be moved to your account.");
    } finally { setBusy(false); }
  }

  // --- preflight (same pure function the server uses at freeze)
  const facts = useMemo(() => new Map<string, AssetFacts>([...assets.values()].map(a => [a.assetId, { sha256: a.sha256, widthPx: a.widthPx, heightPx: a.heightPx }])), [assets]);
  const preflight = useMemo(() => runPreviewPreflight(scene, profile, facts, new Map(LICENSED_FONTS.map(f => [f.fontAssetId, f]))), [scene, facts]);
  const issues = preflight.issues.filter(issue => issue.zoneId === undefined || issue.zoneId === zoneId);

  const numeric = (label: string, value: number, apply: (n: number) => void, unit = "mm") => (
    <label className="ed-field"><span>{label}</span><span className="ed-num"><input key={`${current?.layerId}-${label}-${value}`} inputMode="decimal" defaultValue={String(value)} aria-label={`${label} (${unit})`}
      onBlur={e => { const n = parseMm(e.currentTarget.value); if (n === null) { e.currentTarget.value = String(value); notify(`${label}: enter a number.`); } else apply(n); }}
      onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }} /><small>{unit}</small></span></label>);

  return (
    <section className="atelier ed" aria-label="Garment composition editor">
      <p className="eyebrow">THE INDEPENDENT EDITOR / YOUR ORIGINAL ART</p>
      <h1>{initialId ? "YOUR COMPOSITION." : "YOUR ART. YOUR CANVAS."}</h1>
      <p className="notice" role="note">PREVIEW ONLY. This editor uses a synthetic coordinate frame ({zone.widthMm} × {zone.heightMm} mm), not a manufacturer print area. Nothing here is approved for printing, priced, or ordered. No AI credits required. No account is needed to edit.</p>
      <p className="ed-status" role="status" aria-live="polite">{message || (server.owner === "guest" ? `Guest draft — kept ${describeExpiry(server.expiresAt)} unless you sign in.` : "")}</p>
      <div className="ed-grid">
        <div className="ed-stage">
          <div className="ed-tabs" role="tablist" aria-label="Garment side">
            {profile.zones.map(z => <button key={z.zoneId} role="tab" aria-selected={z.zoneId === zoneId} className="ed-tab" onClick={() => { setZoneId(z.zoneId); setSelected(null); }}>{z.zoneId.toUpperCase()}</button>)}
          </div>
          <svg ref={svgRef} className="ed-canvas" viewBox={`${-8} ${-8} ${zone.widthMm + 16} ${zone.heightMm + 16}`} role="group" aria-label={`${zoneId} print zone, ${zone.widthMm} by ${zone.heightMm} millimetres, synthetic preview frame`} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
            <rect x={-8} y={-8} width={zone.widthMm + 16} height={zone.heightMm + 16} fill="#0b0b0a" />
            <rect x={0} y={0} width={zone.widthMm} height={zone.heightMm} fill="#161614" stroke="#939187" strokeWidth={0.4} />
            <rect x={zone.safeMarginMm} y={zone.safeMarginMm} width={zone.widthMm - 2 * zone.safeMarginMm} height={zone.heightMm - 2 * zone.safeMarginMm} fill="none" stroke="#939187" strokeWidth={0.3} strokeDasharray="2 2" />
            <svg x={0} y={0} width={zone.widthMm} height={zone.heightMm} viewBox={`0 0 ${zone.widthMm} ${zone.heightMm}`} overflow="hidden">
              {layers.filter(l => l.visible).map(layer => {
                const asset = layer.kind === "image" ? assets.get(layer.sourceAssetId) : null, cx = layer.xMm + layer.widthMm / 2, cy = layer.yMm + layer.heightMm / 2, on = layer.layerId === selected;
                return (
                  <g key={layer.layerId} transform={`rotate(${layer.rotationDeg} ${cx} ${cy})`} tabIndex={0} role="button" aria-pressed={on} style={{ cursor: "move", touchAction: "none" }}
                    aria-label={`${layer.kind === "text" ? `Text layer: ${layer.text}` : "Image layer"}, x ${layer.xMm} y ${layer.yMm} millimetres. Arrow keys move 1 mm; Shift 10 mm; Alt 0.1 mm.`}
                    onPointerDown={e => onPointerDown(e, layer)} onFocus={() => setSelected(layer.layerId)} onKeyDown={e => onKeyDown(e, layer)}>
                    {layer.kind === "image"
                      ? (asset ? <image href={asset.url} x={layer.xMm} y={layer.yMm} width={layer.widthMm} height={layer.heightMm} preserveAspectRatio="none" /> : <rect x={layer.xMm} y={layer.yMm} width={layer.widthMm} height={layer.heightMm} fill="#49483f" />)
                      : <text x={layer.xMm} y={layer.yMm} fontSize={layer.fontSizePt * PT_TO_MM} fill={layer.color} style={{ fontFamily: "var(--font-archivo), Archivo, sans-serif" }} dominantBaseline="hanging" aria-hidden="true">{layer.text}</text>}
                    <rect x={layer.xMm} y={layer.yMm} width={layer.widthMm} height={layer.heightMm} fill="transparent" stroke={on ? "#f1efe9" : "transparent"} strokeWidth={0.5} strokeDasharray={on ? "3 2" : undefined} />
                  </g>);
              })}
            </svg>
          </svg>
          <p className="muted ed-caption">SYNTHETIC PREVIEW FRAME — coordinates in millimetres, origin top-left. Text shown here is an approximation until the deterministic print renderer exists.</p>
        </div>
        <div className="ed-panel">
          <div className="ed-row">
            {canUpload
              ? <label className="button button-primary ed-file"><input type="file" accept={ACCEPT} multiple disabled={busy} onChange={e => { void addFiles(e.currentTarget.files); e.currentTarget.value = ""; }} /><span>Upload artwork</span></label>
              : <Button disabled aria-describedby="ed-upload-off">Upload artwork — unavailable</Button>}
            <Button variant="outline" onClick={() => { const r = addTextLayer(scene, zoneId); edit(r.scene); setSelected(r.layerId); }}>Add text</Button>
          </div>
          <div className="ed-row">
            <Button variant="outline" disabled={!history.past.length} onClick={() => setHistory(undo)}>Undo</Button>
            <Button variant="outline" disabled={!history.future.length} onClick={() => setHistory(redo)}>Redo</Button>
          </div>
          <h2 className="ed-h">Layers — {zoneId}</h2>
          {layers.length === 0 ? <p className="muted">No layers yet. Upload a PNG, JPEG or WebP, or add text.</p> : (
            <ol className="ed-layers" aria-label="Layers, top first">
              {[...layers].reverse().map(layer => (
                <li key={layer.layerId} className={layer.layerId === selected ? "is-selected" : undefined}>
                  <button className="ed-layer-name" aria-pressed={layer.layerId === selected} onClick={() => setSelected(layer.layerId)}>{layer.kind === "text" ? `Text · ${layer.text.slice(0, 24)}` : `Image · ${assets.get(layer.sourceAssetId)?.name ?? "missing"}`}{isOutside(zoneId, layer) ? " ⚠" : ""}</button>
                  <span className="ed-icons">
                    <button aria-label="Move up" onClick={() => edit(moveInStack(scene, zoneId, layer.layerId, "up"))}>↑</button>
                    <button aria-label="Move down" onClick={() => edit(moveInStack(scene, zoneId, layer.layerId, "down"))}>↓</button>
                    <button aria-label={layer.visible ? "Hide layer" : "Show layer"} aria-pressed={!layer.visible} onClick={() => patch(layer, { visible: !layer.visible })}>{layer.visible ? "Hide" : "Show"}</button>
                  </span>
                </li>))}
            </ol>)}
          {current && (
            <fieldset className="ed-props"><legend>Selected layer</legend>
              {numeric("X", current.xMm, n => patch(current, { xMm: n }))}{numeric("Y", current.yMm, n => patch(current, { yMm: n }))}
              {numeric("Width", current.widthMm, n => (current.kind === "image" && aspectLock ? edit(resizeKeepingAspect(scene, zoneId, current.layerId, "widthMm", n)) : patch(current, { widthMm: n })))}
              {numeric("Height", current.heightMm, n => (current.kind === "image" && aspectLock ? edit(resizeKeepingAspect(scene, zoneId, current.layerId, "heightMm", n)) : patch(current, { heightMm: n })))}
              {numeric("Rotation", current.rotationDeg, n => patch(current, { rotationDeg: n }), "°")}
              {current.kind === "image" && <label className="ed-check"><input type="checkbox" checked={aspectLock} onChange={e => setAspectLock(e.currentTarget.checked)} /> Lock aspect ratio</label>}
              {current.kind === "text" && (<>
                <label className="ed-field"><span>Text</span><input value={current.text} maxLength={profile.limits.maxTextChars} onChange={e => patch(current, { text: e.currentTarget.value })} aria-label="Text content" /></label>
                {numeric("Size", current.fontSizePt, n => patch(current, { fontSizePt: n }), "pt")}
                <label className="ed-field"><span>Colour</span><input type="color" value={current.color} onChange={e => patch(current, { color: e.currentTarget.value })} aria-label="Text colour" /></label>
                <p className="muted ed-caption">Font: {font.family} · licence {font.licenseVersion}</p></>)}
              <div className="ed-row">
                <Button variant="outline" onClick={() => { const r = duplicateLayer(scene, zoneId, current.layerId); edit(r.scene); setSelected(r.layerId); }}>Duplicate</Button>
                <Button variant="outline" onClick={() => { edit(deleteLayer(scene, zoneId, current.layerId)); setSelected(null); }}>Delete</Button>
              </div>
            </fieldset>)}
          <section aria-labelledby="ed-checks"><h2 className="ed-h" id="ed-checks">Preview checks</h2>
            <p className="muted">Status: <strong>{preflight.state === "blocked" ? "Blocked — fix the items below" : "Preview only — not approved for print"}</strong></p>
            <ul className="ed-issues" aria-live="polite">{issues.map((issue, index) => <li key={index} data-severity={issue.severity}>{ISSUE_TEXT[issue.code] ?? issue.code}{issue.layerId ? ` (${issue.layerId})` : ""}</li>)}</ul>
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
