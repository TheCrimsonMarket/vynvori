# ADR 0012 — web authentication boundary

2026-10-19. Local implementation; production features default OFF. No staging project, credentials, database role/grants, registration, domain or deployment changed.

## Decision

Reuse the audited LuckyLittleDevil server-side OAuth pattern with full-page navigation and VYNVORI-owned durable state. The web application imports the existing commerce/creative workspaces through server-only entrypoints. It issues only an opaque session secret to the browser, in a host-only Secure/HttpOnly/Lax cookie. Central tokens and PKCE verifiers remain encrypted server-side. The callback uses browser-bound state and atomically consumed transactions, not cookie clearing alone, for replay prevention.

`authHttpHandlers` is the shared Request/Response boundary used by eight thin Node Next route wrappers. POST operations require exact origin, a matching random double-submit CSRF token and cookie, and same-origin Fetch Metadata when supplied. The CSRF cookie is host-only Secure/HttpOnly/Strict; the token is delivered by an uncached same-origin JSON response. Bodies are bounded to 2 KiB with a three-second read deadline, methods/paths are fixed, caller identity/grant fields are rejected and duplicate credential cookies fail closed. Callback GET permits the required cross-site OAuth navigation but validates exact host/path, unique query fields and persisted state/browser binding. All callback outcomes clear the temporary browser cookie; no upstream error description is reflected.

The authenticated status response contains only a boolean. Internal user/customer mappings, central credentials and session identifiers are omitted. Responses are no-store and no-referrer. Expired local access credentials yield a renewal-required response without discarding the still-valid opaque app cookie. The client makes one explicit CSRF-protected renewal request and does not automatically retry a failed/uncertain rotation. Logout clears the browser cookie only after durable local revocation and reports central revocation separately; it does not claim global Portal logout.

## Staging enrollment and configuration

The existing public defaults remain false. The server can enroll only central identity, only for an explicit staging deployment on a Vercel preview, at the approved `https://staging.vynvori.com` origin and with an operator-pinned isolated project ID matching the actual platform project ID. Production and ordinary/unpinned previews reject activation. Every financial/provider feature retains its existing closed guard. A matching project ID is an operator configuration check, not independent proof of project isolation; actual platform/domain provenance remains a staging review gate.

Enabled identity settings pin the approved central issuer `https://dev.portal.raum.au`, API `/mana`, audience `urn:vynvori:staging` and callback `/auth/tcm/callback`. The native client ID, client secret, encryption keyring and pooled creative database input must be supplied privately after separate operational approval. The creative connection requires the proposed dedicated `vynvori_identity_runtime_scoped` role, exact staging database/pinned pooled Neon host and verified TLS; it cannot silently reuse the earlier M2 probe or owner role. No new role or credential has been created. Disabled runtime requires none of these values and constructs no database pool.

The runtime validates configuration at startup when explicitly enrolled, memoizes only immutable configuration/pool/service composition, and never caches authorization results. Each protected operation still checks current central state. Deployment/restart is required to change its configuration. The account view preserves the existing unavailable presentation by default, and uses the existing Archivo/button/layout styles when enrolled. Commerce operations are still unavailable until the separate private Medusa transport is wired.

## Local verification and limits

HTTP/config/unit checks: 78 PASS, including disabled endpoints, origin/CSRF denial, duplicate cookies/query fields, bounded bodies, secure cookie attributes, callback replay, cancellation sanitization, renewal, truthful logout and staging-only flag/config guards. An actual disposable PostgreSQL 16.12 run passes 20 scenarios (21 Node entries), including Request/Response login→cookie→callback→expiry→renewal→logout over real durable state. This is handler-level integration with synthetic authority responses, not deployed browser SSO.

The optimized Next production build passes. Browser checks against the built application verify all eight auth endpoints return disabled/no-store by default, account appearance at desktop/mobile widths, no page errors/external requests and no session cookie issuance. Private identity setting markers are absent from client JavaScript. Active account UI and actual central/Medusa staging browser acceptance remain NOT_RUN.

The local build helper now recognizes only its expected disposable `.next` targets, regenerates a dangling expected junction, and places dependency resolution beside the disposable build directory so ESM externals such as pg resolve without a dependency install. It never recursively deletes source or dependency trees. The test server's prior ephemeral port was confirmed closed after browser testing.

## API and rollback

GET `/api/auth/csrf`, GET `/api/auth/session`, POST `/api/auth/tcm/start`, GET `/auth/tcm/callback`, POST `/api/auth/tcm/refresh`, POST `/api/auth/logout`, POST `/api/auth/commerce`, POST `/api/auth/guest/claim`. Errors use sanitized codes/messages/retryability/correlation IDs. No custom external event is added.

Rollback disables the identity flag and restores prior application/configuration while retaining durable sessions, transactions and mapping/revocation journals for reconciliation. It must not drop identity tables, remove encryption keys still required for pending revocations, reset uncertain operations or fall back to email/legacy token validation. Live migration/backup/grants, private transport, pending-revoke reconciliation, CI/security review and staging execution remain open.
