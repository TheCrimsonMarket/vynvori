import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_SYNTHETIC_SCENE, CompositionSceneV1Schema, canonicalSceneJson } from "@vynvori/contracts";
import { addImageLayer, addTextLayer, updateLayer, nudge, moveInStack, deleteLayer, duplicateLayer, parseMm, resizeKeepingAspect, layersOf, keyStep, commit, startHistory, undo, redo, isOutside } from "../src/components/editor/model";

const asset = { assetId: "a1", sha256: "a".repeat(64), widthPx: 3000, heightPx: 2000, name: "art.png", url: "data:", persisted: false };
const valid = (scene: unknown) => CompositionSceneV1Schema.parse(scene);

test("image layers fit inside the safe area, keep aspect and centre; scenes always satisfy the shared schema", () => {
  const { scene, layerId } = addImageLayer(EMPTY_SYNTHETIC_SCENE(), "front", asset); valid(scene);
  const layer = layersOf(scene, "front").find(l => l.layerId === layerId)!;
  assert.ok(Math.abs(layer.widthMm / layer.heightMm - 1.5) < 0.001);
  assert.equal(layer.xMm, (200 - layer.widthMm) / 2); assert.equal(isOutside("front", layer), false);
  assert.equal(layersOf(scene, "back").length, 0, "zones are independent");
});
test("numeric edits are quantised to micrometres and invalid input never corrupts the scene", () => {
  const added = addTextLayer(EMPTY_SYNTHETIC_SCENE(), "front"), layerId = added.layerId;
  let scene = added.scene;
  scene = updateLayer(scene, "front", layerId, { xMm: 12.34567, widthMm: -5, heightMm: Number.NaN, rotationDeg: 9999 });
  const layer = layersOf(scene, "front")[0]!;
  assert.equal(layer.xMm, 12.346); assert.ok(layer.widthMm > 0 && Number.isFinite(layer.heightMm)); assert.equal(layer.rotationDeg, 360); valid(scene);
  assert.deepEqual([parseMm("12"), parseMm("12,5"), parseMm("-3.25"), parseMm(""), parseMm("1e9"), parseMm("NaN"), parseMm("1.23456"), parseMm("12abc")], [12, 12.5, -3.25, null, null, null, null, null]);
});
test("keyboard nudging parity: arrow = 1 mm, Shift = 10 mm, Alt = 0.1 mm — exactly reproducible", () => {
  const first = addImageLayer(EMPTY_SYNTHETIC_SCENE(), "front", asset), layerId = first.layerId;
  let scene = first.scene;
  const x0 = layersOf(scene, "front")[0]!.xMm;
  scene = nudge(scene, "front", layerId, keyStep({ shiftKey: false, altKey: false }), 0);
  scene = nudge(scene, "front", layerId, keyStep({ shiftKey: true, altKey: false }), 0);
  scene = nudge(scene, "front", layerId, keyStep({ shiftKey: false, altKey: true }), 0);
  assert.equal(layersOf(scene, "front")[0]!.xMm, Math.round((x0 + 11.1) * 1000) / 1000);
});
test("z-order is dense and reorder/duplicate/delete keep ids unique", () => {
  let scene = EMPTY_SYNTHETIC_SCENE(); const ids: string[] = [];
  for (let i = 0; i < 3; i++) { const r = addTextLayer(scene, "front", `T${i}`); scene = r.scene; ids.push(r.layerId); }
  scene = moveInStack(scene, "front", ids[0]!, "up");
  assert.deepEqual(layersOf(scene, "front").map(l => l.layerId), [ids[1], ids[0], ids[2]]);
  assert.deepEqual(layersOf(scene, "front").map(l => l.zIndex), [0, 1, 2]);
  assert.deepEqual(layersOf(moveInStack(scene, "front", ids[2]!, "up"), "front").map(l => l.layerId), [ids[1], ids[0], ids[2]], "top layer cannot move up");
  const dup = duplicateLayer(scene, "front", ids[1]!); valid(dup.scene);
  assert.equal(new Set(layersOf(dup.scene, "front").map(l => l.layerId)).size, 4);
  const removed = deleteLayer(dup.scene, "front", ids[0]!); assert.deepEqual(layersOf(removed, "front").map(l => l.zIndex), [0, 1, 2]);
});
test("aspect-locked resize and bounded undo/redo", () => {
  const second = addImageLayer(EMPTY_SYNTHETIC_SCENE(), "front", asset), layerId = second.layerId;
  let scene = second.scene;
  const before = layersOf(scene, "front")[0]!; scene = resizeKeepingAspect(scene, "front", layerId, "widthMm", before.widthMm / 2);
  const after = layersOf(scene, "front")[0]!; assert.ok(Math.abs(after.widthMm / after.heightMm - before.widthMm / before.heightMm) < 0.001);
  let history = startHistory(EMPTY_SYNTHETIC_SCENE()); history = commit(history, scene);
  assert.equal(undo(history).present.pages[0]!.layers.length, 0); assert.equal(redo(undo(history)).present, scene);
  assert.equal(commit(history, history.present), history);
  assert.equal(canonicalSceneJson(scene), canonicalSceneJson(valid(JSON.parse(JSON.stringify(scene)))), "serialisation round trip is stable");
});
