# ADR 0014 — customer credentials and owned account reads

2026-10-19. Implemented locally; operational activation and full M1b acceptance remain open.

## Decision

Extend the private, fixed-path Medusa transport with POST `/auth/customer/tcm/exchange` and POST `/auth/customer/tcm/owned`. Both require the same platform service identity, expiring request proof and current central bearer as provisioning. Exchange validates the native provider binding, issuer/subject-derived entity, project and exact customer/auth-identity mapping. It issues a native HS256 customer token bounded by both 300 seconds and central access expiry. Signing keys stay in Medusa. No staff roles or user identity are copied into the customer token.

The BFF checks consistency of the exchange response; it does not claim to verify the native JWT signature. Medusa verifies that signature, algorithm, issuer, audience, expiry, actor and exact mapping on every owned read. Every request also checks fresh central state and actual resource ownership. The BFF repeats central/local session checks before returning data, suppressing results after logout, rotation or revocation during I/O.

Native credentials are encrypted with the existing versioned AES-GCM vault. Associated data includes the app session, generation, project, auth identity, customer and credential purpose. Proposed additive migration `packages/db/auth-migrations/0003_customer_credentials.sql` adds an all-or-none credential record to the local identity session. Writes require an active current session generation and an exact ready mapping. Refresh/logout clear the record; expiry requires a new exchange. This caches credentials only, never authorization decisions. Central access, native customer and service tokens never reach browser responses or storage.

Owned actions are limited to customer contact, up to 50 recent owned orders and an explicitly identified owned cart. Foreign carts return 404. Native order queries filter by customer and validate every returned row. Responses contain bounded explicit fields. Stock customer/order/cart routes remain closed even when enrollment is off, preventing previously issued native tokens from bypassing current central checks during rollback. Catalog reads remain available under the existing policy. No checkout, order placement or financial mutation is enabled.

## Web contract

GET `/api/account/profile`, `/api/account/orders` and `/api/account/cart?cartId=...` use the opaque app cookie. They reject caller identity selectors; profile omits native identity/customer IDs. No read creates a commerce mapping. Missing mapping returns `AUTH_COMMERCE_SETUP_REQUIRED` with 409. Existing CSRF-protected POST `/api/auth/commerce` performs an explicit `ensure` or no-create `reconcile` action and returns only state.

The account screen displays contact and recent orders, supports explicit shopping-profile setup and offers a status check after an uncertain result. Missing contact leaves sign-in active; conflicts require support. It clears account content when the session expires or logout starts and ignores delayed responses after unmount. Production/default-off account presentation remains unchanged. No application events or live schema changes are introduced.

## Executed evidence and limits

110 combined unit/config checks, 26 disposable creative PostgreSQL scenarios, native Medusa HTTP/module/workflow integration, all affected workspace typechecks, root lint and the optimized Next build pass. Native checks include actual signed customer tokens, staff-token denial, cross-account cart denial, customer-filtered orders and central revocation with a live native token. Eight real React component/browser scenarios use synthetic BFF responses; the built default-off application separately passes eleven route checks and desktop/mobile rendering. These are separate layers, not an enabled end-to-end OAuth browser acceptance test. [Receipt](evidence/M1b-Customer-Owned-Reads-20261019.json).

Actual platform IAM validation, deployed Portal registration/behavior, full enabled browser journey, Neon target-version migration/grants/rollback review, pending central-revocation reconciliation, fresh dependency installation and remote CI remain open. Existing M2 policy exceptions do not authorize M1b activation. Live flags remain off; no commit, push, image publication, registration, grant, migration or deployment was performed.

## Rollback

Disable identity/private transport enrollment and restore the reviewed prior application/configuration. Retain encrypted credentials and required key versions, identity/mapping records, pending revocations and native workflow/operation markers for reconciliation. The proposed columns need not be dropped. Do not delete customers, reset uncertain provisioning or reopen stock native routes as a fallback. Review backup/restore and least-privilege grants before any live migration.
