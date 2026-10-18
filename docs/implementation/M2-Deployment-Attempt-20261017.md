# M2 private Medusa deployment attempt — 2026-10-17

**BLOCKED; no Cloud Run service or revision deployed.** The founder directive authorizes private synthetic staging builds, publication, one initial native migration on the verified empty staging database and deployment. This attempt exercised the deployment path; it is not a new infrastructure-preparation PR.

## Source and image

- Initial clean checkout: `229e251987ea1f907b9658f5f8d6b0c92d16a953`.
- Fetched and verified latest main including merged PR #7: `f923f7b26c4fc0684e26cfdf29ebf177d80103f6`.
- Working branch: `codex/medusa-staging-deploy`. No Git commit or push performed.
- Existing root-context Dockerfile built successfully for linux/amd64 with pinned bases and Medusa 2.21.2. Workspace dependency installation and native backend compilation succeeded inside the build. No dependency/source changes were made to the image.
- Published review image: `us-east1-docker.pkg.dev/lucky-little-devil/vynvori-staging-images/medusa@sha256:f7ed3cbe7b3231764ea61ffdfd10de717c30e110fa5df4cf52ec8587f63aa64d`.
- Tag: `review-f923f7b-20261017`. Artifact Registry independently confirmed the manifest digest. Runtime config digest: `sha256:e93f5e397b08587f855ad945ecb01ce3387884be1eab0e1cd3c8c8d9402cf014`.
- This is a review artifact, not an activated release: its bundled remote policy remains unapproved. Activation would change image bytes and require a rebuilt image and scan.

## Live read-only verification

Cloud Run `vynvori-medusa-staging` was absent in `lucky-little-devil/us-east1`. Existing Artifact Registry repository was reused; its IAM policy had no public principals. The project has no organization/folder ancestor, and the inspected project policy had no public principals. The runtime service account has no user-managed keys. Runtime database secret has its expected runtime-SA accessor binding; migration secret has no secret-level accessor bindings. Project IAM contains no binding for this runtime SA. No migration-secret access was granted to runtime.

Runtime secret version 2 is enabled and old version 1 disabled; migration secret version 1 is enabled. Both database URLs contain `sslmode=require` and `channel_binding`. PR #7's catalog/config validation rejects these options (`CATALOG_URL_OPTIONS_INVALID`). Neither URL is directly deployable under the reviewed configuration.

For read-only diagnostics only, in-memory copies were normalized to `sslmode=verify-full`; host, database, scoped usernames and passwords were preserved. TLS certificate verification stayed enabled. No secret value was printed or persisted.

- Exact direct host: `ep-small-sea-b8ll8zn3.c-14.us-east-1.aws.neon.tech`.
- Both connections verified `vynvori_medusa_staging`, with session/current users matching their dedicated scoped login.
- PR #7 actual catalog collection as `vynvori_medusa_runtime_scoped`: **0 public tables/sequences, 0 public functions**; repeatable-read, read-only snapshot.
- Runtime: no role memberships, superuser, CREATEDB, CREATEROLE, replication, BYPASSRLS, TEMP or public-schema CREATE.
- Migration login: no superuser, CREATEDB, CREATEROLE, BYPASSRLS or TEMP; public-schema CREATE true. Its independent read-only object count was zero.
- No live migration, table grants, domain mutations or recovery operation ran. Founder-provided Neon branch/baseline/recovery identifiers were not independently reverified through the Neon control plane in this attempt.

## Security evidence and concrete blockers

Fresh standard npm audits completed after the automatic reviewer initially rejected metadata upload; inspection showed all 1,472 downloaded lockfile packages resolve to the configured `registry.npmjs.org`, and the evidence-backed retry was approved. Production audit exited 1: 79 propagated findings (76 high, 3 moderate), originating in `braces` and `sprintf-js`. Full audit exited 1: 85 findings (78 high, 7 moderate), additionally including build-only `esbuild`. No vulnerability was claimed fixed.

Pinned Trivy scanned the built image without severity, unfixed or VEX suppression: 31 OS package/advisory pairs (23 medium, 8 low), plus high `braces@3.0.3` / `CVE-2026-93687`. Existing source review traces braces to trusted module/entity/migration discovery and sprintf-js to fixed CLI formatting; this attempt does not establish that every native Admin request path is unreachable. The native remote surface remains untested. These findings require explicit disposition; historical local-only exceptions do not authorize this release.

**Freshness blocker:** fresh downloads from both the default mirror and official `ghcr.io/aquasecurity/trivy-db:2` returned the same expired advisory database:

- UpdatedAt: `2026-10-16T01:13:54.947090392Z`.
- NextUpdate: `2026-10-17T01:13:54.947090202Z` (07:13:54 Bangladesh time).
- Downloads: `2026-10-17T05:10:35.97856233Z` and `2026-10-17T05:12:19.732399272Z`.

The scan executed now, but **does not satisfy current-database acceptance**. No clock manipulation, stale-cache fallback or security-test bypass was used. The source seal still rejects latest main as `UNAUTHORIZED_ACTIVATION_DELTA`; neither historical seal was changed. Remote activation remains false pending a narrowly reviewed replacement scope and acceptable scan evidence.

**Secret-configuration blocker:** automatic approval review rejected adding normalized versions to the existing runtime/migration secrets. Its stated reason was that this persistent secret/configuration mutation was not explicitly authorized by the directive. Proposed change: add new versions only, retaining exact host/database/logins/passwords and replacing URL options with `sslmode=verify-full`; preserve existing versions and IAM. The rejected action did not execute. Both original secrets remain unchanged.

## Validation and deployment result

- Staging validation tests: 12 passed, 1 live-DB optional test skipped.
- Security-policy unit tests: 25 passed. This does **not** mean the actual exception gate accepts this source.
- Existing local Docker integration suite against the exact built image: PASS. Covered native migration/replay on disposable PostgreSQL, scoped-role restrictions, Admin authorization, customer/Store denials, outage/recovery, restart, TLS negatives and 1 CPU/2 GiB smoke. Cold start 5,393 ms; 40 requests at concurrency 8, p95 31 ms; approximately 257 MiB observed.
- Real staging schema migration: **NOT_RUN**. Actual pre-migration table/sequence count: **0**.
- Real runtime grant plan/application and permission tests after migration: **NOT_RUN**.
- Cloud Run URL/revision/Ready and deployed authenticated/unauthenticated HTTP tests: **NOT_RUN; service absent**.
- No public access, live transactions, feature activation, new cloud resource or permission expansion occurred. No application source/policy change was activated.

External evidence: `C:\Users\User\AppData\Local\Temp\VYNVORI-M2-deploy-20261017` (audits, scan, both database metadata files and sanitized catalog); local integration: `C:\Users\User\AppData\Local\Temp\VYNVORI-medusa-container-QFMCEe`.

The approval decision, if the founder chooses an exception, must name both the new strict-TLS secret versions and the exact temporary advisory/freshness risk. An alternative is to wait for an upstream-current database. A stale-DB exception must not silently renew or claim current scan acceptance. Deployment remains incomplete.
