# 16 — Proposed typed API contracts (Next.js BFF, Medusa custom APIs, processing)

All routes are **proposed**; they do not exist yet. Adopt Zod (or equivalent) schemas and OpenAPI generation for stable public contracts. Version `/api/v1` or equivalent; use `application/json`, authenticated cookies protected by CSRF for browser mutation, stable trace ID, `Idempotency-Key` for billable operations, bearer signed service auth for internal endpoints. Every reference to another user's asset returns indistinguishable 404/403 according to API policy.

## Common envelope

Successful API: `{ data: T, requestId: string, contractVersion: 1 }`; failure: `{ error: {code, message, retryable: boolean, detailKey?: string}, requestId: string }` with no provider secrets or internal stack traces. Pagination by opaque cursor. Every billed request accepts/returns `quoteId`, `idempotencyKey`, `state`, `chargeUnits` with contract version.

## Public/guest surfaces

| Route (proposal) | Method | Request | Response | Security |
|---|---|---|---|---|
| `/api/v1/guest/drafts` | POST | draft type, unsigned client UUID | guest capability and draft ID | short TTL, quota, CSRF |
| `/api/v1/assets/upload-intents` | POST | MIME, length, declared purpose | signed upload URL, opaque asset ID | owner/guest scope, byte limit |
| `/api/v1/assets/:id/complete` | POST | upload nonce, hash | status, normalized metadata | validate bytes/rights |
| `/api/v1/compositions/preview` | POST | scene or draft ID, product/zone | short-lived preview ID | no full-res export |
| `/api/v1/catalog/black-oversized-tee` | GET | region/currency | public Medusa product subset | cached, no private inventory leaks |
| `/api/v1/gallery` | GET | filters, cursor | approved public gallery summary | only sanitized assets |

## Authenticated creative surfaces

| Route (proposal) | Method | Purpose |
|---|---|---|
| `/api/v1/me` | GET | central identity profile + Vynvori profile/linked commerce actor safe summary |
| `/api/v1/drafts/migrate` | POST | guest capability + authenticated identity; transfer exactly once |
| `/api/v1/projects` | POST/GET | create/list private DesignProjects |
| `/api/v1/projects/:id/brief` | PATCH | update structured CreativeBrief with optimistic revision |
| `/api/v1/design-generations/quote` | POST | operation, model tier/exact allowed model, input refs → expiring credit quote |
| `/api/v1/design-generations` | POST | quote + idempotency → execution ID and reserved charge state |
| `/api/v1/design-generations/:id` | GET | authoritative async workflow state and permitted artifact links |
| `/api/v1/design-versions/:id/select` | POST | set approved version in project with compare-and-swap |
| `/api/v1/compositions` | POST/GET | save/list owned compositions |
| `/api/v1/compositions/:id/versions` | POST/GET | create new immutable scene snapshot; list |
| `/api/v1/compositions/:id/quote` | POST | size, composition version, zones, destination → signed pricing intent |
| `/api/v1/credits/wallet` | GET | available/reserved unit balances and recent ledger events |
| `/api/v1/credits/quote` | POST | package/operation rate card snapshot |
| `/api/v1/exports/quote` | POST | exact frozen composition, format allowed, cost |
| `/api/v1/exports/:id` | GET | entitlement and owner-signed temporary download link |
| `/api/v1/gallery/publications` | POST | explicit consent to moderated publication |
| `/api/v1/gallery/publications/:id` | DELETE | owner unpublish |
| `/api/v1/gallery/:postId/likes` | POST/DELETE | authenticated like/unlike |

## Medusa integration endpoints

Use Medusa standard SDK routes for product/cart/order where available. Extensions (route names illustrative):

- `/store/vynvori/validated-add-item` validates frozen composition quote and signed ownership context, adds priced personalization item via Medusa workflow.
- `/admin/vynvori/production/:id/approve` authorized staff triggers verified Vynvori QA approval workflow and marks print-release eligibility only after authoritative checks; ideally route in admin extension links to Vynvori services.
- `/internal/vynvori/events` authenticated receipt endpoint for Medusa commerce events; request HMAC/signature and event ID verification, inbox dedupe, then authoritative Medusa fetch.
- `/internal/vynvori/fulfillment-update` trusted service-mediated state sync for actual shipments.

Specific Medusa paths and auth method MUST be validated against pinned version and audited org SSO bridge before authoring route handlers.

## Worker interfaces

`POST /v1/render/print` from Workflow SDK service identity only: `{jobId, compositionVersionId, printProfileId, expectedSourceHashes[], outputVariant, idempotencyKey}`. Response `{state, artifactManifestId, sha256, pxWidth, pxHeight, warnings[], hardErrors[], engineVersion}`. Worker must independently verify source permission and immutable hashes via trusted metadata service; not accept arbitrary URLs.

## Required HTTP semantics

409 for optimistic revision / already settled mismatches, 422 for user-fixable invalid scene, 402/409 for insufficient/changed credit quote, 429 for rate limits, 503 for temporary unavailable qualified model; 200/202 for idempotent accepted async job, not duplicate execution. Long-running API returns job ID and status route rather than holding connection. Error messages do not leak a different user's resource existence.

## Contract tests

Golden OpenAPI snapshots; versioned event JSON fixtures; canonical error mapping; owner/guest auth and role matrix; MIME/size checks; all billable calls idempotent; rejected cart price injection; Medusa round-trip product IDs; no actual external paid provider calls in CI.

## Studio v1.1 API contract additions (v1.1)

The earlier v1.0 `/design-generations/*` and `/design-versions/:id/select` entries are historical conceptual interfaces. For Studio, the versioned project-scoped commands below and in chapter 25 replace them; do not implement a parallel authorization or selection path. Other creative/editor/account surfaces retain their stated independent ownership. All handler names describe unimplemented proposed APIs:

| Endpoint | Purpose / authoritative guard |
|---|---|
| `GET /api/v1/studio/capabilities?region=...` | Return role/region-scoped concept, Standard, Premium, digital, garment rights and current evidence versions; never accept untrusted client eligibility |
| `GET /api/v1/studio/projects/:id/status` | Server-derived `StudioStatusV3` with plan phase, per-slot persisted states, customer credit receipt and allowed *display* actions; ownership mandatory |
| `POST /api/v1/studio/projects/:id/director-plans` | Bounded authenticated free overhead; stable job/ref, no credit charge |
| `POST /api/v1/studio/projects/:id/plan-approval` | Expected brief revision, plan version/hash, three distinct direction IDs; immutable freeze and idempotent approval |
| `GET /api/v1/studio/projects/:id/offers` | Promo and bundle offers separately; all rights and finishing restrictions disclosed before purchase |
| `POST /api/v1/studio/projects/:id/promo/quote` | Verified identity promo eligibility and one direction; zero customer-credit quote |
| `POST /api/v1/studio/projects/:id/promo/authorize` | Identity-level once-only claim; unknown/provider artifacts reconciled rather than blindly renewed |
| `POST /api/v1/studio/projects/:id/bundles/quote` | Exact three approved direction IDs, Standard/eligible downstream rights, pricing + terms snapshot, expiry; viewable with insufficient wallet |
| `POST /api/v1/studio/projects/:id/bundles/authorize` | Fresh quote/idempotency/owner/consent/funds, complete direction mapping; atomic slots+ledger reservation; never auto-run after top-up |
| `POST /api/v1/studio/projects/:id/refinements/:slot/authorize` | Existing package/source branch, slot available/skipped, idempotent operation consent; no duplicate included slot use |
| `POST /api/v1/studio/projects/:id/refinements/:slot/skip` | Set `skipped` only while open; require expected revision |
| `POST /api/v1/studio/projects/:id/refinements/:slot/restore` | Restore skipped slot to available only while open; require expected revision |
| `POST /api/v1/studio/projects/:id/versions/:version/select` | Select completed concept after 3/3 delivery or approved remediation; nonfinancial preference |
| `POST /api/v1/studio/projects/:id/finals/quote` | Source/qualified model/rights, separate final quote and unused slot disclosure |
| `POST /api/v1/studio/projects/:id/finals/authorize` | Fresh explicit consent, ledger hold, closure pending; separate provider execution |
| `POST /api/v1/studio/projects/:id/versions/:version/use` | Selected usable version, not financial approval or print QA |
| `POST /api/v1/studio/projects/:id/cases` | Objective defect, unavailable downstream, unresolved provider or financial dispute; immutable evidence and case ID |
| `GET /api/v1/studio/projects/:id/cases/:caseId` | Customer-safe case status/receipts, no vendor invoice details |

Commands require stable `Idempotency-Key`, expected owner, relevant `expectedRevision`, server-side validated typed schema, `quoteId`/policy+capability snapshot where applicable, and allowed issuer/region. Authenticated purchase and free planning are distinct. Provider submission must occur only after reservation commit; provider idempotency not assumed. HTTP 409 quote stale/plan conflict, 402 insufficient balance, 422 invalid plan scene or rights, 503 capabilities revoked, 202 real pending/unknown. Every status GET is side-effect-free. `allowedActions` is UX-only, never permission grant. See `23` for draft types and runtime validation rules. [F-R01–08,E03–05]

## Phase 6C source-aligned contract correction (UX-C01–C05, proposal)

`QuoteViewV3` is the only proposed customer-visible quote type for promo, 3+2 bundle and Standard/Premium final; no `OfferQuote.v1` payload is an accepted Design 1.1 typed mock contract. Public screen projection is `StudioScreenV1` with server-derived stage, `ConceptCardV1[]`, `CustomerBundleFinancialSummaryV1` and per-operation `PublicOperationV3`/`CustomerLedgerReceiptV1`. Public JSON MUST exclude `ProviderExecutionInternalV1`, vendor invoices, private provider IDs and staff reconciliation notes.

`GET /api/v1/studio/projects/:id/status` is read-only. `POST /api/v1/studio/projects/:id/bundles/authorize` must independently verify owner/issuer, quote signature/expiry, three distinct approved directions, exact quoted downstream uses, current eligible rights/region/model capabilities, all approved mandatory disclosure terms, active price-policy version, consent, idempotency and ledger hold. Any `authorizationHint` from a display read model is advisory, never authorization. Quotes can be inspected with insufficient wallet balances; top-up always requires a new explicit quote confirmation.

`POST /api/v1/studio/projects/:id/versions/:version/use` changes a customer's selected use preference only. It cannot accept/reject a provider charge or bypass supplier QA. Final delivery and settlement are separate server commits/events. `POST /api/v1/studio/projects/:id/cases` opens an evidence-backed quality/support case; it does not auto-issue credits.
