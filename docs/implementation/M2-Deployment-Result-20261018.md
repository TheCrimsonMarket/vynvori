# Medusa private staging — deployed 2026-10-18

**PASS for the bounded Medusa deployment slice. Full M2 and production acceptance remain incomplete.** Verified at 06:13 Bangladesh time.

| Item | Actual result |
|---|---|
| Service URL | https://vynvori-medusa-staging-srvptfc7ba-ue.a.run.app |
| Project / region | `lucky-little-devil` / `us-east1` |
| Ready revision | `vynvori-medusa-staging-00001-qqf` |
| Immutable Linux/amd64 image | `us-east1-docker.pkg.dev/lucky-little-devil/vynvori-staging-images/medusa@sha256:c84b6291314cbfdb14b2193765891cd52ec6046b809d74bc42a1c67887c23f43` |
| Source | Verified main `f923f7b26c4fc0684e26cfdf29ebf177d80103f6` plus exact uncommitted activation overlay SHA-256 `6f96a4a478eaf6c8645c24ad97f9e913370407957799f52ddb81152fc2970e89` |
| Canonical configuration hash | `bd8b4e12186ba8785d2ad80ff6073bed9f4158c79067e887fc20c9af7a92c824` |
| Native schema | Module/link/script migration completed; **147 public tables, 8 sequences** |
| Runtime | Shared mode, no Redis/separate worker; min 0/max 1, 1 CPU, 2 GiB |
| Secrets | Runtime database v3, JWT v1, cookie v1. Migration database v2 used only by local operator |

## Executed checks

- Actual Ready revision and exact image digest independently re-read. Authenticated `/health` **200**, unauthenticated **403**, including a final check after cleanup.
- Native Admin without Medusa authorization **401** despite valid Cloud Run IAM. Synthetic native login **200**, protected `/admin/m2-readiness` **200**, Admin publishable-key creation **200**. Admin UI remains disabled.
- Valid publishable key plus Admin token still receives **403** for Store mutations (including case-variant path), customer auth and registration. Admin bearer cannot authenticate as customer: **401**. All **12 required HTTP checks passed**. No real transactions or operational feature flags enabled.
- PR #7 actual catalog/binder validated ownership and explicit grants. SELECT on 147 migration-owned tables; only 12 have required startup/operator DML: `api_key`, `auth_identity`, `payment_provider` (INSERT/UPDATE only), `price_preference`, `provider_identity`, `publishable_api_key_sales_channel`, `sales_channel`, `store`, `store_currency`, `user`, `user_preference`, `workflow_execution`. No sequence/default/DDL grants or owner-role membership.
- Seven real runtime SQL negatives returned 42501: public CREATE TABLE, CREATE SCHEMA, CREATE TEMP TABLE, TRUNCATE, SET ROLE owner, SET ROLE migrator, bookkeeping UPDATE. All three migration tables are read-only and their sequences inaccessible. Other native domain writes are withheld.
- Native startup creates built-in default sales-channel/store/currency-preference/key metadata. Upstream EUR default store metadata is inert staging initialization, **not approved market/currency/merchant configuration or product pricing**. Native system-provider metadata is not a selected real payment processor. Customer/checkout mutations remain denied.
- Exactly three numeric runtime-secret references; no migration-secret reference/access binding and no runtime-SA project IAM role. Actual service/project IAM has no public principals; project has no folder/org parent. Runtime error-log query returned no ERROR entries at check time. Optional effective-IAM Troubleshooter was unavailable because its API is disabled; it was not enabled. Actual IAM and deployed secret references are the isolation evidence.

## Failures and recovery preserved

Initial migration hit the fixed ten-minute local deadline. It was stopped: container PID zero, no migration-role sessions, and all 171 committed history records matched the reviewed image. Following the directive's inspect-before-retry rule, one separately fenced/ledgered resume with the same image/role/secret/deadline skipped committed modules and completed the remaining work. **Two native command attempts** are reported. No schema reset, down migration or broad privilege was used.

The first restricted bootstrap failed on native `createDefaultsWorkflow` before user creation. Pinned source inspection identified the five additional startup tables. Counts confirmed zero partial user/auth identities and default rows before retry. Only required DML was added; negative permission tests passed again. Runtime DDL was never granted to fix startup.

Initial synthetic-key DELETE returned **400**: native module requires revocation before deletion. The failed assertion remains in raw HTTP evidence. Exact ID/title/type/synthetic creator were checked; native revoke then delete workflows completed with runtime credentials. SQL reconciliation confirmed the key is gone. The temporary cleanup script's first export shape was rejected before application operations; corrected default export succeeded. No second Admin identity or raw domain SQL cleanup was used.

The first final-image scan succeeded but ephemeral Docker-tag cleanup failed during concurrent publication. After exact-tag cleanup, the **complete fresh gate reran and passed**, including cleanup. Build provenance indexes differ, but both builds and actual registry/revision resolve to the same platform manifest above. Raw npm audit exits remain 1 (79 production / 85 full findings); acceptance is an approved exception, not a vulnerability fix. Lint, 25 historical security-policy tests, 41 staging/historical-local-policy tests, and staging/catalog/grants (15 passed / 1 optional DB fixture skipped) passed. Live Neon/permission/HTTP evidence is separate from local fixtures.

## Approval, expiry and remaining work

Founder approved strict-TLS secret versions and separately approved the exact temporary private synthetic residual risks. Braces/sprintf-js and the exact 31 medium/low OS package/advisory pairs remain unresolved; build-only esbuild remains non-exposed. Current advisory database remains mandatory; no renewal is automatic. [Activation ADR](ADR-0006-Approved-Private-Staging-Execution.md).

**Expiry: 25 October 2026, 05:59:59 Bangladesh time** (`2026-10-24T23:59:59Z`). Runtime checks expiry at admission; this does not stop an already running revision. Operator must stop/revoke the service at expiry. No scheduled shutdown/new scheduler resource was created. Preserve database, image, logs and recovery baseline; never automatically reset/drop/down-migrate.

Automatic approval review rejected a Git commit under the separate no-commit restriction. No commit/push/merge/PR occurred. Base SHA + exact source overlay + image digest seal this local release; **published-commit/remote-CI evidence is NOT_RUN**. Publication remains pending Git authorization and review of provenance handling for a published commit. Historical local-only policies remain unchanged and continue rejecting this remote scope.

Full M2 still needs creative Neon/Drizzle, private R2 and processing-worker remote acceptance. M1b, real commerce and rights/printing/payment/shipping launch gates remain OFF/blocked; existing ACC rows are not promoted by this Medusa-only result.

[Machine summary](evidence/M2-medusa-staging-deployed-20261018.json). Detailed ledgers/SQL/IAM/revision/HTTP artifacts and hash manifest: `%TEMP%/VYNVORI-M2-execute-20261018`. Passing fresh gate: `%TEMP%/VYNVORI-M2-approved-20261018-security2`; the cleanup-failed run is retained separately.
