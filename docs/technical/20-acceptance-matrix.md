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

### M2 Cloud Run preparation — 2026-10-17

ACC-24 remains **NOT_PASSED / BLOCKED** for deployment: [ADR-0004](../implementation/ADR-0004-Medusa-Cloud-Run.md) and [readiness evidence/runbook](../implementation/M2-Cloud-Run-readiness.md) prepare one shared-mode Medusa Cloud Run service only. Local container/migration/boundary/restart/outage smoke passed; remote Cloud Run, Neon identity/privileges, IAM, rollback drill and resource acceptance remain NOT_RUN. The unchanged LOCAL M2 dependency exception rejects the changed source fingerprint; independent security resolution is required. No customer authentication, Store mutation, payment or production gate passes through these tests.

A row can be `PASSED` only with a reproducible link to test/evidence. No “conditionally passed” row may satisfy a mandatory production launch gate. A coding agent must not change founder-approved scope to make a test easier. Any architecture deviation requires an ADR and explicit founder approval.

## v1.1 traceability and status segregation (v1.1)

Existing `ACC-01`..`ACC-27` current statuses stay **unchanged** until actual tests. Extend *proposed* acceptance IDs in `24-traceability-acceptance-v1.1.md`: `ACC-28` dual entry/immutable 3-direction plan, `29` full quote/downstream guard, `30` promo separate + two-device race, `31` per-slot 0–3 saved partial and no double paid retry, `32` included refinement fork/skip/forfeiture, `33` qualified separately consented final + no-final gate, `34` provider/credit/public separation, `35` M8a cases/notice/remedy/hold SLA, `36` post-purchase qualification revocation, `37` 25-screen routes/mobile mocks, `38` BYO independent + physical print lineage, `39` visual approval vs backend evidence split. All proposed IDs start `NOT_RUN`/`BLOCKED` as applicable; passing Phase05 demo browser tests does not satisfy them. Prior Archivo/logo/Monumental/visual release are **founder approved**, which is separate from implementation/test acceptance. External model, legal seller, actual shipping, physical samples, IP rights, provider invoices and SOP remain blocked. [F-R01–08,E01–06]
