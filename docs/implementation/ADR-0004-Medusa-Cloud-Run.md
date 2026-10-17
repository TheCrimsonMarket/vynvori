# ADR-0004 — Single-service Medusa staging on Cloud Run

2026-10-17 (Asia/Dhaka). Proposed for independent review; no cloud execution authorized.

## Context and decision

The founder requests self-hosting instead of Medusa Cloud for this staging slice. Base is merged PR #4, `259d3883f9d346cbfd117b014beb6bc5d9b18a72`. Initial clean checkout was `c5fe26b9296ed4d82aa57d32be44f3989d7408a1`; fetched main and created `codex/medusa-cloud-run`. Canonical chapters retain historical Medusa Cloud language; this ADR records the newly authorized staging direction without rewriting historical decisions. Existing frontend/reference, M1a source audit and security exception are preserved.

Use one proposed `vynvori-medusa-staging` Cloud Run service in `lucky-little-devil/us-east1`, Medusa CLI/framework/backend **2.21.2**, explicit `shared` mode, native local event/workflow defaults, no Redis and no new queue or worker service. Request-based CPU, min 0/max 1, initial concurrency 8, 1 CPU/2 GiB. Deployments/revision overlap can temporarily exceed a revision limit; this cap is not a distributed lock. No correctness requirement may depend on singleton execution.

The npm root lockfile controls separate build and production dependency stages. Only Medusa source and workspace manifests enter the build context. Runtime starts compiled `.medusa/server` as UID 1000. No install or migration occurs at instance startup. The same image offers an explicit, separately authorized native `db:migrate` command. No custom schema migration is introduced.

Use a pinned, direct Neon hostname, `staging` branch, dedicated database `vynvori_medusa_staging` and runtime role `vynvori_medusa_app`. URL must declare `sslmode=verify-full`; configuration validates and removes URL SSL options and supplies `rejectUnauthorized: true` to the actual pg/Knex driver. Arbitrary URL overrides are rejected. Pool min 0/max 5, connect timeout 5 seconds; the pinned shared loader retains a 60-second acquisition timeout and does not forward arbitrary pool overrides. The five-connection setting applies per Knex pool, not a proven global cap over all Medusa consumers. No Drizzle writes to Medusa tables.

Direct Neon connections are the initial safe choice: transaction pooling removes session semantics (`SET search_path`, session advisory locks, LISTEN/NOTIFY). Installed Medusa 2.21.2 sets Knex `searchPath`; pooled compatibility is not established. Pooler hosts are rejected until a separately reviewed compatibility test enables them. No endpoint hostname, branch mapping or project identity is invented.

## Interfaces and failure behavior

- Existing `GET /health`: database-independent HTTP startup/liveness; supervisor bounds startup at 180 seconds. Database loader connects before HTTP boot. SIGTERM forwards to native Medusa with 8 seconds before forced termination. Failed startup never becomes success.
- Existing `GET /admin/m2-readiness`: native user authentication, no cache, owned diagnostic pg connection with 1-second connect and 2-second statement/query timeouts, awaited socket termination and generic 503 on failure. No shared-pool borrow, cancellation connection or abandoned query. Maximum eight concurrent diagnostics, with fail-closed overload. This tests connectivity, not shared-pool availability or migration completeness. Protected post-migration API smoke is mandatory. No secret token in public probe config.
- No new public commerce API or business event. Customer providers remain empty; customer auth and Store writes stay denied by M2 middleware, even with a valid publishable key. All operational flags remain disabled. No customer/SSO bridge implementation.

## Consequences and alternatives

Shared mode has no durable in-memory event, job, lock, workflow or session guarantee across restart, CPU throttling or scale-to-zero. Scheduled work can stop. MemoryStore warnings are expected; only synthetic bearer-based Admin testing is supported. Local file uploads are ephemeral and must not be used. This architecture cannot serve live commerce, payments, customer sessions, background rendering or production fulfillment. Adding Redis, durable workers or queues is outside this decision.

Min-one/instance-based CPU and separate durable workers would improve background availability but are outside the approved architecture. Redis-free single-service staging is viable only while those workflows are disabled. Availability is limited by cold starts, one instance, Neon wake latency and request queuing. Security review and exact-head CI are hard blockers; the old local exception cannot authorize this architecture.

## Security, migrations, rollback and evidence

See [readiness/runbook](M2-Cloud-Run-readiness.md) for IAM, secret references, independently authorized migration procedure, rollback, resource/cost measurements and explicit blocked gates. No schema/API event changes or remote migrations were performed. Roll back code via reviewed revert; future service rollback requires a compatible prior image/config and database recovery assessment. Never automatically reverse native migrations.

Independent-review corrections: [PR #5 security dossier](PR5-security-review-dossier.md) records the measured Linux timeout, resource-release strategy, historical policy regression tests and unaccepted container findings. The supervisor now refuses Cloud Run service/job and Vercel contexts; removal of this local-preparation interlock requires separately approved security and remote execution review.

Sources checked 2026-10-17: [Medusa deployment](https://docs.medusajs.com/learn/deployment/general), [configuration](https://docs.medusajs.com/learn/configurations/medusa-config), [node-postgres TLS](https://node-postgres.com/features/ssl), [Neon pooling limitations](https://neon.com/docs/connect/connection-pooling), [Cloud Run billing](https://docs.cloud.google.com/run/docs/configuring/billing-settings). Installed 2.21.2 `framework/dist/database/pg-connection-loader.js`, `utils/dist/modules-sdk/create-pg-connection.js`, `utils/dist/dal/mikro-orm/mikro-orm-create-connection.js` and CLI argument definitions were also inspected; no version-specific extension mismatch was found.
