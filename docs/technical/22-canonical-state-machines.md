# 22 — Canonical separately owned state machines (v1.1)

**Canonical documentation applied locally; state machines remain unimplemented.** UI stage is a derived projection. Backend modules cannot mutate a different domain's state directly. This document supersedes conflicting job-state lists in v1.0 docs 04/08/11 under the founder-authorized local v1.1 documentation application.

## Plane A — Customer-facing Studio project / stage (Neon server-derived view)

`brief_draft → brief_ready → director_planning → director_review → plan_approved → offer_choice → [promo_quote → promo_pending → promo_review] → bundle_quote → bundle_authorized → concepts_running → concepts_partial | concepts_ready → selected_concept → refinements_open → final_quote | final_unavailable → final_pending | final_under_review → final_delivered → project_next_action`.

- `Guide Me` and `Create Freely` converge to one versioned `CreativeBrief`. Bounded Director is nonbillable and cannot guarantee a paid eligible downstream path.
- `director_review → plan_approved` requires owner revision check, exactly three distinct direction IDs, immutable approved plan hash. Public ST-05 is a separate `draft|approved` projection; a draft has no plan hash/approved ID. Before and immediately after approval (before bundle authorization), concept-slot array is **empty**.
- Promo is one separately claimed verified identity entitlement and its generated output does **not** count toward purchased 3+2.
- `bundle_quote → bundle_authorized` checks authenticated verified customer, server rights/region, qualified Standard and at least one downstream digital/garment use, exactly three distinct direction IDs, current policy/offer version, money and explicit reconfirmation. Inspecting quote does not require wallet balance.
- `concepts_partial` preserves 0/3–2/3 durable versions with visible cards, but blocks normal concept-selection/final advancement until 3/3 valid outputs or an operator-approved remediation.
- `refinements_open` offers 0–2 optional slots; `skipped` reversible while package open; `pending|unknown` locked. Each delivered included refinement binds to original source branch/plan and consumes exactly one slot. No general cross-plan portability.
- Final authorization is a **separate quote**. Warn that successful delivered final will close unused included slots. `final_pending` does not forfeit on submission; `final_under_review` freezes expiry/unused slots for unknown results. `final_delivered` closes only upon verified artifact persistence and disclosed rules, independent of customer selecting/liking final.
- Final selection actions are `use|save|quote_new_revision|report_quality`; financial ledger remains independent. Qualified final model ≠ approved print master.
- If Standard or downstream rights are revoked after package purchased, hold expiry, preserve assets/entitlements, notify, create M8a case and seek consented equivalent or approved remedy.

## Plane B — Provider operation / artifact persistence (Neon + durable workflow, internal)

| Current | Next / guard |
|---|---|
| `prepared` | `submitted` only once after durable customer/promo authorization and recorded stable operation intent |
| `submitted` | `running | result_received | verified_zero_charge_failure | outcome_unknown`; record provider request ID immediately when available |
| `running` | `result_received | verified_zero_charge_failure | outcome_unknown` |
| `result_received` | `artifact_persisting` after checksum/MIME validation; provider response alone ≠ customer delivery |
| `artifact_persisting` | `persisted_delivered | persistence_failed_under_review` based on verified R2 original bytes + immutable manifest |
| `outcome_unknown`, `persistence_failed_under_review` | `reconciled_delivered | reconciled_uncharged_failure | operator_case` **only** from authoritative evidence |
| `verified_zero_charge_failure` | authorized safe retry *only* with new explicit policy/consent; don't reuse charged/unknown attempt |

Additional required recovery projections: verified-zero-charge **final** failure must carry the `originalPackageId` and authoritative **pre-attempt** original package closure state. For first final attempted on an `open` package, authoritative verified-uncharged failure + committed ACID release returns to `open`, preserving still-eligible unused refinements. For a separately purchased revision attempted after a previously delivered final on a `closed` package, original closure remains `closed`; any case-bound remedy is a new entitlement/refund/ledger adjustment, never original-slot restoration. The failure read model includes the customer-safe release receipt, not vendor evidence. Until verified release commits show `under_review` and do not project successful recovery. Promo provider result that fails R2 persistence stays claim/operation `under_review`; no second identity-bound free claim from a reload. Director quota exhaustion leaves saved brief with no approved plan, while concept-route unavailability blocks package authorization before purchase and creates durable case/reconciliation after purchase. These are public-safe projections, not new vendor state or reimbursement policies.

Store separate internal `vendor_cost_evidence` (usage/invoice/unknown) not projected to public. A provider can charge Vynvori while customer ledger remains reserved/under review. Never blindly repeat potentially billable POST after timeout. Verify durable artifacts before marking a customer deliverable.

## Plane C — Customer credits, package and promo entitlement (Neon ACID ledger)

Customer command: `quote_visible → authorization_requested → reserved → settled | released | reconciliation_hold → operator_remedy`. `reserved` is not `settled`. A provider invoice/actual USD expense **cannot** settle customer charge without the authorized quoted service delivery or specifically approved remedy contract. Reconciliation hold cannot autoexpire/release/settle absent approved policy.

Bundle: `quoted → authorized → partial | delivered_3_of_3 → open_for_refinements → closure_pending → closed | remedy_pending`. No automatic completion for 2/3. Unknown final maintains `closure_pending`, unused refinements held; successful persisted final permits `closed` and unused slots forfeited under prior disclosure. If no final ever bought, no invented clock-based expiry; approved versioned commercial terms required before live billing. Promo: `eligible → claim_reserved → consumed | verified_uncharged_failure | claim_unknown`; unique issuer+subject, cross-device race safe; paid new concept never recycles promo bytes/slot.

Customer financial projection exposes `{availableUnits, reservedUnits, settledUnitsForOperation, releasedUnitsForOperation, receiptId, quoteId, operationId}` and `under_review` where appropriate. Vendor invoice, retry-cost allocation and private provider error status are never included in customer response.

## Plane D — Independent Garment Editor / version and lineage (Neon/R2)

`guest_draft → editable_scene → saved_owned → frozen_version → composition_quoted → cart_linked → ordered_snapshot`.

- Anonymous BYO stays free of Studio/AI credits; guest drafts can be claimed only by owning scoped capability + verified identity. Expired or conflicting claims fail closed.
- Each scene revision references immutable original/image assets, layer IDs/z-order, exact text/font/license versions, zone physical mm geometry and original SHA hashes. A frozen review proof, preflight report and cart quote all reference the *same* immutable composition version and content hash; draft edits invalidate any attempt to quote them under the prior freeze. Zone switch preserves independent layer arrays.
- `frozen_version` never mutates after a quote/order. Editing creates next version/new quote; no implicit amendment to old Medusa cart line. Public mockup/preview and private print master are distinct artifacts.
- Digital export needs separate paid entitlement (other than retrieving unchanged uploaded original). `artwork_export` is keyed to one immutable generated artwork version and `composition_export` to one frozen composition version, each also bound to exact exported R2 artifact ID/SHA256 and rights policy. A newer source version cannot be retrieved through an older grant; export rights ≠ public-gallery publishing or physical commercial reproduction.

## Plane E — Production QA / fulfillment (Neon + Medusa)

Medusa owns money, product variant/inventory, cart/order/fulfillment/tracking. Neon production state machine only begins from authoritative verified paid order and frozen composition/profile:

`pending_asset_verification → preflight_pending → awaiting_human_qa → approved_for_print → released_to_partner → printing → printed → packed → awaiting_dispatch → shipped → delivered`.

Interruption states: `preflight_blocked` (from preflight pending, requires new version/profile + retry); `needs_customer_reapproval` (from human QA, material new proof and explicit customer consent); `production_exception` (staff intervention); `cancelled_before_release` (terminal before release). Only authorized staff with exact proof/profile/hash and current Medusa captured payment may approve. Before actual partner release, revalidate payment/refunds/rights/hash and approved profile. Provider completion, renderer success and partner ack are not QA.

| Previous labels in v1.0 | Canonical owner/meaning |
|---|---|
| `waiting_payment`, `awaiting_payment`, `paid_verified`, `refunded` | Medusa commerce payment/refund, never Neon production state |
| `qa_pending`, `awaiting_qa` | `awaiting_human_qa` |
| `preflight_failed`, `needs_fix` | `preflight_blocked` before QA, otherwise `production_exception` |
| `customer_reapproval`, `needs_customer_approval` | `needs_customer_reapproval` |
| `qa_approved` | `approved_for_print` + append-only staff decision |
| `released`, `released_to_print` | `released_to_partner` |
| `printer_ack`, `inspected` | Evidence/event, not job state |
| `dispatched`, `handed_to_carrier` | `shipped` only with valid carrier evidence and Medusa reconciliation |
| `cancelled` after release | `production_exception` + commercial remedy, not falsified pre-release cancellation |

This is a proposal to normalize *future* initial state schema; there is no evidence of existing live production rows requiring data migration. Future discovery of persisted rows requires mapping migration and rollback planning, not silent remap.

## Global cancel, recover, reconcile policy

Navigation back/pause/closing tab **never** cancels a provider request or releases customer credit by itself. User-initiated cancellation of unpaid draft may be immediate; paid provider/partner cancellation is confirmed only with authoritative verified evidence and approved published terms. M8a durable case IDs and customer notifications are prerequisites for live billable AI. Numeric maximum hold and remedy/response service levels must be approved by founder/operations before charging.

### Post-closure remedy authority (F-R04 Option A / C-03)

Founder policy is **APPROVED**; live remedy issuance remains **BLOCKED** pending operational terms. Closed original packages and refinement history are immutable. Split internal audited `InternalRemedyAuthorizationCommandV1` and `RemedyExecutionInternalV1` from externally projected `CustomerRemedyStatusV1`. Enforce unique `(caseId, remedyDecisionId)` and `(scope, idempotencyKey)`, payload-consistent replay and at-most-one compensating effect per approved decision; external Medusa refund and Neon credit/replacement transactions must use linked idempotency and reconciliation. Provider invoices, private refund IDs, staff actor IDs and authorization evidence never appear in the customer view.
