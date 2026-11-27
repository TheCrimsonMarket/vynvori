# M7 ledger roles and grants: proposal (S9)

> **PROPOSAL, NOT APPLIED.** Nothing in this document has been run against staging, production or any Neon database. No migration
> grants anything. A future apply needs, in this order: the founder's separate remote-database approval, a native backup (the M2
> procedure), a pinned target in `packages/db/ledger-migrations/plan.json`, and then the founder (or someone the founder names) running
> the blocks below by hand. No thread runs them. No role password is in this document or anywhere in the repository.

Plan step: [M7-Plan.md](M7-Plan.md) §7 S9. Design record: [ADR-0021](ADR-0021-M7-Core-Ledger-Foundation.md) (privilege model B, and the
grants each addendum S2 to S8 says it needs). Evidence: [M7-Evidence.md](M7-Evidence.md). The SQL here is **executed verbatim** by
`packages/db/tests/ledger-acceptance.test.ts` on a disposable PostgreSQL database, as a non-superuser executor; see §9.

## 1. What this sets up

Seven `NOLOGIN` privilege roles. None can log in, none is a superuser, none has `CREATEDB`, `CREATEROLE`, `REPLICATION` or
`BYPASSRLS`, and none is a member of any other role. People and services log in with their own login roles, which are only ever
granted the runtime, checker or reconciliation role (§4 step 7). The four definer roles never get a member.

| Role (psql variable) | Suggested name | Purpose | Privileges, exactly |
|---|---|---|---|
| `ledger_runtime` | `vynvori_ledger_runtime` | The library's customer-path and system-path commands (`runLedgerCommand` and everything built on it) | `USAGE` on `vynvori_ledger`; `SELECT, INSERT` on `wallets`, `ledger_commands`, `ledger_entries`, `ledger_quote_lineages`, `ledger_quotes`, `ledger_quote_allocations`, `promo_claims`, `promo_claim_events`, `ledger_authorizations`, `ledger_packages`, `credit_reservations`, `ledger_package_events`; `INSERT` only on `refinement_slot_events`; `SELECT` on `refinement_slots`; column `UPDATE` on `wallets (user_id)`, `promo_claims (state, event_seq)`, `credit_reservations (workflow_ref)`, `ledger_packages (package_id)`, `refinement_slots (slot_id)`; `USAGE` on `vynvori_identity` and column `SELECT (id, issuer, subject)` on `vynvori_identity.profiles`. Nothing on `ledger_grant_sources` or `vendor_cost_evidence`. No `DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER`, no `EXECUTE` on any ledger function, no `TEMP`. |
| `ledger_wallet_definer` | `vynvori_ledger_wallet_definer` | Owns `ledger_entries_apply_to_wallet()` (S2) | `USAGE` on `vynvori_ledger`; `SELECT, UPDATE` on `wallets` |
| `ledger_reservation_definer` | `vynvori_ledger_reservation_definer` | Owns `ledger_entries_apply_to_reservation()` (S5, also S6's settle and hold) | `USAGE`; `SELECT` and `UPDATE (state)` on `credit_reservations` |
| `ledger_package_definer` | `vynvori_ledger_package_definer` | Owns `ledger_package_events_apply()` (S7) | `USAGE`; `SELECT` and `UPDATE (state)` on `ledger_packages`; `INSERT` on `refinement_slots` |
| `ledger_slot_definer` | `vynvori_ledger_slot_definer` | Owns `refinement_slot_events_apply()` (S7) | `USAGE`; `SELECT` and `UPDATE (state, source_version_id, operation_id, delivered_version_id, closure_cause, closure_notice_version)` on `refinement_slots` |
| `ledger_checker` | `vynvori_ledger_checker` | Runs `checkWalletInvariants` and `findOrphanedReservations` (S8) | `USAGE`; `SELECT` on `wallets`, `ledger_commands`, `ledger_entries`, `credit_reservations`, `ledger_quotes`, `ledger_quote_allocations`, `ledger_authorizations`, `ledger_packages`, `ledger_grant_sources`, `promo_claims`, `promo_claim_events`. Nothing on `vendor_cost_evidence`. No write of any kind. |
| `ledger_reconciliation` | `vynvori_ledger_reconciliation` | Internal reconciliation worker: `recordVendorCostEvidence` (S6) | `USAGE`; `SELECT, INSERT` on `vendor_cost_evidence` and nothing else |

Every list above is **derived by test, not from memory** (§9): the test applies exactly these blocks, shows the real library path works
under them, then removes each privilege one at a time and shows the path fails with `42501`. So each list is necessary and not padded.

Three deliberate differences from what the earlier addenda wrote, all found by that test:

1. **The checker also needs `SELECT` on `ledger_commands`.** The S8 addendum lists ten tables. `checkWalletInvariants` re-derives the
   `ledger_commands (scope, idempotency_key)` idempotency guard (`UNIQUE_KEY_VIOLATED`), so it reads that table; without it the check
   fails with `42501`. It still reads no idempotency key value (counts only).
2. **The runtime role gets nothing on `ledger_grant_sources`.** Earlier test grants gave it `SELECT` so the test fixture could grant
   synthetic credits as the runtime role. Funding is not a runtime operation: no grant source exists in W1 and the HARD GATE (§7)
   forbids registering one before a definer-only grant command exists. Without `SELECT`, the library's grant path
   (`appendGrantEntry`) fails with `42501` for the runtime role, and a raw grant entry is still rejected because no source exists.
3. **The runtime role gets only `INSERT` on `refinement_slot_events`, not `SELECT`.** The S7 addendum lists `SELECT, INSERT`. Nothing
   in the library or in any trigger reads that table (the library inserts without `RETURNING`, and every replay or precondition reads
   `refinement_slots` or `ledger_package_events` instead), so with `SELECT` revoked the whole runtime path still works; the test
   would fail on an unneeded privilege. `SELECT` on `ledger_package_events` stays: `reopenBundleAfterUnchargedFinal` reads it.

## 2. Founder decisions this follows

- **Separate definer roles for S5 and S7** (founder, 2026-11-28): one role per `SECURITY DEFINER` function, four in total, as the S7
  addendum recommended. The wallet definer is separate too.
- **Vendor-cost evidence goes to a dedicated internal role, not the runtime role** (founder decision delegated to the coordinator,
  2026-11-28): `ledger_reconciliation`. The runtime role has no privilege on `vendor_cost_evidence` at all.
- **Checker role** with read-only access and nothing on vendor cost (ADR-0021 S8 addendum).
- **Hard gates that this proposal does not close** (§7): the definer-only command path for settle, hold, authorize, dispatch and
  release; the append-only close and delivery evidence record; and the grant-source gate. Applying these grants does not authorise a
  non-synthetic rollout on its own.

## 3. Who runs it, and what must be true first

**Executor.** The role that applied the ledger migrations and therefore owns the `vynvori_ledger` schema, every ledger table and
function, and the `vynvori_ledger_migrations` journal. On a managed database this is not a superuser, so the blocks are written to work
without one. It needs:

- `CREATEROLE` (to create the seven roles; PostgreSQL 16 and later then give it `ADMIN OPTION` on them, with `INHERIT FALSE` and
  `SET FALSE`, which is what lets it grant and revoke the transient memberships in step 5);
- ownership of the database, or `TEMPORARY ... WITH GRANT OPTION` on it (to revoke `TEMPORARY` from `PUBLIC` in step 2);
- `USAGE ... WITH GRANT OPTION` on schema `vynvori_identity` and `SELECT (id, issuer, subject) ... WITH GRANT OPTION` on
  `vynvori_identity.profiles`, or ownership of them (step 3). These are M1b objects; this proposal grants only those three columns.

The executor must be a separate role from every login that gets the runtime, checker or reconciliation role: the table owner can
`DISABLE TRIGGER` and is the break-glass identity (§6).

**PostgreSQL 16 or later.** The blocks use `GRANT ... WITH INHERIT ..., SET ...` and `pg_has_role(..., 'SET')`. CI runs 17.6.

**How to run.** With `psql` and `ON_ERROR_STOP`, setting every variable, for example:

```text
psql "<connection string of the executor, from your secret manager>" -v ON_ERROR_STOP=1 \
  -v ledger_database=<database name> \
  -v ledger_runtime=vynvori_ledger_runtime -v ledger_wallet_definer=vynvori_ledger_wallet_definer \
  -v ledger_reservation_definer=vynvori_ledger_reservation_definer -v ledger_package_definer=vynvori_ledger_package_definer \
  -v ledger_slot_definer=vynvori_ledger_slot_definer -v ledger_checker=vynvori_ledger_checker \
  -v ledger_reconciliation=vynvori_ledger_reconciliation
```

then paste the blocks in order. The two check blocks (steps 1 and 6) must print **zero rows**; any row is a reason to stop. The blocks
contain no dollar-quoted text, so psql substitutes every `:"name"` (identifier) and `:'name'` (literal). The test performs the same
substitution and refuses a block that contains `$$` or an unset variable.

## 4. Steps

### Step 1: preconditions (must return zero rows)

<!-- s9-sql:preconditions -->
```sql
SELECT check_name, detail FROM (
  SELECT 'server version is older than 16' AS check_name, current_setting('server_version_num') AS detail
    WHERE current_setting('server_version_num')::int < 160000
  UNION ALL SELECT 'schema vynvori_ledger is missing', '' WHERE to_regnamespace('vynvori_ledger') IS NULL
  UNION ALL SELECT 'executor does not own schema', n.nspname || ' owned by ' || pg_get_userbyid(n.nspowner)
    FROM pg_namespace n WHERE n.nspname IN ('vynvori_ledger', 'vynvori_ledger_migrations') AND pg_get_userbyid(n.nspowner) <> current_user
  UNION ALL SELECT 'journal is not exactly migrations 0001 to 0007', coalesce(string_agg(a.file, ',' ORDER BY a.file), 'empty')
    FROM vynvori_ledger_migrations.applied a
    HAVING coalesce(string_agg(a.file, ',' ORDER BY a.file), '') <> '0001_ledger_schema.sql,0002_wallet_ledger.sql,0003_quotes.sql,0004_promo_claims.sql,0005_reservations.sql,0006_vendor_cost_evidence.sql,0007_refinement_slots.sql'
  UNION ALL SELECT 'executor does not own relation', c.relname || ' owned by ' || pg_get_userbyid(c.relowner)
    FROM pg_class c WHERE c.relnamespace = 'vynvori_ledger'::regnamespace AND pg_get_userbyid(c.relowner) <> current_user
  UNION ALL SELECT 'executor does not own function', p.proname || ' owned by ' || pg_get_userbyid(p.proowner)
    FROM pg_proc p WHERE p.pronamespace = 'vynvori_ledger'::regnamespace AND pg_get_userbyid(p.proowner) <> current_user
  UNION ALL SELECT 'SECURITY DEFINER set is not the reviewed four', coalesce(string_agg(p.proname, ',' ORDER BY p.proname), 'none')
    FROM pg_proc p WHERE p.pronamespace = 'vynvori_ledger'::regnamespace AND p.prosecdef
    HAVING coalesce(string_agg(p.proname, ',' ORDER BY p.proname), '') <> 'ledger_entries_apply_to_reservation,ledger_entries_apply_to_wallet,ledger_package_events_apply,refinement_slot_events_apply'
  UNION ALL SELECT 'HARD GATE: a grant source is registered', count(*)::text FROM vynvori_ledger.ledger_grant_sources HAVING count(*) > 0
  UNION ALL SELECT 'a privilege on a ledger relation already exists', pg_get_userbyid(a.grantee) || ' ' || a.privilege_type || ' on ' || c.relname
    FROM pg_class c, aclexplode(c.relacl) a WHERE c.relnamespace = 'vynvori_ledger'::regnamespace AND a.grantee <> c.relowner
  UNION ALL SELECT 'a column privilege on a ledger relation already exists', c.relname || '.' || t.attname
    FROM pg_attribute t JOIN pg_class c ON c.oid = t.attrelid WHERE c.relnamespace = 'vynvori_ledger'::regnamespace AND t.attacl IS NOT NULL
  UNION ALL SELECT 'a privilege on a ledger schema already exists', n.nspname || ': ' || CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END || ' ' || a.privilege_type
    FROM pg_namespace n, aclexplode(n.nspacl) a WHERE n.nspname IN ('vynvori_ledger', 'vynvori_ledger_migrations') AND a.grantee <> n.nspowner
  UNION ALL SELECT 'a trigger function is executable by someone other than its owner', p.proname
    FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    WHERE p.pronamespace = 'vynvori_ledger'::regnamespace AND p.prorettype = 'trigger'::regtype AND a.grantee <> p.proowner
  UNION ALL SELECT 'default privileges exist for the ledger schema', pg_get_userbyid(d.defaclrole)
    FROM pg_default_acl d WHERE d.defaclnamespace = 'vynvori_ledger'::regnamespace
  UNION ALL SELECT 'a role to be created already exists', r.rolname FROM pg_roles r
    WHERE r.rolname IN (:'ledger_runtime', :'ledger_wallet_definer', :'ledger_reservation_definer', :'ledger_package_definer', :'ledger_slot_definer', :'ledger_checker', :'ledger_reconciliation')
  UNION ALL SELECT 'executor cannot create roles', current_user FROM pg_roles r WHERE r.rolname = current_user AND NOT (r.rolcreaterole OR r.rolsuper)
  UNION ALL SELECT 'executor cannot revoke TEMPORARY from PUBLIC', current_database()
    WHERE NOT has_database_privilege(current_user, current_database(), 'TEMPORARY WITH GRANT OPTION')
  UNION ALL SELECT 'executor cannot grant on vynvori_identity', 'schema USAGE'
    WHERE NOT has_schema_privilege(current_user, 'vynvori_identity', 'USAGE WITH GRANT OPTION')
  UNION ALL SELECT 'executor cannot grant on vynvori_identity.profiles', col
    FROM unnest(ARRAY['id', 'issuer', 'subject']) col WHERE NOT has_column_privilege(current_user, 'vynvori_identity.profiles', col, 'SELECT WITH GRANT OPTION')
  UNION ALL SELECT 'database is not the one named in ledger_database', current_database() WHERE current_database() <> :'ledger_database'
) violations ORDER BY 1, 2;
```

### Step 2: roles and the database-wide TEMP revoke

<!-- s9-sql:roles -->
```sql
CREATE ROLE :"ledger_runtime" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE :"ledger_wallet_definer" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE :"ledger_reservation_definer" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE :"ledger_package_definer" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE :"ledger_slot_definer" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE :"ledger_checker" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE :"ledger_reconciliation" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
REVOKE TEMPORARY ON DATABASE :"ledger_database" FROM PUBLIC;
```

`REVOKE TEMPORARY` is database-wide: revoking it from a role alone does nothing while `PUBLIC` holds it (tested in S2). It closes the
first step of every executed `TEMP`-table trigger exploit. If another component in the same database needs temporary tables, grant
`TEMPORARY` to that component's own role, never back to `PUBLIC` and never to a ledger role or a login that holds one.

### Step 3: runtime grants

<!-- s9-sql:runtime -->
```sql
GRANT USAGE ON SCHEMA vynvori_ledger TO :"ledger_runtime";
GRANT SELECT, INSERT ON vynvori_ledger.wallets, vynvori_ledger.ledger_commands, vynvori_ledger.ledger_entries TO :"ledger_runtime";
GRANT UPDATE (user_id) ON vynvori_ledger.wallets TO :"ledger_runtime";
GRANT SELECT, INSERT ON vynvori_ledger.ledger_quote_lineages, vynvori_ledger.ledger_quotes, vynvori_ledger.ledger_quote_allocations TO :"ledger_runtime";
GRANT SELECT, INSERT ON vynvori_ledger.promo_claims, vynvori_ledger.promo_claim_events TO :"ledger_runtime";
GRANT UPDATE (state, event_seq) ON vynvori_ledger.promo_claims TO :"ledger_runtime";
GRANT SELECT, INSERT ON vynvori_ledger.ledger_authorizations, vynvori_ledger.ledger_packages, vynvori_ledger.credit_reservations TO :"ledger_runtime";
GRANT UPDATE (workflow_ref) ON vynvori_ledger.credit_reservations TO :"ledger_runtime";
GRANT SELECT, INSERT ON vynvori_ledger.ledger_package_events TO :"ledger_runtime";
GRANT INSERT ON vynvori_ledger.refinement_slot_events TO :"ledger_runtime";
GRANT SELECT ON vynvori_ledger.refinement_slots TO :"ledger_runtime";
GRANT UPDATE (package_id) ON vynvori_ledger.ledger_packages TO :"ledger_runtime";
GRANT UPDATE (slot_id) ON vynvori_ledger.refinement_slots TO :"ledger_runtime";
GRANT USAGE ON SCHEMA vynvori_identity TO :"ledger_runtime";
GRANT SELECT (id, issuer, subject) ON vynvori_identity.profiles TO :"ledger_runtime";
```

Why each column `UPDATE` exists: `SELECT ... FOR UPDATE` needs an `UPDATE` privilege on at least one column. `wallets (user_id)`,
`ledger_packages (package_id)` and `refinement_slots (slot_id)` are lock-only identity columns that the update guards never let change
(an attempt is `23000`). `credit_reservations (workflow_ref)` is the dispatch marker, written once `NULL → value` and then guarded.
`promo_claims (state, event_seq)` is moved by the promo apply trigger, which is invoker-rights; its guard allows only the next recorded
event. `vynvori_identity.profiles (id, issuer, subject)` is read by `claimPromo` and by the promo-claim insert trigger, which bind a
claim to the verified issuer and subject.

### Step 4: definer, checker and reconciliation grants

<!-- s9-sql:privileges -->
```sql
GRANT USAGE ON SCHEMA vynvori_ledger TO :"ledger_wallet_definer", :"ledger_reservation_definer", :"ledger_package_definer", :"ledger_slot_definer", :"ledger_checker", :"ledger_reconciliation";
GRANT SELECT, UPDATE ON vynvori_ledger.wallets TO :"ledger_wallet_definer";
GRANT SELECT ON vynvori_ledger.credit_reservations TO :"ledger_reservation_definer";
GRANT UPDATE (state) ON vynvori_ledger.credit_reservations TO :"ledger_reservation_definer";
GRANT SELECT ON vynvori_ledger.ledger_packages TO :"ledger_package_definer";
GRANT UPDATE (state) ON vynvori_ledger.ledger_packages TO :"ledger_package_definer";
GRANT INSERT ON vynvori_ledger.refinement_slots TO :"ledger_package_definer";
GRANT SELECT ON vynvori_ledger.refinement_slots TO :"ledger_slot_definer";
GRANT UPDATE (state, source_version_id, operation_id, delivered_version_id, closure_cause, closure_notice_version) ON vynvori_ledger.refinement_slots TO :"ledger_slot_definer";
GRANT SELECT ON vynvori_ledger.wallets, vynvori_ledger.ledger_commands, vynvori_ledger.ledger_entries, vynvori_ledger.credit_reservations, vynvori_ledger.ledger_quotes, vynvori_ledger.ledger_quote_allocations, vynvori_ledger.ledger_authorizations, vynvori_ledger.ledger_packages, vynvori_ledger.ledger_grant_sources, vynvori_ledger.promo_claims, vynvori_ledger.promo_claim_events TO :"ledger_checker";
GRANT SELECT, INSERT ON vynvori_ledger.vendor_cost_evidence TO :"ledger_reconciliation";
```

The wallet definer keeps table-level `UPDATE` on `wallets`, exactly as the S2 addendum wrote it. Column-level `UPDATE` on the five
bucket columns would also suffice; the guard rejects every writer that is not the function owner, so the difference is not a hole, and
this proposal does not change a reviewed list without a review.

### Step 5: re-own the four definer functions (one transaction)

<!-- s9-sql:reown -->
```sql
BEGIN;
GRANT :"ledger_wallet_definer", :"ledger_reservation_definer", :"ledger_package_definer", :"ledger_slot_definer" TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
GRANT CREATE ON SCHEMA vynvori_ledger TO :"ledger_wallet_definer", :"ledger_reservation_definer", :"ledger_package_definer", :"ledger_slot_definer";
ALTER FUNCTION vynvori_ledger.ledger_entries_apply_to_wallet() OWNER TO :"ledger_wallet_definer";
ALTER FUNCTION vynvori_ledger.ledger_entries_apply_to_reservation() OWNER TO :"ledger_reservation_definer";
ALTER FUNCTION vynvori_ledger.ledger_package_events_apply() OWNER TO :"ledger_package_definer";
ALTER FUNCTION vynvori_ledger.refinement_slot_events_apply() OWNER TO :"ledger_slot_definer";
REVOKE CREATE ON SCHEMA vynvori_ledger FROM :"ledger_wallet_definer", :"ledger_reservation_definer", :"ledger_package_definer", :"ledger_slot_definer";
REVOKE :"ledger_wallet_definer", :"ledger_reservation_definer", :"ledger_package_definer", :"ledger_slot_definer" FROM CURRENT_USER;
COMMIT;
```

This is the ADR-0021 S2 owner-change procedure, made precise and executable by a non-superuser:

- `ALTER FUNCTION ... OWNER TO` needs the executor to own the function, to be able to `SET ROLE` to the new owner, and the new owner
  to hold `CREATE` on the schema. So the executor takes `SET` membership (`INHERIT FALSE`: it never inherits a definer's privileges)
  and the definers take `CREATE`, both only inside this transaction. Nobody else ever sees them committed.
- The `REVOKE ... FROM CURRENT_USER` removes only the grant the executor just made. The `ADMIN OPTION` row that `CREATE ROLE` gave the
  executor stays (it has `INHERIT FALSE` and `SET FALSE`, so it is not usable membership; §8 limit 2).
- The guards compare `current_user` to the **owner of their own apply function**, by name. After this step each guard's only legitimate
  writer is its definer role, which has no members.

### Step 6: end state (must return zero rows)

<!-- s9-sql:end_state -->
```sql
WITH ledger_roles(r) AS (VALUES (:'ledger_runtime'), (:'ledger_wallet_definer'), (:'ledger_reservation_definer'), (:'ledger_package_definer'), (:'ledger_slot_definer'), (:'ledger_checker'), (:'ledger_reconciliation')),
definer_roles(r, fn) AS (VALUES (:'ledger_wallet_definer', 'ledger_entries_apply_to_wallet'), (:'ledger_reservation_definer', 'ledger_entries_apply_to_reservation'), (:'ledger_package_definer', 'ledger_package_events_apply'), (:'ledger_slot_definer', 'refinement_slot_events_apply')),
expected(grantee, object, col, privilege) AS (VALUES
  (:'ledger_runtime', 'schema vynvori_ledger', '', 'USAGE'),
  (:'ledger_runtime', 'table vynvori_ledger.wallets', '', 'SELECT'), (:'ledger_runtime', 'table vynvori_ledger.wallets', '', 'INSERT'),
  (:'ledger_runtime', 'table vynvori_ledger.wallets', 'user_id', 'UPDATE'),
  (:'ledger_runtime', 'table vynvori_ledger.ledger_commands', '', 'SELECT'), (:'ledger_runtime', 'table vynvori_ledger.ledger_commands', '', 'INSERT'),
  (:'ledger_runtime', 'table vynvori_ledger.ledger_entries', '', 'SELECT'), (:'ledger_runtime', 'table vynvori_ledger.ledger_entries', '', 'INSERT'),
  (:'ledger_runtime', 'table vynvori_ledger.ledger_quote_lineages', '', 'SELECT'), (:'ledger_runtime', 'table vynvori_ledger.ledger_quote_lineages', '', 'INSERT'),
  (:'ledger_runtime', 'table vynvori_ledger.ledger_quotes', '', 'SELECT'), (:'ledger_runtime', 'table vynvori_ledger.ledger_quotes', '', 'INSERT'),
  (:'ledger_runtime', 'table vynvori_ledger.ledger_quote_allocations', '', 'SELECT'), (:'ledger_runtime', 'table vynvori_ledger.ledger_quote_allocations', '', 'INSERT'),
  (:'ledger_runtime', 'table vynvori_ledger.promo_claims', '', 'SELECT'), (:'ledger_runtime', 'table vynvori_ledger.promo_claims', '', 'INSERT'),
  (:'ledger_runtime', 'table vynvori_ledger.promo_claims', 'state', 'UPDATE'), (:'ledger_runtime', 'table vynvori_ledger.promo_claims', 'event_seq', 'UPDATE'),
  (:'ledger_runtime', 'table vynvori_ledger.promo_claim_events', '', 'SELECT'), (:'ledger_runtime', 'table vynvori_ledger.promo_claim_events', '', 'INSERT'),
  (:'ledger_runtime', 'table vynvori_ledger.ledger_authorizations', '', 'SELECT'), (:'ledger_runtime', 'table vynvori_ledger.ledger_authorizations', '', 'INSERT'),
  (:'ledger_runtime', 'table vynvori_ledger.ledger_packages', '', 'SELECT'), (:'ledger_runtime', 'table vynvori_ledger.ledger_packages', '', 'INSERT'),
  (:'ledger_runtime', 'table vynvori_ledger.ledger_packages', 'package_id', 'UPDATE'),
  (:'ledger_runtime', 'table vynvori_ledger.credit_reservations', '', 'SELECT'), (:'ledger_runtime', 'table vynvori_ledger.credit_reservations', '', 'INSERT'),
  (:'ledger_runtime', 'table vynvori_ledger.credit_reservations', 'workflow_ref', 'UPDATE'),
  (:'ledger_runtime', 'table vynvori_ledger.ledger_package_events', '', 'SELECT'), (:'ledger_runtime', 'table vynvori_ledger.ledger_package_events', '', 'INSERT'),
  (:'ledger_runtime', 'table vynvori_ledger.refinement_slot_events', '', 'INSERT'),
  (:'ledger_runtime', 'table vynvori_ledger.refinement_slots', '', 'SELECT'), (:'ledger_runtime', 'table vynvori_ledger.refinement_slots', 'slot_id', 'UPDATE'),
  (:'ledger_runtime', 'schema vynvori_identity', '', 'USAGE'),
  (:'ledger_runtime', 'table vynvori_identity.profiles', 'id', 'SELECT'), (:'ledger_runtime', 'table vynvori_identity.profiles', 'issuer', 'SELECT'), (:'ledger_runtime', 'table vynvori_identity.profiles', 'subject', 'SELECT'),
  (:'ledger_wallet_definer', 'schema vynvori_ledger', '', 'USAGE'),
  (:'ledger_wallet_definer', 'table vynvori_ledger.wallets', '', 'SELECT'), (:'ledger_wallet_definer', 'table vynvori_ledger.wallets', '', 'UPDATE'),
  (:'ledger_reservation_definer', 'schema vynvori_ledger', '', 'USAGE'),
  (:'ledger_reservation_definer', 'table vynvori_ledger.credit_reservations', '', 'SELECT'), (:'ledger_reservation_definer', 'table vynvori_ledger.credit_reservations', 'state', 'UPDATE'),
  (:'ledger_package_definer', 'schema vynvori_ledger', '', 'USAGE'),
  (:'ledger_package_definer', 'table vynvori_ledger.ledger_packages', '', 'SELECT'), (:'ledger_package_definer', 'table vynvori_ledger.ledger_packages', 'state', 'UPDATE'),
  (:'ledger_package_definer', 'table vynvori_ledger.refinement_slots', '', 'INSERT'),
  (:'ledger_slot_definer', 'schema vynvori_ledger', '', 'USAGE'),
  (:'ledger_slot_definer', 'table vynvori_ledger.refinement_slots', '', 'SELECT'),
  (:'ledger_slot_definer', 'table vynvori_ledger.refinement_slots', 'state', 'UPDATE'), (:'ledger_slot_definer', 'table vynvori_ledger.refinement_slots', 'source_version_id', 'UPDATE'),
  (:'ledger_slot_definer', 'table vynvori_ledger.refinement_slots', 'operation_id', 'UPDATE'), (:'ledger_slot_definer', 'table vynvori_ledger.refinement_slots', 'delivered_version_id', 'UPDATE'),
  (:'ledger_slot_definer', 'table vynvori_ledger.refinement_slots', 'closure_cause', 'UPDATE'), (:'ledger_slot_definer', 'table vynvori_ledger.refinement_slots', 'closure_notice_version', 'UPDATE'),
  (:'ledger_checker', 'schema vynvori_ledger', '', 'USAGE'),
  (:'ledger_checker', 'table vynvori_ledger.wallets', '', 'SELECT'), (:'ledger_checker', 'table vynvori_ledger.ledger_commands', '', 'SELECT'),
  (:'ledger_checker', 'table vynvori_ledger.ledger_entries', '', 'SELECT'), (:'ledger_checker', 'table vynvori_ledger.credit_reservations', '', 'SELECT'),
  (:'ledger_checker', 'table vynvori_ledger.ledger_quotes', '', 'SELECT'), (:'ledger_checker', 'table vynvori_ledger.ledger_quote_allocations', '', 'SELECT'),
  (:'ledger_checker', 'table vynvori_ledger.ledger_authorizations', '', 'SELECT'), (:'ledger_checker', 'table vynvori_ledger.ledger_packages', '', 'SELECT'),
  (:'ledger_checker', 'table vynvori_ledger.ledger_grant_sources', '', 'SELECT'), (:'ledger_checker', 'table vynvori_ledger.promo_claims', '', 'SELECT'),
  (:'ledger_checker', 'table vynvori_ledger.promo_claim_events', '', 'SELECT'),
  (:'ledger_reconciliation', 'schema vynvori_ledger', '', 'USAGE'),
  (:'ledger_reconciliation', 'table vynvori_ledger.vendor_cost_evidence', '', 'SELECT'), (:'ledger_reconciliation', 'table vynvori_ledger.vendor_cost_evidence', '', 'INSERT'),
  ('PUBLIC', 'function vynvori_ledger.promo_claim_edge_allowed', '', 'EXECUTE'),
  ('PUBLIC', 'function vynvori_ledger.ledger_package_edge_allowed', '', 'EXECUTE'),
  ('PUBLIC', 'function vynvori_ledger.refinement_slot_edge_allowed', '', 'EXECUTE')
),
actual(grantee, object, col, privilege) AS (
  SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END, 'schema ' || n.nspname, '', a.privilege_type
    FROM pg_namespace n, aclexplode(n.nspacl) a WHERE n.nspname IN ('vynvori_ledger', 'vynvori_ledger_migrations') AND a.grantee <> n.nspowner
  UNION ALL SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END, 'table ' || n.nspname || '.' || c.relname, '', a.privilege_type
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a WHERE n.nspname IN ('vynvori_ledger', 'vynvori_ledger_migrations') AND a.grantee <> c.relowner
  UNION ALL SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END, 'table ' || n.nspname || '.' || c.relname, t.attname::text, a.privilege_type
    FROM pg_attribute t JOIN pg_class c ON c.oid = t.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(t.attacl) a
    WHERE n.nspname IN ('vynvori_ledger', 'vynvori_ledger_migrations') AND a.grantee <> c.relowner
  UNION ALL SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END, 'function vynvori_ledger.' || p.proname, '', a.privilege_type
    FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a WHERE p.pronamespace = 'vynvori_ledger'::regnamespace AND a.grantee <> p.proowner
  UNION ALL SELECT pg_get_userbyid(a.grantee)::text, 'schema vynvori_identity', '', a.privilege_type
    FROM pg_namespace n, aclexplode(n.nspacl) a WHERE n.nspname = 'vynvori_identity' AND pg_get_userbyid(a.grantee) IN (SELECT r FROM ledger_roles)
  UNION ALL SELECT pg_get_userbyid(a.grantee)::text, 'table vynvori_identity.' || c.relname, '', a.privilege_type
    FROM pg_class c, aclexplode(c.relacl) a WHERE c.relnamespace = 'vynvori_identity'::regnamespace AND pg_get_userbyid(a.grantee) IN (SELECT r FROM ledger_roles)
  UNION ALL SELECT pg_get_userbyid(a.grantee)::text, 'table vynvori_identity.' || c.relname, t.attname::text, a.privilege_type
    FROM pg_attribute t JOIN pg_class c ON c.oid = t.attrelid, aclexplode(t.attacl) a WHERE c.relnamespace = 'vynvori_identity'::regnamespace AND pg_get_userbyid(a.grantee) IN (SELECT r FROM ledger_roles)
)
SELECT check_name, detail FROM (
  SELECT 'unexpected privilege' AS check_name, x.grantee || ' ' || x.privilege || ' on ' || x.object || CASE WHEN x.col <> '' THEN ' (' || x.col || ')' ELSE '' END AS detail
    FROM (SELECT * FROM actual EXCEPT SELECT * FROM expected) x
  UNION ALL SELECT 'missing privilege', y.grantee || ' ' || y.privilege || ' on ' || y.object || CASE WHEN y.col <> '' THEN ' (' || y.col || ')' ELSE '' END
    FROM (SELECT * FROM expected EXCEPT SELECT * FROM actual) y
  UNION ALL SELECT 'PUBLIC still holds TEMPORARY on the database', current_database()
    FROM pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a WHERE d.datname = current_database() AND a.grantee = 0 AND a.privilege_type = 'TEMPORARY'
  UNION ALL SELECT 'a ledger role holds a database privilege of its own', pg_get_userbyid(a.grantee) || ' ' || a.privilege_type
    FROM pg_database d, aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a WHERE d.datname = current_database() AND pg_get_userbyid(a.grantee) IN (SELECT r FROM ledger_roles)
  UNION ALL SELECT 'a ledger role has a dangerous attribute', r.rolname
    FROM pg_roles r WHERE r.rolname IN (SELECT r FROM ledger_roles) AND (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls OR r.rolcanlogin)
  UNION ALL SELECT 'a ledger role is missing', l.r FROM ledger_roles l WHERE NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = l.r)
  UNION ALL SELECT 'a ledger role is a member of another role', m.rolname || ' in ' || g.rolname
    FROM pg_auth_members a JOIN pg_roles m ON m.oid = a.member JOIN pg_roles g ON g.oid = a.roleid WHERE m.rolname IN (SELECT r FROM ledger_roles)
  UNION ALL SELECT 'a ledger role has a role or database setting', pg_get_userbyid(s.setrole) || ': ' || array_to_string(s.setconfig, ', ')
    FROM pg_db_role_setting s WHERE pg_get_userbyid(s.setrole) IN (SELECT r FROM ledger_roles)
  UNION ALL SELECT 'a definer role has a member', g.rolname || ' has member ' || m.rolname
    FROM pg_auth_members a JOIN pg_roles m ON m.oid = a.member JOIN pg_roles g ON g.oid = a.roleid
    WHERE g.rolname IN (SELECT r FROM definer_roles) AND (a.inherit_option OR a.set_option OR m.rolname <> current_user)
  UNION ALL SELECT 'a role other than the definer can act as it', r.rolname || ' -> ' || d.r
    FROM pg_roles r, definer_roles d WHERE NOT r.rolsuper AND r.rolname <> d.r AND (pg_has_role(r.oid, d.r, 'USAGE') OR pg_has_role(r.oid, d.r, 'SET'))
  UNION ALL SELECT 'a definer function has the wrong owner', d.fn || ' owned by ' || coalesce(pg_get_userbyid(p.proowner)::text, 'missing')
    FROM definer_roles d LEFT JOIN pg_proc p ON p.pronamespace = 'vynvori_ledger'::regnamespace AND p.proname = d.fn AND p.prosecdef WHERE p.oid IS NULL OR pg_get_userbyid(p.proowner) <> d.r
  UNION ALL SELECT 'a ledger function other than the four definers is not owned by the executor', p.proname
    FROM pg_proc p WHERE p.pronamespace = 'vynvori_ledger'::regnamespace AND p.proname NOT IN (SELECT fn FROM definer_roles) AND pg_get_userbyid(p.proowner) <> current_user
  UNION ALL SELECT 'a SECURITY DEFINER function is not one of the four', p.proname
    FROM pg_proc p WHERE p.pronamespace = 'vynvori_ledger'::regnamespace AND p.prosecdef AND p.proname NOT IN (SELECT fn FROM definer_roles)
  UNION ALL SELECT 'a ledger relation is not owned by the executor', c.relname
    FROM pg_class c WHERE c.relnamespace IN ('vynvori_ledger'::regnamespace, 'vynvori_ledger_migrations'::regnamespace) AND pg_get_userbyid(c.relowner) <> current_user
  UNION ALL SELECT 'a definer role holds CREATE on the ledger schema', d.r FROM definer_roles d WHERE has_schema_privilege(d.r, 'vynvori_ledger', 'CREATE')
  UNION ALL SELECT 'a login holding a ledger role is too powerful', m.rolname || ' in ' || g.rolname
    FROM pg_auth_members a JOIN pg_roles m ON m.oid = a.member JOIN pg_roles g ON g.oid = a.roleid
    WHERE g.rolname IN (:'ledger_runtime', :'ledger_checker', :'ledger_reconciliation') AND (a.inherit_option OR a.set_option)
      AND (m.rolsuper OR m.rolcreaterole OR m.rolcreatedb OR m.rolreplication OR m.rolbypassrls OR m.rolname = current_user
        OR pg_has_role(m.oid, current_user, 'USAGE') OR pg_has_role(m.oid, current_user, 'SET')
        OR pg_has_role(m.oid, 'pg_write_all_data', 'USAGE') OR pg_has_role(m.oid, 'pg_read_all_data', 'USAGE'))
  UNION ALL SELECT 'a login holds two ledger roles', m.rolname
    FROM pg_auth_members a JOIN pg_roles m ON m.oid = a.member JOIN pg_roles g ON g.oid = a.roleid
    WHERE g.rolname IN (:'ledger_runtime', :'ledger_checker', :'ledger_reconciliation') AND (a.inherit_option OR a.set_option)
    GROUP BY m.rolname HAVING count(DISTINCT g.rolname) > 1
  UNION ALL SELECT 'a ledger role or its login can create temporary tables', r.rolname
    FROM pg_roles r WHERE (r.rolname IN (SELECT r FROM ledger_roles)
        OR r.oid IN (SELECT a.member FROM pg_auth_members a JOIN pg_roles g ON g.oid = a.roleid WHERE g.rolname IN (SELECT r FROM ledger_roles) AND (a.inherit_option OR a.set_option)))
      AND NOT r.rolsuper AND has_database_privilege(r.oid, current_database(), 'TEMPORARY')
  UNION ALL SELECT 'HARD GATE: a grant source is registered', count(*)::text FROM vynvori_ledger.ledger_grant_sources HAVING count(*) > 0
) violations ORDER BY 1, 2;
```

Run it again after step 7 and after any later change to roles.

### Step 7: attach logins (outside the repository)

Create each login in the provider's console or with `CREATE ROLE ... LOGIN PASSWORD ...` typed directly into psql, with a password
from your secret manager. Never put a password in a file, a variable on a shared machine, or this repository. Then, with the extra
variables `ledger_runtime_login`, `ledger_checker_login` and `ledger_reconciliation_login`:

<!-- s9-sql:attach_logins -->
```sql
GRANT :"ledger_runtime" TO :"ledger_runtime_login";
GRANT :"ledger_checker" TO :"ledger_checker_login";
GRANT :"ledger_reconciliation" TO :"ledger_reconciliation_login";
```

Each login holds exactly one ledger role (the end-state check reports a login with two), is not the executor, is not a superuser, and
holds no `CREATEROLE`, `CREATEDB`, `REPLICATION`, `BYPASSRLS`, `pg_write_all_data` or `pg_read_all_data`. Never grant a definer role
to anyone. Then run step 6 again, and run `checkWalletInvariants` as the checker login: the only acceptable report on a W1 database
is `ok: true`.

## 5. Undo, and the migration rollback after the re-own

**Undo the proposal** (returns the database to its post-migration state; tested). Re-owning back needs `INHERIT` membership, not
`SET`: `ALTER FUNCTION` requires the executor to have the privileges of the current owner (PostgreSQL treats only inherited
membership as ownership), whereas the forward step needed `SET`. Both are transient and inside one transaction.

<!-- s9-sql:reown_back -->
```sql
BEGIN;
GRANT :"ledger_wallet_definer", :"ledger_reservation_definer", :"ledger_package_definer", :"ledger_slot_definer" TO CURRENT_USER WITH INHERIT TRUE, SET FALSE;
ALTER FUNCTION vynvori_ledger.ledger_entries_apply_to_wallet() OWNER TO CURRENT_USER;
ALTER FUNCTION vynvori_ledger.ledger_entries_apply_to_reservation() OWNER TO CURRENT_USER;
ALTER FUNCTION vynvori_ledger.ledger_package_events_apply() OWNER TO CURRENT_USER;
ALTER FUNCTION vynvori_ledger.refinement_slot_events_apply() OWNER TO CURRENT_USER;
REVOKE :"ledger_wallet_definer", :"ledger_reservation_definer", :"ledger_package_definer", :"ledger_slot_definer" FROM CURRENT_USER;
COMMIT;
```

<!-- s9-sql:drop_roles -->
```sql
BEGIN;
REVOKE ALL ON ALL TABLES IN SCHEMA vynvori_ledger FROM :"ledger_runtime", :"ledger_wallet_definer", :"ledger_reservation_definer", :"ledger_package_definer", :"ledger_slot_definer", :"ledger_checker", :"ledger_reconciliation";
REVOKE ALL ON SCHEMA vynvori_ledger FROM :"ledger_runtime", :"ledger_wallet_definer", :"ledger_reservation_definer", :"ledger_package_definer", :"ledger_slot_definer", :"ledger_checker", :"ledger_reconciliation";
REVOKE ALL ON vynvori_identity.profiles FROM :"ledger_runtime";
REVOKE ALL ON SCHEMA vynvori_identity FROM :"ledger_runtime";
DROP ROLE :"ledger_runtime", :"ledger_wallet_definer", :"ledger_reservation_definer", :"ledger_package_definer", :"ledger_slot_definer", :"ledger_checker", :"ledger_reconciliation";
GRANT TEMPORARY ON DATABASE :"ledger_database" TO PUBLIC;
COMMIT;
```

Revoke each login's membership first (`REVOKE <ledger role> FROM <login>`), or `DROP ROLE` refuses. `REVOKE` at table level also
removes the column privileges. Restoring `TEMPORARY` to `PUBLIC` is only right if nothing else in the database was relying on its
absence; skip that line if in doubt.

**Migration rollback after the re-own.** The `rollback/000N_*.down.sql` scripts run as the executor and `DROP FUNCTION` or
`CREATE OR REPLACE FUNCTION` the definer functions, which needs the owner. While the four functions are re-owned, `0007.down` fails
with `must be owner of function ...` and, because each script is one `DO` block, changes nothing (fails closed). The documented order is:
run `reown_back` above, then the down scripts in reverse order (0007 to 0001), then, if the schema is re-applied, this proposal again
from step 1. Tested as up → re-own → down (refused) → re-own back → down → up. The same applies to any later migration that replaces a
definer function: it must re-own back first and re-own afterwards (ADR-0021 S6 caveat), and must update this proposal in the same PR.

## 6. Break-glass (corrected note)

There is no code bypass and none is added. After step 5:

- A **superuser that is not the function owner** is blocked by the guards like everyone else: it cannot `UPDATE` a wallet bucket, a
  reservation state, a package state or a slot state, directly or from a trigger (tested).
- **Re-owning a function back does not by itself permit a correcting `UPDATE`.** Each guard also requires `pg_trigger_depth() > 1`,
  so even the function owner cannot update the row directly.
- The audited options are (a) **restore from backup**, or (b) the **table owner** (the executor) or a superuser runs
  `ALTER TABLE vynvori_ledger.<table> DISABLE TRIGGER <guard>` in a reviewed, time-boxed step, makes the correction, re-enables the
  trigger, and then runs the S8 invariant check as the checker. Never a silent `UPDATE`.
- Because the executor can do (b) at will, it must stay distinct from every login that holds a ledger role, and its credentials are
  handled like a superuser's.

## 7. Hard gates (not closed by this proposal)

1. **Grant sources.** "No real grant source may be registered by any means (migration, seed, runtime, operator script) before grant
   writes sit behind a definer command function bound to verified external evidence. Gate for M4 and W3; precondition in the S9 grants
   proposal." Under this proposal the runtime role still holds `INSERT` on `ledger_entries` and `ledger_commands`, so a registered
   source would let it mint up to the entry bounds. It has no privilege on `ledger_grant_sources` (not even `SELECT`), and steps 1 and 6
   refuse a database where any source is registered.
2. **Definer-only command path for settle, hold, authorize, dispatch and release** (founder, 2026-11-28, HARD GATE before any
   non-synthetic rollout). Under this proposal the runtime role writes these commands through the library with `INSERT` on
   `ledger_commands` and `ledger_entries`, and evidence is caller-asserted (ADR-0021 S5 limit 1, S6 review MEDIUM-1). A forged settle
   or hold through raw runtime-role SQL is irreversible in W1. The gate is met only by a later migration that moves these writes behind
   `SECURITY DEFINER` command functions and revokes the runtime role's direct `INSERT`; this proposal would then change in that PR.
3. **Append-only close and delivery evidence record** (founder, 2026-11-28, HARD GATE before non-synthetic rollout): explicit close and
   delivery counts need an append-only evidence record (actor issuer + subject, time, source event id), with delivery counts from
   system delivery events, never caller-asserted. Not built in W1; the runtime role can record a caller-asserted delivery or close event
   (ADR-0021 S7 limit 1).
4. **Dedicated definer owner roles** (ADR-0021 S2): met by step 5 once applied, and checked by step 6.

## 8. Honest limits

1. **These grants bound the shape of every write, not the business decision behind it.** The runtime role can still do, through raw
   SQL, everything ADR-0021 S5 limit 1 and S7 limit 1 list (authorize against a user's own quote without consent, set a dispatch
   marker, release, settle or hold with caller-asserted evidence, record a delivery or close event). It cannot move a wallet bucket,
   reservation state, package state or slot state outside the definer path, mint credits while no source exists, delete or rewrite
   history, or disable a trigger. Closing the rest is hard gates 2 and 3.
2. **The executor keeps `ADMIN OPTION` on the seven roles** (PostgreSQL 16 gives it to the creating role, with `INHERIT FALSE` and
   `SET FALSE`). It is not usable membership, but the executor could grant itself a definer role again. That is the same trust as the
   table owner's `DISABLE TRIGGER` (§6), so the executor is the break-glass identity, not an application login. Step 6 allows exactly
   this one administrative row per definer and nothing else.
3. **`pg_has_role` and the end-state query see one database's grants.** Roles are cluster-wide; a grant of a ledger role in another
   database on the same cluster is invisible here. Run step 6 in the ledger database and keep the ledger roles out of other databases.
4. **Logins are outside this proposal.** Step 6 checks their attributes and memberships when they hold a ledger role. It cannot check how
   their passwords are stored or rotated, or `pg_hba`/network rules.
5. **The proposal is tied to migrations 0001 to 0007.** Step 1 refuses any other journal, and the test fails if `plan.json` changes
   without this document. A migration that adds a table, a column the runtime writes, a trigger that reads another table, or a definer
   function must update this proposal and its test in the same PR (the S8 maintenance rule, extended).
6. **Database-wide `TEMPORARY` revoke** affects every role in the database (§4 step 2).
7. **Test fidelity.** The test runs the blocks as a non-superuser executor (`current_user`) reached from the superuser fixture login,
   the same technique as `ledger-privileges.test.ts`. `ALTER FUNCTION ... OWNER TO` and `GRANT` check `current_user`, so the
   procedure is faithfully exercised; `SET ROLE` checks the *session* user, so the "a login cannot `SET ROLE` to a definer" assertion
   is made with a real `LOGIN` role (random password generated in the test process, never stored, dropped at the end) connecting on
   its own. Only CI's `db-integration` job on PostgreSQL 17.6 counts as evidence; local PostgreSQL 16 runs are feedback only.

## 9. How this document is tested

`packages/db/tests/ledger-acceptance.test.ts`:

- a unit test (runs everywhere) parses the nine `s9-sql:*` blocks, refuses `$$` and unknown variables, and checks that step 1's
  journal list equals `plan.json` and that every definer function and table named here exists in the migrations;
- the `S9-B*` and `S9-G*` database subtests apply the blocks verbatim as the non-superuser executor on a fresh database, then: step 6 returns zero
  rows; the real library runs every runtime command kind as the runtime role, the checker report is clean as the checker role, and
  vendor-cost evidence is recorded as the reconciliation role; each privilege removed one at a time makes its path fail with `42501`;
  no role can act as a definer (catalog and a real `LOGIN` that tries `SET ROLE`, also with `pg_write_all_data`); the re-own was done
  without a superuser; the migration rollback is refused while re-owned and succeeds after `reown_back`; and `drop_roles` returns the
  database to its pre-proposal privileges.
