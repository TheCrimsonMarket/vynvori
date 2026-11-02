/**
 * Canonical, separately owned state machines (Planes A-E).
 * Source: docs/technical/22-canonical-state-machines.md.
 *
 * These are pure transition-validity graphs and guard predicates — no persistence, no side
 * effects, no provider/Medusa calls. "UI stage is a derived projection. Backend modules cannot
 * mutate a different domain's state directly" (doc 22 line 3) — each plane below is modeled
 * independently and this module does not let a caller drive one plane's transition from another's.
 */

function buildGraph<State extends string>(edges: ReadonlyArray<readonly [State, readonly State[]]>): ReadonlyMap<State, ReadonlySet<State>> {
  return new Map(edges.map(([from, to]) => [from, new Set(to)]));
}

function canTransition<State extends string>(graph: ReadonlyMap<State, ReadonlySet<State>>, from: State, to: State): boolean {
  return graph.get(from)?.has(to) ?? false;
}

// --- Plane A: customer-facing Studio project/stage (Neon server-derived view) --------------
export type PlaneAStage =
  | "brief_draft" | "brief_ready" | "director_planning" | "director_review" | "plan_approved"
  | "offer_choice" | "promo_quote" | "promo_pending" | "promo_review" | "bundle_quote"
  | "bundle_authorized" | "concepts_running" | "concepts_partial" | "concepts_ready"
  | "selected_concept" | "refinements_open" | "final_quote" | "final_unavailable"
  | "final_pending" | "final_under_review" | "final_delivered" | "project_next_action";

export const PLANE_A_GRAPH = buildGraph<PlaneAStage>([
  ["brief_draft", ["brief_ready"]],
  ["brief_ready", ["director_planning"]],
  ["director_planning", ["director_review", "brief_ready"]], // doc 22: quota exhaustion returns to saved brief, no approved plan
  ["director_review", ["plan_approved", "director_planning"]], // revision creates a new plan version
  ["plan_approved", ["offer_choice"]],
  ["offer_choice", ["promo_quote", "bundle_quote"]], // promo is optional and does not block the bundle path
  ["promo_quote", ["promo_pending"]],
  ["promo_pending", ["promo_review"]],
  ["promo_review", ["offer_choice", "bundle_quote"]], // one claim consumed; return to offer choice for the bundle decision
  ["bundle_quote", ["bundle_authorized", "offer_choice"]],
  ["bundle_authorized", ["concepts_running"]],
  ["concepts_running", ["concepts_partial", "concepts_ready"]],
  ["concepts_partial", ["concepts_ready"]], // only once the missing slot(s) resolve to 3/3 or an approved remedy
  ["concepts_ready", ["selected_concept"]],
  ["selected_concept", ["refinements_open"]],
  ["refinements_open", ["final_quote", "final_unavailable"]],
  ["final_quote", ["final_pending"]],
  ["final_pending", ["final_under_review", "final_delivered"]],
  ["final_under_review", ["final_delivered", "refinements_open"]], // reconciled_delivered vs reconciled_uncharged_failure (Plane B) returns here
  ["final_delivered", ["project_next_action"]],
  ["final_unavailable", ["project_next_action"]],
  ["project_next_action", []],
]);

export function canTransitionPlaneA(from: PlaneAStage, to: PlaneAStage): boolean {
  return canTransition(PLANE_A_GRAPH, from, to);
}

// --- Plane B: provider operation/artifact persistence (Neon + durable workflow, internal) --
export type PlaneBStatus =
  | "prepared" | "submitted" | "running" | "result_received" | "artifact_persisting"
  | "outcome_unknown" | "persistence_failed_under_review" | "persisted_delivered"
  | "verified_zero_charge_failure" | "reconciled_delivered" | "reconciled_uncharged_failure" | "operator_case";

export const PLANE_B_GRAPH = buildGraph<PlaneBStatus>([
  ["prepared", ["submitted"]], // only once, after durable customer/promo authorization (doc 22 line 23)
  ["submitted", ["running", "result_received", "verified_zero_charge_failure", "outcome_unknown"]],
  ["running", ["result_received", "verified_zero_charge_failure", "outcome_unknown"]],
  ["result_received", ["artifact_persisting"]], // only after checksum/MIME validation
  ["artifact_persisting", ["persisted_delivered", "persistence_failed_under_review"]],
  ["outcome_unknown", ["reconciled_delivered", "reconciled_uncharged_failure", "operator_case"]],
  ["persistence_failed_under_review", ["reconciled_delivered", "reconciled_uncharged_failure", "operator_case"]],
  // verified_zero_charge_failure has no automatic next state: a retry is a brand-new operation,
  // authorized only under fresh explicit policy/consent (doc 22 line 29) — never reuse this ID.
  ["verified_zero_charge_failure", []],
  ["persisted_delivered", []],
  ["reconciled_delivered", []],
  ["reconciled_uncharged_failure", []],
  ["operator_case", ["reconciled_delivered", "reconciled_uncharged_failure"]],
]);

export function canTransitionPlaneB(from: PlaneBStatus, to: PlaneBStatus): boolean {
  return canTransition(PLANE_B_GRAPH, from, to);
}

// --- Plane C: customer credits, package and promo entitlement (Neon ACID ledger) -----------
export type PlaneCCommandState = "quote_visible" | "authorization_requested" | "reserved" | "settled" | "released" | "reconciliation_hold" | "operator_remedy";
export const PLANE_C_COMMAND_GRAPH = buildGraph<PlaneCCommandState>([
  ["quote_visible", ["authorization_requested"]],
  ["authorization_requested", ["reserved"]],
  ["reserved", ["settled", "released", "reconciliation_hold"]],
  ["settled", []],
  ["released", []],
  ["reconciliation_hold", ["operator_remedy"]], // cannot autoexpire/release/settle absent approved policy
  ["operator_remedy", ["settled", "released"]],
]);
export function canTransitionPlaneCCommand(from: PlaneCCommandState, to: PlaneCCommandState): boolean {
  return canTransition(PLANE_C_COMMAND_GRAPH, from, to);
}

export type PlaneCBundleState = "quoted" | "authorized" | "partial" | "delivered_3_of_3" | "open_for_refinements" | "closure_pending" | "closed" | "remedy_pending";
export const PLANE_C_BUNDLE_GRAPH = buildGraph<PlaneCBundleState>([
  ["quoted", ["authorized"]],
  ["authorized", ["partial", "delivered_3_of_3"]],
  ["partial", ["delivered_3_of_3"]], // no automatic completion for 2/3 (doc 22 line 39): requires an explicit resolved 3/3
  ["delivered_3_of_3", ["open_for_refinements"]],
  ["open_for_refinements", ["closure_pending"]],
  ["closure_pending", ["closed", "remedy_pending"]], // unknown final keeps closure_pending; successful persisted final permits closed
  ["closed", []],
  ["remedy_pending", ["closed"]],
]);
export function canTransitionPlaneCBundle(from: PlaneCBundleState, to: PlaneCBundleState): boolean {
  return canTransition(PLANE_C_BUNDLE_GRAPH, from, to);
}

export type PlaneCPromoState = "eligible" | "claim_reserved" | "consumed" | "verified_uncharged_failure" | "claim_unknown";
export const PLANE_C_PROMO_GRAPH = buildGraph<PlaneCPromoState>([
  ["eligible", ["claim_reserved"]],
  ["claim_reserved", ["consumed", "verified_uncharged_failure", "claim_unknown"]],
  ["consumed", []],
  ["verified_uncharged_failure", []], // a paid new concept never recycles promo bytes/slot
  ["claim_unknown", ["consumed", "verified_uncharged_failure"]], // only from authoritative reconciliation evidence
]);
export function canTransitionPlaneCPromo(from: PlaneCPromoState, to: PlaneCPromoState): boolean {
  return canTransition(PLANE_C_PROMO_GRAPH, from, to);
}

/** doc 23 invariant 7 / doc 22 line 39: skipped -> available only while the bundle package is open. */
export function canRestoreSkippedRefinement(packageState: PlaneCBundleState): boolean {
  return packageState === "open_for_refinements";
}

// --- Plane D: independent Garment Editor / version and lineage (Neon/R2) -------------------
export type PlaneDState = "guest_draft" | "editable_scene" | "saved_owned" | "frozen_version" | "composition_quoted" | "cart_linked" | "ordered_snapshot";
export const PLANE_D_GRAPH = buildGraph<PlaneDState>([
  ["guest_draft", ["editable_scene"]],
  ["editable_scene", ["saved_owned", "frozen_version"]], // anonymous BYO may freeze/quote without an account
  ["saved_owned", ["editable_scene", "frozen_version"]],
  ["frozen_version", ["composition_quoted", "editable_scene"]], // frozen_version never mutates; editing starts a NEW version
  ["composition_quoted", ["cart_linked", "editable_scene"]],
  ["cart_linked", ["ordered_snapshot", "editable_scene"]],
  ["ordered_snapshot", []],
]);
export function canTransitionPlaneD(from: PlaneDState, to: PlaneDState): boolean {
  return canTransition(PLANE_D_GRAPH, from, to);
}

// --- Plane E: production QA / fulfillment (Neon + Medusa) ----------------------------------
export type PlaneEState =
  | "pending_asset_verification" | "preflight_pending" | "preflight_blocked" | "awaiting_human_qa"
  | "needs_customer_reapproval" | "approved_for_print" | "released_to_partner" | "printing"
  | "printed" | "packed" | "awaiting_dispatch" | "shipped" | "delivered"
  | "cancelled_before_release" | "production_exception";

const PRE_RELEASE_STATES: readonly PlaneEState[] = [
  "pending_asset_verification", "preflight_pending", "preflight_blocked", "awaiting_human_qa", "needs_customer_reapproval",
];

export const PLANE_E_GRAPH = buildGraph<PlaneEState>([
  ["pending_asset_verification", ["preflight_pending", "cancelled_before_release"]],
  ["preflight_pending", ["awaiting_human_qa", "preflight_blocked", "cancelled_before_release"]],
  ["preflight_blocked", ["preflight_pending", "cancelled_before_release"]], // requires a new version/profile, then retry
  ["awaiting_human_qa", ["approved_for_print", "needs_customer_reapproval", "cancelled_before_release"]],
  ["needs_customer_reapproval", ["awaiting_human_qa", "cancelled_before_release"]], // explicit customer consent on a new proof
  ["approved_for_print", ["released_to_partner", "cancelled_before_release"]],
  ["released_to_partner", ["printing", "production_exception"]],
  ["printing", ["printed", "production_exception"]],
  ["printed", ["packed", "production_exception"]],
  ["packed", ["awaiting_dispatch", "production_exception"]],
  ["awaiting_dispatch", ["shipped", "production_exception"]],
  ["shipped", ["delivered", "production_exception"]],
  ["delivered", []],
  ["cancelled_before_release", []], // terminal before release only
  ["production_exception", ["production_exception"]], // staff intervention; recovery is a commercial remedy, not a silent remap
]);

export function canTransitionPlaneE(from: PlaneEState, to: PlaneEState): boolean {
  return canTransition(PLANE_E_GRAPH, from, to);
}

export function isPreReleaseState(state: PlaneEState): boolean {
  return PRE_RELEASE_STATES.includes(state);
}

export function isCancellableBeforeRelease(state: PlaneEState): boolean {
  return isPreReleaseState(state) || state === "approved_for_print";
}

/** Guard for the `approved_for_print -> released_to_partner` transition (doc 04 §Suggested states). */
export interface ReleaseToPartnerContext {
  readonly currentState: PlaneEState;
  readonly medusaPaymentVerifiedNow: boolean;
  readonly compositionAndProfileHashesCurrent: boolean;
  readonly hasBlockingRefund: boolean;
  readonly humanQaDecision: "approved" | "rejected" | "pending";
}
export function canReleaseToPartner(context: ReleaseToPartnerContext): boolean {
  return context.currentState === "approved_for_print"
    && context.medusaPaymentVerifiedNow
    && context.compositionAndProfileHashesCurrent
    && !context.hasBlockingRefund
    && context.humanQaDecision === "approved";
}
