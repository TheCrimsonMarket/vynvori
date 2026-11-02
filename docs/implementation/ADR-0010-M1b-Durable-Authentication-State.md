# ADR 0010 — durable VYNVORI authentication state

2026-10-19. Local implementation; live migration and activation NOT_AUTHORIZED. Extends the approved issuer+subject boundary in ADR 0002 and central strict-client isolation in ADR 0009.

## Decision

Adapt LuckyLittleDevil's server-side OAuth flow to VYNVORI using durable PostgreSQL transactions rather than signed-cookie-only authorization or product-specific Firestore records. The proposed `vynvori_identity` schema resides in the creative database, never the Medusa database. Medusa remains the commerce authority; no customer or commerce data is written by this store.

Profiles have a unique (issuer, subject) key; email is absent from the identity key. Browser transaction state and session/guest credentials are stored as hashes. PKCE verifiers and central/commerce credentials use versioned AES-256-GCM encryption with deployment, issuer, client, owner, generation and purpose bound as authenticated data. Keys are supplied privately by future server composition; this code does not load, generate, distribute or log live keys.

Callback consumption is a single atomic UPDATE that commits before external exchange. Exactly one raced callback can consume a live transaction, and browser binding must match. A later network failure does not restore the transaction. Transactions expire after ten minutes.

Sessions have an eight-hour absolute ceiling, thirty-minute idle timeout, persisted status and generation. Protected operations must verify central authority state before touching the session. Refresh claims move a session into a non-authorizing refreshing state. Only the matching live lease and generation can commit a rotation; leases are never stolen or retried after uncertainty. Logout changes persisted status and clears leases, so delayed refresh results cannot restore access. A maximum of 96 rotations applies.

Guest draft claim requires possession of the hashed capability plus a current session generation. A first claim binds ownership atomically. Repeated claims by that same owner are idempotent while the capability remains valid; another account cannot take ownership. This is a persistence primitive, not yet integrated with project/assets or exposed through a web route.

## Migration and rollback proposal

### Explicit migration integration — 2026-10-19

The four additive SQL proposals now have a separate Drizzle-format journal and reviewed hash manifest under `packages/db/auth-migrations`. The existing M2 journal and migration command remain unchanged. `identity-migrations.ts` uses the installed Drizzle journal reader, verifies each SQL checksum, and applies all new SQL plus bookkeeping in one PostgreSQL transaction under an advisory lock. The metadata schema is `vynvori_identity_migrations`; runtime receives no access to it. A stored physical-schema digest detects manual schema drift independently of migration text/history. LF attributes keep checked-in SQL hashes stable across platforms.

`node --conditions=react-server --import tsx packages/db/src/migrate-identity.ts --plan` is offline and writes nothing. `--apply` needs the exact plan digest, target acknowledgement and a dedicated explicit migration URL. It rejects the root DATABASE_URL fallback, runtime roles, production, unpinned hosts, poolers, weak TLS and extra connection options. The staging target is the existing M2 creative branch/owner recorded in its deployment plan, never a new inferred resource. The command is not imported by application startup. No automatic retry follows a failure; lost COMMIT acknowledgement returns OUTCOME_UNKNOWN. Separately acknowledged `--inspect` reads only metadata in a read-only transaction and rolls it back. Environment acknowledgements are execution guards, not substitutes for the founder's separate live authorization.

The proposed runtime grant artifact creates a NOLOGIN role and grants only CONNECT, identity-schema USAGE and SELECT/INSERT/UPDATE on the five exact identity tables. It grants no password, owner membership, sequences, defaults, migration history, deletion or Medusa access. LOGIN/secret custody and all actual role/config changes remain separately blocked. Existing roles cause a stop rather than an implicit alteration.

PostgreSQL18.6 disposable verification passes45Node entries:33identity/session scenarios,8migration/privilege scenarios,2plan/target checks and2parent entries. Tests cover all-or-nothing DDL rollback, replay, occupied schema retention, history/physical drift, unknown commit acknowledgement and runtime denial of migration history, DDL, DELETE, TRUNCATE and TEMP. Native pg_dump/pg_restore to another disposable database preserves the exact four history entries and physical schema digest. The image is a public test image, not an application build/deployment. This is not a live Neon backup or migration receipt. [Executed evidence](evidence/M1b-Identity-Migrations-20261019.json).

Live prerequisites remain: source/policy review, a fresh native backup of the actual staging database and verified restore receipt, current target/owner/catalog inspection, explicit grant/secret authorization and approved application rollout. Rollback retains the additive schema, journal, encrypted credentials and reconciliation evidence. There is no destructive down migration or automatic restore/cutover.

`packages/db/auth-migrations/0001_identity_state.sql` is an explicit additive proposal, deliberately outside M2's current automatic migration journal. It creates one new schema and four tables, with identity and credential uniqueness plus lifetime constraints. No existing schema, legacy client, role or index is changed. Runtime store code performs DML only and does not apply DDL on startup/request paths.

Before a separately approved live migration, privately verify the creative target, inspect name/ownership conflicts, record a tested backup/restore receipt, review the exact schema and narrowly scoped runtime grants, and integrate the approved migration into the authoritative migration mechanism with a checksum. A conflicting pre-existing schema must stop execution; do not drop/recreate it or use IF NOT EXISTS to hide drift. No live migration runner or new connection credential has been activated.

Operational rollback disables VYNVORI customer-auth activation and restores the prior application configuration/image. Retain new identity/session/transaction rows and encrypted credential material for reconciliation and any required revocation. Do not drop tables or delete session/family evidence as a default rollback. Destructive removal needs a separate retention/backup decision. No new API/event is externally exposed by this slice. Future route/workflow integration requires its own executed authorization and replay tests.

## Executed verification

Actual PostgreSQL 16.12 in a disposable loopback container: nine scenarios pass (ten Node test entries including parent), including parallel first-login identity uniqueness, twelve-way callback consume, expiry, idle/absolute limits, logout/refresh race, expired-lease fencing, 96-rotation ceiling, competing guest accounts and runtime denial of DDL/delete/truncate/role escalation. The test used an already cached image, synthetic credentials and a non-superuser runtime role; its labeled container was removed. This is not Neon PostgreSQL 18 staging acceptance.

Commerce tests: 48 PASS; credential encryption/context/key-rotation and PKCE/browser/replay cases included. TypeScript and affected lint are checked separately. Public routes/providers, actual commerce provisioning, session cookies, CSRF, complete renewal/logout orchestration and staging acceptance remain incomplete; feature activation remains closed.
