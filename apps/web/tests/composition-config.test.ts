import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { LICENSED_FONTS, SYNTHETIC_PREVIEW_PROFILE } from "@vynvori/contracts";
import { publicConfig } from "@vynvori/shared/public";
import { compositionSettings } from "../src/server/composition-runtime";

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
