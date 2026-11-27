# M7 evidence record (step S9)

Status: **evidence record for review, not an acceptance decision.** The founder decides every ACC status. This record is filled by the
S9 pull request from executed runs only. A check that did not run says `NOT_RUN`. A local PostgreSQL run is feedback only and is
recorded as `NOT_RUN`. Database results count only from the CI `db-integration` job (PostgreSQL 17.6, `CI_REQUIRE_PG_TESTS=1`).
Firefox and WebKit are not involved in M7.

- Starting point: `main` at `3b58997` (merge of #57, S8). Branch `claude/project-thread-zuykda`. `main` at `dc33923` was merged in
  afterwards (records PR #58 and the C6 follow-up); no S9 file changed in that merge except the ADR-0021 addendum.
- CI evidence: CI run [46071716263](https://github.com/smallhingelabs/vynvori/actions/runs/46071716263), job `db-integration` [140750028693](https://github.com/smallhingelabs/vynvori/actions/runs/46071716263/job/140750028693), on PR #60 head `58a021a` (the merge of `main` at `dc33923`). PostgreSQL 17.6 (`starting PostgreSQL 17.6 (Debian 17.6-2.pgdg12+1)` in the job log),
  `CI_REQUIRE_PG_TESTS: 1`. `npm run test:m2` node totals: `# tests 690`, `# pass 688`, `# fail 0`, `# skipped 2`. The two skips are
  the M1b identity tests (`ok 355`, `ok 363`, `# SKIP`), not S9 tests. No line in the job log reads `not ok`.
- Suite: `packages/db/tests/ledger-acceptance.test.ts`. Test names carry the row ids below. The 100-way cases stay in
  `ledger-concurrency.test.ts`. The unit test `S9-TRACE` fails if a row below is missing here or names a test that does not exist.
- Grants proposal: [M7-Runtime-Grants-Proposal.md](M7-Runtime-Grants-Proposal.md) (**proposal, not applied**). The suite executes its
  SQL blocks verbatim, as a non-superuser executor, on a disposable database, and runs every database row below as the proposed roles.
- All units, prices and identities are synthetic. No role password is stored: the one real `LOGIN` role used to test `SET ROLE` gets a
  random password generated inside the test process and is dropped at the end.

## How each check runs

| Where | Command | Counts as evidence |
|---|---|---|
| CI `db-integration` job | `npm run test:m2` (runs `packages/db/tests/*.test.ts` with `CI_REQUIRE_PG_TESTS=1`, so Postgres tests cannot skip) | **yes**, from the job log |
| CI `unit` job | `npm test` (Postgres-backed tests skip there; `S9-DOC` and `S9-TRACE` run) | yes, for the two unit tests |
| Local sandbox, PostgreSQL 16 (all `ledger-*.test.ts`: 278 pass, 0 fail, feedback only) | `M7_TEST_POSTGRES_URL=postgres://synthetic@127.0.0.1:5432/postgres node --conditions=react-server --import tsx --test packages/db/tests/ledger-acceptance.test.ts` | **no** (feedback only, `NOT_RUN`) |

The CI log line for a row is the `node:test` line `ok N - <row id>: ...` (or `not ok`) printed under the top-level test
`S9 grants proposal: applied verbatim by a non-superuser executor; ...` or `S9-B3: migration rollback after the re-own: ...`.

## Rows

Columns: **W1** = in scope for wave 1. **Local** = local PostgreSQL 16 feedback (`feedback: pass` means it ran locally and passed; it is still `NOT_RUN` as evidence). **CI** = the `db-integration` result
and log line from the CI run named above. `ok N` is the subtest number under the main S9 top-level test (`ok 366`) unless the row says
otherwise.

### Doc 15 acceptance targets

| ID | Check | W1 | Tests | Local (feedback only) | CI `db-integration` |
|---|---|---|---|---|---|
| D15-T1 | 100-way concurrent balance operations | yes | `ledger-concurrency.test.ts` (100 grants, S5 100 authorizations, S6 100 mixed commands); `D15-T1` here, small scale under the proposed roles | feedback: pass | pass (`ok 7`) |
| D15-T2 | Duplicate and out-of-order events | yes | `ledger-concurrency.test.ts` (100 identical grants, 100 identical settles); `D15-T2` | feedback: pass | pass (`ok 8`) |
| D15-T3 | Isolation of unknown provider cost | yes | `ledger-settlement.test.ts` vendor-cost isolation; `S9-G4 / D15-T3` as the reconciliation role | feedback: pass | pass (`ok 6`) |
| D15-T4 | Stale-quote renewal | yes | `ledger-concurrency.test.ts` A3(a), S5 renew/authorize race; `D15-T4` | feedback: pass | pass (`ok 9`) |
| D15-T5 | No negative balance, double charge or double grant | yes | `ledger-concurrency.test.ts` same-source_ref grants, S6 mixed on one reservation; `D15-T5` | feedback: pass | pass (`ok 10`) |

### Doc 06 test-matrix rows

| ID | Check | W1 | Tests | Local (feedback only) | CI `db-integration` |
|---|---|---|---|---|---|
| D06-R01 | Simultaneous requests against a wallet that covers exactly one | yes | `D06-R01` | feedback: pass | pass (`ok 11`) |
| D06-R02 | Duplicated payment capture | **no** (M4) | `D06-R02` checks only that no runtime path can register a capture source; the capture flow is **NOT_IN_W1** | feedback: pass | pass, structural part only (`ok 12`) |
| D06-R03 | Provider timeout after billing | yes (ledger side) | `ledger-settlement.test.ts` hold; `D06-R03` | feedback: pass | pass (`ok 13`) |
| D06-R04 | Provider returns artifact but DB write fails | yes (ledger side) | `D06-R04` (`persistence_failed_under_review` hold, unverified settle refused) | feedback: pass | pass (`ok 14`) |
| D06-R05 | Webhook replay / out-of-order | yes (ledger commands; no webhook or inbox in W1) | `ledger-settlement.test.ts` out of order; `D06-R05` | feedback: pass | pass (`ok 15`) |
| D06-R06 | Refund after partial credit consumption | **no** | none; typed `RefundReversalPort` only | NOT_RUN | **NOT_IN_W1** |
| D06-R07 | Unauthorized redemption; ownership on every ID | partly (ownership only) | `D06-R07` | feedback: pass | pass (`ok 16`) |
| D06-R08 | Concurrent carts reuse entitlement | **no** | none; redemption out of scope | NOT_RUN | **NOT_IN_W1** |
| D06-R09 | Digital export paid then failed render | **no** | none; typed port only | NOT_RUN | **NOT_IN_W1** |
| D06-R10 | Guest attempts credit purchase | yes (structurally) | `D06-R10` | feedback: pass | pass (`ok 17`) |
| D06-R11 | Rounding of fractional USD costs | partly | `D06-R11` (units, allocations and USD micros must be whole; USD to credit conversion needs a rate card and is out) | feedback: pass | pass (`ok 18`) |
| D06-R12 | Package fee scenario | partly (synthetic allocations) | `D06-R12` | feedback: pass | pass (`ok 19`) |

### Binding S9 content (ADR-0021 S2 review) and the grants proposal

| ID | Check | W1 | Tests | Local (feedback only) | CI `db-integration` |
|---|---|---|---|---|---|
| S9-B1 | No definer has members; no role can `SET ROLE` to one, checked in the catalog and with a real `LOGIN`, also while it holds `pg_write_all_data` | yes | `S9-B1` | feedback: pass | pass (`ok 3`) |
| S9-B2 | The owner change runs as a non-superuser executor; the transient membership and `CREATE` are gone; the end state is exact | yes | `S9-B2` | feedback: pass | pass (`ok 1`) |
| S9-B3 | Rollback after the re-own: up, re-own, down (DROP succeeds as schema owner; `0006.down` is refused and fails closed), up, steps 3 to 6, re-own back, full down, up, whole proposal, undo | yes | `S9-B3` (separate top-level test, fresh database) | feedback: pass | pass (`ok 367`, subtests `ok 1` to `ok 4`) |
| S9-B4 | Every ledger trigger function refuses a wrong table or schema, `TG_OP`, `TG_WHEN` and `TG_LEVEL`, each alone (29 functions, 116 probes) | yes | `S9-B4` | feedback: pass | pass (`ok 22`) |
| S9-B5 | Break-glass: no superuser or definer owner can update a bucket or state directly; the table owner can only by disabling the named guard | yes | `S9-B5` | feedback: pass | pass (`ok 23`) |
| S9-B6 | HARD GATE on grant sources: steps 1 and 6 refuse a registered source; the runtime role has no privilege on the registry | yes | `S9-B6` | feedback: pass | pass (`ok 4`) |
| S9-G1 | The proposal's end state is exact (step 6 returns zero rows) | yes | `S9-G1`, `S9-B2` | feedback: pass | pass (`ok 2`) |
| S9-G2 | Every runtime and definer privilege is necessary: each unit revoked alone makes the real path fail with `42501` | yes | `S9-G2` | feedback: pass | pass (`ok 5, 20`) |
| S9-G3 | The checker role runs the S8 checks clean, each of its privileges is necessary, and it cannot write | yes | `S9-G3` | feedback: pass | pass (`ok 21`) |
| S9-G4 | The reconciliation role records vendor cost, each of its privileges is necessary; the runtime has no vendor-cost access | yes | `S9-G4 / D15-T3` | feedback: pass | pass (`ok 6`) |
| S9-G5 | Step 6 reports each kind of deviation | yes | `S9-G5` | feedback: pass | pass (`ok 24`) |
| S9-G6 | Undo returns every privilege and owner to the pre-proposal snapshot | yes | `S9-G6` | feedback: pass | pass (`ok 25`) |

### Unit tests (no database)

| Check | Tests | Local | CI `unit` |
|---|---|---|---|
| The proposal parses, renders like psql, grants nothing forbidden, and pins exactly the migrations in `plan.json` | `S9-DOC` | pass | pass: `unit` job succeeded; the same test printed `ok 364` in the `db-integration` log |
| Every row above names tests that exist, and this record lists every row | `S9-TRACE` | pass | pass: `unit` job succeeded; the same test printed `ok 365` in the `db-integration` log |

## NOT RUN

- **Every Postgres-backed row above, locally.** The local PostgreSQL 16 results stay feedback only. The evidence is the CI
  `db-integration` column.
- **D06-R02, D06-R06, D06-R08, D06-R09: NOT_IN_W1.** No Medusa capture, refund, redemption or export path exists in wave 1.
- **The proposal applied to any real database.** It is a proposal. No role, grant or re-own was applied outside a disposable test
  database. No cloud or Neon resource was touched.
- **PostgreSQL 17.6 membership options** (`WITH INHERIT`, `SET`, the creator's `ADMIN`-only row) are now covered by the CI run on
  17.6 (`S9-B1`, `S9-B2`, `S9-G5`, `S9-G6`, `S9-B3` pass). They are not run on any other major version.
- **Connection peak of this file under CI.** Declared peak 7 (runtime pool 2, funder 1, one short-lived checker or reconciliation
  pool, the fixture client, one short-lived real login connection). Not measured: the `db-integration` log reports no per-file peak,
  so it stays declared only (`NOT_RUN`). The job's shared-ceiling test passed (`M3 connection budget: declared peaks fit the shared
  40-connection ceiling`).

## ACC rows proposed to the coordinator (not edited here)

Per M7-Plan §9. The founder decides; `20-acceptance-matrix.md` is not edited by this step.

- **ACC-11 → IN_PROGRESS**, core ledger evidence only. Double grant through Medusa is out of W1.
- **ACC-15 → IN_PROGRESS**, ledger side only.
- **ACC-23 → IN_PROGRESS**, ledger-command replay only. No inbox, outbox or Medusa events.
- No row is proposed as PASSED.

## Repository checks for this PR

Local results are from the merged commit `58a021a` unless the row says otherwise. CI results are from run 46071716263 on the same commit.

| Command | Local result | CI job |
|---|---|---|
| `npm ci` | exit 0 on `9101188`; the merge changed no `package.json` or lockfile | every job: success |
| `npm run lint` | exit 0, `Checked 272 files in 514ms. No fixes applied.` | `lint-typecheck`: success |
| `npm run typecheck` | exit 0, 0 `error TS` | `lint-typecheck`: success |
| `npm test` | exit 0, every runner `# fail 0` (Postgres-backed tests skip without a database) | `unit`: success |
| `npm run security:audit` | exit 0, `npm audit exit=0; findings=0; effective security gate=ACCEPTED_WITH_DATED_WAIVER` (the existing dev-only waiver, unchanged) | `security`: success |
| `npm run test:m2` | not run locally against CI's database | `db-integration`: success (690 tests, 688 pass, 0 fail, 2 M1b skips) |

The other CI jobs on this commit also succeeded: `build`, `container`, `integrity`, `changes`, and `browser` for chromium, firefox and webkit. S9 involves no browser, so the browser jobs are not M7 evidence.
