# 21 — AI Studio and connected screens: v1.1 canonical documentation

**STATUS: PHASE 6C CANONICAL DOCUMENTATION APPLIED LOCALLY; IMPLEMENTATION AND DESIGN RELEASE 1.1 ACCEPTANCE NOT_RUN.** Design Release 1.0 governs visual character (Monumental Atelier, pale commerce/dark Studio/neutral Editor, approved Archivo interface/editorial face, original logo). It does **not** govern app routes, event state, backend request bodies, credit rules or print acceptance. Applicable canonical references: `docs/technical/05-ai-studio-and-agents.md` §User experience/Bounded design workflow; `06-credit-ledger-and-entitlements.md` §Ledger accounting; `07-garment-composition-editor.md` §MVP features; `16-api-contracts.md` §Authenticated creative surfaces; `18-ui-routes-and-state.md` §Main app navigation/UX state machines. Design references: `views/creative.js` (`create`, `prompt`, `results`, `editor`, `garmentReview`); `views/storefront.js` (`bag`, `handoff`); `src/app.js` local router; `src/state.js` fixtures; `docs/USER-FLOWS.md` provisional demonstrations.

## Conventions required of **every** screen

- **Canonical URL** = a proposed Next.js route. Existing Phase 05 hash keys (`#create`, `#prompt`, `#results`, `#editor`, `#bag`) are local demonstration screens, not public routes. In particular multiple `ST-xx` screens are derived substates at the **same** `/studio/projects/[projectId]` URL. A `?stage=` hint, if used for navigational focus, is *not authorization*; server status always wins.
- **Types:** `CreativeBrief.v1`, `DirectorPlan.v1`, `QuoteViewV3`, `StudioStatusV3`, `PublicOperationV3`, `DesignVersion.v1`, `Scene.v1`, `AssetManifest.v1`, `CompositionQuote.v1`, `CommerceStatus.v1`, `ProductionStatus.v1`, `UserCreditSummary.v1` are proposed contracts and require Zod/API version review, not existing deployed schemas.
- **Default display:** initial skeleton, truly empty state, data-bearing state, validation error, access/auth error, optimistic revision conflict, connectivity/retry-safe state, and explicit uncertain **provider/financial** state where applicable. Never paint static output as fresh model generation or pretend an async charge resolved. Wallet states show real whole-unit customer values; internal provider USD cost is not exposed as customer debit.
- **Navigation:** Preserve guest entry provenance (`BYO` vs `Studio`) in a safe, signed/local navigation context. Do not treat `window.history` as sufficient proof of intended route. Every signed-in project deep link validates owner; login return route allowlisted/short-lived. Refresh/reconnect fetches server stage/operation ID, not a new generation. Avoid hidden reruns from back/next.
- **Mobile/a11y:** At 320px and 390px display usable controls and clear stage labels; 768px and desktop follow approved token system. No sticky bar covers CTA or price; numeric fallback for all drags, full keyboard/tab order, field errors announced, logical focus on changing stages, WCAG 2.2 AA-target tests. Reduced motion for progress; no fake progress percentage. Artwork has accessible name/caption. No font/logo redesign.
- **Operations:** Start actions may be subject to `Idempotency-Key`, optimistic `expectedRevision`, `quoteId`, `rightsSnapshotId`. `Cancel` = leave dialog/stop listening unless pre-submission provider cancellation is **confirmed**. Always separate it from a verified financial release.

## AI Studio — stage screen inventory

### ST-00 — Entry / creation mode
- **URL:** `/studio`. **Entry:** any visitor; no account or credits needed just to enter.
- **Visible:** Guide Me and Create Freely as peer choices; independent BYO Upload link; truthful free-preview eligibility as `check on sign-in`, not a promise; sample artwork visibly illustrative if rights not cleared.
- **Primary/secondary:** choose Guide Me / Create Freely; BYO direct; visit Shop. **Back/resume:** return to referrer/home; resume existing owned project only after auth.
- **Data/API:** public feature capability flags; optional `GET /api/v1/studio/config`; no credit mutation. **States:** empty first-visit, unavailable AI creation, informative guest eligibility; no `provider_running` implied.
- **Mobile/accept:** both choices and BYO remain equally discoverable at 320px; `UX-02`, `UX-01`, `R05-A01`.

### ST-01 — Guide Me wizard
- **URL:** `/studio/guide`. **Entry:** guest capability or account, AI Studio mode `guided`.
- **Visible:** progressive choice cards for niche, aesthetic, palette, motif, exact text, reference mood, restrictions and rights; step count, draft-save/expiry status, no charge.
- **Primary/secondary:** next/previous, attach reference, review brief, cancel draft. **Back/resume:** explicit per-step navigation; avoid lost fields; guest source scoped and TTL visible.
- **Data/API:** `CreativeBrief.v1` draft, `POST /api/v1/guest/drafts`, `PATCH /api/v1/projects/:id/brief` after sign-in, upload intents. **States:** validation, upload processing/rejected, offline local draft, conflict, expired claim.
- **Credits/mobile/accept:** `0 credits used` during drafting; thumb-friendly inputs and error summaries; `UX-02`, `UX-16`, `R05-A02`.

### ST-02 — Create Freely prompt-first
- **URL:** `/studio/free`. **Entry:** guest or account draft.
- **Visible:** prompt, optional restrictions/exact phrase/reference source and normalized preview; visible user-owned rights acknowledgement; drafting does not generate artwork.
- **Primary/secondary:** continue to brief, add reference, switch to Guide Me without losing intent. **Back/resume:** return `/studio`; normalized CreativeBrief persists and mode provenance retained.
- **Data/API:** `CreativeBrief.v1` with `entryMode='free'`; same validation schema as ST-01. **States:** empty, invalid/malicious references, upload error, recovery; no fake generator.
- **Credits/mobile/accept:** no credits charged, prompt usable at 320px with keyboard resize; guided/free normalization contract test `UX-02`, `R05-A03`.

### ST-03 — CreativeBrief review and sign-in boundary
- **URL:** `/studio/brief/[draftId]` (guest) or `/studio/projects/[projectId]` (owner). **Entry:** valid draft capability or authenticated ownership.
- **Visible:** structured CreativeBrief details, content/rights risks, draft version, next Director planning step, why verified identity required, guest draft expiry.
- **Primary/secondary:** confirm brief → sign in/plan, edit, save/recover. **Back/resume:** SSO roundtrip with signed allowed return; transfer both brief and uploaded assets only with ownership capability.
- **Data/API:** `CreativeBrief.v1`, `GuestDraft.v1`, identity-bridge status; `POST /api/v1/drafts/migrate` only after SSO audit. **States:** claim busy, expired, already claimed, mismatch, bridge outage, stale edit conflict.
- **Credits/mobile/accept:** no promo consumed for sign-in, no artificial credit prerequisite for BYO; `UX-03`, `UX-16`, `UX-11`, `R05-A04`.

### ST-04 — Creative Director planning
- **URL:** `/studio/projects/[projectId]`, derived `director_planning`. **Entry:** verified central SSO actor, owner brief, valid planner quota and accepted content policy.
- **Visible:** `Preparing three creative directions`, brief summary, nonbillable planning disclosure, action limits/approximate stages without invented time, no rendered image promise.
- **Primary/secondary:** continue viewing, stop viewing/return to project. **Back/resume:** same job ID on reload; no restart from page navigation.
- **Data/API:** `POST /api/v1/studio/projects/:id/director-plans`, `GET /api/v1/studio/projects/:id/status`; `DirectorPlanJob.v1`. **States:** `director_quota_reached` with saved brief and no guessed retry time; moderated input, transient planner error, network pending, plan saved. A quota failure cannot produce an approved plan or imply a provider call.
- **Credits/mobile/accept:** `No artwork credits used` (Director is bounded nonbillable platform overhead); reduced-motion activity region; `R03`, `R05-A05`.

### ST-05 — Three-direction plan review and approval
- **URL:** `/studio/projects/[projectId]`, derived `director_review`. **Entry:** owned `DirectorPlan.v1` with exactly three proposed directions tied to current brief revision.
- **Visible:** 3 direction cards, summary/rationale, per-direction specific visual prompt/refs/rights warnings, explicit explanation **one generated concept per approved direction** per founder-approved F-R01:A; proposed frozen version hash/revision.
- **Primary/secondary:** `Approve these three directions`; revise plan (quota-bound), edit brief. **Back/resume:** revisions create new plan versions; old approved versions preserved; old quote invalidated when editing.
- **Data/API:** ST-05 uses `DirectorPlanProjectionV1(kind=draft|approved)`; draft has `draftPlanId`, brief version, plan revision, exactly three distinct direction cards and **no** plan approval hash/version; approved has immutable `planVersionId`, `approvalHash`, `approvedAt` and frozen directions. `POST /api/v1/studio/projects/:id/plan-approval` requires owner, expected draft/brief revision, approved content hash and idempotency. **States:** fewer-than-three invalid plan, moderation, stale revision, quota error. Neither projection authorizes purchase; concepts slots remain absent until bundle authorization.
- **Credits/mobile/accept:** approving **does not charge**; creates exactly three distinct direction-linked slots only on later bundle authorization; stack cards sequentially at 320px with explicit numbering; `R01`, `R03`, `R05-A06`.

### ST-06 — Offer choice / optional promotional single preview
- **URL:** `/studio/projects/[projectId]`, derived `offer_choice`/`promo_quote`. **Entry:** current approved plan, promo eligibility evaluated against canonical SSO identity.
- **Visible:** separate cards: optional **one free preview** vs paid **3 new paid concepts + up to 2 included refinements**; promo limitations and whether already claimed; exact output counts.
- **Primary/secondary:** choose direction for one promo; continue to paid bundle quote; skip promo. **Back/resume:** return to plan only through new plan version (changes invalidate quotes); no forced promo path.
- **Data/API:** `PromoEligibility.v1`, `QuoteViewV3(offerKind=promo_single_preview)`, `DirectorPlan.v1`. **States:** ineligible, pending unknown promo claim, unavailable model, quota exceeded.
- **Credits/mobile/accept:** promo quote explicitly `0 customer credits`, no full bundle promise; physical print not guaranteed; show distinct concept/qualified Standard/digital export/garment capability and region; `R02`, `R05-A07`.

### ST-07 — Promotional preview processing/review
- **URL:** `/studio/projects/[projectId]`, derived `promo_running`/`promo_review`. **Entry:** user confirmed one-preview offer with identity-bound claim, 1 frozen direction.
- **Visible:** actual operation ID/status; thumbnail after private R2 persistence; watermark/rights/quality qualifiers where required; `Preview, not final print file`.
- **Primary/secondary:** review result; begin paid bundle or save/exit; request support if unknown. **Back/resume:** leave safely; refresh status via same operation; no silent second call.
- **Data/API:** `PublicOperationV3`, `DesignVersion.v1(kind=promo_preview)`, `GET .../status`. **States:** pending, confirmed uncharged fail, public outcome `under_review` (claim held), already redeemed, *promo artifact persistence failure* (do not present an undurable preview as delivered; preserve the identity-bound claim and operation for reconciliation). Never auto reissue a second preview.
- **Credits/mobile/accept:** 0 customer-credit charge shown with customer-safe promo status/receipt; a later paid concept for the same direction is a separate new generation with no promo offset; no Vynvori vendor cost, private provider identifier or invoice appears in UI; portrait cards/responsive zoom; `R02`, `R07`, `R05-A08`.

### ST-08 — Full 3+2 package quote and consent
- **URL:** `/studio/projects/[projectId]`, derived `concept_quote`. **Entry:** approved frozen 3-direction plan and browsable quote eligibility; **no balance prerequisite merely to view**.
- **Visible:** three NEW generated concepts, one per direction; two optional guided refinement uses for this project; final rendering **sold separately**; no garment, digital export, printing or shipping included in the concept quote; max customer credit hold and customer-safe wallet available/reserved/held-for-review summary; quote expiry; a list of eligible AND excluded downstream uses with per-use rights and region restrictions; included/excluded purchases; required approved disclosure/expiry/partial-remedy terms. Customer-facing server eligibility snapshot gives reasons for disabled authorization, never grants permission.
- **Primary/secondary:** `Authorize package`, top up credits via Medusa if supported, decline/return. **Back/resume:** quote invalid on plan/price/rights change; no implicit authorization after top-up.
- **Data/API:** `QuoteViewV3(offerKind=concept_bundle_3x2)` with exact three-direction mapping, `POST /api/v1/studio/projects/:id/bundles/quote`, `POST /api/v1/studio/projects/:id/bundles/authorize` with server-authoritative eligibility and idempotency. **States:** expired/stale quote, insufficient credits, concept route unavailable (disable authorize and preserve plan), route revoked, declined, failed hold. If the concept route becomes unavailable after bundle authorization, retain durable operations/holds, notify and create M8a case; never blind retry.
- **Credits/mobile/accept:** explicit before/after balance and reserved/settled distinction; sticky price summary must not obscure consent; `R02`, `R07`, `UX-05`, `R05-A09`.

### ST-09 — Three-concept generation progress
- **URL:** `/studio/projects/[projectId]`, derived `concepts_running`. **Entry:** committed package authorization and exactly 3 immutable operation slots.
- **Visible:** 3 separately labeled direction/slot cards, actual per-slot states, delivery count, aggregate bundle quoted/held/settled/released/under-review units AND independent per-slot customer receipts, plus expected rights; *no fake countdown/progress percentage*.
- **Primary/secondary:** view details, stop watching/return, support if unresolved. **Back/resume:** polling/reconnect of same 3 operation IDs, never generate on route enter.
- **Data/API:** `StudioScreenV1`/`StudioStatusV3` with three `ConceptCardV1` projections, per-slot safe operation/receipt, and `CustomerBundleFinancialSummaryV1`; `GET /api/v1/studio/projects/:id/status`. **States:** queued/pending, asset-save-in-progress, 1/3 or 2/3 incomplete, provider outcome unknown / customer-safe under-review status, successful all 3.
- **Credits/mobile/accept:** customer holds and settlements displayed without any provider expense; slot labels stable on narrow screens; `R01`, `R07`, `R05-A10`.

### ST-10 — Partial concept completion and resolution
- **URL:** `/studio/projects/[projectId]`, derived `concepts_partial`/`resolution_required`. **Entry:** one or two delivered concepts or unknown/charged/failed slot.
- **Visible:** successful saved concepts clearly **partial** and individually viewable (even at 1/3 or 2/3), missing slot and customer-safe reason category, aggregate customer financial status and independent per-slot receipts, support case reference when needed; regular selection/final progression held until all three outputs or approved remedy.
- **Primary/secondary:** inspect successes, ask for resolution, explicit retry **only after verified zero-charge and approved policy**, leave safely. **Back/resume:** preserve all delivered versions; unknown keeps existing operation ID and blocks another paid attempt.
- **Data/API:** `StudioScreenV1`, `CustomerBundleFinancialSummaryV1`, `ConceptCardV1[3]`, `ReconciliationCase.v1`, `GET /api/v1/studio/operations/:id`; support case endpoint. **States:** partial, `outcome_unknown`, `failed_uncharged`, `under_review`, remedy_required, resolved.
- **Credits/mobile/accept:** package-level `quoted / reserved / settled / released / held_for_review` plus each operation receipt shown separately; no provider billing info; support CTA in primary reading order; `R02`, `R07`, `R05-A11`.

### ST-11 — Three concepts comparison/selection
- **URL:** `/studio/projects/[projectId]`, derived `concepts_review`. **Entry:** 3 distinct immutable deliverable concept versions complete.
- **Visible:** 3 side-by-side or carousel alternatives, each tied to direction and version ID; prompt/rights summary; account save status; available included refinements.
- **Primary/secondary:** select one concept; inspect history; return to read-only plan view. **Back/resume:** selection saved with optimistic revision, not deletion of other concepts.
- **Data/API:** `DesignVersion.v1[3]`, `POST /api/v1/studio/projects/:id/versions/:version/select`. **States:** asset thumb failure, stale selected revision, rights revoked.
- **Credits/mobile/accept:** show bundle payment state if settled; three explicit alternatives in accessible swipe/list navigation, not infinite carousel; `UX-04`, `R01`, `R05-A12`.

### ST-12 — Guided refinement 1
- **URL:** `/studio/projects/[projectId]`, derived `refinement_1`. **Entry:** selected owned concept or saved valid branch; included slot 1 available/skipped and restorable while eligible.
- **Visible:** selected source, structured refinement controls (change/keep/exact typography/constraints), `Included refinement 1 of 2`, `0 additional credits`, uncertainty/cancellation explanation.
- **Primary/secondary:** explicitly confirm Generate, `Skip for now` (or restore previously skipped slot), back to compare; inspect before/after when delivered. **Back/resume:** preserve selected source and slot; unknown locks slot; skip reversible until package closes upon verified final persisted delivery under approved terms; unknown final prevents silent forfeiture.
- **Data/API:** `RefinementIntent.v1`, `POST /api/v1/studio/projects/:id/refinements/1/authorize`, `PublicOperationV3`. **States:** pending, delivered, uncharged fail, unknown/hold, moderation/conflict.
- **Credits/mobile/accept:** no second customer debit; slider/contrast gestures optional with textual fields; `R02`, `R07`, `R05-A13`.

### ST-13 — Guided refinement 2
- **URL:** `/studio/projects/[projectId]`, derived `refinement_2`. **Entry:** selected concept or prior refinement version, slot 2 available/skipped and restorable while eligible (slot1 may have been skipped).
- **Visible:** latest source version, `Included refinement 2 of 2`, exact change/keep prompt, visible slot1 used/skipped state, link to prior history.
- **Primary/secondary:** Generate, Skip or restore while eligible, review/history, continue toward final. **Back/resume:** no duplicate slot use after refresh; include branch-specific source lineage and skipped/used/pending state; preserve lineage, finish with 0, 1 or 2 used slots.
- **Data/API:** `RefinementIntent.v1`, `POST .../refinements/2/authorize`. **States:** same as ST-12 + stale source version.
- **Credits/mobile/accept:** 0 additional credits for included slot, before/after accessible compare; `R02`, `R05-A14`.

### ST-14 — Final readiness / quote
- **URL:** `/studio/projects/[projectId]`, derived `pre_final_review`/`final_quote`. **Entry:** selected approved source version, model qualification checked live against versioned registry.
- **Visible:** current artwork/version, consumed/skipped/refinement slots, clear Standard final eligibility and **separate** exact quote; Premium displayed only if independently proven; supplier printability explicitly separate.
- **Primary/secondary:** authorize final at quoted credits, save and exit, inspect history, return to refine if still allowed. **Back/resume:** invalid quote on source/rights/model change, preserve versions.
- **Data/API:** `FinalAvailability.v1`, `QuoteViewV3(offerKind=final_standard|final_premium)`. **States:** qualified/no qualified route, expired quote, balance insufficient, model revoked, usage quota.
- **Credits/mobile/accept:** show unused-included-refinement forfeiture disclosure BEFORE final confirmation; closure only on successfully persisted final delivery; clear price before consent and pending holds separated; fixed CTA reachable without obscuring quote; `R04`, `R05-A15`.

### ST-15 — Final unavailable / rights-limited existing work
- **URL:** `/studio/projects/[projectId]`, derived `final_unavailable`. **Entry:** `standard.final.available=false` for requested territory/rights/print target; no billable final can start.
- **Visible:** `Final rendering unavailable`, including post-purchase route loss and durable customer notice/support case if applicable; factual qualification reason class, preserved concepts/refinements and rights/quality labels, permitted composer preview and eligible digital export caveats; `Not print-qualified` when applicable.
- **Primary/secondary:** save work, inspect versions, use allowed asset in editor *preview*, subscribe to status/support, leave. **Back/resume:** nothing deleted or auto-purchased; if route revoked after bundle purchase retain entitlements, notify and open operator case with no silent expiry; eligible outputs stay accessible only under actual rights.
- **Data/API:** `FinalAvailability.v1`, `DesignVersion.v1`, `AssetRightsStatus.v1`, `PrintProfileCapability.v1`. **States:** no Standard route, rights limited, model paused, qualification revoked; no generated success overlay.
- **Credits/mobile/accept:** *no final charge or new hold*; textual readiness readable before artwork; `R04`, `R05-A16`.

### ST-16 — Final execution, outcome reconciliation and version choice
- **URL:** `/studio/projects/[projectId]`, derived `final_running`/`final_review`/`resolution_required`. **Entry:** separate final quote consent, valid reservation, qualified route at authorization.
- **Visible:** exact frozen source, provider pending status and credit reserved/settled independently; once stored, final version provenance, rights, quality advisory and separate print qualification. Unknown overlay must not claim job cancelled or artwork delivered.
- **Primary/secondary:** stop viewing, status/support, after verified persistence choose `Use this version`, `Save without using`, `Request another revision` (fresh quote), or `Report a quality problem`; choosing a version cannot change financial settlement or bypass human print QA. **Back/resume:** same op ID; return after navigation, no retry from refresh.
- **Data/API:** `StudioScreenV1`, `PublicOperationV3`, `DesignVersion.v1`, `ReconciliationCase.v1`, `POST /api/v1/studio/projects/:id/versions/:version/use` (nonfinancial choice), `POST /api/v1/studio/projects/:id/cases` (quality case). **States:** queued, pending, verified zero-charge failure, unresolved outcome, remedy review, final persisted, version used, version saved; no `rejected` or `accepted` accounting stage.
- **Credits/mobile/accept:** show `reserved→settled` only after ledger commit; focus management and nonvisual comparison details; `R04`, `R07`, `R05-A17`.

### ST-17 — Project completion/version history/next action
- **URL:** `/studio/projects/[projectId]/history` and `/studio/projects/[projectId]` stage `complete`. **Entry:** authenticated project owner; any saved version exists, completion only with verified persisted final (or alternate eligible work without false complete label).
- **Visible:** immutable version timeline, source → concepts → refinements → finals, rights/quality for each; open independent editor, digital artwork purchase, private/public-gallery submission via separate consent.
- **Primary/secondary:** compose, buy eligible export, keep private, opt in to moderated gallery; compare versions and create a *new* selection/branch. **Back/resume:** stable versions and link; cannot mutate past paid jobs.
- **Data/API:** `GET /api/v1/projects/:id/versions`, `DesignVersion.v1[]`, `AssetManifest.v1`. **States:** no final yet, export unavailable, rights revoked, assets missing/support, partial project.
- **Credits/mobile/accept:** receipts link to wallet; timeline linearized for screen readers and 320px; `UX-04`, `UX-08`, `R05-A18`.

## Connected non-Studio production screens (must exist but not redefine Studio stage machine)

### ED-01 — Independent guest BYO editor entry
- **URL:** `/customize`. **Guard:** none. **Visible:** blank garment Editor, clearly separate from AI; sample fixtures demo-only unless rights cleared; upload PNG/JPEG/WebP, exact text, sides, temporary draft expiry. **Actions:** upload, add layer, switch front/back, edit, review, optional SSO claim. **Back/resume:** return to BYO entry/source, **never** AI results; capability-scoped short-lived draft. **Typed data:** `GuestDraft.v1`, `Scene.v1`, `AssetManifest.v1`; upload intent/complete. **States:** empty, upload pending/rejected, expired, invalid source, quota exceeded, local preview. **Credits:** no AI credits needed. **Mobile/accept:** Canvas/Controls toggle keyboard + touch, numeric position alternate; `UX-01`, `UX-14`, `UX-15`.

### ED-02 — Owned multilayer composition workspace
- **URL:** `/customize/[compositionId]`. **Guard:** owner via verified SSO or valid temporary scoped guest route where supported. **Visible:** per-zone image/text layers, z-order, exact text/font license, numeric mm position/size/rotation, print-zone clipping, undo/redo, autosave revision, rights/status and synthetic vs supplier-approved profile. **Actions:** upload, add/reorder/hide/lock layer, switch zones, draft save, freeze new version. **Back/resume:** optimistic conflict merge/copy, no loss, BYO provenance. **Types:** `CompositionScene.v1`, `CompositionVersion.v1`, `PrintProfile.v1`; `POST /api/v1/compositions`, `POST .../versions`, preview. **States:** missing asset, invalid bounds, stale revision, no profile, pending autosave. **Credits:** free composition; no paywall for edit/preview. **Mobile/accept:** touch/keyboard/numeric parity; `UX-06`, `UX-16`, `UX-18`.

### ED-03 — Composition review / print eligibility
- **URL:** `/customize/[compositionId]/review`. **Guard:** immutable scene version, attached assets and declared garment size/variant; actual checkout needs all gates. **Visible:** proofs vs derived mockup vs print master labels, dimension/quality/rights alerts, one base zone + extra charges, per-market availability, human QA notice. **Actions:** edit, obtain server quote, put in cart if enabled, optionally buy separate composition digital export. **Back/resume:** scene remains frozen for quote; changes produce new version/requote. **Types:** `PrintPreflight.v1`, `CompositionQuote.v1`, `AssetManifest.v1`. **States:** preview-only, profile unapproved, hard print error, quote expired, rights blocked, **proof/version/hash mismatch**. Proof imagery MUST be rendered from the selected immutable `compositionVersionId + sceneHashSha256`, with both preflight and signed cart quote bound to that same exact snapshot/variant/profile; edited draft geometry cannot be displayed as an older frozen proof. Edit → new freeze/revalidate/requote; viewing old proof remains explicit. **Credits:** garment charges from Medusa not wallet debits; qualified redemption may affect quote only. **Mobile/accept:** issue list outside visual canvas; `UX-06`, `UX-07`, `UX-09`, `UX-10`.

### CO-01 — Authoritative cart and checkout
- **URLs:** `/cart`, `/checkout`. **Guard:** Medusa owns cart/variant/validated customization and verified region; signed in before live payment. **Visible:** size, frozen design reference, quantity, added print zones, verified price/tax/duty/shipping rules, actual offer terms and cancellation/return policy. **Actions:** requote, remove, proceed, cancel safely. **Back/resume:** cart token verified; no stored browser price trusted. **Types:** `CompositionQuote.v1`, `MedusaCartV1`, `CommerceStatus.v1`; Medusa SDK + server trusted custom add-item API. **States:** empty, quote expired, region unserviceable, payment declined/unknown, item stale, preorder deferred. **Credits:** only eligible consumption-based redemption under approved cap; AI wallet and garment money separate. **Mobile/accept:** legally required pricing present before button; `UX-09`, `UX-12`.

### AC-01 — Account wallet, orders, exports and saved drafts
- **URLs:** `/account/credits`, `/account/orders/[id]`, `/account/exports`, `/account/projects`. **Guard:** verified SSO owner plus source-audited Medusa bridge. **Visible:** available/reserved/settled wallet, distinct provider-reconciliation case, payments and fulfillment, purchased digital art vs composed-art entitlement, expiring download link, drafts and guest claims. **Actions:** view statement/receipt, request remedy, download entitled artifact, resume own work. **Back/resume:** stable authenticated links; no cross-tenant IDs. **Types:** `UserCreditSummary.v1`, `DigitalEntitlement.v1`, `CommerceStatus.v1`; `/api/v1/credits/wallet`, `/api/v1/exports/:id`, verified Medusa queries. **States:** empty/pending/unknown/reversed/restricted, export artifact not persisted, version/kind mismatch, download URL expired; reload never double grants. Each paid export entitlement binds `artwork_export` or `composition_export`, its exact immutable source version/hash and independently persisted artifact ID/hash; `/account/exports` and download may never resolve `latestVersion`. An unchanged original uploaded file remains retrievable without paid export entitlement. **Credits:** do not label provider expense as customer debit. **Mobile/accept:** balances with semantic labels and readable ledger; `UX-10`, `UX-11`, `UX-17`.

### GA-01 — Public gallery publication
- **URLs:** `/gallery`, `/gallery/[postId]`, `/account/gallery`. **Guard:** public only for moderator-approved derivatives and purpose-bound owner consent; authenticated submit/revoke. **Visible:** original/derivative rights notices, report control and explicit `showcase only` restriction; no remix/other-owner download/retail sale. **Actions:** opt in, submit review, unpublish/revoke, share approved card. **Back/resume:** private state until moderation, revoke cannot be undone by stale cache. **Types:** `GalleryPublication.v1`, `RightsGrant.v1`, approved `AssetDerivative.v1`. **States:** empty, pending moderation, rejected, published, revoked. **Credits:** none. **Mobile/accept:** no public source exposure, keyboard publication dialog; `UX-08`.

### AD-01 — Authorized staff print QA / fulfillment
- **Route:** Medusa Admin extension `/admin/vynvori/*` **illustrative; verify against pinned Medusa version**. **Guard:** central staff actor + least privilege + verified Medusa order capture + approved supplier profile + persisted immutable proof. **Visible:** garment/zone print checks, original/proof/master hash, rights, payment verification, manual QA decision, AU consolidation/US direct shipping status, exceptions. **Actions:** approve, reject, request customer reapproval, release only after approval. **Back/resume:** immutable audit, no reapproval after source change; separate payment and fulfillment histories. **Types:** `ProductionJob.v1`, `QAApproval.v1`, `PrintProfile.v1`, Medusa order refs. **States:** preflight_blocked, awaiting_human_qa, approved_for_print, released_to_partner, production_exception, cancelled_before_release. **Credits:** staff can't adjust AI wallet by manipulating QA. **Mobile/accept:** usable responsive review where safe, but production approval can require stronger device/session verification; `UX-07`, `OPS-02`.

## Screen-state testing matrix (PROPOSED / NOT RUN)

| Fixture class | Screens to inspect | Required demonstration |
|---|---|---|
| Draft/SSO claim expired | ST-01/02/03, ED-01 | Content warning and safe recovery; no cross-owner transfer |
| Three Director directions | ST-04/05 | Exactly three direction cards; whole-plan approval; no image/provider call preapproval |
| Promo eligible/used/unknown | ST-06/07 | One identity promo, visible zero credit, no duplicate after reload |
| Credit insufficient/stale quote | ST-08/14 | Exact quote and user consent; no auto top-up or charge |
| Slot 2/3 unknown after submit | ST-09/10 | Saved outputs remain; reservation held; no blind retry |
| One/both refinements skipped | ST-12/13/14 | Slots optional; disclosed forfeiture condition; no extra debit |
| No qualified Standard | ST-15 | No final or print-ready claim, history/editor preview where legally eligible |
| Provider billed, customer not charged | ST-10/16, AC-01 | Internal USD invoice never shown as customer settlement |
| Layer typography/print hard error | ED-02/03 | Exact text and mm controls; checkout blocked; preflight errors outside canvas |
| Medusa payment captured but QA pending | CO-01, AD-01, AC-01 | `paid` distinct from `approved_for_print`, no partner release |
| Screen reader/keyboard/mobile | All | 320/390/768/1440 widths, short heights, reduced motion, deterministic focus, semantics, no obstructed controls |

**Approval boundary:** Design session may critique layouts, copy and affordances against Design Release 1.0. It cannot silently reduce three concepts, force AI on BYO, add a live print/payment implication, redefine charge semantics or treat fixtures as backend execution evidence. The founder authorized this screen inventory as a local canonical documentation amendment. Design Release 1.1 implementation, commit/push and production activation require separate authorization.


## Consolidated correction history (informational, not overrides)

Founder F-R01–F-R08 and independent reviews E01–E06 and UX-C01–C07 are integrated into the individual ST screen requirements above. No later section supersedes screen-local pricing, visibility, status, command or action language. This chapter is **applied canonical documentation with unimplemented contracts**. The presentation shell is reused across project stages; the ST IDs are server-derived read states, not separate branded routes. Companion type contract: `23-typed-contracts-runtime-validation.md`; route/command registry: `25-route-api-event-domain-matrix.md`.

## Phase 6E targeted recovery and version-binding acceptance (PROPOSED / NOT RUN)

- ST-05: explicitly render `draft` versus `approved` Director plan; no provisional hash named "approved"; stale brief/revision and duplicate approval guards; plan approval never charges or creates concept slots.
- ST-04: on Director quota exhausted, retain brief and an understandable nonbillable recovery state; no fabricated `retry at` deadline.
- ST-07: provider result without verified R2 persistence remains under review; promo claim cannot be consumed or reset merely by page reload.
- ST-08/09: concept route unavailable before purchase disables authorization; loss afterward retains recorded holds/operations, stable IDs and case-based remedy.
- ST-16: final verified uncharged and *customer hold release committed* → public failure receipt linked to `originalPackageId` and authoritative pre-attempt closure: initial final on an open package preserves eligible unused refinements; a separately purchased later revision keeps the original package closed with no original-slot restoration. Unresolved release → `under_review`, no new paid call; prior successful closure remains immutable. Any new paid request needs fresh quote/consent, never auto-resubmission.
- ED-03: after a draft geometry edit, view either the exact prior frozen proof or re-freeze/revalidate/requote; all proof/preflight/quote/cart snapshot hashes match on refresh, browser back and deep link.
- AC-01: purchase export of final v1, create final v2, and confirm entitlement/download still points to v1 artifact; forbid kind/owner/source mismatch; show pending paid export before R2 persistence without file link.
- ED/AC/CO: mock read models must use distinct runtime-validated discriminated schemas, reject unknown fields and unauthorized cross-owner IDs; design browser tests cannot certify server authorization.

## Design Release 1.1 acceptance addendum (PROPOSED / NOT RUN)

- Separate optional `1 free preview` from `3 new concepts + up to 2 optional included refinements`, with a **separately charged qualified final**; accessible plain-language review on ST-06 and ST-08.
- Test 0/3, 1/3, 2/3 and 3/3 persisted cards with combined package-safe wallet display and distinct per-slot receipts, including verified delivery with unsettled customer accounting; no private vendor invoice fields.
- Test disabled bundle authorization when qualified final or all downstream uses unavailable, expired/changed quote after top-up, and mismatch between signed quote and current user region/rights; viewable quote does not guarantee purchase.
- Test skipped refinement, restoration, unknown operation, pending final closure, documented forfeiture before final confirmation, and objective quality report without a false refund promise.
- At 320×480, 390×568, 390×844, 200% text and on-screen keyboard: retain visible prices, exclusions, availability and actions; require keyboard accessible list comparisons, reduced motion, and stable live-region announcements only on meaningful state transitions.
- Fixture/test evidence is `NOT_RUN` until demonstrated. Phase 05 browser tests are **visual release evidence only**.
