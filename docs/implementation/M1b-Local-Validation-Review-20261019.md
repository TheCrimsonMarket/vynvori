# M1b local validation review

2026-10-19. VYNVORI HEAD `262489d8a5c367e579839806d7e8554a394dcd2a`; implementation remains uncommitted and operational flags remain off. This is the current review entry point. Earlier dated receipts describe their own narrower checkpoints.

The audited LuckyLittleDevil pattern now connects real React account controls, production BFF/auth-session source, restricted creative PostgreSQL state, the private Medusa SDK transport, native provider/customer workflows and native workflow persistence in one disposable local test. The authority is synthetic; no live Portal registration, user login or deployment was used.

CI compatibility continuation: the Vercel-style isolated normal npm install and Next/Turbopack build now PASS with24deployment traces and no backend/migration/test/reference files traced. The required BFF package source is included; source context and trace exclusions are tightened. npm dependency-key ordering was normalized without changing versions/resolutions/integrity, and only Windows CRLF/LF differences are allowed in exact lock-text comparison. The current root lock SHA therefore differs from the earlier clean-install receipt; that receipt remains historical, while the [deployment receipt](evidence/M1b-Deployment-Readiness-20261019.json) records the current canonical install. M0's17checks and explicit BFF source-smoke checks PASS. [Security/source review](M1b-Security-Source-Review-20261019.md). These results do not activate a new exception or make full CI green.

## Executed validation

| Check | Result and scope |
|---|---|
| Connected browser/native stack | PASS: nine checks cover PKCE/callback, actual Chrome Secure/HttpOnly/Lax cookies, replay denial, rotation/generation fencing and native credential replacement, two-account isolation, guest ownership/CSRF, logout outage/reconciliation, central revocation with a cached native token, committed-but-lost refresh response and browser credential absence. Actual source SDK/router/provider/workflows and two separate disposable databases are used. |
| Native security/workflow integration | PASS: signed customer tokens, foreign-cart404, staff-token401, stock-route403, customer-filtered orders, raced provisioning, durable duplicate/incomplete execution and exact orphan recovery. |
| Creative state integration | PASS:33scenarios,34Node entries on disposable PostgreSQL16.12, including restricted-role negatives and revocation races/backoff/exhaustion. |
| Fresh dependency extraction | PASS: normal `npm ci` lifecycle on Node22.23.3/npm10.9.9; exact lock hash retained; only public npm registry URLs; empty user/global npm credential configuration; no live settings copied. |
| Fresh source verification | PASS:117unit/config checks, root lint and complete root typecheck against the independently installed workspace. The first extraction omitted a deployment test fixture; the omission was corrected and checks resumed using the verified install. The initial failure receipt remains outside the checkout. |
| Web build/default boundary | PASS: optimized Next build; eleven default-off auth/account routes, default account desktop/mobile rendering and no active login button. Eight additional React UI states passed with synthetic BFF responses. |
| Full regression/CI | NOT_GREEN: the existing M2 security and staging-source gates reject the changed M1b lockfile. No seal or policy was changed. Windows lifecycle permission failures were corrected by an identity-verified cleanup and proper-permission rerun. |

[Connected browser/native receipt](evidence/M1b-Connected-Browser-Stack-20261019.json), [fresh install/source checks](evidence/M1b-Fresh-Dependencies-20261019.json), [durable state and revocation](evidence/M1b-Revocation-Reconciliation-20261019.json). The connected screenshot is an unstyled component test fixture, not an approval of production visual design. The enabled Next production bootstrap, real Portal behavior/TLS and actual Cloud Run IAM remain untested by this fixture. The local browser deliberately trusts its ephemeral self-signed loopback certificate; production TLS checks remain unchanged.

## Dependency findings retained for review

Unfiltered production audit:79affected package entries (76high,3moderate,0critical), deriving from two advisory roots: `braces` GHSA-vfj7-8cjw-p6xm and `sprintf-js` GHSA-hp3w-g68c-fv3c. Full dependency audit:85affected package entries (78high,7moderate,0critical), additionally including development `esbuild` GHSA-67mh-4wv8-2f99. These counts include inherited effects through Medusa packages; they are not counts of distinct advisories.

The two production roots are listed in the existing M2 exception policy. That historical policy does not authorize new M1b authentication surfaces, a new source seal or live staging enrollment. Both audits exit1; no finding was filtered, auto-fixed or accepted by this work. npm's reported fixes include incompatible Medusa major-version downgrades, which were not applied. A fresh M1b reachability/remediation/residual-risk review is required. [Production raw audit](evidence/M1b-Npm-Production-Audit-20261019.json), [all-dependency raw audit](evidence/M1b-Npm-All-Audit-20261019.json).

## Remaining work before source and operational approval

1. Migration integration is now implemented locally: separate checksum/Drizzle journal, atomic DDL, physical drift checks and read-only inspection. PostgreSQL18.6 passes45test entries and native backup/restore with matching schema/history digests. Runtime-grant negatives pass; exact grants remain a NOLOGIN proposal. [Current migration evidence](evidence/M1b-Identity-Migrations-20261019.json). Live target backup/inspection, grants and application still require review and separate authorization.
2. Prepare the private operator invocation/monitoring procedure for pending/exhausted revocations and review renewable service-identity custody. The batch currently has no live scheduler or public route.
3. Finish the M1b security/source proposal against the fresh audit and exact implementation, preserving the existing M2 approval seal. Obtain the separate source publication/policy approval and green exact-head CI before any merge/release acceptance.
4. Revalidate current Portal/Core source/deployment provenance and execute the approved legacy compatibility baseline/rollback plan before a separately authorized central development rollout. The legacy checklist is not a local coding blocker.
5. Obtain separately authorized dedicated client registration, additive central storage/configuration, isolated VYNVORI staging target/domain, grants/secrets/IAM and deployment. Then execute real central trust/rotation/revocation negatives, full enabled browser acceptance and the operational rollback drill.

No commit/push/merge, image publication, release tag, client registration, live schema/grant/configuration change or deployment is performed by these validations. Full M1b and production acceptance remain IN_PROGRESS.
