# 20 — Traceability and acceptance matrix

Use statuses `NOT_STARTED`, `NOT_RUN`, `IN_PROGRESS`, `PASSED`, `FAILED`, `BLOCKED`. **All rows currently NOT_STARTED or BLOCKED:** this documentation does not imply code exists. For each completed requirement record PR/commit, test evidence, migration/deploy link, reviewer and date.

| ID | Area | Acceptance evidence | Current status |
|---|---|---|---|
| ACC-01 | Repository | Existing benchmark CLI/tests unchanged and green after npm workspace expansion | NOT_STARTED |
| ACC-02 | Central auth | LuckyLittleDevil actual bridge audited with source SHA and threat model | BLOCKED: repo access |
| ACC-03 | Auth correctness | org canonical subject maps to one Medusa customer; issuer/audience/logout tests pass | BLOCKED: ACC-02 |
| ACC-04 | Guest onboarding | anonymous BYO editing/preview, expiry/quota, secure sign-in migration | NOT_STARTED |
| ACC-05 | Independent composer | BYO full journey without AI credit/account upfront | NOT_STARTED |
| ACC-06 | Scene model | ordered edit layers/typography, stable mm transforms, immutable version snapshots | NOT_STARTED |
| ACC-07 | Artwork security | private R2 uploads, scans/hash, owner download, expired presigned URL | NOT_STARTED |
| ACC-08 | Medusa catalog | dedicated project, black tee size variants, real stock, separate merchant sandbox | NOT_STARTED |
| ACC-09 | Personalized price | Medusa quote server validated; tampered zone/price rejected; distinct custom items | NOT_STARTED |
| ACC-10 | Payments→Neon | captured order exactly once creates production job / paid entitlement | NOT_STARTED |
| ACC-11 | Credit wallet | immutable ledger, reserved/released, 100-way concurrent test, no negative/double grant | NOT_STARTED |
| ACC-12 | Paid exports | owner entitlement, exact composition snapshot, secure download; originals free unchanged | NOT_STARTED |
| ACC-13 | Studio dual onboarding | guide/free both reach consistent brief; 3 concepts/2 refinements; version restoration | NOT_STARTED |
| ACC-14 | Model qualification | only qualified models show, premium disabled until proven, regional rights checked | BLOCKED: model evidence |
| ACC-15 | Provider metering | no blind billable retry; unknown state reconciled; configured per-call cap | NOT_STARTED |
| ACC-16 | Print preflight | supplier profile version, effective PPI, alpha, fonts, bounds and output manifest | BLOCKED: print spec for go-live |
| ACC-17 | Human QA | paid but unapproved never released to print; new proof invalidates old approval | NOT_STARTED |
| ACC-18 | Physical validation | DTF on 220 and 240 GSM samples inspected; manufacturer signs off final profile | BLOCKED: samples |
| ACC-19 | US shipping | live carrier/import quote and displayed total/duty/ETA, refund/cancel test | BLOCKED: quotations |
| ACC-20 | AU batch | threshold/deadline/least-cost fallback, customer consent/refund path | NOT_STARTED (live blocked) |
| ACC-21 | Gallery | private default, consent moderation, share only safe derivative, original hidden | NOT_STARTED |
| ACC-22 | Identity & privacy | BOLA/IDOR, CSRF, session, admin, object access, user-data deletion tests | NOT_STARTED |
| ACC-23 | Cross-system events | duplicate/reordered/missing delivery and reconciliation simulations | NOT_STARTED |
| ACC-24 | CI/CD & rollback | staging/prod isolation, migrations reviewed, rollback drill, alerting | NOT_STARTED |
| ACC-25 | Legal/payment setup | authorized legal seller/merchant, sandbox→live review and policy approvals | BLOCKED: external |
| ACC-26 | Price cards | supplier-verified per-order margin and credit cost cards, discounted offer safe | BLOCKED: costs |
| ACC-27 | Controlled launch | full signed go/no-go checklist, test order fulfilled end-to-end | BLOCKED: preceding gates |

## Release rules

### M2 private Cloud Run preparation — 2026-10-17

Remote staging activation is **BLOCKED: independent security exception, provider identifiers/least-privilege evidence, migration/recovery and execution approval pending**. [Preparation ADR and evidence](../implementation/ADR-0005-Private-Medusa-Staging-Activation.md). Local synthetic regression results are recorded separately; they pass no remote/production gate. ACC-03, ACC-08, ACC-22, ACC-24 and ACC-27 remain unchanged. No real Neon migration, Cloud Run invocation, Vercel integration or customer activation has been tested by this preparation.

A row can be `PASSED` only with a reproducible link to test/evidence. No “conditionally passed” row may satisfy a mandatory production launch gate. A coding agent must not change founder-approved scope to make a test easier. Any architecture deviation requires an ADR and explicit founder approval.

### M2 authorized deployment attempt — 2026-10-17

**BLOCKED; service absent.** Founder authorization for private synthetic staging execution was received. The actual root-context image was built and published to the existing registry; live read-only checks verified both scoped database identities and an empty staging catalog. Fresh npm audits and local container integration completed. Both official Trivy database download paths returned an expired database, so current-scan acceptance remains blocked. Existing database secret URL options also fail the reviewed strict configuration; automatic approval review rejected adding normalized versions without explicit authorization. No live migration, runtime grants, Cloud Run revision or deployed HTTP smoke tests ran. [Actual execution evidence and exact blockers](../implementation/M2-Deployment-Attempt-20261017.md). Existing acceptance rows remain unchanged; local results pass no remote or production gate.

Resume, **2026-10-18**: founder-approved strict-TLS secret versions (runtime 3, migration 2) were added and verified against the still-empty staging database. A fresh image scan now uses a current advisory database, resolving both prior blockers. Explicit remote residual-risk acceptance and reviewed activation remain pending: one high JavaScript image finding, 31 medium/low OS package/advisory pairs, and the recorded npm origins. Live migration, grants, Cloud Run deployment and HTTP smoke tests remain NOT_RUN. [Updated evidence and exact decision](../implementation/M2-Deployment-Resume-20261018.md). No acceptance row is promoted.

Deployment execution, **2026-10-18**: founder approved the exact temporary residual-risk exception. **Medusa private staging is RUNNING and Ready**, revision `vynvori-medusa-staging-00001-qqf`, platform digest `sha256:c84b6291314cbfdb14b2193765891cd52ec6046b809d74bc42a1c67887c23f43`. Native module/link/script migration completed after one inspected deadline recovery (147 public tables / 8 sequences); seven runtime negative permission checks and 12 required deployed HTTP checks passed. Native revoke/delete resolved the synthetic-key cleanup failure. Runtime has no DDL/owner membership/bookkeeping writes or migration-secret reference/access binding. IAM remains private and operational flags OFF. [Actual result, recovery, expiry and limitations](../implementation/M2-Deployment-Result-20261018.md). Full M2, remote CI/publication and other ACC gates remain incomplete; this updates only the verified Medusa staging slice.

R2 execution, **2026-10-18**: original US-jurisdiction bucket verified private; existing credentials work with the correct US endpoint. Four synthetic live cases covered round trip, conditional no-overwrite and locally injected lost PUT/DELETE acknowledgements. All four exact test keys are confirmed absent; 18 local commerce tests, typecheck, lint and known-secret smoke passed. Founder confirmed the existing token has Object Read & Write scoped only to this bucket, completing the bounded synthetic R2 staging slice. Token scope is founder-confirmed rather than independently read through the API, which denies token metadata access. Customer asset access/scanning/expired links and whole-release acceptance remain unverified; **ACC-07 is unchanged**. The prior Medusa exact-source seal correctly rejects the changed checkout; no reseal or redeployment occurred. [R2 evidence and limits](../implementation/M2-R2-Result-20261018.md).

## v1.1 traceability and status segregation (v1.1)

M2 closure follow-up, **2026-10-18**: creative Neon staging completed backup/restore, migration/replay, restricted runtime and actual negative/transaction tests with zero fixture rows. The founder approved the exact worker ingress/residual risk, source policy and conditional publication/merge scope. The worker is deployed and Ready with all 11 remote checks passed; the fresh full image/dependency gate and root local verification passed. Combined real staging readiness reports four ready dependencies, including an additional cleaned-up R2 fixture. **Publication/remote CI/conditional merge remain pending, so full M2 is not yet complete; existing ACC requirement rows are unchanged.** [Actual runtime evidence](../implementation/M2-Closure-Result-20261018.md).

Existing `ACC-01`..`ACC-27` current statuses stay **unchanged** until actual tests. Extend *proposed* acceptance IDs in `24-traceability-acceptance-v1.1.md`: `ACC-28` dual entry/immutable 3-direction plan, `29` full quote/downstream guard, `30` promo separate + two-device race, `31` per-slot 0–3 saved partial and no double paid retry, `32` included refinement fork/skip/forfeiture, `33` qualified separately consented final + no-final gate, `34` provider/credit/public separation, `35` M8a cases/notice/remedy/hold SLA, `36` post-purchase qualification revocation, `37` 25-screen routes/mobile mocks, `38` BYO independent + physical print lineage, `39` visual approval vs backend evidence split. All proposed IDs start `NOT_RUN`/`BLOCKED` as applicable; passing Phase05 demo browser tests does not satisfy them. Prior Archivo/logo/Monumental/visual release are **founder approved**, which is separate from implementation/test acceptance. External model, legal seller, actual shipping, physical samples, IP rights, provider invoices and SOP remain blocked. [F-R01–08,E01–06]
