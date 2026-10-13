# 16 — Proposed typed API contracts (Next.js BFF, Medusa custom APIs, processing)

All routes are **proposed**; they do not exist yet. Adopt Zod (or equivalent) schemas and OpenAPI generation for stable public contracts. Version `/api/v1` or equivalent; use `application/json`, authenticated cookies protected by CSRF for browser mutation, stable trace ID, `Idempotency-Key` for billable operations, bearer signed service auth for internal endpoints. Every reference to another user's asset returns indistinguishable 404/403 according to API policy.

## Common envelope

Successful API: `{ data: T, requestId: string }`; failure: `{ error: {code, message, retryable?, detailKey?}, requestId }` with no provider secrets or internal stack traces. Pagination by opaque cursor. Every billed request accepts/returns `quoteId`, `idempotencyKey`, `state`, `chargeUnits` with contract version.

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
