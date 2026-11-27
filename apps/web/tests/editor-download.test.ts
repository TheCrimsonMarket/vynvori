/**
 * ADR-0022 C6: the editor's "Download original" control. Pure helpers plus static checks that the control lives in editor.tsx (fetch
 * policy, constraint 10), mints on an explicit press, fetches the grant itself without navigating the editor tab (a failed redeem is
 * announced, never a page change that would lose edits), and never renders a link a browser could prefetch.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canDownloadOriginal, describeDownloadFailure, describeDownloadStarted, downloadFileName, downloadTargetFrom, type ScanStatus } from "../src/components/editor/model";

const C = "0b6c6f2e-4f4a-4c1e-9d0e-1a2b3c4d5e6f", A = "5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", TOKEN = "T".repeat(43);
const path = `/api/v1/compositions/${C}/assets/${A}/download`;

test("offered only for an uploaded asset the server reports clean", () => {
  assert.equal(canDownloadOriginal({ persisted: true, scanStatus: "clean" }), true);
  for (const status of ["pending", "unknown", "quarantined"] as ScanStatus[]) assert.equal(canDownloadOriginal({ persisted: true, scanStatus: status }), false, status);
  assert.equal(canDownloadOriginal({ persisted: true }), false, "no status yet");
  assert.equal(canDownloadOriginal({ persisted: false, scanStatus: "clean" }), false, "a local-only asset has no server original");
  assert.equal(canDownloadOriginal(undefined), false);
});

test("the redeem target must be exactly this composition's and asset's download route with no query, plus one well-formed token", () => {
  assert.deepEqual(downloadTargetFrom({ downloadUrl: path, grantToken: TOKEN, expiresAt: "x" }, C, A), { path, token: TOKEN });
  for (const url of [
    `https://evil.test${path}`, `//evil.test${path}`, `/api/v1/compositions/${A}/assets/${A}/download`, `/api/v1/compositions/${C}/assets/${C}/download`,
    `${path}?grant=${TOKEN}`, `${path}?`, `${path}/`, "javascript:alert(1)", "",
  ]) assert.equal(downloadTargetFrom({ downloadUrl: url, grantToken: TOKEN }, C, A), null, url);
  for (const grantToken of [TOKEN.slice(1), `${TOKEN}=`, `${"T".repeat(42)}%`, "", 1, null, undefined]) assert.equal(downloadTargetFrom({ downloadUrl: path, grantToken }, C, A), null, String(grantToken));
  for (const data of [null, undefined, "x", 1, {}, { downloadUrl: path }, { grantToken: TOKEN }]) assert.equal(downloadTargetFrom(data, C, A), null, JSON.stringify(data));
});

test("failure and success sentences: each case has its own text, and none names a token, grant or internal reason", () => {
  const sentences = [
    describeDownloadFailure(429, { error: { code: "COMPOSITION_RATE_LIMITED", retryAfterSeconds: 30 } }),
    describeDownloadFailure(429, { error: { code: "COMPOSITION_RATE_LIMITED" } }),
    describeDownloadFailure(409, { error: { code: "COMPOSITION_ASSET_NOT_AVAILABLE" } }),
    describeDownloadFailure(503, { error: { code: "COMPOSITION_LIMITS_NOT_CONFIGURED" } }),
    describeDownloadFailure(404, { error: { code: "COMPOSITION_NOT_FOUND" } }),
  ];
  assert.equal(new Set(sentences).size, sentences.length);
  assert.match(sentences[0]!, /30 seconds/);
  assert.equal(describeDownloadFailure(503, { error: { code: "COMPOSITION_DOWNLOAD_UNAVAILABLE" } }), sentences[3], "both closed states read the same");
  for (const sentence of [...sentences, describeDownloadStarted("art.png")]) assert.doesNotMatch(sentence, /token|grant|scanner|evidence|reason|ttl/i);
  assert.match(describeDownloadStarted("art.png"), /^art\.png: /);
});

test("the saved filename is taken only from the server's exact attachment header shape", () => {
  const sha12 = "0123456789ab";
  for (const ext of ["png", "jpg", "webp"]) assert.equal(downloadFileName(`attachment; filename="original-${sha12}.${ext}"`), `original-${sha12}.${ext}`);
  for (const header of [null, "", `inline; filename="original-${sha12}.png"`, `attachment; filename="../original-${sha12}.png"`, `attachment; filename="original-${sha12}.svg"`,
    `attachment; filename="original-${sha12}.png"; x`, `attachment; filename="original-${sha12.toUpperCase()}.png"`, `attachment; filename="evil.exe"`]) assert.equal(downloadFileName(header), null, String(header));
});

test("static: the control mints with one POST and no body, fetches the grant without navigating, and renders no link to the download route", () => {
  const source = readFileSync(new URL("../src/components/editor/editor.tsx", import.meta.url), "utf8");
  assert.match(source, /api\(`\/api\/v1\/compositions\/\$\{compositionId\}\/assets\/\$\{assetId\}\/download-grants`, "POST"\)/);
  assert.match(source, /const target = downloadTargetFrom\(response\.data, compositionId, assetId\);/);
  assert.match(source, /await fetch\(target\.path, \{ cache: "no-store", credentials: "same-origin", headers: \{ "x-vynvori-download-grant": target\.token \} \}\)/, "the grant is redeemed by the editor's own request, token in a header");
  assert.match(source, /const name = downloadFileName\(file\.headers\.get\("content-disposition"\)\);/);
  assert.match(source, /URL\.revokeObjectURL\(url\)/);
  assert.match(source, /canDownloadOriginal\(assets\.get\(current\.sourceAssetId\)\) && \(/, "offered only for a clean server asset");
  assert.doesNotMatch(source, /window\.location|location\.(assign|href|replace)/, "the editor tab never navigates to a grant");
  assert.doesNotMatch(source, /href=\{[^}]*download/i, "no rendered link to a grant");
  assert.doesNotMatch(source, /<Link[^>]*download/i);
  assert.doesNotMatch(source, /\?grant=|grant=\$\{/, "no token is ever put in a URL");
  assert.doesNotMatch(readFileSync(new URL("../src/components/editor/review.tsx", import.meta.url), "utf8"), /download-grants|\/download/);
});
