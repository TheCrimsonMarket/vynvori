import test from "node:test";
import assert from "node:assert/strict";
import {
  CompositionSceneV1Schema, PrintProfileV1Schema, SYNTHETIC_PREVIEW_PROFILE, LICENSED_FONTS, EMPTY_SYNTHETIC_SCENE,
  normalizeScene, canonicalSceneJson, sceneSourceHashes, assertSceneLimits, SceneLimitError, runPreviewPreflight,
  toNormalized, fromNormalized, rotatedBounds, effectivePpi, quantizeMm, type CompositionSceneV1, type AssetFacts,
} from "../src/composition-scene";

const sha = (c: string) => c.repeat(64);
const font = LICENSED_FONTS[0]!;
const image = (id: string, over: Record<string, unknown> = {}) => ({ kind: "image" as const, layerId: id, sourceAssetId: "asset_1", sourceAssetSha256: sha("a"), xMm: 20, yMm: 20, widthMm: 100, heightMm: 100, rotationDeg: 0, zIndex: 0, visible: true, ...over });
const text = (id: string, over: Record<string, unknown> = {}) => ({ kind: "text" as const, layerId: id, text: "HELLO", fontAssetId: font.fontAssetId, fontFileSha256: font.fileSha256, fontLicenseVersion: font.licenseVersion, fontSizePt: 30, color: "#ffffff", xMm: 20, yMm: 150, widthMm: 100, heightMm: 20, rotationDeg: 0, zIndex: 1, visible: true, ...over });
function scene(layers: unknown[] = [image("l1"), text("l2")]): CompositionSceneV1 {
  const base = EMPTY_SYNTHETIC_SCENE();
  return CompositionSceneV1Schema.parse({ ...base, pages: [{ zoneId: "front", layers }, { zoneId: "back", layers: [] }] });
}
const assets = new Map<string, AssetFacts>([["asset_1", { sha256: sha("a"), widthPx: 2400, heightPx: 2400 }]]);
const fonts = new Map(LICENSED_FONTS.map(f => [f.fontAssetId, f]));

test("synthetic profile can never be approved or print-eligible", () => {
  assert.equal(SYNTHETIC_PREVIEW_PROFILE.printReleaseEligible, false);
  assert.equal(SYNTHETIC_PREVIEW_PROFILE.supplierApproved, false);
  for (const patch of [{ supplierApproved: true }, { printReleaseEligible: true }, { status: "approved" }]) {
    assert.equal(PrintProfileV1Schema.safeParse({ ...SYNTHETIC_PREVIEW_PROFILE, ...patch }).success, false);
  }
});
test("scene schema is strict and rejects duplicate zone/layer ids and unknown keys", () => {
  assert.equal(CompositionSceneV1Schema.safeParse({ ...scene(), extra: 1 }).success, false);
  assert.equal(CompositionSceneV1Schema.safeParse({ ...EMPTY_SYNTHETIC_SCENE(), pages: [{ zoneId: "front", layers: [] }, { zoneId: "front", layers: [] }] }).success, false);
  assert.equal(CompositionSceneV1Schema.safeParse({ ...EMPTY_SYNTHETIC_SCENE(), pages: [{ zoneId: "front", layers: [image("dup")] }, { zoneId: "back", layers: [image("dup")] }] }).success, false);
  assert.throws(() => scene([image("l1", { widthMm: 0 })]));
});
test("canonical JSON is order-independent and quantised; hash inputs are stable across reload", () => {
  const a = scene([image("l1", { xMm: 20.00049 }), text("l2")]), b = scene([text("l2"), image("l1", { xMm: 20 })]);
  b.pages.reverse();
  assert.equal(canonicalSceneJson(a), canonicalSceneJson(b));
  const reloaded = CompositionSceneV1Schema.parse(JSON.parse(JSON.stringify(normalizeScene(a))));
  assert.deepEqual(normalizeScene(reloaded), normalizeScene(a));
  assert.equal(canonicalSceneJson(reloaded), canonicalSceneJson(a));
  assert.equal(quantizeMm(20.00049), 20);
});
test("mm <-> normalised conversion is reproducible and independent of display size", () => {
  const zone = SYNTHETIC_PREVIEW_PROFILE.zones[0]!, box = { xMm: 33.333, yMm: 12.5, widthMm: 101.101, heightMm: 77.7, rotationDeg: 12.5 };
  assert.deepEqual(fromNormalized(zone, toNormalized(zone, box)), box);
});
test("rotated bounds and effective PPI", () => {
  const b = rotatedBounds({ xMm: 0, yMm: 0, widthMm: 100, heightMm: 100, rotationDeg: 45 });
  assert.ok(Math.abs((b.maxX - b.minX) - 141.42) < 0.01);
  assert.ok(Math.abs(effectivePpi({ widthPx: 1000, heightPx: 2000 }, { widthMm: 25.4, heightMm: 50.8 }) - 1000) < 1e-9);
});
test("limits reject non-finite, huge and over-long input", () => {
  assert.throws(() => assertSceneLimits({ ...scene(), pages: [{ zoneId: "front", layers: [image("l1", { xMm: 1e9 })] }] } as CompositionSceneV1), SceneLimitError);
  assert.throws(() => assertSceneLimits({ ...scene(), pages: [{ zoneId: "front", layers: [text("t", { text: "x".repeat(2001) })] }] } as CompositionSceneV1), SceneLimitError);
  assert.throws(() => assertSceneLimits({ ...scene(), pages: [{ zoneId: "front", layers: [image("l1", { rotationDeg: 721 })] }] } as CompositionSceneV1), SceneLimitError);
  assert.doesNotThrow(() => assertSceneLimits(scene()));
});
test("preflight is preview_only when clean and NEVER passed_pending_human_qa", () => {
  const result = runPreviewPreflight(scene(), SYNTHETIC_PREVIEW_PROFILE, assets, fonts);
  assert.equal(result.state, "preview_only");
  assert.ok(result.issues.some(i => i.code === "PRINT_PROFILE_UNAPPROVED"));
});
test("preflight blocks bounds, missing/mismatched assets, unlicensed fonts, low PPI and profile mismatch", () => {
  const run = (layers: unknown[], a = assets, f = fonts) => runPreviewPreflight(scene(layers), SYNTHETIC_PREVIEW_PROFILE, a, f);
  assert.ok(run([image("l1", { xMm: 150 })]).issues.some(i => i.code === "LAYER_OUT_OF_BOUNDS"));
  assert.ok(run([image("l1", { xMm: 2 })]).issues.some(i => i.code === "LAYER_OUTSIDE_SAFE_MARGIN" && i.severity === "warning"));
  assert.equal(run([image("l1", { xMm: 2 })]).state, "preview_only");
  assert.ok(run([image("l1")], new Map()).issues.some(i => i.code === "ASSET_MISSING"));
  assert.ok(run([image("l1", { sourceAssetSha256: sha("b") })]).issues.some(i => i.code === "ASSET_HASH_MISMATCH"));
  assert.ok(run([text("t", { fontFileSha256: sha("c") })]).issues.some(i => i.code === "FONT_UNLICENSED"));
  assert.ok(run([text("t", { fontLicenseVersion: "proprietary" })]).issues.some(i => i.code === "FONT_UNLICENSED"));
  assert.ok(run([image("l1", { widthMm: 190, heightMm: 190, xMm: 5, yMm: 5 })], new Map([["asset_1", { sha256: sha("a"), widthPx: 300, heightPx: 300 }]])).issues.some(i => i.code === "LOW_EFFECTIVE_PPI"));
  const mismatch = runPreviewPreflight({ ...scene(), printProfileVersion: "other" }, SYNTHETIC_PREVIEW_PROFILE, assets, fonts);
  assert.equal(mismatch.state, "blocked");
  assert.ok(runPreviewPreflight(scene([image("l1", { visible: false, xMm: 900 })]), SYNTHETIC_PREVIEW_PROFILE, assets, fonts).state === "preview_only", "hidden layers are not printed");
});
test("source hashes pin images and fonts, de-duplicated and sorted", () => {
  const hashes = sceneSourceHashes(scene([image("a1"), image("a2", { sourceAssetSha256: sha("0") }), text("t1"), text("t2")]));
  assert.deepEqual(hashes.assets, [sha("0"), sha("a")]);
  assert.deepEqual(hashes.fonts, [font.fileSha256]);
});
