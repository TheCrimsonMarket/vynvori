Adds a trusted, default-off strict OAuth cohort for the VYNVORI identity bridge while preserving legacy authorize/token/refresh/revoke/userinfo contracts. Draft source review only: no merge, release tag, registration, storage preparation, secret distribution or deployment is authorized.

## Architecture decision (ADR-0009)
Use isolated strict policy, storage and server transport instead of changing legacy token semantics. Bind issuer + subject, exact client/audience, current enrollment/scopes and central token version. Pin HS256, exact callback/S256, finite lifetimes, atomic code consumption, single-use refresh rotation, family revocation and persistent generation fencing. Unknown outcomes require reauthentication; no blind retries or strict-to-legacy fallback.

Absent/false feature configuration touches no strict model or endpoint. Malformed enabled settings preserve legacy availability and deny strict operations. The existing central refresh signing secret stays in Portal. No staff grant or commerce mapping is added.

## API, schema and rollback
Configured-only POST /oauth/strict/v1/{token,introspect,revoke,profile}, with /mana aliases: server Basic authentication, bounded forms, per-client rate enforcement, no browser Origin/Cookie, sanitized no-store responses. The strict-only public /mana/oauth/authorize alias uses the native consent controllers and session guard.

Profile requires BOTH consented profile and email scopes. It reads top-level central contact fields and rechecks client/family/subject state after I/O. Return only issuer/subject/client/audience, email, actual emailVerified boolean and optional bounded display name. Missing/invalid contact: 409 contact_required; missing granted scope: 403. Email is mutable contact data, never ownership/linking proof; no placeholders, provider fallback or silent account merge.

Authorization-code strictContext is optional, server-owned and has no legacy defaults. Two new strict-only collections require explicit, separately approved preparation; startup/HTTP creates or repairs no indexes. Existing full unique code index is required and supported by owner-supplied development metadata. No automatic migration/event or legacy data conversion.

Settings: PORTAL_STRICT_OAUTH_ENABLED (off by default), versioned PORTAL_STRICT_OAUTH_CONFIG and separate PORTAL_STRICT_OAUTH_SIGNING_KEY. Rollback: disable/deny the strict cohort, retain family lineage, preserve legacy consumers; never downgrade strict verification.

## Executed validation and limits
Base e54028d0a3a9fa22fdac2acca1f84744df115225 equals live developmerger at publication. Exactly 24 reviewed source/test paths; package/lock/pipeline unchanged. Fresh npm ci passed; independent dependencies.

OAuth: 24 suites / 281 assertions PASS. Full Portal: 114 suites PASS / 30 FAIL; 748 assertions PASS / 19 FAIL. Baseline: 102 PASS / 30 FAIL suites; 587 PASS / 19 FAIL assertions. Every prior assertion identity/status/count and exact failure identity is preserved; 161 added passing assertions. Existing failures remain unresolved, not waived.

Three paired Core/Portal/MongoDB source cases pass, including contact and central revoke. Next request/response context, transport routing and unrelated provider modules are adapters. Disposable MongoDB 7.0.14; downloads disabled. Affected lint, hash/allowlist, whitespace and patch checks pass.

Known legacy boolean compound-index source defects remain unchanged; fixture auto-DDL is disabled with valid unique indexes explicitly prepared. Fresh legacy auto-DDL, deployed/browser acceptance, full consumer coverage, exact-head CI and VYNVORI sessions/guest ownership/Medusa provisioning remain unverified or unimplemented. M1b is NOT complete.

Companion: service.core-ui branch codex/m1b-core-authorizer-provenance. Commit uses [skip ci] because the checked-in pipeline builds/pushes images and deploys Kubernetes. No tags pushed or remote job intentionally queued. No auto-complete.
