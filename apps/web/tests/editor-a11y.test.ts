import test from "node:test";
import assert from "node:assert/strict";
import { EMPTY_SYNTHETIC_SCENE } from "@vynvori/contracts";
import {
  KEY_HELP, KEY_STEP_MM, addTextLayer, describeLayerCount, describeMove, keyStep, layerActionName, layerTitle, layersOf, moveInStack, neighbourAfterDelete, stackPosition, summarizeIssues,
} from "../src/components/editor/model";

function sceneWithLayers(count: number) {
  let scene = EMPTY_SYNTHETIC_SCENE(); const ids: string[] = [];
  for (let i = 0; i < count; i++) { const added = addTextLayer(scene, "front", `LAYER ${i + 1}`); scene = added.scene; ids.push(added.layerId); }
  return { scene, ids }; // ids[0] is the bottom of the stack, the last id is the top
}

test("key help and nudge distances share one source", () => {
  assert.deepEqual(KEY_STEP_MM, { fine: 0.1, normal: 1, coarse: 10 });
  assert.equal(keyStep({ shiftKey: false, altKey: false }), KEY_STEP_MM.normal); assert.equal(keyStep({ shiftKey: true, altKey: false }), KEY_STEP_MM.coarse); assert.equal(keyStep({ shiftKey: false, altKey: true }), KEY_STEP_MM.fine);
  assert.match(KEY_HELP, /1 mm/); assert.match(KEY_HELP, /10 mm/); assert.match(KEY_HELP, /0\.1 mm/); assert.match(KEY_HELP, /Delete removes the layer/);
});

test("stack position counts from the top of the list and per-layer action names are unique", () => {
  const { scene, ids } = sceneWithLayers(3);
  assert.deepEqual(ids.map(id => stackPosition(scene, "front", id)), [3, 2, 1]);
  assert.equal(stackPosition(scene, "back", ids[0]!), null); assert.equal(stackPosition(scene, "front", "layer_99"), null);
  const layers = [...layersOf(scene, "front")].reverse(), names = layers.flatMap((layer, index) => ["Move up", "Move down", "Hide layer"].map(action => layerActionName(action, layerTitle(layer), index + 1, layers.length)));
  assert.equal(new Set(names).size, names.length, "no two actions share a name even when two layers have the same text");
  assert.equal(layerActionName("Move up", "Text · A", 2, 3), "Move up: Text · A, layer 2 of 3");
});

test("stack position follows reordering", () => {
  const { scene, ids } = sceneWithLayers(3), bottom = ids[0]!;
  assert.equal(stackPosition(moveInStack(scene, "front", bottom, "up"), "front", bottom), 2);
  assert.equal(stackPosition(moveInStack(scene, "front", ids[2]!, "up"), "front", ids[2]!), 1, "the top layer cannot move up: position unchanged");
});

test("focus after delete goes to the neighbour below in the list, else above, else nowhere", () => {
  const { scene, ids } = sceneWithLayers(3);
  assert.equal(neighbourAfterDelete(scene, "front", ids[2]!), ids[1], "top layer: the one under it");
  assert.equal(neighbourAfterDelete(scene, "front", ids[1]!), ids[0]);
  assert.equal(neighbourAfterDelete(scene, "front", ids[0]!), ids[1], "bottom layer: the one above it");
  assert.equal(neighbourAfterDelete(sceneWithLayers(1).scene, "front", "layer_1"), null);
  assert.equal(neighbourAfterDelete(scene, "front", "layer_99"), null);
});

test("issue summaries count problems and warnings, ignore the always-present info note and pluralise", () => {
  assert.equal(summarizeIssues([{ severity: "info" }]), "Preview checks: no problems or warnings.");
  assert.equal(summarizeIssues([]), "Preview checks: no problems or warnings.");
  assert.equal(summarizeIssues([{ severity: "hard_error" }, { severity: "info" }]), "Preview checks: 1 problem.");
  assert.equal(summarizeIssues([{ severity: "hard_error" }, { severity: "hard_error" }, { severity: "warning" }]), "Preview checks: 2 problems and 1 warning.");
  assert.equal(summarizeIssues([{ severity: "warning" }, { severity: "warning" }]), "Preview checks: 2 warnings.");
});

test("announcement wording", () => {
  assert.equal(describeLayerCount(0), "No layers"); assert.equal(describeLayerCount(1), "1 layer"); assert.equal(describeLayerCount(3), "3 layers");
  assert.equal(describeMove(13, 123.121), "Moved to x 13 mm, y 123.121 mm.");
});
