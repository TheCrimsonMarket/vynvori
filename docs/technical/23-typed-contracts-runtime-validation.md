# 23 — Versioned typed and runtime-validated contracts (v1.1)

**Status:** proposal only. Companion review source: [proposed TypeScript reference](reference-contracts/v1.1/vynvori-v1_1-proposed.ts). No deployed API, test fixture or database schema is asserted.

## Contract owner and versioning

- `StudioStatusV3` and the fully discriminated `StudioScreenV1` are **public read models** derived by the authenticated BFF, not authorization grants. The mock contract defines renderable ST-00–17 states, artwork cards, customer-safe bundle receipts, history, optional promo, quote, case and actions. An authoritative server guard always revalidates all mutations.
- `DirectorPlanV1` contains exactly three distinct direction IDs and an immutable plan revision/hash on approval. Unapproved plan status has no concept slots; browser clients must not invent temporary slot IDs.
- `QuoteViewV3` is a discriminated union. `concept_bundle_3x2` quote has exactly three direction IDs and `finalRenderIncludedInThisPurchase=false`, `physicalGarmentIncluded=false`, has an explicitly bound two-use eligibility matrix (each of digital export and garment, including ineligible/excluded statuses), rights/region restrictions, safe wallet breakdown, included/excluded offer contents and non-null approved mandatory disclosure versions for live paid authorization. `final_standard|final_premium` quote has `finalRenderIncludedInThisPurchase=true`; never implies physically printable success.
- `ProviderExecutionInternalV1` carries provider request ID, private costs and invoice evidence in an **internal-only** API. `PublicOperationV3` and `CustomerBundleFinancialSummaryV1` carry customer-safe aggregate/per-slot facts, customer ledger receipt IDs and support states, not vendor-billing evidence; `delivered` is independent of `settled`.
- `RefinementSlotV1` requires project/package/source branch and successful-delivery consumption. `PromoClaimV1` requires unique issuer/subject and uncertainty handling.
- Asset lineage contract distinguishes `customer_original | provider_original | derived_preview | garment_mockup | digital_export | print_master | qa_proof`. Runtime validate rights/region/owner separately for each.

## Runtime validation rules

At all trust boundaries, use server-side Zod or equivalent schemas with strict object parsing, explicit enums, exactly three distinct approved directions, quote expiry and cryptographic quote nonce, plan and capability snapshot agreement, owner and regional rights. Compile-time TS strict mode alone is insufficient. Schema validation for the eventual BFF MUST use strict Zod/equivalent at each trust boundary; proposed mock runtime validators are illustrative and must be expanded to cover every externally supplied fixture before Design Release 1.1 typed acceptance. Never derive a paid CTA from the old `canAuthorizeConceptQuote` helper (removed). A `ServerAuthorizationHintV1` reflects a BFF snapshot for UX only, expires with the quote and is not an authorization grant. Reject unknown/extra fields on financial commands. Cross-system events are versioned and signature/auth validated before inbox persist, then authoritative Medusa fetch. Never treat client `allowedActions` or quoted amounts as authorization.

Key invariants for schema tests:

1. Unapproved plan => `conceptSlots.length===0`; approved bundle => exactly three slots mapped bijectively to approved distinct directions.
2. Quote `offerKind=concept_bundle_3x2` => three mapped directions and current qualified Standard + permitted export/garment use, or disabled authorization.
3. Quote `offerKind=final_standard|final_premium` => one selected source version, model qualification current, explicit separate customer consent.
4. `promo` is free only if verified current one-time identity entitlement, no bundled concept reuse.
5. Provider `outcome_unknown` cannot become customer `settled` by a vendor-charge message alone.
6. `persisted_delivered` requires immutable R2 hash/manifest and correct user/rights; `provider result_received` alone insufficient.
7. Package refinement `skipped` can return to `available` only if open; `closure_pending` forbids silent consumption/forfeiture.
8. Print proof/human approval does not derive from provider qualified final; physical supplier print profile and verified Medusa order required.

## Public error codes (proposed)

`AUTH_REQUIRED`, `SSO_BRIDGE_UNAVAILABLE`, `PLAN_NOT_APPROVED`, `PLAN_STALE`, `QUOTE_STALE`, `INSUFFICIENT_CREDITS`, `CONCEPT_MODEL_UNQUALIFIED`, `STANDARD_FINAL_UNQUALIFIED`, `DOWNSTREAM_USE_UNAVAILABLE`, `RIGHTS_INELIGIBLE`, `PROMO_ALREADY_USED`, `PROVIDER_OUTCOME_UNKNOWN`, `ARTIFACT_PERSISTENCE_UNCONFIRMED`, `PARTIAL_DELIVERY`, `QUALITY_CASE_OPEN`, `REMEDY_REQUIRED`, `PACKAGE_CLOSURE_PENDING`, `INCLUDED_REFINEMENT_UNAVAILABLE`, `DRAFT_EXPIRED`, `CLAIM_CONFLICT`, `PRINT_PROFILE_UNAPPROVED`.

Do not expose `failed_provider_cost_incurred_no_deliverable`, internal invoice IDs, vendor USD charges, private source key, privileged staff notes, bank identifiers. Public `under_review` is suitable for financially uncertain provider operations; customer receipt shows actual wallet amounts.

## Contract evolution/migration

No production API or DB is claimed deployed by Phase6C. Proposed v1.1 replaces informal free-form statuses but cannot be implemented until reviewed API/DB migration generated from the approved schema. For Design Release 1.1, seed typed mock data using runtime schema validation against the reviewed candidate; do not use real checkout/provider network calls. Any discrepancy between design local simulator and signed BFF API should block design tech acceptance.

## Phase 6C corrected public projection requirements (UX-C02–C05)

- `QuoteViewV3` represents `digital_art_export` and `personalized_garment` **individually**, whether eligible, blocked or under review, including per-use region, commercial-rights status, named customer-safe exclusions and terms version. At least one quoted eligible use must remain **that same eligible use** at server authorization. Global capability of a different use is not a substitute.
- `CreditWalletSummaryV1` exposes available, reserved and held-for-review customer units separately, with policy-versioned integer quote units and *no provider cost*. Live paid authorization requires non-null, approved consent, rights, expiry, partial-remedy and (when relevant) refinement-closure terms. It may not invent those values.
- `ServerAuthorizationHintV1` (`canAuthorize`, reason codes, fresh quote snapshot) is **server-derived display guidance only**, including when balance is insufficient. Even an affirmative hint does not grant execution; server checks on mutation are final. An expired/rights-revoked/region-changed/plan-changed quote must never be authorized.
- `StudioScreenV1` discriminates `ST-00`–`ST-17` with screen-specific presentation data. Three concept cards expose persisted preview URLs/alt text, direction/version IDs and individual safe receipts. History shows immutable versions and current entitlement rights; no mock should fabricate a missing asset or slot ID.
- `CustomerBundleFinancialSummaryV1` reports aggregate quoted and actually held/settled/released customer credits and case/receipt refs **alongside** individual `PublicOperationV3` instances. The bundle may be partially delivered while the ledger remains under review; never imply delivery and financial settlement are synchronous.
- Companion editor/account/commerce read models are **distinct future schemas**, not substitutes for Studio; no full ED/AC/CO typed mock acceptance until they are separately specified and runtime validated.
