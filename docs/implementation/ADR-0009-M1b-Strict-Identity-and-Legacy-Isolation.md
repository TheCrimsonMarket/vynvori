# ADR-0009 — Strict identity contract with legacy Portal isolation

**Source-pair v8 update:** an anonymous dev public-authorizer probe returned 404, so the prepared Portal candidate adds a default-off `/mana/oauth/authorize` alias restricted to explicitly enrolled strict clients. Core's strict proxy pins approved web/API origins, sends server-selected provenance and retains legacy contracts; credentials/payloads are redacted from diagnostics. The actual source-pair contract test passes locally. Strict readiness verifies existing code uniqueness without repairing legacy metadata. Contact-email policy and real development index/build evidence remain open. [Current review package](M1b-Central-Candidate-Review-20261018.md), [Medusa compatibility/contact review](M1b-Medusa-Compatibility-Review-20261018.md). Earlier primitive-only/current-v5 language below is historical.

**Current implementation update (local only):** the strict authority candidate is wired behind default-off `PORTAL_STRICT_OAUTH_ENABLED` in an isolated release worktree. Explicit server-owned enrollment supplies the approved strict audience for a dedicated interactive client without mutating its legacy registration; a conflicting nonempty registration audience is rejected. No strict identity/secret is inferred from browser inputs. Authorization-time context is an optional code-schema extension with no legacy default/backfill. Readiness verifies complete unique indexes; startup and requests never create or repair storage. Storage preparation is an explicit separately gated operator function. Strict-prefix parsing precedes shared body parsers only when the new feature is configured. See [current execution](M1b-Prerequisite-Progress-20261018.md) and [v5 evidence](evidence/M1b-Portal-Release-Candidate-20261018.json). Earlier primitive-only/unmounted descriptions below are historical. Live activation, registration, domain/storage/secret changes and deployment remain blocked.

2026-10-18, Asia/Dhaka. **Direction and legacy compatibility requirements APPROVED; operational activation BLOCKED.** Local implementation work is authorized toward M1b. Exact API/schema changes below remain review candidates until their implementation and evidence are available. This ADR passes no auth acceptance gate.

## Problem and decision

Portal serves multiple applications. Its existing human OAuth verification lacks the issuer/client/product guarantees required by VYNVORI. Changing shared verification, refresh or revocation behavior globally would violate the founder's complete legacy-support requirement.

Use an additive strict-client contract with explicit server-controlled enrollment. Existing clients retain their token, API, callback, cookie, grant and SDK contracts. Strict VYNVORI verification always fails closed; legacy mode cannot be selected by a caller or used as fallback. Do not distribute Portal's signing key to VYNVORI or Medusa.

The first candidate is a standalone authority-side verification factory in Portal, covered by real JWT cryptography and stubbed persistence tests. It is deliberately unconnected to routes, models and token issuance. Its passing tests establish local primitive behavior only. Current Portal tokens lack issuer claims and therefore do not satisfy this new contract.

## Approved and outstanding configuration

| Item | Value / evidence status |
|---|---|
| Development web origin | Founder-confirmed `https://dev.portal.raum.au` |
| Development API base | Founder-confirmed `https://dev.portal.raum.au/mana`; public OAuth catalog GET returned 200 |
| Development strict issuer namespace | Founder-approved `https://dev.portal.raum.au`; new strict contract, not an existing token-claim observation |
| VYNVORI staging audience | Founder-approved `urn:vynvori:staging` |
| VYNVORI staging origin | Founder-approved target `https://staging.vynvori.com`; domain/project provisioning NOT_RUN |
| Exact callback | Founder-approved `https://staging.vynvori.com/auth/tcm/callback`; registration BLOCKED |
| Production web/API | Founder identifies `https://www.thecrimsonmarket.com` and `/mana`; no production auth changes authorized |
| Client registration | Client ID, least-scope registration receipt and server-secret reference outstanding. Do not place secrets in this ADR |
| Portal deployment provenance | Development deployment exists per founder; image tag/digest and matching source SHA outstanding |
| Policy values | Strict token lifetime, session absolute/inactivity TTL, transaction TTL, clock skew, revocation SLA and rotation/family recovery policy need explicit review before activation |

Subsequent founder policy approval: strict staging access tokens 300 seconds; token family and app absolute lifetime 28,800 seconds; app idle 1,800 seconds; login transaction 600 seconds; no authorization cache, central checks per protected operation; maximum 96 family rotations. Other unresolved policy/activation decisions remain open. The implementation now has a separately tested local issuance/refresh/revocation/persistence/HTTP candidate and authorization-time context plumbing in an isolated release worktree; the initial primitive-only description above is historical. [Current candidate evidence](evidence/M1b-Portal-Release-Candidate-20261018.json).

The issuer is an exact authority namespace used with immutable subject as the identity key. It does not imply OIDC discovery, an ID token, a JWKS endpoint or an existing `iss` claim. Production and development remain separate trust domains.

## Boundaries and implementation sequence

1. Preserve pre-change Portal OAuth/full-suite evidence and inventory source consumers. Add legacy characterization tests before connecting new behavior.
2. Implement and review authority-owned strict issuance, server-authenticated validation, one-use refresh/family revocation and explicit strict enrollment. Select additive API paths and error schemas in that review; none exists by virtue of this ADR. Avoid changing legacy userinfo semantics. Include rollback/backup and old/new application compatibility for any additive schema.
3. Verify the exact development deployment/source correspondence and run synthetic strict-client positives/negatives against the approved development target only after registration/deployment authorization. Source inspection and public catalog availability cannot substitute for this step.
4. Implement the VYNVORI bridge only after the central trust/registration gates close: durable opaque sessions, server credential vault, atomic callback transactions, issuer+subject profile identity, idempotent commerce mapping and provisioning reconciliation, guest claims and ownership enforcement. Use the installed dedicated Medusa 2.21.2 mechanisms after version-specific verification.
5. Execute AUTH-01–23 as applicable and record exact-head CI, synthetic deployed evidence and rollback drill. Keep financial, public gallery, paid AI and printing operations OFF.

## Compatibility and persistence review

The source inventory is partial: shared OAuth SDK, Lucky/Medusa, SocialRiddle, DiscordManager, Megaphone, Connect and developer/core UI surfaces were found locally. It is not a complete deployed-client registry. Obtain a metadata-only owner inventory; do not export client secrets, users or tokens.

Baseline Portal has 30 failed suites / 19 failed assertions. The candidate adds 45 passing checks while the failed-suite and failed-assertion sets remain identical. This supports no new failures in the executed suite, not a globally regression-free release. Existing red tests and incomplete dependent-service coverage remain release-review blockers. Do not weaken tests or alter legacy security behavior to make the suite appear green.

No schema/migration/API/event is activated by the current candidate. Its `strictIdentity` policy shape is an internal candidate input supplied by trusted authority configuration, not a deployed field or developer-controlled registration setting. The existing client model has not been changed.

Future VYNVORI identity storage requires unique `(issuer, subject)`, unique per-project commerce mappings, hashed opaque session/transaction handles, revocation tombstones, generation/fencing, provisioning/outbox recovery and guest claim constraints. Review the executable schema, synthetic database tests, scoped runtime grants and forward-fix/backup plan before a live migration. Never write Medusa tables through VYNVORI's Drizzle package.

## Rollback and security review

The current new Portal helper and tests can be removed without changing existing services, since nothing imports the helper. Future strict activation must be reversible independently. Disable strict access on failure; never map strict clients back to legacy verification. Preserve old token support for legacy consumers and retain token/session/provisioning lineage for reconciliation.

The helper pins HS256, issuer, exact single audience/client, finite time/jti/type/subject checks, current strict enrollment/active grants/scopes and persisted token owner/revocation/expiry/scopes. Storage outages return sanitized unavailable status. It returns no token, email or role grant. It does not yet provide issuance, refresh/revoke, a persistence adapter, a transport, family guarantees or VYNVORI authentication.

Vercel inspection found the existing `vynvori-dev` project shares `vynvori-dev.vercel.app` with public `vynvori.com`/`www.vynvori.com`, and the current main deployment has target `production`. The project name is not environment isolation evidence. Use a separately isolated staging target for the approved callback; no domain/project mutation is authorized by this ADR.

See [execution record](M1b-Prerequisite-Progress-20261018.md), [sanitized receipt](evidence/M1b-Portal-Prerequisite-20261018.json), [remediation requirements](M1b-Trust-Remediation-Proposal-20261018.md) and [M1a bridge contract](M1a-bridge-integration-contract.md).


## Current local candidate update (2026-10-18, v9)

The helper-only statements below are historical. The isolated v9 Portal candidate now wires default-off strict authorization, code context, issuance, family rotation/revocation, persistence/readiness, server transport and scoped contact retrieval. Core supplies server-selected strict origin provenance while retaining legacy contracts. The approved contact response uses consented `profile email` and the central top-level contact fields; issuer+subject remains the identity key. No registration, migration, tag, push or deployment occurred. Owner fresh dependencies and all prior assertion identities/statuses/counts were verified. Existing full-suite failures and incomplete dependent-service coverage remain release limits. See the [current review](M1b-Central-Candidate-Review-20261018.md) and [contact API/security/rollback contract](M1b-Strict-Contact-Contract-20261018.md), which supersede earlier candidate capability counts.

# ADR-0009 — Strict identity contract with legacy Portal isolation

**Source-pair v8 update:** an anonymous dev public-authorizer probe returned 404, so the prepared Portal candidate adds a default-off `/mana/oauth/authorize` alias restricted to explicitly enrolled strict clients. Core's strict proxy pins approved web/API origins, sends server-selected provenance and retains legacy contracts; credentials/payloads are redacted from diagnostics. The actual source-pair contract test passes locally. Strict readiness verifies existing code uniqueness without repairing legacy metadata. Contact-email policy and real development index/build evidence remain open. [Current review package](M1b-Central-Candidate-Review-20261018.md), [Medusa compatibility/contact review](M1b-Medusa-Compatibility-Review-20261018.md). Earlier primitive-only/current-v5 language below is historical.

**Current implementation update (local only):** the strict authority candidate is wired behind default-off `PORTAL_STRICT_OAUTH_ENABLED` in an isolated release worktree. Explicit server-owned enrollment supplies the approved strict audience for a dedicated interactive client without mutating its legacy registration; a conflicting nonempty registration audience is rejected. No strict identity/secret is inferred from browser inputs. Authorization-time context is an optional code-schema extension with no legacy default/backfill. Readiness verifies complete unique indexes; startup and requests never create or repair storage. Storage preparation is an explicit separately gated operator function. Strict-prefix parsing precedes shared body parsers only when the new feature is configured. See [current execution](M1b-Prerequisite-Progress-20261018.md) and [v5 evidence](evidence/M1b-Portal-Release-Candidate-20261018.json). Earlier primitive-only/unmounted descriptions below are historical. Live activation, registration, domain/storage/secret changes and deployment remain blocked.

2026-10-18, Asia/Dhaka. **Direction and legacy compatibility requirements APPROVED; operational activation BLOCKED.** Local implementation work is authorized toward M1b. Exact API/schema changes below remain review candidates until their implementation and evidence are available. This ADR passes no auth acceptance gate.

## Problem and decision

Portal serves multiple applications. Its existing human OAuth verification lacks the issuer/client/product guarantees required by VYNVORI. Changing shared verification, refresh or revocation behavior globally would violate the founder's complete legacy-support requirement.

Use an additive strict-client contract with explicit server-controlled enrollment. Existing clients retain their token, API, callback, cookie, grant and SDK contracts. Strict VYNVORI verification always fails closed; legacy mode cannot be selected by a caller or used as fallback. Do not distribute Portal's signing key to VYNVORI or Medusa.

The first candidate is a standalone authority-side verification factory in Portal, covered by real JWT cryptography and stubbed persistence tests. It is deliberately unconnected to routes, models and token issuance. Its passing tests establish local primitive behavior only. Current Portal tokens lack issuer claims and therefore do not satisfy this new contract.

## Approved and outstanding configuration

| Item | Value / evidence status |
|---|---|
| Development web origin | Founder-confirmed `https://dev.portal.raum.au` |
| Development API base | Founder-confirmed `https://dev.portal.raum.au/mana`; public OAuth catalog GET returned 200 |
| Development strict issuer namespace | Founder-approved `https://dev.portal.raum.au`; new strict contract, not an existing token-claim observation |
| VYNVORI staging audience | Founder-approved `urn:vynvori:staging` |
| VYNVORI staging origin | Founder-approved target `https://staging.vynvori.com`; domain/project provisioning NOT_RUN |
| Exact callback | Founder-approved `https://staging.vynvori.com/auth/tcm/callback`; registration BLOCKED |
| Production web/API | Founder identifies `https://www.thecrimsonmarket.com` and `/mana`; no production auth changes authorized |
| Client registration | Client ID, least-scope registration receipt and server-secret reference outstanding. Do not place secrets in this ADR |
| Portal deployment provenance | Development deployment exists per founder; image tag/digest and matching source SHA outstanding |
| Policy values | Strict token lifetime, session absolute/inactivity TTL, transaction TTL, clock skew, revocation SLA and rotation/family recovery policy need explicit review before activation |

Subsequent founder policy approval: strict staging access tokens 300 seconds; token family and app absolute lifetime 28,800 seconds; app idle 1,800 seconds; login transaction 600 seconds; no authorization cache, central checks per protected operation; maximum 96 family rotations. Other unresolved policy/activation decisions remain open. The implementation now has a separately tested local issuance/refresh/revocation/persistence/HTTP candidate and authorization-time context plumbing in an isolated release worktree; the initial primitive-only description above is historical. [Current candidate evidence](evidence/M1b-Portal-Release-Candidate-20261018.json).

The issuer is an exact authority namespace used with immutable subject as the identity key. It does not imply OIDC discovery, an ID token, a JWKS endpoint or an existing `iss` claim. Production and development remain separate trust domains.

## Boundaries and implementation sequence

1. Preserve pre-change Portal OAuth/full-suite evidence and inventory source consumers. Add legacy characterization tests before connecting new behavior.
2. Implement and review authority-owned strict issuance, server-authenticated validation, one-use refresh/family revocation and explicit strict enrollment. Select additive API paths and error schemas in that review; none exists by virtue of this ADR. Avoid changing legacy userinfo semantics. Include rollback/backup and old/new application compatibility for any additive schema.
3. Verify the exact development deployment/source correspondence and run synthetic strict-client positives/negatives against the approved development target only after registration/deployment authorization. Source inspection and public catalog availability cannot substitute for this step.
4. Implement the VYNVORI bridge only after the central trust/registration gates close: durable opaque sessions, server credential vault, atomic callback transactions, issuer+subject profile identity, idempotent commerce mapping and provisioning reconciliation, guest claims and ownership enforcement. Use the installed dedicated Medusa 2.21.2 mechanisms after version-specific verification.
5. Execute AUTH-01–23 as applicable and record exact-head CI, synthetic deployed evidence and rollback drill. Keep financial, public gallery, paid AI and printing operations OFF.

## Compatibility and persistence review

The source inventory is partial: shared OAuth SDK, Lucky/Medusa, SocialRiddle, DiscordManager, Megaphone, Connect and developer/core UI surfaces were found locally. It is not a complete deployed-client registry. Obtain a metadata-only owner inventory; do not export client secrets, users or tokens.

Baseline Portal has 30 failed suites / 19 failed assertions. The candidate adds 45 passing checks while the failed-suite and failed-assertion sets remain identical. This supports no new failures in the executed suite, not a globally regression-free release. Existing red tests and incomplete dependent-service coverage remain release-review blockers. Do not weaken tests or alter legacy security behavior to make the suite appear green.

No schema/migration/API/event is activated by the current candidate. Its `strictIdentity` policy shape is an internal candidate input supplied by trusted authority configuration, not a deployed field or developer-controlled registration setting. The existing client model has not been changed.

Future VYNVORI identity storage requires unique `(issuer, subject)`, unique per-project commerce mappings, hashed opaque session/transaction handles, revocation tombstones, generation/fencing, provisioning/outbox recovery and guest claim constraints. Review the executable schema, synthetic database tests, scoped runtime grants and forward-fix/backup plan before a live migration. Never write Medusa tables through VYNVORI's Drizzle package.

## Rollback and security review

The current new Portal helper and tests can be removed without changing existing services, since nothing imports the helper. Future strict activation must be reversible independently. Disable strict access on failure; never map strict clients back to legacy verification. Preserve old token support for legacy consumers and retain token/session/provisioning lineage for reconciliation.

The helper pins HS256, issuer, exact single audience/client, finite time/jti/type/subject checks, current strict enrollment/active grants/scopes and persisted token owner/revocation/expiry/scopes. Storage outages return sanitized unavailable status. It returns no token, email or role grant. It does not yet provide issuance, refresh/revoke, a persistence adapter, a transport, family guarantees or VYNVORI authentication.

Vercel inspection found the existing `vynvori-dev` project shares `vynvori-dev.vercel.app` with public `vynvori.com`/`www.vynvori.com`, and the current main deployment has target `production`. The project name is not environment isolation evidence. Use a separately isolated staging target for the approved callback; no domain/project mutation is authorized by this ADR.

See [execution record](M1b-Prerequisite-Progress-20261018.md), [sanitized receipt](evidence/M1b-Portal-Prerequisite-20261018.json), [remediation requirements](M1b-Trust-Remediation-Proposal-20261018.md) and [M1a bridge contract](M1a-bridge-integration-contract.md).
