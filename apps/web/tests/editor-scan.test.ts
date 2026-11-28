/**
 * ADR-0022 C5: editor placeholder states and announcements for the artwork safety check. Pure helpers plus a static check that the
 * canvas draws server pixels only through `previewHref` (founder ruling QB: local previews of browser-held bytes are unchanged).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canRequestScan, describeScanOutcome, parseScanStatus, previewHref, scanLabel, type ScanStatus } from "../src/components/editor/model";

const STATUSES: ScanStatus[] = ["pending", "clean", "quarantined", "unknown"];
const server = (scanStatus?: ScanStatus) => (scanStatus ? { url: "/api/v1/compositions/c/assets/a", scanStatus } : { url: "/api/v1/compositions/c/assets/a" });

test("server pixels are drawn only when clean; browser-held bytes are always drawn (ruling QB)", () => {
  assert.equal(previewHref(server("clean")), "/api/v1/compositions/c/assets/a");
  for (const status of ["pending", "quarantined", "unknown", undefined] as const) assert.equal(previewHref(server(status)), null, String(status));
  for (const status of STATUSES) assert.equal(previewHref({ url: "data:image/png;base64,AAAA", scanStatus: status }), "data:image/png;base64,AAAA");
  assert.equal(previewHref({ url: "data:image/png;base64,AAAA" }), "data:image/png;base64,AAAA", "a local asset not uploaded yet");
});

test("an unrecognised status from the server is pending, never clean", () => {
  for (const status of STATUSES) assert.equal(parseScanStatus(status), status);
  for (const raw of [undefined, null, "CLEAN", "infected", "", 1, true, {}]) assert.equal(parseScanStatus(raw), "pending", String(raw));
});

test("labels, Check again and announcements cover every status and never name internals", () => {
  assert.equal(scanLabel("clean"), null); assert.equal(scanLabel(undefined), null);
  for (const status of ["pending", "unknown", "quarantined"] as const) assert.ok(scanLabel(status), status);
  assert.equal(canRequestScan({ persisted: true, scanStatus: "pending" }), true); assert.equal(canRequestScan({ persisted: true, scanStatus: "unknown" }), true);
  assert.equal(canRequestScan({ persisted: true, scanStatus: "clean" }), false); assert.equal(canRequestScan({ persisted: true, scanStatus: "quarantined" }), false, "quarantine is terminal");
  assert.equal(canRequestScan({ persisted: false }), false); assert.equal(canRequestScan(undefined), false);
  const sentences = STATUSES.map(status => describeScanOutcome("art.png", status));
  assert.equal(new Set(sentences).size, STATUSES.length, "each status has its own sentence");
  for (const sentence of sentences) { assert.match(sentence, /^art\.png: /); assert.doesNotMatch(sentence, /scanner|evidence|reason|verdict|infected|virus|malware/i); }
  assert.match(describeScanOutcome("art.png", "quarantined"), /cannot be used/);
  assert.equal(describeScanOutcome("art.png", "clean"), "art.png: format check passed.", "a clean result is a structural format check, never described as a safety or virus check");
});

test("static: the canvas never binds a server asset URL directly, and Check again posts to the scan route with no body", () => {
  const source = readFileSync(new URL("../src/components/editor/editor.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /href=\{asset\.url\}/); assert.match(source, /href = asset \? previewHref\(asset\) : null/);
  assert.match(source, /api\(`\/api\/v1\/compositions\/\$\{server\.compositionId\}\/assets\/\$\{assetId\}\/scan`, "POST"\)/);
  assert.match(source, /ASSET_NOT_SCANNED: "/);
  assert.match(source, /scanStatus: parseScanStatus\(a\.scanStatus\)/, "hydrated assets carry the server status");
});
