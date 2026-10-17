# M2 — Neon migration and runtime privilege review

2026-10-17. **PROCEDURE ONLY; no Neon credentials accessed, remote SQL/migrations NOT_RUN.** Run only after separate founder approval of the exact database target, native migration list and recovery plan. Never use creative Drizzle or another product's commerce database.

## Identify and verify before connecting

Record from the Neon control plane: dedicated commerce **project ID (MISSING)**, branch **ID (MISSING)** and name `staging`, endpoint **ID/direct hostname (MISSING)**, database `vynvori_medusa_staging`, PostgreSQL version, owner and recovery window. Match endpoint-to-branch-to-project, not just DNS suffix. Confirm source is synthetic and the branch was not copied from customer production data. Stop on ambiguity. The `ep-synthetic...` names in tests are fixtures, never provisioning values.

In a protected operator environment use a pinned direct host, password-protected role and `sslmode=verify-full`; no pooler, connection URL options other than sslmode, TLS bypass or hostname substitution. A protected libpq service file/password file may be used for psql; never place a password-bearing URL in shell history, repository, PR or logs. Before DDL, verify `current_database()`, `current_user`, `session_user`, `inet_server_addr()` and `SELECT ssl, version, cipher FROM pg_stat_ssl WHERE pid=pg_backend_pid()`. TLS success does not establish Neon branch identity; compare the control-plane mapping. Record certificate/hostname failure tests against the synthetic TLS fixture, and a real verify-full handshake only after approval.

## Ownership findings and proposed grants

[Neon roles documentation](https://neon.com/docs/manage/roles) says Console/API/CLI-created roles receive `neon_superuser` membership; SQL-created roles do not. Therefore a dashboard-created `vynvori_medusa_app` is **not proven least privilege**. Inspect `pg_roles`, recursive memberships (`pg_auth_members`), database/schema/object ownership, PUBLIC/default ACLs, CONNECT/TEMP/CREATE, and `has_*_privilege` results. NOINHERIT alone is insufficient if SET ROLE can reach an owner. Do not use blanket REASSIGN OWNED across the shared branch or alter Neon internal roles.

Installed Medusa 2.21.2 evidence: framework `database/pg-connection-loader.js` uses `public` and the configured Knex pool; utils `dal/mikro-orm/mikro-orm-create-connection.js` sets `ensureDatabase:false`. Native framework migration runners create/update `mikro_orm_migrations` and `script_migrations` and use session advisory locks. Native `db:migrate` handles module/link/script changes. Direct connections preserve these semantics. Runtime HTTP testing must establish the actual DML requirements, rather than granting DDL to work around an error.

The local disposable test now uses separate SQL-created migrator and app roles, native migrations/replay as migrator, runtime/user/API operations as app, and negative DDL/TEMP/TRUNCATE checks. This is local PostgreSQL evidence only; actual Neon ownership and effective grants remain a remote acceptance blocker.

For a new empty dedicated commerce database, the following is a **review template**, to be executed by the authorized database administrator only after ownership inspection. Set role passwords interactively (`\password`) through the approved secret process; do not paste them into SQL. If a role exists, STOP and review its memberships/ownership before adapting this template. Do not run CREATE ROLE blindly or drop/recreate an existing role.

```sql
CREATE ROLE vynvori_medusa_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE vynvori_medusa_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
REVOKE ALL ON DATABASE vynvori_medusa_staging FROM PUBLIC;
GRANT CONNECT ON DATABASE vynvori_medusa_staging TO vynvori_medusa_migrator, vynvori_medusa_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO vynvori_medusa_migrator;
GRANT USAGE ON SCHEMA public TO vynvori_medusa_app;
```

Migration role owns its created relations; a dedicated administrative owner may retain database/public-schema ownership. Runtime must own neither database nor schema nor relations and must have no owner/admin memberships. Audit inherited grants from PUBLIC, existing direct grants and role memberships separately; the SQL above cannot remove privileges on an already populated database. Revoke only reviewed excessive grants, never unrelated shared-project privileges.

After native migration success, as the object-owning migrator:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO vynvori_medusa_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vynvori_medusa_app;
ALTER DEFAULT PRIVILEGES FOR ROLE vynvori_medusa_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO vynvori_medusa_app;
ALTER DEFAULT PRIVILEGES FOR ROLE vynvori_medusa_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO vynvori_medusa_app;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.link_module_migrations,
  public.mikro_orm_migrations, public.script_migrations FROM vynvori_medusa_app;
```

The three bookkeeping names above were observed in disposable PostgreSQL after native migration. The local service and Admin smoke passed with their writes revoked; runtime retains SELECT only. Confirm the exact list after each native migration and reapply these restrictions after any broad grant, including default privileges on newly introduced migration tables. This is a bounded candidate for Medusa's own isolated schema, not a claim of column/table-minimal grants. It excludes TRUNCATE, REFERENCES, TRIGGER, sequence UPDATE, schema/database CREATE and TEMP. Inspect function EXECUTE/public grants and extension installation requirements from the exact migration list. If an extension needs administrator privileges, approve that single extension separately rather than granting neon_superuser to runtime. Future objects created by another owner are not covered by the migrator's default ACLs.

## Separate migration approval and execution

Preferred first run: trusted operator's local Docker with protected temporary environment file; no separate Cloud Run worker/job. Proposed fourth secret: **`vynvori-medusa-migration-database-url`**, migrator URL with verify-full, numeric version, accessible only to the approved human migration operator. Do not grant runtime SA access. A new GCP migration SA is unnecessary for this operator-run approach; if organizational policy requires one, separately propose `vynvori-medusa-migrator@lucky-little-devil.iam.gserviceaccount.com`, secretAccessor only on that fourth secret, no run.invoker/admin, no key creation. Workload identity/impersonation policy requires separate review; create nothing here.

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
