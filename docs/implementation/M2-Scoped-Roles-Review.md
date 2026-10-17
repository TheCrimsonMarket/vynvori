# PR #6 — Provisioned scoped Neon roles

2026-10-17. Follow-up base `97f5c75045419af34967d40edac6f32a2003d1c8`. **Proposed code/grants for independent review; no migration or deployment approval.**

## Verified report versus agent evidence

Founder-verified environment: database `vynvori_medusa_staging`; runtime login `vynvori_medusa_runtime_scoped`; migration login `vynvori_medusa_migration_scoped`. Both authenticated through direct certificate-verified connections. Both SQL-created roles have CONNECT/public USAGE and no TEMP, neon_superuser membership, CREATEDB, CREATEROLE or BYPASSRLS. Only migration has public CREATE. Database remains empty. Owner `vynvori_medusa_app` stays unchanged and must never supply runtime or migration credentials. These facts come from the founder's report; no agent Neon connection, credentials access or SQL execution is represented as evidence.

Staging configuration and release-role validation now pin the two scoped names; owner/legacy/wrong-mode login names reject. The service's existing runtime secret remains `vynvori-medusa-database-url`; the separate migration invocation uses `vynvori-medusa-migration-database-url`. No secret values are added, accessed, rotated or updated. Runtime must never receive the migration URL or secret access. Numeric versions, actual project/branch/endpoint mapping and cloud IAM still require review.

## Native migration source review

Reviewed the installed, lock-pinned Medusa **2.21.2** implementation without invoking migrations:

- `@medusajs/medusa/dist/commands/db/migrate.js`: checks existing DB connectivity, runs module migrations, synchronizes links, conditionally migrates enabled search indexes and invokes native migration scripts. Scripts may load the application; migration credentials must remain selected for those child processes. Native migration operations need DDL and their own bookkeeping DML.
- `@medusajs/medusa/dist/commands/utils/index.js`: `ensureDbExists` issues `SELECT 1 + 1`; missing database exits with an instruction to run db:create. It does not require CREATEDB for this existing database.
- `@medusajs/framework/dist/migrations/migrator.js`, `run-migration-scripts.js`, and `@medusajs/link-modules/dist/migration/index.js`: histories include `mikro_orm_migrations`, `script_migrations`, `link_module_migrations`, each with SERIAL ID in the inspected definitions. Script runner also uses session advisory locking and completion records. Their table writes and sequence usage belong to migration, not runtime.
- `@medusajs/utils/dist/dal/mikro-orm/custom-db-migrator.js`: delegates to the pinned migration engine and sets migration search_path. Direct verified TLS is retained. Module history/catalog must be inventoried after the approved migration to catch any additional bookkeeping objects.
- `@medusajs/user/dist/migrations/Migration20240214033943.js`: native user/invite IDs are text in this inspected initial definition, illustrating why blanket sequence access is unjustified. This example does not establish all current module defaults or a final grant list.

No ownership reassignment is needed for an empty existing database: public CREATE lets migration_scoped own the relations it creates. Keep owner/app membership absent from both scoped logins. An extension or ownership error must be reviewed specifically, without neon_superuser, owner substitution or CREATEDB/CREATEROLE/BYPASSRLS expansion.

## SQL proposal boundary

No new pre-migration CONNECT/USAGE/CREATE/TEMP grants are required by the verified report. Do not recreate either role or modify the database owner. After separately approved migration, review a catalog-backed list of migration-owned public objects and necessary native runtime operations; emit only explicit per-object DML grants. Runtime bookkeeping tables receive no writes, their sequences receive no privileges, and domain sequences receive USAGE only when proven necessary for approved INSERT paths. No ALL TABLES/ALL SEQUENCES/default-DML grants. Read-only migration history access is proposed only if needed; absence of need means no grant. Inspect existing PUBLIC/default ACLs and functions for indirect privilege paths.

The pure `scripts/medusa-runtime-grants.mjs` builder accepts entries `{schema,name,owner,kind,privileges,reason}` (sequences additionally name their reviewed INSERT table). It rejects wrong ownership/schema, unsupported privileges, bookkeeping writes/sequences, injection-like identifiers, missing rationale and duplicate objects. It executes nothing; catalog authenticity, effective ACLs and operation necessity remain independent-review responsibilities. The synthetic Docker harness now consumes an explicit generated fixture plan, has distinct random role credentials and records the SQL. That fixture deliberately exercises native modules; it is not a production table-privilege allowlist.

Before any future GRANT execution: capture actual object owner/default/dependency/ACL evidence, annotate required operations per table, independently approve the generated SQL, apply as migration_scoped in a bounded transaction, verify effective role privileges and native startup/Admin/customer denial. Actual object names and a measured minimal allowlist are still **BLOCKED until approved migration and catalog review**. Never fill missing objects or privileges with invented names or blanket defaults.

## Follow-up verification

- PASS: `npm run lint`, `npm run typecheck:m2`.
- PASS: six configuration/Cloud Run tests, including owner/legacy/cross-mode login rejection, real installed pg TLS configuration and protected failure handling (loopback failure only, no Neon).
- PASS: `npm run test:staging`: seven groups, including pure grant proposal rejection and unchanged unapproved remote gate behavior.
- PASS: 25 historical security-policy tests; reference integrity verifies 146 payloads, 202 protected files and nine copied assets. Canonical chapters/protected manifest unchanged in this follow-up.
- NOT_RUN: local Docker/DB migration harness, native migrations, new-image build/scan, real Neon runtime startup, cloud secret/IAM operations and deployment. Earlier image and role-grant runtime results remain historical and do not cover this source.
- Expected rejection: PR #5's sealed actual-source policy remains out of scope. Both original policy files/evaluators, bundled remote policy/expiry, supervisor/remote gate, dependency lock and CI workflows remain byte-for-byte unchanged. No approval fingerprints, expiry or required checks are relaxed. A new source inventory is evidence only, not an exception activation.

Remaining blockers: independently approved scoped object grants; future native migration/recovery and actual runtime evidence; project/branch/endpoint identifiers; separate numeric secret versions and least-privilege GCP IAM; a current image scan and final digest; independent/founder risk/source-scope approval. PR remains draft and must not be merged or deployed by this task. Final commit/CI status is recorded in PR #6 rather than inside a self-referential source artifact.
