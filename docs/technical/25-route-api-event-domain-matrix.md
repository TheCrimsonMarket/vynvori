# 25 — Routes → API and owners → events/records matrix (v1.1 canonical documentation; interfaces proposed)

**All endpoint routes and types in this file are proposed, not verified existing endpoints.** Authority references: canonical `docs/technical/16-api-contracts.md` §Common envelope/Public/Authenticated/Medusa integration; `04-domain-database-model.md` §Core entities; `09-medusa-commerce-integration.md` §Trusted cart API; `10-cross-system-events.md` §Event envelope; `18-ui-routes-and-state.md` §Public routes. Phase 05 `src/app.js` uses hash-based demo navigation: neither its hash keys nor `src/state.js` define API shapes.

## A. Canonical route registry and domain mapping

| Surface/Screen IDs | Next.js public URL / staff surface | BFF endpoint candidates (v1) | Authority/records/events |
|---|---|---|---|
| ST-00 | `/studio` | `GET /api/v1/studio/config` | Vynvori versioned feature/model availability config (Neon); no provider events |
| ST-01 / ST-02 | `/studio/guide`, `/studio/free` | `POST /api/v1/guest/drafts`; `PATCH /api/v1/projects/:id/brief`; `POST /api/v1/assets/upload-intents` | `guest_sessions`, `creative_briefs` (Neon), original R2 asset; `brief.updated.v1` internal |
| ST-03 | `/studio/brief/[draftId]`, `/studio/projects/[projectId]` | `POST /api/v1/drafts/migrate`, `GET .../status`; SSO callback **TBD** | Canonical issuer+subject in SSO; Neon `user_profiles`, `guest_sessions`; verified Medusa customer only after M1b; `guest.claimed.v1` |
| ST-04/05 | `/studio/projects/[projectId]` | `POST /api/v1/studio/projects/:id/director-plans`, `POST .../plan-approval`, `GET .../status` | Neon `director_plan_versions`, `creative_briefs`, `design_projects`; `studio.director_plan_created.v1`, `studio.director_plan_approved.v1` |
| ST-06/07 | same project URL | `GET /api/v1/studio/promo-eligibility`, `POST /api/v1/studio/projects/:id/promo/quote`, `POST .../promo/authorize`, `GET .../status` | Neon promo claim unique identity+offer, `model_executions`, `assets`, `design_versions`; `studio.promo_claim_reserved/delivered/released.v1` (uncertain claims remain held pending reconciliation) |
| ST-08 | same project URL | `POST /api/v1/studio/projects/:id/bundles/quote`, `POST .../bundles/authorize` | Neon `studio_quotes`, `credit_reservations`, `studio_packages`, `concept_slots`, outbox; `studio.bundle_authorized.v1` |
| ST-09/10 | same project URL | `GET /api/v1/studio/projects/:id/status`, `GET /api/v1/studio/operations/:id`, `POST /api/v1/support/cases` | Neon `model_executions`, `assets`, `reconciliation_cases`, ledger; `provider.execution_submitted/completed/unknown/reconciled.v1`, `credit.operation_settled/released/held.v1` (internal projections) |
| ST-11 | same project URL | `POST /api/v1/studio/projects/:id/versions/:version/select` | Neon `design_versions`, `design_projects`; `studio.selection.updated.v1` |
| ST-12/13 | same project URL | `POST /api/v1/studio/projects/:id/refinements/:slot/authorize`, `POST .../refinements/:slot/skip`, `GET .../status` | Neon `refinement_slots`, `design_versions`, `model_executions`; `studio.refinement_delivered/skipped.v1` |
| ST-14/15 | same project URL | `GET /api/v1/studio/projects/:id/final-availability`, `POST /api/v1/studio/projects/:id/finals/quote` | Qualified model registry + rights/print snapshot; `model_qualification_versions`, quote; **no provider call** when unavailable |
| ST-16 | same project URL | `POST /api/v1/studio/projects/:id/finals/authorize`, `POST /api/v1/studio/projects/:id/versions/:version/use`, `POST .../cases`, `GET .../status` | Neon provider execution, immutable `assets`, `design_versions`, ledger; `studio.final_delivered.v1` and nonfinancial `studio.version_used.v1` |
| ST-17 | `/studio/projects/[projectId]/history` | `GET /api/v1/projects/:id/versions`, `GET /api/v1/assets/:id/authorized-manifest` | Neon project/version lineage and rights; owner-signed R2 access only |
| ED-01 | `/customize` | `POST /api/v1/guest/drafts`, `POST /api/v1/assets/upload-intents` | Independent guest capability, Neon/R2 owner lineage; **no AI/credit prerequisite** |
| ED-02 | `/customize/[compositionId]` | `POST/GET /api/v1/compositions`, `POST /api/v1/compositions/:id/versions`, `POST /api/v1/compositions/preview` | Neon `compositions`, `composition_versions`, private R2 originals/derived previews; `composition.version_frozen.v1` |
| ED-03 | `/customize/[compositionId]/review` | `GET /api/v1/compositions/:id/review?versionId=...`, `POST /api/v1/compositions/:id/quote`, `GET .../preflight` (**proposed**) | Neon immutable `{versionId, sceneSha, variant, profile}` binds proof + validation + signed quote; Medusa custom cart line must revalidate identical snapshot, `composition.preflight_completed.v1` |
| CO-01 | `/cart`, `/checkout` | Medusa standard SDK plus verified custom `POST /store/vynvori/validated-add-item` (**illustrative**) | Dedicated Medusa variants, cart, pricing, order, capture, refund, shipping; verified event relay to Neon: `commerce.payment_captured.v1`, `.refunded.v1` |
| AC-01 | `/account/credits`, `/account/orders/[id]`, `/account/exports`, `/account/projects` | `GET /api/v1/credits/wallet`, `GET /api/v1/account/exports`, `GET /api/v1/exports/:entitlementId`, verified Medusa customer/order APIs (**proposed**) | Central SSO actor; Neon immutable `kind + sourceVersionId/hash + artifactId/hash` entitlements and credits; verified Medusa capture/financial truth; no latest-version lookup or public original asset keys |
| GA-01 | `/gallery`, `/gallery/[postId]`, `/account/gallery` | `GET /api/v1/gallery`, `POST /api/v1/gallery/publications`, `DELETE .../:id` | Neon signed purpose-specific `rights_grants`, moderation, sanitized R2 derivatives; `gallery.permission_granted/revoked.v1` (moderation/publication notifications require separate reviewed schemas) |
| AD-01 | Medusa Admin route `/admin/vynvori/*` (verify actual extension route) | Verified Medusa Admin extension + trusted Vynvori `POST /api/v1/production/:id/qa-decisions` | Medusa order/fulfillment; Neon QA, print checks, Cloud Run/R2 masters, audit; `production.qa_decision.v1`, `production.partner_release.v1` |

ST-05 is a single project route with a `draft|approved` public plan discriminator; plan approval creates an immutable record only after revision/ownership checks. ST-04, ST-07, ST-08/09 and ST-16 recovery projections are read-only server-derived statuses, **not route-entry triggers** or billable retries. ED-01 guest BYO remains independent of Studio and credits. ED-03 review and Medusa cart must use the same frozen snapshot identity. AC-01 export lookup is entitlement-bound, never newest project version. No real network handlers exist by virtue of adding this registry.

Record names refer to the representative entity catalog in chapter 04. Capability qualification and reconciliation/support records are conceptual module contracts until their exact schemas are reviewed. Section C controls event spellings for its listed transitions; other signals above require separately reviewed versioned event schemas. Slash-separated event suffixes abbreviate separate events and are not literal wire names.

### Navigation and indexing

- `/create`→`/studio`, `/editor`→`/customize`, `/bag`→`/cart` **only if those paths have real external traffic** and after provenance-aware behavior tests. A local Phase 05 hash is *not* evidence a public 301 is required. Canonical route registry should be held centrally (suggest `route-registry.v1`) and reflected in design mocks, Next.js navigation, tests and sitemap.
- Product/catalog `/products/[handle]`, `/collections/gaming`, public gallery only have crawlable SEO content after legitimate pricing/asset rights and privacy approval. Private project, guest draft, checkout, wallet, upload, callback and staff URLs `noindex`/unauthorized responses.
- For unauthenticated private screens, allowlisted server-bound `returnTo` carries only non-secret link context through SSO; Medusa auth bridge path may not be invented before Lucky source inspection.

## B. Contract envelopes and command invariants

Proposed uniform response success `{data:T, requestId:string, contractVersion:1}`, error `{error:{code:string,message:string,retryable:boolean,detailKey?:string},requestId:string}`; financial commands require authenticated actor, `Idempotency-Key`, `expectedRevision` and frozen `quoteId`, `consentId` and appropriate `rightsSnapshotId`. Identity is from **validated central SSO session**, not user-supplied body. All sensitive internal calls signed; no browser-shipped Medusa admin credentials.

Typed error vocabulary (candidate): `AUTH_REQUIRED`, `GUEST_CLAIM_EXPIRED`, `STALE_BRIEF_REVISION`, `PLAN_NOT_APPROVED`, `QUOTA_EXCEEDED`, `RIGHTS_BLOCKED`, `PROMO_INELIGIBLE`, `QUOTE_EXPIRED`, `INSUFFICIENT_CREDITS`, `QUALIFIED_MODEL_UNAVAILABLE`, `PROVIDER_OUTCOME_UNKNOWN`, `PARTIAL_DELIVERY`, `REMEDY_REQUIRED`, `COMPOSITION_INVALID`, `PRINT_PROFILE_UNAPPROVED`, `COMMERCE_REGION_UNAVAILABLE`, `MEDUSA_PAYMENT_NOT_VERIFIED`. HTTP codes are policy-mapped in the validated OpenAPI contract; responses must not leak other owners' resource existence.

## C. Event and record ownership; exactly-once **business effect**, not exactly-once transport

| Business transition | Evidence + event proposal | Transactional system of record | Protection |
|---|---|---|---|
| Director approval | `studio.director_plan_approved.v1`, plan version/hash | Neon | CAS expected revision, frozen brief reference; no paid action |
| Promo single preview claim | `studio.promo_claim_reserved/delivered/released.v1` | Neon unique identity+promotion | No duplicate devices/session claims; unknown held |
| Package 3+2 consent | `studio.bundle_authorized.v1` | Neon reservation/entitlement and outbox | Quote snapshot, unique consent, idempotency and atomic funds guard |
| Each direction concept delivered | `studio.concept_slot_delivered.v1` | Neon asset/version/slot plus R2 evidence | `UNIQUE(bundle_id,slot_index)` entitlement; provider attempt may be multiple only if verified uncharged |
| Provider event | `provider.execution_submitted/completed/unknown/reconciled.v1` | Neon immutable provider evidence and hash | Post-timeout no new POST unless documented provider idempotency/proven zero-charge |
| Customer credit settle/release | `credit.operation_settled/released/held.v1` | Neon wallet ACID ledger | Unique causal key; provider invoice is not settlement authority |
| Full design/comp version | `studio.version_used.v1` (customer preference only), `studio.final_delivered.v1` (persistence) and `composition.version_frozen.v1` | Neon + private R2 manifest | Frozen source hash; new edit becomes new version |
| Medusa credit top-up or export order | `commerce.payment_captured.v1` received, **re-fetch and verify** | Medusa capture; Neon derived entitlement once | Inbox dedupe+signed event+Medusa authoritative fetch+unique line item |
| Personalized garment order | `commerce.order_paid_verified.v1` | Medusa payment/order; Neon production projection | Only after verified payment and frozen composition quote; no QA shortcut |
| Human QA decision | `production.qa_decision.v1`, `production.partner_release.v1` | Neon QA record, Medusa release/fulfillment | Verified human role and immutable proof/profile hash; release cannot race reapproval |
| Public gallery permission | `gallery.permission_granted/revoked.v1` | Neon owner/consent/moderation | Never expose source R2 bucket; revoke cached derivative where required |

## D. Asset/rights/physical lineage independent of Studio purchase

`OriginalAsset.v1` (private owner, hash, rights attestations) → `DerivedPreview.v1` (never a paid source master) → `DesignVersion.v1` (provider operation + original hash/source lineage) → `CompositionScene.v1` (image/text/shape layers in real mm coordinates) → `FrozenCompositionVersion.v1` (garment variant/zone profile IDs, all source SHA256) → `PreviewProof.v1` (derived mockup, not master) → `PrintMaster.v1` (only after confirmed technical preflight, supplier-approved print profile and Cloud Run deterministic renderer) → `QAApproval.v1` (human actor, proof hash, timestamp) → `PartnerRelease.v1` (separately authorized). Asset names do not prove source license, vendor acceptance or ownership. Store originals unmodified; own-source retrieval free; do not confuse composed digital high-resolution exports with internal manufacturing print masters.

## E. Reconciliation/cancellation signals to UI

`credits reserved` ≠ `provider pending` ≠ `partial result` ≠ `customer charge settled` ≠ `reconciliation hold` ≠ `customer remedy required`. A paid provider timeout may be followed by delivery or a cost invoice even after browser leaves. Asynchronously update UI via polling/subscription to the original operation. Safe retry requires **specific verified uncharged outcome** and a new explicit user action or documented provider idempotency; general workflow retry is not authorization for a second billable POST. Any hold escalation/auto-resolution waits for approved numeric SLA.

## F. API contract acceptance scenarios (NOT RUN)

- `API-R2-01`: unauthorized caller cannot read another user's project or return their resource ID.
- `API-R2-02`: two devices approving plan revisions yield exactly one accepted hash; other returns revision conflict.
- `API-R2-03`: simultaneous promo requests use one identity-bound offer, not two previews.
- `API-R2-04`: three concept slot assignments map one-to-one to three approved direction IDs.
- `API-R2-05`: customer wallet reservation survives an API crash and can resume without duplicate charge.
- `API-R2-06`: Medusa event duplicated/out of order never duplicates credits or production jobs.
- `API-R2-07`: expiry/revocation of qualified model prevents new final quote and preserves existing versions.
- `API-R2-08`: a different owner cannot attach composition to Medusa cart by ID.
- `API-R2-09`: payment captured + failed print profile never releases a production job.
- `API-R2-10`: no EU shipping quote or promise appears by default; authorized US/AU only when verified.


## Phase 6C canonicalization notes (founder-approved v1.1 documentation)

Routes from the approved proposal must agree with `18-ui-routes-and-state.md` and `21-studio-ux-screen-contract.md`. Server-derived stages ST-04–17 resolve under `/studio/projects/[projectId]`; raw Phase05 hash keys are noncanonical. Any earlier matrix route that conflicts with `/studio/guide`, `/studio/free`, `/studio/brief/[draftId]`, `/customize`, `/customize/[compositionId]`, `/cart`, `/checkout` or owner project routes is superseded. Each mutation requires session/capability owner, revision, idempotency, and signed quote where applicable. Studio 3+2 authorization requires current region rights + qualified Standard + at least one downstream use. Customer UI sees sanitized `PublicOperationV3`, not provider vendor billing. Medusa remains commerce source and Neon creative/credits/QA source; 5 state-plane registry in `22` controls events. A purchased bundle can't progress to regular final if <3 persisted slots without approved operational remediation. Verified human QA remains preprint gate. No EU delivery promises.

## G. Single route, stage, command registry — amended proposal UX-C07

**Canonical stage route:** ST-04…ST-17 share `/studio/projects/[projectId]`; stage and screen ID derive from authenticated `StudioScreenV1`, never client `?stage` authorization. ST-00 `/studio`, ST-01 `/studio/guide`, ST-02 `/studio/free`, ST-03 `/studio/brief/[draftId]` guest, or owner project URL. BYO entry `/customize` works as guest without AI or credits; saved composition `/customize/[compositionId]` and review `/customize/[compositionId]/review`. Preserve signed allowlisted `returnTo` and BYO/Studio provenance; never derive canonical navigation from prototype hashes.

`/studio/projects/[projectId]/history` is the read-only owner history child route specified by ST-17; it does not create a separate execution stage or start generation.

| Stage | Typed read model | Command or endpoint (candidate, not deployed) | Owner |
|---|---|---|---|
| ST-05 | `StudioScreenV1`/`DirectorPlanV1` | `POST /api/v1/studio/projects/:id/plan-approval` | Neon Director plan |
| ST-06/07 | `StudioScreenV1`/`QuoteViewV3(promo_single_preview)` | `POST .../promo/quote`; `POST .../promo/authorize` | Neon identity-bound promo |
| ST-08 | `StudioScreenV1`/`QuoteViewV3(concept_bundle_3x2)` | `POST .../bundles/quote`; `POST .../bundles/authorize` | Neon rights, quote, ledger |
| ST-09/10/11 | `StudioScreenV1`/`ConceptCardV1[3]`/`CustomerBundleFinancialSummaryV1` | `GET .../status`; `POST .../versions/:version/select` | Neon, public projection only |
| ST-12/13 | `StudioScreenV1`/`RefinementSlotV1` | `POST .../refinements/:slot/(skip|restore|authorize)` with revision guard; restore is reversible only while package remains open | Neon package entitlement |
| ST-14/15 | `StudioScreenV1`/`QuoteViewV3(final_*)` | `POST .../finals/quote`; `POST .../finals/authorize` | Neon quote/ledger |
| ST-16/17 | `StudioScreenV1`/`PublicOperationV3`/history | `POST .../versions/:version/use`, `POST .../cases`, `GET .../status` | Neon version preference, cases and ledger independent |
| ED-01/02/03 | Editor domain read model (separate typed schema required before mocks) | `/api/v1/compositions/*` and scoped guest asset capabilities | Neon scene / R2 originals |
| AC-01 | Account domain read model (separate typed schema required before mocks) | `/api/v1/credits/wallet` etc | Neon credits + verified Medusa order links |
| CO-01 | Commerce domain read model (separate typed schema required before mocks) | Medusa SDK + trusted personalized add-to-cart | Medusa |

There is **no** `final-acceptance` endpoint or financial `studio.final_accepted` event (retired term). Customer `use_version` is an independent nonfinancial preference. Final asset persistence, customer credit settlement and supplier human QA are separately owned events. Admin extension URLs and central-SSO callbacks remain illustrative until version/source audit. `allowedActions` and client quote hints do not grant mutations; BFF revalidates all business predicates at execution.
