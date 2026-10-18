# M2 closure — runtime evidence, 2026-10-18

**All four real staging dependency checks PASS. Publication/CI acceptance is pending until the approved PR is checked.** This report does not claim a production gate or working SSO.

| Workstream | Executed result |
|---|---|
| Medusa | Original private revision `vynvori-medusa-staging-00001-qqf` unchanged; platform digest `sha256:c84b6291314cbfdb14b2193765891cd52ec6046b809d74bc42a1c67887c23f43`. Fresh IAM/health recheck: no public principals, anonymous 403, authenticated 200. Earlier native schema/Admin/runtime-denial evidence remains applicable |
| Creative Neon | Existing project `shy-water-16757830`, branch `br-nameless-waterfall-b891fhyx`, DB `vynvori_creative_staging`. Native PG18 backup/restore, migration + known-complete replay, single history record; separate pooled runtime role with SELECT/INSERT only, eight 42501 negatives, actual constraint/rollback tests and zero fixture rows |
| R2 | Original `vynvori-staging-assets`, jurisdiction `us`, remains private. Founder confirmed bucket-only Object Read & Write. Original four cases cleaned up; final combined probe also completed one PUT/one DELETE, verified exact bytes and confirmed absence |
| Processing | Private worker deployed and Ready: `vynvori-staging-image-processing-00001-82q`, platform digest `sha256:73467ae3c71e71e6cfced0f368a6355c6dc4414c78348eaf0c63d4cbf89d502b`. All 11 remote HTTP/auth/limit/replay tests passed; `printed:false` |

Worker URL: `https://vynvori-staging-image-processing-srvptfc7ba-ue.a.run.app`. Medusa URL: `https://vynvori-medusa-staging-srvptfc7ba-ue.a.run.app`. Both require Cloud Run IAM; a normal anonymous browser is rejected. Medusa Admin UI remains disabled as recorded in the approved M2 foundation.

Worker uses existing `vynvori-image-worker` SA with no project roles, only its new token secret version 1, no public IAM principal and no binding on any of the four Medusa secrets. Runtime has no DB/R2/provider/migration credentials. Min 0/max 1, 1 CPU/256 MiB, concurrency 4, timeout 15 seconds. The founder explicitly approved changing the planned worker network boundary to an externally routable IAM-protected endpoint, its exact 31 OS findings and the allowlisted publication/merge-after-green-CI batch. The internal-only template is retained; the approved deployed source file keeps its original `.proposed.yaml` name to preserve its reviewed digest.

## Security and provenance

The new worker image has **zero critical/high findings**, 23 medium and 8 low, none with a reported fix. Its exact OS finding set matches the prior Medusa OS review. Whole-repo raw npm audits still exit 1 with **79 production / 85 full findings**. The Medusa image still has its previously explicitly accepted JavaScript residual risk; the worker's zero-high result does not fix or waive that risk.

The founder-approved exact source policy digest is `abedb2518665b13e53cb9a83c9c6504310ab58266361ceb6f37b7bcc8105c5af`; 133-file overlay digest `e8b850d0c761bd5caa9c7d4c2d51c4a2c44a41a5e529f2809d7c6416c3ba3054`. Published descendants of the immutable base are permitted only with that exact complete source inventory. Audits, image/runtime identity, fresh scanner database and expiry checks remain mandatory. The **complete fresh local gate passed**, including image scan and owned-resource cleanup, with `ACCEPTED_WITH_FOUNDER_PRIVATE_STAGING_EXCEPTION`. Raw audits remain nonzero. An initial gate invocation lacked its required local-synthetic marker and stopped before image work; the properly scoped full rerun passed without relaxing the check.

**Expiry is unchanged: 25 October 2026, 05:59:59 Bangladesh time (`2026-10-24T23:59:59Z`).** Operator stop/revocation is required at expiry; no automatic shutdown/scheduler resource was created. Do not start real customer operations or assume M1b source changes can borrow this exact-tree M2 exception.

## Validation and known limits

`npm run verify` PASS; affected M2 typechecks/tests/lint/migration metadata, real disposable PostgreSQL permissions/replay, web build and exact credential leak scan PASS. `verify:reference` confirms 202 recorded protected entries, 146 reference payloads and nine copied assets. Only the authorized acceptance status-note hashes were updated, preserving their previous hash pair/history; other 201 protected entries were unchanged. Forty-two staging/historical-policy checks passed after activation. Default DB/platform skips remain explicit; the separate live Neon test had zero skips.

The combined operator run returned four `ready/OK` results. It used the existing Medusa adapter's caller-supplied authenticated fetch transport; the bare default adapter and generic smoke command do not mint Cloud Run IAM tokens. Processing likewise receives a freshly minted token in memory. This is an operator readiness result, not a public health expansion, Vercel-to-private-service deployment or M1b token-lifecycle implementation. No token value is included in evidence or browser bundles.

Current source is local until publication below. Remote CI and merge must be independently verified before full M2 is promoted. Operational flags, customer auth/Store writes, paid AI, payments, print release, exports and gallery publication remain OFF. M1a central issuer/client/product validation, registration/provenance, revocation/session/provisioning and staff-policy gates remain separate M1b prerequisites.

[Combined readiness](evidence/M2-combined-staging-readiness-20261018.json), [worker deployment](evidence/M2-worker-deployed-20261018.json), [creative evidence](evidence/M2-creative-staging-20261018.json), [Medusa recheck](evidence/M2-medusa-recheck-20261018.json), [approved release decisions](M2-Closure-Release-Review-20261018.md), [architecture/rollback](ADR-0008-M2-Closure-and-Published-Provenance.md). Full native backup, ledgers, scans and execution artifacts remain under `%TEMP%/VYNVORI-M2-close-20261018`; credentials stay in ignored local configuration and the named Secret Manager version.
