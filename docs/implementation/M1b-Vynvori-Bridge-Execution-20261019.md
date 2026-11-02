# M1b VYNVORI bridge implementation

## Current checkpoint — connected browser and independent installation

2026-10-19: nine connected browser checks PASS across real React account controls, production BFF/auth-session source, restricted creative PostgreSQL and actual private SDK/native Medusa HTTP/provider/workflows. This includes a centrally committed refresh whose response is lost: the app denies access, performs no refresh retry and reconciles revocation with the retained spent credential. [Connected receipt](evidence/M1b-Connected-Browser-Stack-20261019.json).

Independent normal `npm ci` PASS on Node22.23.3/npm10.9.9 using public npm and empty credential configs. The extraction's omitted deployment fixture was corrected without repeating installation;117checks, root lint and full typecheck PASS in that clean workspace. Both unfiltered audits exit1, with two production advisory roots and an additional esbuild development root. No finding was accepted and no M2 seal was changed. [Fresh receipt/raw-audit links](evidence/M1b-Fresh-Dependencies-20261019.json).

[Current review entry point and exact remaining implementation/approval work](M1b-Local-Validation-Review-20261019.md). Synthetic authority/local test TLS does not prove live Portal, actual IAM, enabled Next production bootstrap or staging acceptance. No live registration/schema/grant/configuration/deployment action occurred. Full M1b remains IN_PROGRESS; earlier checkpoints below retain their original scope.

## Current checkpoint — bounded pending revocations

2026-10-19: implemented scoped server-only revocation reconciliation with atomic local closure, credential-cache removal, leases, backoff and eight-attempt ceiling.117combined unit/config checks and33disposable creativePostgreSQL scenarios PASS; root lint, full typecheck and optimized Next build PASS. [ADR/API/migration/rollback boundaries](ADR-0015-M1b-Bounded-Revocation-Reconciliation.md), [execution receipt](evidence/M1b-Revocation-Reconciliation-20261019.json). No live invocation, scheduler, schema/grant change or deployment occurred.

Broader regression exposed the expected M2 approval fingerprint mismatch for the changed M1b lockfile; both security-policy and staging-source suites fail with `LOCK_FINGERPRINT_MISMATCH`. Do not bypass or silently reseal it. Root `npm test` first stopped at sandbox-denied lifecycle process cleanup; only verified test children were terminated, and the proper-permission lifecycle rerun passed. The remaining two suites were then run independently and their failures recorded. Full suite/CI is not green.

Next: enabled synthetic full-stack/browser integration, final migration/grant/backup review, fresh dependency evidence and a concrete M1b security/source approval proposal. Actual Portal enrollment/IAM/private staging operations still require their existing separate authorization. Full M1b remains IN_PROGRESS. Earlier checkpoints below are chronological records.

## Current checkpoint — customer credentials and owned reads

2026-10-19: added private native customer token exchange/owned reads, encrypted session-generation-bound custody and account details/setup UI.110combined unit/config checks and26creativePostgreSQL scenarios PASS. The actual native HTTP/module/workflow fixture passes customer JWT issuance/signature validation, customer-filtered orders, foreign-cart404, staff-token401, stock-route403 and central revocation401 despite a live native token. Root lint, db/commerce/Medusa/worker/web typechecks and optimized Next build PASS. The rebuilt default-off web application passes eleven closed routes and desktop/mobile rendering; eight real React component scenarios pass with synthetic BFF responses. [Current receipt](evidence/M1b-Customer-Owned-Reads-20261019.json), [ADR/API/migration/rollback](ADR-0014-M1b-Customer-Credentials-and-Owned-Reads.md).

No action is required from the owner to repeat Docker readiness or the completed local tests. Continue locally with bounded pending central-revocation reconciliation, then enabled full-stack/browser integration and migration/CI review. Actual IAM, deployed strict Portal enrollment, live grants/migration/domain/config and staging deployment are still unexecuted and require their existing separate operational authorization. This checkpoint does not pass full M1b or a production gate. Earlier implementation entries below are chronological evidence, superseded where this checkpoint explicitly adds behavior.

2026-10-19, Asia/Dhaka. Local implementation authorized by founder steering to reuse and enhance the audited LuckyLittleDevil integration. Starting repository HEAD: `262489d8a5c367e579839806d7e8554a394dcd2a`. Existing supplemental work is preserved. No commit, registration, deployment or live database mutation performed.

## Implemented central adapter

`packages/commerce/src/central-identity.ts` adds a server-only adapter to the reviewed Portal strict contract. It is not wired into any route, provider or runtime configuration. Disabled configuration makes no request. An enabled instance copies and freezes its configuration, pins HTTPS issuer/API origin and `/mana`, and sends only Basic authentication plus a form token to fixed strict introspection/profile paths. Redirects, browser credentials, caching and automatic retries are disabled. Responses have a 16 KiB cap and a five-second fetch timeout; errors are sanitized.

The adapter verifies active central state and exact issuer/client/audience/subject bindings, finite expiry within the approved five-minute access lifetime and recent authority verification. It checks profile binding, returns email/name only as mutable contact, and repeats introspection after the profile read to detect revocation during contact I/O. Identity is issuer+subject, never email. No central signing key is copied to VYNVORI: the trusted HTTPS authority performs signature and persisted revocation checks under the reviewed Portal implementation.

## Executed local checks

`node --conditions=react-server --import tsx --test packages/commerce/tests/*.test.ts`: 40 PASS / 0 FAIL, including 22 new central adapter cases. Synthetic fetch responses only; no live authority requests, accounts or tokens. Tests cover disabled mode, transport, pinned identity fields, expiry, verification freshness, revocation during profile I/O, contact subject mismatch, bounded response, sanitized/no-retry failures, profile error categories and configuration mutation. Commerce TypeScript, affected ESLint and whitespace checks PASS.

Existing root `test:m2` discovers the commerce test glob, so these tests are included without a manifest or dependency change. No installation was needed. The existing deployed M2 customer-auth boundary remains closed.

## Continuing implementation

Next: durable single-use login transactions and PKCE; explicit code exchange/refresh/revoke with unknown-outcome handling; encrypted credential custody; opaque active sessions with approved idle/absolute lifetimes and generation fencing; additive local schema/migrations with rollback; dedicated native Medusa identity/provisioning workflows with concurrency and orphan reconciliation; guest ownership; protected web flows and end-to-end synthetic tests. Local implementation does not wait for all legacy consumer baselines. Live registrations, grants, storage changes and deployment remain separately gated, and actual staging acceptance is still NOT_RUN.

Source-level tests do not prove deployed Portal behavior, a complete login, durable sessions, Medusa mapping, browser acceptance or M1b completion. No such claim is made.

## Durable primitives implemented — 2026-10-19

Versioned AES-GCM credential vault, S256/browser-bound login transaction service and PostgreSQL identity/session/guest state store are implemented locally. The additive SQL migration remains proposed and is not in the current live migration journal. Commerce suite: 48 PASS; disposable PostgreSQL16.12: nine scenarios PASS (ten test entries), including identity/callback races, expiry, refresh fencing,96-rotation ceiling, logout and cross-account guest claims. Commerce/db typechecks, affected lint and whitespace PASS. [ADR and rollback](ADR-0010-M1b-Durable-Authentication-State.md), [source hashes and execution receipt](evidence/M1b-Durable-Auth-Primitives-20261019.json). No live database was accessed. The integration container was removed.

Next implementation: fixed-endpoint code exchange/refresh/revoke and a session service composing durable state with fresh central verification; then dedicated native Medusa provisioning and protected web routes. The persistence primitives do not yet constitute integrated durable sessions or full guest project migration. No owner action is required for this local continuation.

## Composed login and session service — 2026-10-19

Implemented fixed-endpoint exchange/refresh/revoke plus authSessionService over the durable store and credential vault. Identity-only introspection is separate from scoped commerce contact: missing email does not prevent login or guest ownership. Protected operations recheck current authority state. Refresh uncertainty causes local revocation and no automatic rotation retry. A lost database acknowledgement after a committed refresh is covered by a fail-closed revocation test. Logout persists local revocation before central RPC and records pending/confirmed central revoke status; an absent local session never yields a false central confirmation. Pending-revoke worker reconciliation remains unimplemented.

Commerce55PASS; actual disposable PostgreSQL16.12 integration15scenariosPASS (16testentries), including complete synthetic login/verify/refresh/logout/guest composition, contact separation, upstream failure and logout/rotation races. Commerce/db typechecks, affected lint and whitespacePASS. [Current receipt and source hashes](evidence/M1b-Composed-Sessions-20261019.json). No live authority or database access. Next: native Medusa provider and fenced dedicated customer provisioning, then cookie/CSRF/web integration and pending-revoke reconciliation. No live activation occurred.

## Native Medusa provider — 2026-10-19

Added the Medusa2.21.2 TCM provider using the audited custom-provider pattern. It accepts only a server Bearer credential, verifies current Portal identity, creates/retrieves a bounded issuer+subject-derived entity key through the native provider service, checks exact issuer/subject metadata, reconciles a lost/raced native identity insertion by read only, rejects staff-linked identities/caller identity overrides and rechecks central state after identity I/O. It neither links by email nor creates a customer. Native physical provider-index acceptance is still open; mocked unique-service fixtures do not substitute for it.

The protocol implementation now lives in central-identity-core.ts. The web wrapper retains server-only; the standalone backend contains an exact-byte copy, validated before build. This avoids importing Next's server-only runtime guard into Medusa while preventing protocol drift. Docker's local build recipe copies the canonical source for that check. No npm installation, image build/push or deployment was performed. The provider module is exported but not registered by medusa-config.ts; existing customer-auth boundary and actor policy remain unchanged.

Combined commerce+Medusa tests69PASS (8newproviderchecks), both affected typechecks and lintPASS. The real Medusa compiler succeeded in an external temporary tree with synthetic loopback-port9 configuration; the compiled disabled provider loaded in ordinary Node without React conditions, database access or network requests. [Current receipt](evidence/M1b-Native-Medusa-Provider-20261019.json). Next: fenced native customer workflow and durable commerce mapping/reconciliation, followed by web/cookie integration.

## Fenced native customer provisioning — 2026-10-19

Implemented a creative-database commerce mapping journal, encrypted immutable original-contact request, exactly-once dispatch claim and explicit no-create reconciliation. The internal Medusa workflow delegates new creation to the installed stock account workflow, verifies exact identity/project/auth-identity/operation metadata, rejects email-only linking and unrelated guest accounts, and repairs a proved orphan through native auth metadata workflow steps. Existing ready mapping resolution uses fresh central identity and does not require current email availability. [Architecture/rollback](ADR-0011-M1b-Fenced-Commerce-Provisioning.md).

Combined commerce/Medusa75testsPASS. Creative PostgreSQL16.12:19scenariosPASS. Actual native Medusa2.21.2 module migrations, physical uniqueness,12-way auth identity race, one-customer creation/repeat, email conflict denial, contact change continuity, orphan repair and unresolved no-create reconciliation PASS in a separate disposable loopback database. Real compiler and compiled provider probe PASS. All affected typechecks/lintPASS; both test containers removed. No dependency installation or live service operation occurred. [Current source/evidence receipt](evidence/M1b-Fenced-Commerce-Provisioning-20261019.json).

Next: private backend HTTP transport and actor-bound credential custody, then web cookie/CSRF/login integration, pending central-revoke reconciliation and end-to-end synthetic coverage. Public customer routes/provider enrollment remain disabled. Registration, live database/grant changes and deployment still require separate authorization.

## Web HTTP/session boundary — 2026-10-19

Implemented eight thin Node routes for CSRF, login start/callback, status, renewal, logout, commerce status and guest claim; shared server-only handlers enforce secure opaque cookies, exact origins, CSRF, bounded bodies, unique callback fields and sanitized responses. Added private staging-only configuration/pool composition and account controls using existing design. Production and financial features remain closed; default account presentation is preserved. [ADR/API/rollback](ADR-0012-M1b-Web-Session-Boundary.md).

78unit/config/HTTP checksPASS. Actual disposable PostgreSQL16.12:20scenariosPASS, including HTTP callback/cookie/known-authority-expiry renewal and logout. Real optimized Next buildPASS. Real built-app browser checksPASS for all8disabled endpoints and desktop/mobile default account rendering; private server config markers absent from client JS. [Current receipt](evidence/M1b-Web-Session-Boundary-20261019.json). Docker was briefly stopped, then restarted by the owner; the test reran successfully with exact-label cleanup. Stale disposable Next output and ESM resolution were corrected without installing dependencies or deleting source.

Native Medusa HTTP transport is not yet wired into the web runtime; enabled browser account flow, pending revoke reconciliation, full end-to-end transport, fresh install/CI and staging acceptance remain open. Internal workspace metadata changed; no external dependency was resolved/installed. No owner operational config, registration, role/grant, database schema or deployment was changed.

## Private provisioning HTTP connected — 2026-10-19

Implemented and wired the server-only installed SDK client, separate target/body/credential-bound request proof, private backend route/loader, scoped provider enrollment, PostgreSQL identity locks and persisted idempotent workflows. Browser origin/cookies and caller overrides are denied. A known local credential failure before any HTTP dispatch releases only that new create reservation; an old uncertain create cannot be reset by a failed reconciliation. [Transport architecture and rollback](ADR-0013-M1b-Private-Medusa-Provisioning-Transport.md).

107combinedunit/config testsPASS;22disposable creativePostgreSQL scenariosPASS. Actual nativeSDK+router+provider+locks+module HTTP testPASS:3duplicate deliveries→1customer/1persistedexecution, unfinishedexecution→pending/no-create, invalidproof/browser/override→deny. The optimized Next build and default-disabled browser checksPASS; private config markers absent from client JS. Typechecks/lintPASS. [Current receipt](evidence/M1b-Private-Medusa-Transport-20261019.json). No library download/install or live change. SDK2.21.2 was already production-locked and installed; only direct dependency metadata was added.

The staging service identity source currently accepts private short-lived operator input and fails closed on missing/stale/audience-mismatched metadata. Google signature/invoker validation and renewable workload-identity acquisition are not proved by the loopback fixture and remain explicit operational gates. Customer bearer custody/owned reads, active account browser verification, central-revoke worker, full CI and approved staging acceptance remain incomplete. No owner action is required for continued local implementation.
