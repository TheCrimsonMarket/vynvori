# Creative staging execution plan — 2026-10-18

Scope: finish M2 using the existing creative staging database. Starting checkout `12a6ab3c07630b0b1613080bfc191f18cf0760aa`; preserve all existing work. The founder supplied the two requested staging migration settings after being told this credential is for migration/setup only and a separate restricted runtime identity is required.

Verified through the signed-in Neon console and catalog-only read transaction: project `shy-water-16757830` (`vynvori-creative`), branch `br-nameless-waterfall-b891fhyx` (`staging`), PostgreSQL 18, existing database `vynvori_creative_staging`, owner `vynvori_staging_app`. Direct endpoint `ep-patient-dust-b8dmxyrl.c-14.us-east-1.aws.neon.tech`; runtime pooler is the corresponding `-pooler` endpoint. This is separate from Medusa's project/database. Root `DATABASE_URL` addresses the **production** branch and is never a setup/migration fallback. Its owner credential was not reused after automatic approval review rejected that attempt.

Preflight verified zero user relations. The existing owner has CREATEDB, CREATEROLE and BYPASSRLS, so it is unsuitable for runtime. A verified TLS 1.3 client connection and native `pg_dump` backup are recorded outside the checkout. Backup SHA-256 `b603766a5131123e09475095d518f527412bcbdbbb5ac9814f2945acc35d53a4`, 976 bytes, restored successfully into disposable local PostgreSQL 18 with zero user relations. Metadata/ACLs are captured separately. The temporary credential file and restore container were removed. Initial backup preflights stopped on a proxy/backend TLS-observation mismatch and a missing CA bundle; client certificate verification remained enabled. A public bundle from Node's built-in trusted roots enabled native verify-full backup. Failed zero-byte dump files are retained separately.

## Bounded execution

1. Revalidate exact project, branch, database and role using the supplied direct staging credential. Verify the backup hash and still-empty catalog. Hold a session advisory lock and persist a one-attempt migration ledger before native Drizzle execution.
2. Apply the unchanged reviewed `packages/db/migrations/0000_organic_valkyrie.sql`: additive `vynvori_infrastructure.synthetic_probes`, fixed-fixture constraint, plus Drizzle's bookkeeping schema/table/sequence. After successful reconciliation, one explicit replay check may verify a stable single history record. No retry after unknown completion.
3. Create only `vynvori_creative_runtime_scoped`, with a new random credential stored in ignored local `.env`, not the report or process arguments. Persist setup intent before its transaction. Keep `vynvori_staging_app` as migration/setup-only. Do not copy either credential to Medusa or the worker.

```sql
-- Role password generated privately by the operator; never included here.
CREATE ROLE vynvori_creative_runtime_scoped LOGIN
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT CONNECTION LIMIT 3;
REVOKE CREATE, TEMPORARY ON DATABASE vynvori_creative_staging FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE vynvori_creative_staging TO vynvori_creative_runtime_scoped;
GRANT USAGE ON SCHEMA vynvori_infrastructure TO vynvori_creative_runtime_scoped;
GRANT SELECT, INSERT ON vynvori_infrastructure.synthetic_probes TO vynvori_creative_runtime_scoped;
```

This targets only the named database on the staging branch. No owner/migration membership, DDL, TEMP, UPDATE, DELETE, TRUNCATE, sequence, default or migration-history grant goes to runtime. No other database ACL is changed. Other database connection defaults are not asserted revoked by these grants.

4. Configure `M2_CREATIVE_DATABASE_URL` with the new runtime identity and observed pooled host, plus `M2_CREATIVE_DATABASE_HOST`; append only if these keys are absent. Preserve `DATABASE_URL`, migration settings and R2 credentials. Verify actual runtime flags/membership/ownership, eight denied privileged operations, real constraints/transaction rollback and zero remaining fixture rows. Reconcile failures before any new mutation.

## Rollback and acceptance

Keep feature flags OFF. Prefer retaining the additive schema/history and withholding the new credential if activation fails. No automated DROP, branch reset, down migration or overwrite of the production branch is permitted. If restoration is needed, restore the preserved backup into a separately approved recovery target and explicitly review cutover/data loss; the restore drill does not authorize such a cutover.

The separate migration configuration accepts only an explicit direct staging URL with pinned hostname, verified TLS, exact creative database and a VYNVORI role; runtime cannot fall back to it. Local loopback CI retains its synthetic fallback. No API/event or business-domain schema is added. Existing migration SQL is unchanged.

Disposable PostgreSQL 17.6 testing already passed two migration applications with one history row, all eight runtime permission negatives, no privileged attributes/membership, fixture constraint/duplicate/rollback checks and zero fixture rows. This is local evidence; live Neon results are recorded separately after execution. Neither this plan nor a backup is proof of completed M2 migration or green release CI.
