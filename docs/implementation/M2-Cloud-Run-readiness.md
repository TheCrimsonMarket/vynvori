# M2 — Medusa Cloud Run readiness

2026-10-17 (Asia/Dhaka). **PREPARATION ONLY / DEPLOYMENT BLOCKED**. [ADR-0004](ADR-0004-Medusa-Cloud-Run.md) is the architecture record. No Cloud Run deployment, image upload, resource/credential creation, remote migration, Vercel change or operational activation is included.

## Reviewable artifacts

- `apps/medusa/Dockerfile` and its Dockerfile-specific allowlist: original digest-pinned Node 22.23.3/npm 10.9.9 build/install stages; final runtime is digest-pinned Distroless Debian 13 C/C++ libraries plus the identical official Node binary and unchanged compiled application/dependencies. No global npm/npx/Corepack/Yarn, Perl, shell or package manager is shipped. UID/GID **65532:65532**; native CLI is invoked directly with Node. Docker build executes fresh `npm ci`; `--no-audit` only separates installation from the existing unfiltered security gate, which remains mandatory and blocked. The [hardening dossier and separate A/B proposal](PR5-security-review-dossier.md#final-runtime-hardening-and-comparison) bind exact local source/dependency/image identities without activating a waiver.
- `deploy/medusa/service.yaml`: proposed single service, us-east1, dedicated proposed `vynvori-medusa-runtime@lucky-little-devil.iam.gserviceaccount.com`, immutable image digest placeholder in existing `vynvori-staging-images`. Service/revision max 1, min 0, request CPU, 1 CPU/2 GiB, concurrency 8, 60-second request timeout. Every `REPLACE_*` must be resolved from verified infrastructure records after separate approval. Template is intentionally not deployable as supplied.
- `scripts/test-medusa-container.mjs`: isolated Docker PostgreSQL, migration authorization/replay, real pg TLS, non-root runtime, native Admin/readiness access, customer/Store denial including valid publishable key, wrong actor rejection, 40 reads at concurrency 8, DB outage/recovery and process restart. Owned containers are label-checked and removed; synthetic env file is deleted; redacted evidence stays in external temp storage.
- `.github/workflows/medusa-container.yml`: local Docker tests only; no credentials, deployment or registry push. Existing security CI remains unchanged and fail-closed.

The final Linux integration includes `scripts/medusa-runtime-inventory.mjs`: it records actual Node/compiled-tree hashes and image identity, loads native GNU bindings and checks removal of global tools/Perl/MiniZip plus the vendor-fixed zlib version. Diagnostic commands use `docker exec CONTAINER /usr/local/bin/node ...`; there is intentionally no `docker exec ... sh`, `id`, apt or npm inside the runtime. Compiler tools remain available only in the build stages. Development and arbitrary shell/npm-driven CLI operations are outside the image contract; verified native start/user/migrate operations remain supported. No shell-based entrypoint is added.

Build/test from repository root:

```sh
docker build -f apps/medusa/Dockerfile -t vynvori-medusa-local:readiness .
node scripts/test-medusa-container.mjs
npm run lint
npm run typecheck:m2
npm run test:m2
npm run build:medusa
npm run security:audit
```

The last command is expected to fail on the changed security boundary. Do not suppress it. Deterministic security regression tests use independently hashed source from the immutable reviewed PR #4 baseline and pass their original fixture cases; they separately assert this current source is rejected. The production runner/policy/hashes are unchanged and never consume that test fixture. This PR must remain draft/blocked for independent review.

Local development remains `npm run dev:medusa` with operator-supplied isolated local database/secrets. `apps/medusa/.env.example` contains no credentials. Admin UI stays disabled. Native `/auth/user/emailpass` is used only with synthetic operator accounts in local tests. No customer provider is added.

## Configuration, Neon and secrets

Use the separate Medusa Neon project, `staging` branch, database `vynvori_medusa_staging`, app role `vynvori_medusa_app`. Review branch/project ownership against the actual Neon control plane before future connection; hostname pinning alone cannot prove project/branch isolation. Never use LuckyLittleDevil's commerce database. Neither images nor GitHub need database secrets.

The database secret must be a PostgreSQL URL for the verified direct host and approved role/database, with `?sslmode=verify-full` only. Reject pooled hosts, unsupported query options, wrong role/database, insecure origins and enabled operational flags. The real pg consumer test checks normalized TLS settings; local TLS integration verifies encrypted PostgreSQL with trusted CA and rejects untrusted CA/wrong hostname. **Real Neon handshake, role privileges, cold wake and pooling behavior remain NOT_RUN.** Local TLS is not proof of remote Neon configuration. Do not set `NODE_TLS_REJECT_UNAUTHORIZED=0`, `rejectUnauthorized:false`, or downgrade to `sslmode=require` to make a connection pass.

Secret Manager env references cover the database URL, JWT signing secret and independent cookie secret, pinned to numeric versions. Missing/denied secrets prevent startup. Pin replacements to a new reviewed revision for rotation, then retain prior versions only for the approved rollback window. No build args, Docker ENV secrets, credentials in YAML or GitHub secrets. The supervisor redacts configured secrets/database URLs from child output; logs must still receive separate security review for unexpected driver/provider details. No real secrets are used in the tests.

## IAM proposal — create nothing in this PR

| Principal | Proposed minimum scope |
|---|---|
| Medusa runtime SA (new identity above) | `roles/secretmanager.secretAccessor` on only the three Medusa secrets. No project-wide Editor, Artifact Registry writer, Cloud SQL, image-worker role, storage/admin, key creation or IAM administration |
| Cloud Run service agent | Existing platform image-pull role; verify Artifact Registry reader on this repository if needed. Image pulling is not a reason to grant runtime SA registry write |
| Future deployer | Reviewed Cloud Run deployment permissions scoped to this service; `roles/iam.serviceAccountUser` only on Medusa runtime identity. Separate approver controls IAM policy. Artifact Registry writer only on staging repository for a separately authorized image publisher |
| Future migration operator/job | Separately authorized execution and database migration credentials; no runtime-triggered migration endpoint. Separate identity/secret scope and zero automatic retries if a Job is chosen |
| Future Vercel invoker | `roles/run.invoker` only on this service, after reviewed federated trust. No Admin API role implicit in Cloud Run IAM |

Cloud Run ingress `all` permits the future Vercel server to reach the IAM boundary over HTTPS; it does not make invocation public. IAM invoker checking remains enabled, with **no** `allUsers`/`allAuthenticatedUsers` bindings. Review the effective IAM policy before any exposure; a YAML service cannot prove absence of old IAM grants. Never reuse `vynvori-image-worker` or download service-account keys.

The runtime PostgreSQL app role must have only the required database/schema/table/sequence privileges. Migration ownership must be separated from runtime DML grants before remote use; do not make the app role a Neon project owner/superuser. Native migrations require DDL. Proposed database role `vynvori_medusa_migrator` owns schema changes and grants runtime privileges on existing/future objects; its creation/credentials need separate approval. Staging configuration accepts this role only for explicit migration authorization; the serve supervisor removes that authorization before loading runtime config. The migration credential belongs in a separate migration-only Secret Manager reference, never the service template. Validate actual Medusa startup/queries under those grants and prohibit runtime DDL; this least-privilege remote test is **BLOCKED**, not inferred from the local synthetic owner test.

## Separately authorized migrations

Normal image startup runs `serve` only. It never runs `db:migrate`, `db:setup`, seed, user creation or framework synchronization commands. No custom database migrations are added by this PR.

Before a future staging migration: independently approve exact image digest/native migration list, verify target project/branch/database/role via control-plane evidence, record a tested Neon backup/restore point, quiesce all service revisions/invocations, stop concurrent migrators and review expand/contract compatibility with the rollback image. Pin direct connection and secret versions; use the controlled migration identity. Preserve evidence outside source, redact logs, and stop on any uncertain result.

For a separately approved local/container execution with a protected env file:

```sh
docker run --rm --env-file /protected/medusa-migration.env \
  -e M2_AUTHORIZE_MEDUSA_MIGRATION=vynvori_medusa_staging \
  REVIEWED_IMAGE_BY_DIGEST migrate
```

This invokes native `medusa db:migrate` from compiled `.medusa/server`, with a 10-minute process deadline. The authorization string is an accident-prevention guard, not a credential or permission grant. Keep the file outside the repo; do not put its values on a command line. A future one-off Cloud Run Job may use this same image/`migrate` argument, approved migration SA/secret refs, one task/parallelism 1, retries 0 and bounded execution. It is a migration operation, not a second worker/service. No Job or remote execution is created here.

After success: inspect native migration state, run protected Admin/readiness API smoke with synthetic data, verify no customer/Store activation and record evidence. Replay only after inspecting migration outcome; never auto-retry on timeout. Test schema/table ownership and grant the app role only the reviewed privileges. Service activation requires its own security/deployment approval.

## Probes, availability and future Vercel access

Startup/liveness use native `/health` without dependency details. Supervisor startup deadline is 180 seconds; Cloud Run startup probe gives 36 attempts at 5 seconds with 2-second probe timeouts. SIGTERM allows native shutdown then escalates after 8 seconds. Liveness checks at 30-second intervals restart only a wedged process. Protected `/admin/m2-readiness` returns 401 without user auth, 200 on DB connectivity and generic 503 on bounded failure; it must not become a public Cloud Run readiness probe or carry an Admin bearer in YAML. Readiness owns a short-lived pg connection: connect timeout 1 second, statement/query timeout 2 seconds, maximum eight concurrent probes, no retry or second cancellation connection. Socket termination and query settlement are awaited before failure; request disconnect closes the owned connection. The Linux HTTP regression limit is 4 seconds including scheduling allowance. This probes connectivity, not the shared pool, and may fail closed during a Neon cold wake. Database outages do not turn liveness into a restart loop. `SELECT 1` is not evidence that migrations completed. See the [measured defect and security dossier](PR5-security-review-dossier.md).

For a future approved Vercel server/BFF path: server-only environment contains the private Cloud Run origin; use Vercel OIDC exchanged through tightly scoped Google Workload Identity Federation (team/project/environment claims) and a dedicated invoker identity to obtain an audience-bound Cloud Run ID token. Validate actual federation/audience/revocation behavior in a later task. Use `X-Serverless-Authorization` for Cloud Run IAM where an application Authorization header is also required. Cloud Run IAM is service authentication, not human identity. Browser never receives the ID token or Admin credentials. BFF exposes only explicitly allowlisted Store reads with no arbitrary path forwarding, redirects or caching of private responses; publishable keys are not user authorization. No `/admin`, internal diagnostic or native user-auth proxy is exposed. Customer auth/mutations wait for the M1b issuer+subject trust remedy and separate authorization. No Vercel configuration, domain or implementation changes here.

## Resource estimate and operational cost

Initial target is 1 CPU/2 GiB with concurrency 8, not a proven production capacity. Final local Docker smoke measured 11.026 seconds to health, roughly 225–250 MiB sampled container memory, and p95 108 ms for 40 protected readiness reads at concurrency 8. An earlier run measured 5.136 seconds and p95 36 ms, demonstrating local variability. These are small synthetic local samples with a warm local database, not Cloud Run cold-start, peak migration memory, real commerce latency or a load-test SLA. Retest on the exact reviewed image with Neon before acceptance; measure CPU saturation, cold/warm p95, OOM, connection totals and idle wake. No resource reduction is justified by these samples alone.

At published us-east1 request-based list rates, 1 CPU + 2 GiB active compute is approximately **$0.000029 per active second**, or **$0.1044 per active hour**, before shared free-tier/discounts. Illustrative 10 active hours/month = **$1.044 compute**; 100 hours = **$10.44**, plus $0.40/million requests. Startup/probe/shutdown time, image storage/scanning, network egress, logging, Secret Manager and Neon billing are additional. A continuously active 30-day month is about $75.17 compute before those extras. Min 0 avoids reserved idle-instance cost; it does not promise a zero invoice. Maximum instances is not a spend cap, and revision overlap/restarts add costs. No live billing account or Neon plan was inspected; these estimates are not a supplier quote.

Scale-to-zero loses all in-memory state. Request-based CPU can stop between requests; no background task completion, scheduled-job timing, notification delivery, event replay or durable sessions are promised. Max 1 limits throughput and redundancy; queued requests can fail. Ephemeral files consume memory and disappear. Native startup may warn about local event bus/fake Redis/MemoryStore; no Redis service is activated. No payment/provider/print work may depend on these defaults.

## Security review blockers and rollback

Final-stage hardening reduces the same-database unfiltered image scan from **241 OS / 22 JavaScript pairs** to **31 OS / 1 JavaScript pair**, with **zero remaining critical or OS-high matches**. Perl is absent; retained zlib is vendor-fixed for CVE-2023-45853. The Node binary, compiled Medusa application and installed application-package inventory are unchanged byte-for-byte/by identity. [Exact comparison](evidence/pr5-hardening-comparison.json) preserves all remaining findings and identities; the old image report remains historical evidence. The full all-dependency npm audit is separately recorded (85 propagated findings, including developer-tool esbuild); production audit remains 79 and fails closed. Neither scan is suppressed or treated as an approval.

The exception at `security/m2-exception-policy.json` is **LOCAL M2 ONLY**. Its policy, hash anchor, audit fixtures and evaluator are unchanged. Changed Medusa source and new container surface invalidate the exact fingerprint. Executed `npm run security:audit` returned **REJECTED / SECURITY_BOUNDARY_CHANGED** with raw audit exit 1. CI must stay fail-closed; no refresh, waiver or reinterpretation is included.

Independent security review must resolve remaining originating advisories (`braces` GHSA-vfj7-8cjw-p6xm and `sprintf-js` GHSA-hp3w-g68c-fv3c), inspect the complete fresh runtime dependency graph/container OS scan and SBOM, assess startup/migration discovery and remote reachability, and approve a separately implemented resolution. Also review container supervisor/redaction/signal handling, image provenance/digest, effective IAM/secret scope, Neon identity/TLS/role grants, native Admin exposure, Vercel federation and M1a trust blockers. The local exception expires or becomes unusable before remote exposure/M1b and cannot satisfy any of these gates.

Keep two decisions separate: **A** may only consider the exact reviewed local/isolated-runner preparation source, lock and scanned image with remaining risks acknowledged; **B** is remote Cloud Run staging and remains unauthorized. The current image refuses remote contexts. No deployable B fingerprint has been issued; guard removal/config changes would need a new independently reviewed commit and image. See the dossier for exact identifiers and proposed bounded A scope. Do not implement either exception or remove the guard from this runbook alone.

Local rollback: revert this PR's exact commit after review; no remote state exists. Future service rollback: quiesce traffic, keep all feature flags disabled, restore the prior reviewed image/config/secret versions only if compatible with the applied schema, then run protected synthetic smoke. If schema compatibility is uncertain, leave service inaccessible and restore a verified backup into an isolated recovery branch/database, reconcile native migration state and obtain approval before switching. Never run automatic `db:rollback`, drop a database or overwrite an existing Neon branch. A container revision rollback does not undo migrations. For the first deployment there may be no prior service revision: keep it inaccessible/remove traffic and recover the database independently.

## Validation status

| Gate | Result |
|---|---|
| Fresh locked container build and compiled runtime | PASS local Docker; native warning about optional tsconfig-paths remains nonfatal |
| Existing M2 tests/typecheck, affected lint and backend build | PASS; PostgreSQL test skips without explicit local creative DB URL; 2 POSIX lifecycle cases skip on Windows |
| Local PostgreSQL migrations twice, Admin boundary, outage/recovery/restart, resource smoke | PASS; external temp results recorded above |
| Local TLS encrypted pg connection, CA and hostname rejection | PASS with real installed Medusa pg against local TLS PostgreSQL; no remote Neon acceptance implied |
| Exact dependency exception/security CI | BLOCKED: source fingerprint changed; unchanged gate rejects |
| Cloud Run/IAM/Secret Manager/Artifact Registry runtime | NOT_RUN; no deployment or resource mutation |
| Neon project/branch/role grants/live TLS/pooling | NOT_RUN / BLOCKED pending independently authorized verification |
| Cloud Run resource sizing and rollback drill | NOT_RUN remotely; local sample only |
| M1b/customer auth, payments, Store mutations, production | DISABLED / BLOCKED; M1a findings preserved |

Sources checked 2026-10-17: [Medusa self-hosted deployment](https://docs.medusajs.com/learn/deployment/general), [pg TLS URL precedence](https://node-postgres.com/features/ssl), [Neon transaction pooling](https://neon.com/docs/connect/connection-pooling), [Cloud Run health checks](https://docs.cloud.google.com/run/docs/configuring/healthchecks), [Secret Manager injection](https://docs.cloud.google.com/run/docs/configuring/services/secrets), [service authentication](https://docs.cloud.google.com/run/docs/authenticating/service-to-service), [Cloud Run pricing](https://cloud.google.com/run/pricing). Reviewed sources establish configuration mechanics; they do not establish this project's deployed state.

Independent-review correction evidence: final local `%TEMP%/VYNVORI-medusa-container-2CRJkS` includes query/connect/termination timing, repeated HTTP outages, recovery, remote-context refusal and clean shutdown; unchanged live-audit evidence `%TEMP%/VYNVORI-M2-security-7kelwr` rejects the source. Sanitized [container results](evidence/medusa-cloud-run-local.json), [original diagnosis](evidence/pr5-readiness-diagnosis.json) and [unaccepted image inventory/findings](evidence/pr5-container-security.json) are included. Six Medusa configuration/readiness/template tests and 25 historical-baseline/current-rejection security-policy tests pass locally. The earlier local-only success at reviewed head did not establish Linux acceptance; its actual Linux failure and the correction are recorded in the [dossier](PR5-security-review-dossier.md). Exact-head GitHub checks must be reviewed separately. The supervisor refuses `K_SERVICE`, `CLOUD_RUN_JOB` and `VERCEL=1`; no amended exception or remote activation is included.

Final container-hardening evidence: fresh no-cache Docker build; complete minimal-image tests in `%TEMP%/VYNVORI-medusa-container-kkWxpZ`; identical-database before/after scans and full all-dependency npm audit in `%TEMP%/VYNVORI-pr5-hardening`; production-policy rejection in `%TEMP%/VYNVORI-M2-security-Vx0ms8`. [Hardening comparison/identities](evidence/pr5-hardening-comparison.json) and [latest local runtime results](evidence/medusa-cloud-run-local.json) supersede the prior image's local measurements. GitHub's final-head Linux/browser/M2 results are recorded in PR #5 to avoid changing the tested commit merely to add its own SHA. No canonical technical chapter or approved policy/expiry/fingerprint is edited.
