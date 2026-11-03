# ADR-0021 — M7 credit-ledger core: foundation (S1)

Status: **proposed, implemented locally for S1 only; not deployed.** Base commit `1fa10e8551211a3ad8611074634773a3f5125b34`. Branch `claude/youthful-johnson-p85ycz`. Plan: `docs/implementation/M7-Plan.md` (rev 4), step S1. Founder approved S1 on 2026-11-02 (direct instruction in session). This ADR records the plan's design decisions as the contract that S2–S9 implement; S1 itself ships **no tables, no wallet or quote logic, no workflows and no dependencies**.

## Context
M7 needs a Neon/Drizzle credit ledger (whole-number credits; `available` / `reserved` / `held_for_review` buckets; append-only entries; versioned quotes; reserve → settle/release; reconciliation hold on unknown provider outcome). Medusa stays the system of record for commerce and is never written from Drizzle. Every financial/paid flag stays OFF; no price, credit cost, package size, hold duration or cut-off may be invented. S1 lays the verified foundation: this ADR, a hash-pinned migration journal with a tested rollback, additive server-only contracts, and the per-file Postgres test harness.

## What S1 delivers
- `packages/db/ledger-migrations/` — `plan.json` (SHA-256 pinned), `0001_ledger_schema.sql` (creates the empty schema `vynvori_ledger` only; no grants), `rollback/0001_ledger_schema.down.sql`.
- `packages/db/src/ledger-migrations.ts` — `ledgerMigrationPlan`, `applyLedgerMigrations`, `LedgerMigrationError`; exported as `@vynvori/db/ledger-migrations`. Same pattern as the composition runner: advisory lock `(742110, 7)`, `lock_timeout`, journal/schema drift check, pinned digests, `OUTCOME_UNKNOWN` when a sent `COMMIT` gets no answer. Targets: only `vynvori_m7_<name>_test` databases, host `127.0.0.1`, role `synthetic`; host, name, role-string and plan-digest mismatches are `TARGET_REJECTED` before any statement; the server-side `current_database()` / `current_user` / `session_user` check runs inside the transaction (after `BEGIN`, `SET LOCAL`, the advisory lock) and also yields `TARGET_REJECTED`. The `planSha256` argument guards against a caller holding a stale plan; it does not pin `plan.json` itself — plan and SQL changes are protected by review. There is deliberately **no remote target** in the plan.
- `packages/contracts/src/ledger-internal.ts` — `server-only`, exported as `@vynvori/contracts/ledger-internal`, **not** in the public barrel: command envelope, `LedgerEntryKindV1`, `LedgerErrorCodeV1` (+ map to `CustomerErrorCode`), `LedgerQuoteRecordV1`, `QuoteAllocationV1`, `ReservationStateV1`, `HoldReasonV1`, `TransitionEvidenceV1`, `GrantSourceKindV1` (names only), three type-only ports (`PricePolicyPort`, `AuthorizationEligibilityPort`, `ProviderOutcomeEvidencePort`) and a `DeferredCapabilityV1` registry (names only, no method shapes).
- `packages/db/tests/ledger-fixture.ts` and `ledger-migrations.test.ts`.

## Decisions (D1–D15; final wording is the plan's §5, which S2–S9 implement)
- **D1 Actor key.** `wallets.user_id uuid PRIMARY KEY REFERENCES vynvori_identity.profiles(id) ON DELETE RESTRICT`; every owned row carries `user_id`. No guest wallets, no email column, no Medusa customer id.
- **D2 Buckets and balanced entries.** `available/reserved/held_for_review/consumed` as `bigint CHECK (>= 0 AND <= 9007199254740991)`; every entry has five deltas summing to zero with a per-`entry_kind` sign pattern (`grant`, `reserve`, `release`, `settle`, `hold`). `0 < charge ≤ hold`. Hold-resolution kinds and anything entering or leaving `operator_remedy` are deferred to the remedy milestone.
- **D3 Database-enforced immutability.** `ledger_entries` append-only (triggers); wallet and reservation state change only through the entry trigger (depth guard `pg_trigger_depth() > 1`); unique cause `(cause_kind, cause_ref)`; one of release/settle/hold per reservation.
- **D4 Idempotency.** Immutable `ledger_commands`; `UNIQUE(scope, idempotency_key)`, `scope = {user_id}:{command_kind}`; same key + same hash replays, different hash is `IDEMPOTENCY_CONFLICT`; terminal business rejections are persisted under the key, transient failures are not. The contract envelope (S1) encodes the scope rule and key format.
- **D5 One reservation per provider operation**, bundle allocations frozen in the quote; the ledger verifies and never computes a split or rounding remainder.
- **D6 Release, settle and hold are evidence-gated and never auto-resolved.** Settle needs `persisted_delivered` with verified manifest and owner/rights; release needs `verified_zero_charge_failure` only (no pre-dispatch release — founder question Q9); hold needs `outcome_unknown` or `persistence_failed_under_review`. A vendor-charge message is never evidence. No timer or sweeper.
- **D7 Quotes.** Immutable `ledger_quotes` with `UNIQUE(quote_id, version_no)`, a locked lineage pointer, authorization checks in one transaction ending in a default-deny `AuthorizationEligibilityPort`. Column ↔ contract mapping:

  | Column | Contract field |
  |---|---|
  | `max_charge_units` | `maxHoldUnits` |
  | `credits_quoted` | `creditsQuoted` |
  | `price_version` | `pricePolicyVersion` |
  | `operation_kind` | `offerKind` |
  | `model_ref` | `modelQualificationSnapshotId` for finals; for bundles the concept-model snapshot reference **supplied by the issuer** (the bundle contract has no model field — additive note for S3) |

  `LedgerQuoteRecordV1` uses the column-side names and stores the validated `QuoteViewV3` separately.
- **D8 Promo uniqueness** per verified `issuer + subject`; entitlement, not a wallet debit; evidence-gated events.
- **D9 Packages and refinement slots** (scaffolding), including the C-02 reopen rule via root's guard.
- **D10 Locking and outcomes.** Lock order: lineage → wallet → reservations by `id`; transaction-scoped features only (Neon pooled connections); `LEDGER_OUTCOME_UNKNOWN` only when `COMMIT` was sent and produced no response, resolved by replaying the same key.
- **D11 Ownership.** Every predicate carries `user_id`; absent and foreign ids return the same `NOT_FOUND`; internal transitions carry `actor` + `expectedUserId`.
- **D12 Funding in W1: a grant-source registry, not a flag.** `0002` registers no sources; the runtime role gets no `INSERT` on the registry, so runtime privileges alone cannot mint credits.
- **D13 Not reachable from runtime.** Static test from S2: nothing under `apps/` and no non-test module imports `@vynvori/db/ledger*`; no numeric constants exported; flags all `false`. S1 satisfies this trivially (no ledger code is imported anywhere).
- **D14 Read-only checks** (`checkWalletInvariants`, `findOrphanedReservations` with a required cut-off, report-only).
- **D15 Test databases and connection budget** — recorded below.

### Privilege model (A vs B) — decision recorded here
**Chosen: A — invoker-rights trigger functions**, with column-level `UPDATE` on `wallets` and `credit_reservations` neutralised by the depth guard, `CHECK`s and the absence of any other writing trigger; `ALTER … DISABLE TRIGGER` and `session_replication_role` are superuser-only and must stay off the runtime role. B (`SECURITY DEFINER` functions owned by a `NOLOGIN` role with a pinned `search_path`) remains the fallback: **the S2 security review must confirm A or flip to B before S2 merges, and the S9 grants proposal must match whichever is chosen.** S1 creates no function or trigger, so nothing in S1 depends on the choice. This is a reviewable engineering decision, not a founder decision, unless the review escalates.

## Connection budget (D15)
Each ledger test file owns database `vynvori_m7_<name>_test`; the fixture allow-list currently contains `migrations`, `fixture`, `concurrency` (later steps append). The single 100-way file `ledger-concurrency.test.ts` (from S2) may use up to **110** connections; every other ledger file caps its pool at **5** (≤ 9 files ⇒ ≤ **45**). Existing suites, counted at their declared maxima in the repository: `auth-state.test.ts` 6, `composition-pg.test.ts` 4, runtime pools in `packages/db/src/{index,identity}.ts` 3 + 3 = **16**. Worst case 110 + 45 + 16 = **171**, below `250 − 3 reserved superuser slots = 247` (CI sets `max_connections=250` and asserts it in `.github/workflows/m2.yml`, root-owned). The fixture reads `SHOW max_connections`; `ledgerPool` clamps to `max_connections − 3` and reports `degraded` when the server limit is below the requested cap. From S2 the concurrency file must **fail** under `CI_REQUIRE_PG_TESTS=1` when degraded; locally it runs reduced and its 100-connection row is `NOT_RUN`. Measured in CI by S9, not by S1.

## Test harness semantics
Postgres-backed tests gate on `M7_TEST_POSTGRES_URL` or `M2_CREATIVE_DATABASE_URL`. URL present ⇒ run. Absent and `CI_REQUIRE_PG_TESTS=1` ⇒ the test **fails**. Absent otherwise ⇒ skipped, reported `NOT_RUN`, never PASS. `CI_REQUIRE_PG_TESTS` is deliberately not a `VYNVORI_*` variable (`packages/shared` rejects unknown `VYNVORI_*` keys). The fixture refuses any target that is not `127.0.0.1` + user `synthetic` + an allow-listed `vynvori_m7_<name>_test` database.

### Security-review dispositions (S1)
Fixed in S1: fixture target guard now rejects any URL query/fragment (pg lets `?host=`/`?user=` override the authority) and never echoes a malformed URL; the down script's guard and drops are one atomic statement (safe under plain `psql -f`); user ids must be lowercase UUIDs so case variants cannot fork idempotency scopes; quote `expiresAt` must follow `issuedAt`. Carried forward: settle/release/hold evidence parse success is **not** authorization — S5/S6 must bind it to persisted state read by the ledger and restrict it to `system` actors (S6 gate); ledger-only keys (`requestSha256`, `evidenceRef`, `modelRef`, `capabilitySnapshotId`, `contentSha256`) are not in `FORBIDDEN_PUBLIC_FIELDS` — extending that list is a root-owned follow-up; the fixture does not pin the port, and concurrent runs of the same test name on a shared server would drop each other's database (CI uses a private server per job).

## Rollout — NOT authorised
Nothing is applied to staging or production. A future apply needs: a separate founder remote-database approval, a native backup first (M2 procedure), a pinned target added to `plan.json`, and runtime-role grants (S9 proposal). The runner has no remote target and no grants.

## Rollback
- Code: revert the PR; the ledger is unreachable from runtime.
- Data: `rollback/0001_ledger_schema.down.sql` (manual; guarded). It refuses while any relation exists in `vynvori_ledger`, drops `vynvori_ledger`, then drops the journal schema `vynvori_ledger_migrations` so up → down → up does not trip the drift check. Rollbacks apply in reverse numeric order. **Caveat (not hidden):** once later migrations add append-only tables, deleting rows needs a superuser to disable triggers; removing real ledger data is **restore from backup**, not "run the down script".
- Tested: up → down → up, rollback refusal while a relation exists, and half-state drift detection in `ledger-migrations.test.ts`.

## Security notes
Parameterised SQL only (the only interpolated identifiers are constants from the reviewed plan); loopback/synthetic/allow-list target rejection precedes any statement; pinned SHA-256 per SQL file and for the plan; idempotency fields are in `FORBIDDEN_PUBLIC_FIELDS` and covered by the leak scan; contracts are `strict`, `server-only` and carry no numeric defaults, prices or limits; nothing here reads or writes Medusa; no secrets in tests (synthetic URLs only).

## API / events / flags
None. No route, no event, no flag added; `.env.example` and `packages/shared` untouched; no dependency or lockfile change. Contract change is additive (new subpath export `./ledger-internal`).

## Open items
Q8 privilege model (above, confirmed in S2 review); Q9 pre-dispatch cancellation path (founder, not W1); remedy execution and Medusa-funded flows (M4+, behind OFF flags).
