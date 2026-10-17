# M2 — Neon migration and runtime privilege review

2026-10-17. **PROCEDURE ONLY; no Neon credentials accessed, remote SQL/migrations NOT_RUN.** Run only after separate founder approval of the exact database target, native migration list and recovery plan. Never use creative Drizzle or another product's commerce database.

## Provisioning update — founder-verified, not re-executed by this agent

The founder reports successful direct, certificate-verified PostgreSQL authentication to `vynvori_medusa_staging` with **`vynvori_medusa_runtime_scoped`** and **`vynvori_medusa_migration_scoped`**. Both SQL-created logins have CONNECT and public-schema USAGE, neither has TEMP, neon_superuser membership, CREATEDB, CREATEROLE or BYPASSRLS. Only migration has public-schema CREATE. The database remains empty; no native Medusa migrations have run.

The existing dashboard login **`vynvori_medusa_app` remains database owner** and is prohibited for runtime and migration connection URLs. No database ownership reassignment, role recreation, role password reset or new broad privilege is proposed. Superseded `vynvori_medusa_migrator` is also rejected. Staging configuration accepts only the two scoped usernames in their respective explicitly selected modes. Project/branch/endpoint IDs and direct hostname were not supplied here; still record their verified mapping before execution. TLS success is founder-verified; this agent has not accessed Neon or its credentials.

## Identify and verify before connecting

Record from the Neon control plane: dedicated commerce **project ID (MISSING)**, branch **ID (MISSING)** and name `staging`, endpoint **ID/direct hostname (MISSING)**, database `vynvori_medusa_staging`, PostgreSQL version, owner and recovery window. Match endpoint-to-branch-to-project, not just DNS suffix. Confirm source is synthetic and the branch was not copied from customer production data. Stop on ambiguity. The `ep-synthetic...` names in tests are fixtures, never provisioning values.

In a protected operator environment use a pinned direct host, password-protected role and `sslmode=verify-full`; no pooler, connection URL options other than sslmode, TLS bypass or hostname substitution. A protected libpq service file/password file may be used for psql; never place a password-bearing URL in shell history, repository, PR or logs. Before DDL, verify `current_database()`, `current_user`, `session_user`, `inet_server_addr()` and `SELECT ssl, version, cipher FROM pg_stat_ssl WHERE pid=pg_backend_pid()`. TLS success does not establish Neon branch identity; compare the control-plane mapping. Record certificate/hostname failure tests against the synthetic TLS fixture, and a real verify-full handshake only after approval.

## Ownership findings and proposed grants

[Neon roles documentation](https://neon.com/docs/manage/roles) explains the dashboard-role privilege risk; the founder has now verified the separate SQL-created scoped logins. Before approved execution archive `pg_roles`, recursive memberships (`pg_auth_members`), database/schema/object ownership, PUBLIC/default ACLs, CONNECT/TEMP/CREATE and `has_*_privilege` results. Ensure scoped roles cannot SET ROLE into the database owner/admin. No blanket REASSIGN OWNED, database ALTER OWNER or Neon internal-role changes.

Installed Medusa 2.21.2 evidence: framework `database/pg-connection-loader.js` uses `public` and the configured Knex pool; utils `dal/mikro-orm/mikro-orm-create-connection.js` sets `ensureDatabase:false`. Native framework migration runners create/update `mikro_orm_migrations` and `script_migrations` and use session advisory locks. Native `db:migrate` handles module/link/script changes. Direct connections preserve these semantics. Runtime HTTP testing must establish the actual DML requirements, rather than granting DDL to work around an error.

Earlier PR #6 disposable-PostgreSQL evidence used the superseded test role names. The harness is updated to the scoped names and independently generated runtime/migration passwords; its grant construction now uses explicit per-object SQL, no automatic defaults. It is not run in this follow-up because migrations are prohibited. Earlier results do not prove the updated grant plan or real Neon startup. Non-migrating unit tests validate configuration and SQL-proposal rejection paths only.

The scoped migration login already has the schema privilege needed to create and own its relations. Keep database ownership with `vynvori_medusa_app`; migration does not need database ownership, runtime membership in migrator, database CREATE or TEMP. Native migrations must connect directly as `vynvori_medusa_migration_scoped`, not execute SET ROLE into the dashboard owner. Existing owned objects would require a separate targeted review; the verified database is empty, so **no ownership change is required or authorized**. An extension/DDL error is a blocker to investigate, never grounds for broad Neon grants.

The previous ALL TABLES / ALL SEQUENCES / automatic default-DML proposal is superseded. After a separately approved native migration, review the actual catalog and operation needs before applying any runtime grants:

| Object | Proposed privilege limit |
|---|---|
| Explicitly reviewed migration-owned native domain table in public | Only measured/required subset of SELECT, INSERT, UPDATE, DELETE for enabled native runtime operations; no TRUNCATE, REFERENCES, TRIGGER or grant option |
| `mikro_orm_migrations`, `script_migrations`, `link_module_migrations`, other module migration bookkeeping | No runtime writes; SELECT only if a verified startup/read path requires it; otherwise no grant |
| Sequence owned/dependent on bookkeeping table | No runtime USAGE, SELECT or UPDATE, including its SERIAL ID sequence |
| Explicitly reviewed sequence serving an INSERT-enabled domain table | USAGE only if the actual default/nextval path requires it; no blanket SELECT or UPDATE/setval |
| Newly created objects in future migrations | No automatic runtime DML defaults; repeat explicit catalog/operation review |

Installed framework `migrations/migrator.js` and `migrations/run-migration-scripts.js` create SERIAL IDs in bookkeeping tables. Their sequences are needed by the migration login, not by runtime. Domain sequence needs must be discovered from actual defaults/dependencies; do not infer that every table needs a sequence. Native module migrations are in pinned `@medusajs/*/dist/migrations`; module migration histories can introduce additional bookkeeping names, so inspect them rather than relying only on the three historical names.

`scripts/medusa-runtime-grants.mjs` is a pure proposal builder for a reviewer-authored object/privilege list. It executes nothing, requires public-schema objects owned by the scoped migrator and a rationale, restricts table grants to DML, rejects every migration-named table write, and rejects bookkeeping sequences. It emits only explicit object GRANT statements. Sequence entries require a separately reviewed INSERT table and USAGE only. Independent review must establish catalog identity and actual necessity; the builder cannot prove them. Its synthetic fixtures are not the Neon grant list.

**SQL review still required:** following a separately approved migration, produce the actual per-object GRANT list, verify owner and sequence dependency/default paths, and review any existing PUBLIC/default ACLs or function EXECUTE grants that could exceed it. Execute as the scoped object owner only after approval, inside a bounded transaction with ON_ERROR_STOP, then verify effective privileges as runtime. If existing default ACLs give automatic DML, propose specific REVOKE statements after observing the exact ACL; do not assume or execute them now. There are no Medusa objects to grant on yet. No executable live-table allowlist or successful updated runtime test can be claimed before migration/catalog evidence exists.

## Separate migration approval and execution

Preferred first run: trusted operator's local Docker with protected temporary environment file; no separate Cloud Run worker/job. Proposed fourth secret: **`vynvori-medusa-migration-database-url`**, migrator URL with verify-full, numeric version, accessible only to the approved human migration operator. Do not grant runtime SA access. A new GCP migration SA is unnecessary for this operator-run approach; if organizational policy requires one, separately propose `vynvori-medusa-migrator@lucky-little-devil.iam.gserviceaccount.com`, secretAccessor only on that fourth secret, no run.invoker/admin, no key creation. Workload identity/impersonation policy requires separate review; create nothing here.

Credential mapping is exact: `vynvori-medusa-database-url` contains only the `vynvori_medusa_runtime_scoped` login; `vynvori-medusa-migration-database-url` contains only `vynvori_medusa_migration_scoped`. Use distinct credentials and numeric versions; never copy the owner URL into either secret or attach the migration secret to the runtime service. The existing migration process receives its separate URL as M2_MEDUSA_DATABASE_URL only in its separately approved invocation. No cloud secret creation/update/access occurs here.

1. Approve immutable image/native migration inventory, exact source scope and execution window. Verify a Neon restore/PITR point, actual plan retention/restore capability, and a successful recovery drill into a separate synthetic recovery branch. Record IDs/time and restore duration. Back up schema/ACLs independently; don't assume branch creation is an independent backup.
2. Fence all service revisions/invokers and all migrators; initial service should remain absent. Record one operator/execution ID and an execution ledger. Native migration bookkeeping/replay is not a global exactly-once guarantee. No orchestration retries, scheduled migration or startup migration.
3. Materialize only migration env keys outside the checkout using the approved secret delivery process, restrictive permissions and automatic file cleanup. `M2_ENV=staging`, direct host/name, migration URL, synthetic signing secrets/CORS required by existing config. No K_SERVICE/K_REVISION, remote approval markers, Vercel or cloud job context. The operator environment is explicitly approved for this migration; it is not a deployable service context.
4. Execute once, then inspect native module/link/script records and logs before making any replay decision. Timeout/unknown exit => STOP, reconcile committed state and locks, never simply rerun. Capture redacted output. The supervisor permits only this explicit command (10-minute deadline):

```sh
docker run --rm --env-file /protected/migration.env \
  -e M2_AUTHORIZE_MEDUSA_MIGRATION=vynvori_medusa_staging \
  us-east1-docker.pkg.dev/lucky-little-devil/vynvori-staging-images/medusa@sha256:REPLACE_APPROVED_DIGEST migrate
```

5. Grant reviewed runtime privileges, verify negative CREATE SCHEMA/TABLE/TEMP/TRUNCATE and owner-membership checks as app. Start the exact compiled image with app credentials in the approved environment; prove native Admin auth/readiness, synthetic Admin writes actually required for smoke, denied customer auth/Store mutations even with valid publishable key. Do not grant DDL because startup fails; investigate and escalate the specific requirement.
6. Delete temporary credential files; retain redacted logs and target/role/ACL evidence. Revoke migration access outside the execution window; runtime references only its three secrets. Independently approve service activation.

Recovery: quiesce first, retain evidence, compare prior code/schema compatibility. Restore into a separately reviewed recovery branch when needed, explicitly approve data loss/cutover and rotate only reviewed database-secret versions. Never automatic native down migrations, DROP SCHEMA CASCADE or overwrite the sole staging branch. No backup or restore has been performed in this PR.
