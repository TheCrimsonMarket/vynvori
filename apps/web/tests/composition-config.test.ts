import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { LICENSED_FONTS, SYNTHETIC_PREVIEW_PROFILE } from "@vynvori/contracts";
import { publicConfig } from "@vynvori/shared/public";
import { unconfiguredScanPort } from "@vynvori/commerce/composition";
import { compositionSettings, editorCapabilities, scanPortFor, serviceConfigFor, uploadLimitsFor } from "../src/server/composition-runtime";

test("licensed font registry pins the exact bundled Archivo file", () => {
  const bytes = readFileSync(new URL("../src/fonts/archivo.ttf", import.meta.url));
  assert.equal(LICENSED_FONTS[0]!.fileSha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(LICENSED_FONTS[0]!.licenseVersion, "OFL-1.1");
});
test("composition API and uploads are closed by default and never enabled in production", () => {
  assert.equal(compositionSettings({}).enabled, false);
  assert.equal(compositionSettings({ M3_COMPOSITION_ENABLED: "true" }).enabled, false, "needs the identity canary");
  assert.equal(compositionSettings({ M3_COMPOSITION_ENABLED: "true", VERCEL_ENV: "production" }).enabled, false);
  assert.equal(publicConfig.features["assets.production_uploads"], false);
  assert.equal(SYNTHETIC_PREVIEW_PROFILE.printReleaseEligible, false);
});
test("flag-off state: the editor UI offers no artwork upload under any default or partial configuration", () => {
  for (const env of [{}, { M3_COMPOSITION_ENABLED: "true" }, { M3_COMPOSITION_UPLOADS: "true" }, { M3_COMPOSITION_ENABLED: "true", M3_COMPOSITION_UPLOADS: "true" },
    { M3_COMPOSITION_ENABLED: "true", M3_COMPOSITION_UPLOADS: "true", VERCEL_ENV: "production" }, { VYNVORI_ASSETS_PRODUCTION_UPLOADS: "true" }])
    assert.equal(editorCapabilities(env).artworkUpload, false, JSON.stringify(env));
  // The UI answer is, by construction, never looser than the API's own gate.
  assert.equal(editorCapabilities({ M3_COMPOSITION_ENABLED: "true", M3_COMPOSITION_UPLOADS: "true" }).artworkUpload, compositionSettings({ M3_COMPOSITION_ENABLED: "true", M3_COMPOSITION_UPLOADS: "true" }).enabled);
});
test("M3_LIMIT_* variables alone never enable uploads or hand the editor any limit; unset limits give no editor limits", () => {
  // SYNTHETIC values, not policy.
  const SYNTHETIC_LIMIT_ENV = { M3_LIMIT_JSON_MAX_BYTES: "11", M3_LIMIT_GUEST_TTL_SECONDS: "12", M3_LIMIT_IMAGE_MAX_BYTES: "13", M3_LIMIT_IMAGE_MAX_PIXELS: "14", M3_LIMIT_IMAGE_MAX_SIDE_PX: "15", M3_LIMIT_MAX_ASSETS_PER_COMPOSITION: "16", M3_LIMIT_MAX_BYTES_PER_COMPOSITION: "17" };
  for (const env of [SYNTHETIC_LIMIT_ENV, { ...SYNTHETIC_LIMIT_ENV, M3_COMPOSITION_UPLOADS: "true" }, { ...SYNTHETIC_LIMIT_ENV, M3_COMPOSITION_ENABLED: "true" }]) {
    assert.deepEqual(editorCapabilities(env), { artworkUpload: false, uploadLimits: null }, JSON.stringify(Object.keys(env)));
    assert.equal(compositionSettings(env).enabled, false);
  }
  assert.deepEqual(editorCapabilities({}), { artworkUpload: false, uploadLimits: null });
  assert.equal(uploadLimitsFor({}), null);
  assert.equal(uploadLimitsFor({ ...SYNTHETIC_LIMIT_ENV, M3_LIMIT_IMAGE_MAX_PIXELS: undefined }), null, "one unset key closes the editor limits");
  assert.equal(uploadLimitsFor({ ...SYNTHETIC_LIMIT_ENV, M3_LIMIT_IMAGE_MAX_BYTES: "26214401" }), null, "above the structural ceiling is invalid");
  assert.deepEqual(uploadLimitsFor(SYNTHETIC_LIMIT_ENV), { maxBytes: 13, maxPixels: 14, maxSidePx: 15 });
  assert.equal(publicConfig.features["assets.production_uploads"], false);
});

test("C4 service configuration: rate policies and the live-guest cap come only from M3_LIMIT_*; nothing is defaulted and each gap closes just its own operation", () => {
  // SYNTHETIC values, not policy.
  const SYNTHETIC_ENV: Record<string, string> = { M3_LIMIT_JSON_MAX_BYTES: "11", M3_LIMIT_GUEST_TTL_SECONDS: "12", M3_LIMIT_LIVE_GUEST_DRAFTS_MAX: "13",
    M3_LIMIT_RATE_GUEST_CREATE_GLOBAL_WINDOW_SECONDS: "14", M3_LIMIT_RATE_GUEST_CREATE_GLOBAL_MAX: "15", M3_LIMIT_RATE_OWNER_WRITE_WINDOW_SECONDS: "16" };
  const empty = serviceConfigFor({}, false);
  assert.deepEqual(empty.rate, {}); assert.equal(empty.liveGuestDraftsMax, undefined); assert.equal(empty.guestTtlMs, undefined); assert.equal(empty.imageLimits, undefined);
  const config = serviceConfigFor(SYNTHETIC_ENV, false);
  assert.deepEqual(config.rate, { GUEST_CREATE_GLOBAL: { windowSeconds: 14, max: 15 } }, "OWNER_WRITE has only its window, so it stays closed");
  assert.equal(config.liveGuestDraftsMax, 13); assert.equal(config.guestTtlMs, 12_000); assert.equal(config.uploadsEnabled, false);
  assert.equal(serviceConfigFor(SYNTHETIC_ENV, true).uploadsEnabled, true);
  assert.equal(serviceConfigFor({ ...SYNTHETIC_ENV, M3_LIMIT_LIVE_GUEST_DRAFTS_MAX: "0" }, false).liveGuestDraftsMax, undefined, "zero is invalid, not unlimited");
});

test("C5: no scanner is chosen, so the runtime always wires unconfiguredScanPort and the editor never offers upload, whatever the environment says", () => {
  // SYNTHETIC values, not policy. Every limit an upload needs, the scan limits, and both opt-ins: still closed, because no scanner exists.
  const SYNTHETIC_FULL_ENV: Record<string, string> = { M3_LIMIT_JSON_MAX_BYTES: "11", M3_LIMIT_IMAGE_MAX_BYTES: "13", M3_LIMIT_IMAGE_MAX_PIXELS: "14", M3_LIMIT_IMAGE_MAX_SIDE_PX: "15",
    M3_LIMIT_MAX_ASSETS_PER_COMPOSITION: "16", M3_LIMIT_MAX_BYTES_PER_COMPOSITION: "17", M3_LIMIT_SCAN_TIMEOUT_SECONDS: "18", M3_LIMIT_SCAN_LEASE_SECONDS: "19",
    M3_COMPOSITION_ENABLED: "true", M3_COMPOSITION_UPLOADS: "true", M3_SCANNER: "anything", M3_SCAN_PORT: "synthetic" };
  for (const env of [{}, SYNTHETIC_FULL_ENV]) {
    assert.equal(scanPortFor(env), unconfiguredScanPort);
    assert.equal(serviceConfigFor(env, true).scanPort, unconfiguredScanPort);
    assert.equal(editorCapabilities(env).artworkUpload, false);
  }
  const config = serviceConfigFor(SYNTHETIC_FULL_ENV, true);
  assert.deepEqual([config.scanTimeoutMs, config.scanLeaseMs], [18_000, 19_000]);
  assert.deepEqual([serviceConfigFor({}, true).scanTimeoutMs, serviceConfigFor({}, true).scanLeaseMs], [undefined, undefined], "unset closes scanning; no default");
  const inverted = serviceConfigFor({ ...SYNTHETIC_FULL_ENV, M3_LIMIT_SCAN_LEASE_SECONDS: "18" }, true);
  assert.deepEqual([inverted.scanTimeoutMs, inverted.scanLeaseMs], [undefined, undefined], "a lease that does not outlive the timeout closes scanning");
  assert.equal(publicConfig.features["assets.production_uploads"], false);
});

test("C6: the download-grant TTL comes only from M3_LIMIT_DOWNLOAD_GRANT_TTL_SECONDS; unset or invalid closes minting, with no default", () => {
  // SYNTHETIC value, not policy.
  assert.equal(serviceConfigFor({ M3_LIMIT_DOWNLOAD_GRANT_TTL_SECONDS: "21" }, false).downloadGrantTtlMs, 21_000);
  for (const env of [{}, { M3_LIMIT_DOWNLOAD_GRANT_TTL_SECONDS: "0" }, { M3_LIMIT_DOWNLOAD_GRANT_TTL_SECONDS: "-1" }, { M3_LIMIT_DOWNLOAD_GRANT_TTL_SECONDS: "2.5" }]) {
    assert.equal(serviceConfigFor(env, true).downloadGrantTtlMs, undefined, JSON.stringify(env));
  }
});
