# 13 — CI/CD, telemetry, operations and disaster recovery

## CI pipeline

GitHub Actions for workspace install (`npm ci`), lint/format, TypeScript, existing benchmark unit tests, new domain/unit/integration tests, migration generation diff, security/scanning, artifact build and Playwright E2E for changed flows. Cache dependencies by lockfile. Different job matrix for `apps/web`, `apps/medusa`, `services/image-processing`. Protect production secrets in GitHub Environments; forbid unreviewed production apply.

## Deployment plan

- `apps/web` → Vercel, Next.js supported Node runtime, environment secrets/flags, feature preview deployments; PR previews point to staging services, not live sensitive production.
- `apps/medusa` → new dedicated Medusa Cloud project; verify workspace root/build command and database migration sequence; independently deploy/rollback.
- `services/image-processing` → private GCP Cloud Run service with least-privilege service identity, controlled time/memory/concurrency, health/readiness; build pinned container.
- `packages/db` → Neon staging/dev branches and production environment; reviewed migration job with backup before risky changes.
- R2 → bucket CORS/private/public gallery policy, lifecycle cleanup and retention, key separation.
- Organization central auth → registered Vynvori client/app via existing org integration; staging and production authorized redirect origins based on verified Lucky pattern.

## Observability

PostHog for consent-appropriate product funnels, Sentry for frontend/server exceptions, structured application logs/traces for latency, model operations, print rendering and payment reconciliation. Correlation ID from browser request to Medusa and workflow/job. No sensitive prompt or PII in analytics. Internal metrics: API requests, AI cost USD/accepted design, generation failure/unknown count, wallet discrepancies, paid-order-to-QA wait, rejected proofs, print defects, shipped-on-time, R2 storage, Cloud Run job cost.

## Alerts

Critical: credits issued without captured payment, negative/imbalanced ledger, unauthorized production release, payment capture with no local order mapping after SLA, exposed bucket access, malformed auth bridge, unknown paid provider outcome beyond review limit. High: production job stuck QA, print file checksum mismatch, order/refund sync failure, product out-of-stock while preorder open, Australian batch delay threshold approaching.

## Recovery

Scheduled verification of Neon and Medusa Cloud backups/restores and R2 object retention. Recovery SOP: freeze live checkout if financial/accounting sync broken; suspend billable AI if credit ledger/provider billing uncertain; preserve event log; replay outbox/inbox idempotently after repair; never fabricate a success event. Maintain and test staging rollback for schema, provider adapter and rendering upgrades.

## Operations documentation

`runbooks/payment-missing-credit.md`, `unknown-ai-billing.md`, `stuck-print-job.md`, `r2-upload-leak.md`, `auth-outage.md`, `shipping-late.md`, `medusa-neon-reconciliation.md`, `rollback.md`. Every production alert links to safe diagnostic queries and escalation owner.
