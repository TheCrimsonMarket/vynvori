import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canReleaseToPartner, canRestoreSkippedRefinement, canTransitionPlaneA, canTransitionPlaneB,
  canTransitionPlaneCBundle, canTransitionPlaneCCommand, canTransitionPlaneCPromo, canTransitionPlaneD,
  canTransitionPlaneE, isCancellableBeforeRelease, isPreReleaseState,
} from "../src/state-machines";

test("Plane A follows the documented stage chain and rejects skipping/rewinding where forbidden", () => {
  assert.equal(canTransitionPlaneA("brief_draft", "brief_ready"), true);
  assert.equal(canTransitionPlaneA("plan_approved", "offer_choice"), true);
  assert.equal(canTransitionPlaneA("bundle_authorized", "concepts_running"), true);
  assert.equal(canTransitionPlaneA("final_delivered", "project_next_action"), true);
  // cannot jump straight from brief_draft to director_review, skipping brief_ready/director_planning
  assert.equal(canTransitionPlaneA("brief_draft", "director_review"), false);
  // project_next_action is terminal
  assert.equal(canTransitionPlaneA("project_next_action", "brief_draft"), false);
});

test("Plane B never lets outcome_unknown or a zero-charge failure jump straight to a delivered state", () => {
  assert.equal(canTransitionPlaneB("prepared", "submitted"), true);
  assert.equal(canTransitionPlaneB("result_received", "artifact_persisting"), true);
  assert.equal(canTransitionPlaneB("artifact_persisting", "persisted_delivered"), true);
  assert.equal(canTransitionPlaneB("outcome_unknown", "persisted_delivered"), false);
  assert.equal(canTransitionPlaneB("outcome_unknown", "reconciled_delivered"), true);
  // a verified zero-charge failure has no automatic next state — any retry is a new operation.
  assert.equal(canTransitionPlaneB("verified_zero_charge_failure", "submitted"), false);
});

test("Plane C command ledger: reserved is not settled; reconciliation hold requires operator remedy", () => {
  assert.equal(canTransitionPlaneCCommand("authorization_requested", "reserved"), true);
  assert.equal(canTransitionPlaneCCommand("reserved", "settled"), true);
  assert.equal(canTransitionPlaneCCommand("quote_visible", "settled"), false);
  assert.equal(canTransitionPlaneCCommand("reconciliation_hold", "settled"), false);
  assert.equal(canTransitionPlaneCCommand("reconciliation_hold", "operator_remedy"), true);
});

test("Plane C bundle: no automatic completion from partial, closure_pending gates closed", () => {
  assert.equal(canTransitionPlaneCBundle("authorized", "partial"), true);
  assert.equal(canTransitionPlaneCBundle("partial", "closed"), false);
  assert.equal(canTransitionPlaneCBundle("partial", "delivered_3_of_3"), true);
  assert.equal(canTransitionPlaneCBundle("open_for_refinements", "closed"), false);
  assert.equal(canTransitionPlaneCBundle("closure_pending", "closed"), true);
});

test("Plane C promo: a verified_uncharged_failure claim is terminal, never silently reconsumed", () => {
  assert.equal(canTransitionPlaneCPromo("eligible", "claim_reserved"), true);
  assert.equal(canTransitionPlaneCPromo("verified_uncharged_failure", "consumed"), false);
  assert.equal(canTransitionPlaneCPromo("claim_unknown", "consumed"), true);
});

test("restoring a skipped refinement slot is only legal while the bundle package is open_for_refinements", () => {
  assert.equal(canRestoreSkippedRefinement("open_for_refinements"), true);
  assert.equal(canRestoreSkippedRefinement("closure_pending"), false);
  assert.equal(canRestoreSkippedRefinement("closed"), false);
});

test("Plane D: a frozen_version never mutates in place — editing always produces a new version", () => {
  assert.equal(canTransitionPlaneD("frozen_version", "editable_scene"), true);
  assert.equal(canTransitionPlaneD("frozen_version", "frozen_version"), false);
  assert.equal(canTransitionPlaneD("guest_draft", "frozen_version"), false);
});

test("Plane E production job: release-to-partner needs every guard true, not just the state", () => {
  assert.equal(canTransitionPlaneE("approved_for_print", "released_to_partner"), true);
  assert.equal(canTransitionPlaneE("preflight_pending", "released_to_partner"), false);
  assert.equal(isPreReleaseState("preflight_pending"), true);
  assert.equal(isPreReleaseState("printing"), false);
  assert.equal(isCancellableBeforeRelease("approved_for_print"), true);
  assert.equal(isCancellableBeforeRelease("printing"), false);

  const baseContext = {
    currentState: "approved_for_print" as const,
    medusaPaymentVerifiedNow: true,
    compositionAndProfileHashesCurrent: true,
    hasBlockingRefund: false,
    humanQaDecision: "approved" as const,
  };
  assert.equal(canReleaseToPartner(baseContext), true);
  assert.equal(canReleaseToPartner({ ...baseContext, hasBlockingRefund: true }), false);
  assert.equal(canReleaseToPartner({ ...baseContext, humanQaDecision: "pending" }), false);
  assert.equal(canReleaseToPartner({ ...baseContext, currentState: "preflight_pending" }), false);
});
