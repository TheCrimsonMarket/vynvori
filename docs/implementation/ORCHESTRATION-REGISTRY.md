# Orchestration registry

Shared-resource and thread registry for the Claude Projects harness. **The coordinator holds the root role and owns this file.** Only coordinator-authored PRs change it, and the founder merges them. Milestone status remains authoritative in [MILESTONE-PROGRESS.md](MILESTONE-PROGRESS.md); this file allocates resources and records who works where. (Repository moved from `TheCrimsonMarket/vynvori` to `smallhingelabs/vynvori`; older documents may still link the old owner.)

Last updated: 2026-11-27 (about 18:50Z). `main` @ `165b645` after the founder merged #42 (CI rebuild, `2797614`), #46 (M3 C7a, `4f32f80`), #44 (M7 S4, `3f51f3a`) and #45 (M3 C3b, `165b645`) on 2026-11-27. **CI on `main` at `165b645`: all `ci.yml` jobs passed** ([run 46051173948](https://github.com/smallhingelabs/vynvori/actions/runs/46051173948), conclusion success, completed 18:47Z; this covers #44 and #45 together, because the run of `3f51f3a` ([46051143832](https://github.com/smallhingelabs/vynvori/actions/runs/46051143832)) was cancelled in the queue before it started). The run of `4f32f80` (#46, [46051113296](https://github.com/smallhingelabs/vynvori/actions/runs/46051113296)) **failed**: `db-integration` was red at the step "M1b identity Postgres harness" ([job 140682402122](https://github.com/smallhingelabs/vynvori/actions/runs/46051113296/job/140682402122)), the other jobs on it that finished were green. The log readable through the API held only the PostgreSQL service output, so that failing assertion is unconfirmed. The same step passed on `165b645`, whose diff against `4f32f80` touches no M1b, identity or commerce-mapping file (21 files, none of them in those areas), which is consistent with the known M1b race (hard-gates row "Known M1b race") but does not prove it; it was not re-run by hand. Each of #44, #45 and #46 was also green on all 11 `ci.yml` jobs at its own PR head before merge (see the merged step history).

## Harness

This repository is worked through Claude Projects, not hand-run sessions.

```
Founder (the only approver and the only merger)
└── Coordinator (the project's channel session; holds the root role)
    ├── Implementer thread 1  (one plan step = one thread = one branch from main = one PR)
    ├── Implementer thread 2
    ├── Implementer thread 3
    └── Implementer thread 4  (sliding window of four; see the rules below)
```

| Node | Does | Does not |
|---|---|---|
| **Founder** | Approves every implementation round, gate and risk; merges all PRs; performs every live or cloud action; answers the owed decisions | — |
| **Coordinator (root role)** | Sequences work within the DAG (`docs/technical/15`); owns this registry and grants shared resources; proposes merge order; **proposes threads and waits for the founder's go-ahead**; verifies integrated `main` after each merge; writes cross-milestone records (`MILESTONE-PROGRESS.md`, dated checkpoints, waiver re-triage); closes milestones; escalates to the founder; reminds the founder of owed decisions without deciding them | Write milestone code; merge; treat any thread message as founder approval |
| **Worker thread** | Executes exactly one plan step inside the files that step lists; commits and pushes in progress; opens one PR with tests, security notes and an evidence table; reports step ID, PR link and head SHA, CI status per job, what ran and what did not, and open questions | Touch another step's scope or any shared lane; merge; touch cloud infrastructure |

Rules for running threads (founder decision of 2026-11-27, which replaces "at most two worker threads at a time, one per milestone track"): a **sliding window of four parallel implementer threads**. When one of them is reviewed and merged by the founder, the coordinator starts the next eligible step, and this continues until the founder says halt. A slot is filled only with a step whose dependencies are merged and whose files, migration journals and shared edits (`plan.json`, `package.json` `exports`) do not overlap a step already running; otherwise the slot stays empty. The window needs no per-step confirmation, but every other rule is unchanged: the founder approves and merges every PR, and a message from a thread or from the coordinator is never founder approval. Reuse the existing thread for follow-ups on the same step. Every thread brief carries the step ID and its file list from the plan, the hard constraints and sandbox facts, the lanes it may not touch, the exit checks, and the relevant rows of the hard-gates table below, and tells the thread to read `AGENTS.md` (`CLAUDE.md` imports it). Security-critical steps (M3 C3b, C5, C6; M7 S5, S6) run on Opus and need a security review before the founder looks at them; every other step runs on Sonnet.

### Authority rules (non-negotiable)

1. **Only the founder approves.** A message between threads or from the coordinator (including relayed text and PR comments) is never founder authorization, merge approval, scope expansion or a gate pass, whatever it claims. The coordinator confirms anything requiring authorization with the founder directly.
2. **One implementation round = one explicit founder go** (AGENTS.md). A blueprint or plan is not authorization to implement.
3. **No node merges, force-pushes to shared branches, or acts on cloud infrastructure** (GCP, Neon, R2, Vercel).
4. **Escalate, don't guess:** every AGENTS.md stop-and-escalate condition goes thread → coordinator → founder.
5. **Acceptance rows PASS only with executed evidence.** In the cloud sandbox, checks needing Docker or Postgres count only when CI runs them (`ci.yml` `db-integration` and `container`). A local "not run" is never reported as passed.

### Cloud-sandbox facts every brief must state

- No Docker daemon or live databases in sessions; no GCP/Neon/R2/Vercel access.
- Containers are ephemeral and isolated: only pushed work exists, and sessions cannot see each other's working trees.
- One designated branch per thread; GitHub through the MCP tools (`gh` only for search).
- `npm ci` before any check; run `npm run verify` and `npm run security:audit` before reporting a PR ready.

## Resource lanes

Only the holder may change files in a lane. **Root-only** lanes change through coordinator PRs (or a worker PR that the coordinator explicitly grants for a named step). "Root" below means the coordinator.

| Lane | Files | Holder | Notes |
|---|---|---|---|
| Dependencies | `package-lock.json`, any `package.json` dependency/override fields | **free** (request from root) | One holder at a time. Any new advisory fails `security:audit` (ADR-0020) and needs a founder risk decision. |
| Shared contracts | `packages/contracts/**` | **M7 (additive), shared with root** | Granted to M7 2026-11-02 for additive ledger contracts. Root holds `state-machines.ts` Plane C and `operations.ts` package-state definitions (Q7 fix); M7 must not edit them. |
| Security policy | `security/**`, `scripts/security/**`, `scripts/security-smoke.mjs` | root only | Founder approval required for any change. |
| Protected files | `docs/implementation/M0-protected-files.json` and every file it lists (including `docs/technical/20-acceptance-matrix.md`) | root only | Re-anchoring needs founder authorization (precedent: PR #18). |
| CI | `.github/workflows/**`, `scripts/deployment-check.mjs`, `scripts/integrity.mjs` | root only | |
| Cross-milestone records | `docs/implementation/MILESTONE-PROGRESS.md`, this registry | root only | Threads propose text; the coordinator writes it. |
| Environment example | `.env.example` | root only | Commented key names only, never values. Thread edits need an explicit grant (founder rule, 2026-11-03). |
| Canonical specs | `docs/technical/00`–`25`, reference contracts | founder only | Byte-for-byte intact unless the founder authorizes otherwise. |

## Numbered resources

### ADRs (`docs/implementation/ADR-NNNN-*.md`)

Last used: **ADR-0023**. Two historical files share number 0008 (`ADR-0008-M2-Closure-and-Published-Provenance.md`, `ADR-0008-Typed-Contracts-Scaffold.md`). They are kept as-is to preserve existing links. New numbers come only from this table.

| Number | Reserved for | Holder | Status |
|---|---|---|---|
| ADR-0021 | M7 core ledger foundation | M7 track | granted 2026-11-02; **merged** with S1 ([#23](https://github.com/smallhingelabs/vynvori/pull/23), `714a0ae`); addenda for S2 ([#27](https://github.com/smallhingelabs/vynvori/pull/27)), S3 ([#36](https://github.com/smallhingelabs/vynvori/pull/36)) and S4 ([#44](https://github.com/smallhingelabs/vynvori/pull/44)) merged; the S5 addendum is in open [#47](https://github.com/smallhingelabs/vynvori/pull/47) |
| ADR-0022 | M3 closure (asset access, scan boundary, guest limits) | M3 track | granted 2026-11-03; **written and merged** with C2 ([#29](https://github.com/smallhingelabs/vynvori/pull/29), `06f68e8`); the C3a section merged with [#35](https://github.com/smallhingelabs/vynvori/pull/35) and the C3b section (lock order, review outcomes, gates for C4 and C5) with [#45](https://github.com/smallhingelabs/vynvori/pull/45) |
| ADR-0023 | Dated waiver refresh and Next.js 16.4.6 ([ADR-0023](ADR-0023-Waiver-Policy-Refresh-and-Next-16-4-6.md)) | root (dependency lane) | **merged** with [#41](https://github.com/smallhingelabs/vynvori/pull/41) (`c99f589`) on 2026-11-27 |
| ADR-0024 and later | unallocated | root | request from the coordinator |

### Migration journals (`packages/db`)

| Journal | Path | Latest | Owner milestone |
|---|---|---|---|
| Core (drizzle-kit) | `packages/db/migrations/` | `0000_organic_valkyrie.sql` | M2 |
| Identity / auth | `packages/db/auth-migrations/` | `0004_revocation_reconciliation.sql` | M1b |
| Composition | `packages/db/composition-migrations/` | `0002_asset_access_and_limits.sql` (M3 C3a, [#35](https://github.com/smallhingelabs/vynvori/pull/35), `35d73d8`); `0003` is the next number and is unallocated (C3b added no migration) | M3 |
| Ledger | `packages/db/ledger-migrations/` | `0004_promo_claims.sql` (M7 S4, [#44](https://github.com/smallhingelabs/vynvori/pull/44), `3f51f3a`); after `0001_ledger_schema.sql` (S1), `0002_wallet_ledger.sql` (S2) and `0003_quotes.sql` (S3, [#36](https://github.com/smallhingelabs/vynvori/pull/36)). **`0005` is the next number and is taken by open PR [#47](https://github.com/smallhingelabs/vynvori/pull/47) (S5, `0005_reservations`)**; the plan fixes `0006` for S6 and `0007` for S7 by step, not by merge order | M7 (granted 2026-11-02) |

### Advisory-lock keys (`pg_advisory_xact_lock(742110, n)`)

| n | Use | Holder |
|---|---|---|
| 1 | identity migrations | M1b |
| 2 | unassigned | root |
| 3 | composition migrations (includes `0002`) | M3 |
| 4 | **not used in the two-int form.** M3-closure runtime/quota serialization uses the single-bigint form `pg_advisory_xact_lock(bigint)` whose high 32 bits are 4: `(4::bigint << 32) | (hashtext(subject)::bigint & 4294967295)`. That is a separate lock space from the two-int form. Binding conditions (unsigned mask, one acquisition order composition-before-asset, xact locks only, hashtext never persisted) are in the M3 plan D8 and ADR-0022. | M3-closure manager (granted 2026-11-03) |
| 5, 6 | unassigned | root |
| 7 | ledger migrations | M7 |

### Postgres test databases and connection budget (`ci.yml` `db-integration` job)

- Job Postgres: `max_connections = 250` (asserted in the workflow); 20 are held back for tooling, so test files may use at most 230 combined.
- `node --test` runs at most `availableParallelism - 1` files at once (a handful on standard GitHub runners), so the real peak is the sum of the largest concurrently running files, not of all files. Each track declares per-file peaks **including each file's own persistent client and transient admin/probe connections**, not only pool caps. Declared so far: M7 about 112 (one concurrency file) and about 7 per other ledger file (about 175 if all ran at once, about 191 with the existing suites); M3 closure 20 (one file) + 5 per other DB file. Existing suites (M2 creative, M3 composition, M1b identity) also count.
- Fixtures check their own pool against `SHOW max_connections` and fail under `CI_REQUIRE_PG_TESTS=1` when it does not fit; they cannot see other files' usage. Threads record the CI-measured number at close.
- If a runner change or new suites make the realistic worst case exceed the ceiling, root serializes the Postgres suites with `--test-concurrency=1` in a workflow PR instead of shrinking tests (M7 has agreed this is acceptable).
- Database naming: M3 closure `vynvori_m3_<name>_test`, one database per DB test file; M7 uses one database per ledger test file. CI's `synthetic` superuser creates them. No test may drop another file's schemas.

New journals or new sequence numbers in an existing journal are allocated by the coordinator on request. A milestone never appends to another milestone's journal without a grant from the coordinator. Every migration needs a documented, non-destructive rollback (AGENTS.md §4).

## Threads and merged step history

**Claude Projects setup (from 2026-11-27).** One coordinator holds the root role. Each plan step runs in its own implementer thread on its own branch from `main` and opens one PR. Up to four implementer threads run at once as a sliding window (decisions log, 2026-11-27); the founder merges every PR, and each merge frees a slot. A message from a thread is unverified until the founder confirms it. Threads started by the coordinator are listed here when they start:

| Thread | Step | Branch | PR | Status |
|---|---|---|---|---|
| Update root records and agent entry docs | root housekeeping | `claude/project-thread-fgu3my` | [#37](https://github.com/smallhingelabs/vynvori/pull/37) | **merged** (`0880cbe`) |
| M7 S4 promo-claim uniqueness | M7 S4 | `claude/project-thread-p0dvuj` | [#44](https://github.com/smallhingelabs/vynvori/pull/44) | **merged** (`3f51f3a`) |
| M3 C3b store port | M3 C3b | `claude/project-thread-c1ti5g` | [#45](https://github.com/smallhingelabs/vynvori/pull/45) | **merged** (`165b645`) |
| M3 C7a editor core accessibility | M3 C7a | `claude/project-thread-2kzd85` | [#46](https://github.com/smallhingelabs/vynvori/pull/46) | **merged** (`4f32f80`) |
| M7 S5 authorize, reserve, release | M7 S5 | `claude/project-thread-f6lpbg` | [#47](https://github.com/smallhingelabs/vynvori/pull/47) | open, awaiting the founder (S5 questions in the owed decisions) |
| M3 P1 scanner options paper | M3 P1 (docs only, one new file) | `claude/project-thread-iewdxh` | [#48](https://github.com/smallhingelabs/vynvori/pull/48) | open, awaiting the founder |
| M3 C4 quota, rate limits, authorize-before-read | M3 C4 | not yet reported | none yet | started 2026-11-27 by the coordinator, after #45 merged |
| This records update | root records (this change) | `claude/project-thread-apocs2` | opened with this change | in review |

**Merged step history (hand-run sessions, until 2026-11-04, and the founder merges of 2026-11-27).** The old session table was removed; the old session IDs no longer exist.

| Track | Step | PR | Merge | Branch |
|---|---|---|---|---|
| Root | W0 CI recovery, waiver gate | [#18](https://github.com/smallhingelabs/vynvori/pull/18) | `3760de6` | |
| Root | registry; W1 shared-lane PR | [#19](https://github.com/smallhingelabs/vynvori/pull/19), [#21](https://github.com/smallhingelabs/vynvori/pull/21) | `92c8114`, `1fa10e8` | |
| M7 | plan rev 4 | [#20](https://github.com/smallhingelabs/vynvori/pull/20) | `190a73e` | `claude/exciting-wright-9f71eg` |
| M7 | S1 foundation | [#23](https://github.com/smallhingelabs/vynvori/pull/23) | `714a0ae` | `claude/youthful-johnson-p85ycz` |
| M7 | S2 wallet + ledger, privilege model B | [#27](https://github.com/smallhingelabs/vynvori/pull/27); docs corrections [#33](https://github.com/smallhingelabs/vynvori/pull/33) | `c4b54dd`; `804843a` | `claude/jolly-darwin-fpwkqu` |
| M7 | plan rev 6 (docs only) | [#34](https://github.com/smallhingelabs/vynvori/pull/34) | `db5b401` (2026-11-27) | `claude/exciting-wright-9f71eg` |
| M7 | S3 versioned quotes, ledger `0003_quotes` | [#36](https://github.com/smallhingelabs/vynvori/pull/36) | `2bff532` (2026-11-27) | `claude/busy-wright-xadant` |
| M3 | plan | [#22](https://github.com/smallhingelabs/vynvori/pull/22); rev 4 [#30](https://github.com/smallhingelabs/vynvori/pull/30) | `0bcc78a`; `7a51d8e` | `claude/determined-mendel-0h42pl` |
| M3 | C1a browser harness | [#25](https://github.com/smallhingelabs/vynvori/pull/25) | `37021ba` | `claude/vigilant-noether-toz8yc` |
| M3 | C2 ADR-0022, typed fail-closed limits | [#29](https://github.com/smallhingelabs/vynvori/pull/29) | `06f68e8` | |
| M3 | C1c cross-engine triage and fix | [#32](https://github.com/smallhingelabs/vynvori/pull/32) | `b84ad68` | `claude/nice-carson-4d7v4d` |
| Root | Firefox and WebKit in the browser CI job | [#28](https://github.com/smallhingelabs/vynvori/pull/28) | `61c261e` | `claude/peaceful-heisenberg-cocinf` |
| M3 | C3a composition `0002` + rollback | [#35](https://github.com/smallhingelabs/vynvori/pull/35) | `35d73d8` (2026-11-27) | `claude/m3-migration-ddl-rollback-62pu2f` |
| Root | records, `CLAUDE.md`, mandate text | [#37](https://github.com/smallhingelabs/vynvori/pull/37) | `0880cbe` (2026-11-27) | `claude/project-thread-fgu3my` |
| Root | skip full CI on docs-only changes | [#38](https://github.com/smallhingelabs/vynvori/pull/38) | `9264549` (2026-11-27) | `claude/project-thread-2okwd1` |
| Root | ESLint replaced by Biome (lint only) | [#40](https://github.com/smallhingelabs/vynvori/pull/40) | `b49b0d1` (2026-11-27) | `claude/project-thread-034odu` |
| Root | next 16.4.6, dated waiver refresh, ADR-0023 | [#41](https://github.com/smallhingelabs/vynvori/pull/41) | `c99f589` (2026-11-27) | `claude/project-thread-50ucpn` |
| Root | CI rebuilt as one purpose-named `ci.yml`; WebKit prefetch settle fix (`e76c8ed`) | [#42](https://github.com/smallhingelabs/vynvori/pull/42) | `2797614` (2026-11-27 15:20Z) | `claude/project-thread-jfm5hu` |
| M3 | C7a editor core accessibility (no ADR, migration or contract change) | [#46](https://github.com/smallhingelabs/vynvori/pull/46) | `4f32f80` (2026-11-27 18:39Z); PR head `d0d7c79`, all 11 CI jobs green ([run 46029584529](https://github.com/smallhingelabs/vynvori/actions/runs/46029584529)) | `claude/project-thread-2kzd85` |
| M7 | S4 promo-claim uniqueness, ledger `0004_promo_claims` + rollback, [ADR-0021 S4 addendum](ADR-0021-M7-Core-Ledger-Foundation.md) | [#44](https://github.com/smallhingelabs/vynvori/pull/44) | `3f51f3a` (2026-11-27 18:39Z); PR head `d2338b3`, all 11 CI jobs green ([run 46027588086](https://github.com/smallhingelabs/vynvori/actions/runs/46027588086)) | `claude/project-thread-p0dvuj` |
| M3 | C3b store port (PostgreSQL and in-memory), no migration, [ADR-0022 C3b section](ADR-0022-M3-Closure-Asset-Access-Scanning-and-Limits.md) | [#45](https://github.com/smallhingelabs/vynvori/pull/45) | `165b645` (2026-11-27 18:40Z); PR head `ecef2a4`, all 11 CI jobs green ([run 46028562572](https://github.com/smallhingelabs/vynvori/actions/runs/46028562572), `db-integration` 346 pass, 0 fail, 2 skipped) | `claude/project-thread-c1ti5g` |

**Next steps (from the 2026-11-27 sliding-window decision, no per-step confirmation).** Merged: M3 C1a, C1c, C2, C3a, C3b, C7a; M7 S1 to S4. In flight: M3 C4 (started after #45), M7 S5 (open [#47](https://github.com/smallhingelabs/vynvori/pull/47)) and the M3 scanner options paper P1 (open [#48](https://github.com/smallhingelabs/vynvori/pull/48)). Remaining W1: M3 C5, C6, C7b and C8; M7 S6 to S9. Eligibility follows the plans' dependency chains: M3 is serial (C4 → C5 → C6 → C7b → C8, and C7b also needs C7a); M7 S6 and S7 need S5 merged, S8 needs S4, S6 and S7, and S9 needs S1 to S8. So until #47 and C4 merge, no other implementer step is eligible, and the window stays below four (P1 is a docs-only paper). C5, C6 and S5, S6 are security-critical (Opus plus a security review).

## Protocol

- **Resource request (thread → coordinator):** `RESOURCE REQUEST — milestone, lane or number, plan step, reason`. The coordinator replies `GRANTED`/`DENIED`/`QUEUED`. A grant is effective on the coordinator's reply and recorded in the next registry update. Grants that need a founder decision (dependencies, security policy, protected files, `.env.example` values) wait for the founder. On conflict, this file plus the coordinator's latest grant message wins.
- **Status report (thread → coordinator):** step ID, PR link and head SHA, CI status per job, evidence (including what was *not* run), open questions.
- **Milestone close request (thread → coordinator):** all step PRs merged; evidence and ADR links. The coordinator then verifies integrated `main`, writes the closing records and asks the founder to confirm any acceptance changes.
- **Merge order:** the coordinator proposes it to the founder, and the founder merges. After each merge the coordinator verifies `main` and updates the records.

## Wave plan

From the 2026-11-02 council; the founder decides each wave's start.

| Wave | Tracks | Prerequisites | Max parallel worker PRs | Status |
|---|---|---|---|---|
| W0 | CI recovery, dependency remediation, waiver gate | — | 1 | **DONE** (PR #18) |
| W1 | M7 core ledger (no Medusa top-ups) + M3 local closure | CI green ✅ on `165b645` (see header; `security:audit` passes under the ADR-0020 waiver; one `db-integration` M1b-harness failure on `4f32f80` is noted in the header); founder authorization ✅ | 4 (sliding window, founder decision 2026-11-27) | **IN PROGRESS**: M7 S1 to S4 merged (S5 open as #47, then S6 to S9); M3 C1a, C1c, C2, C3a, C3b and C7a merged (C4 started, then C5, C6, C7b, C8 and P1); Firefox/WebKit CI job [#28](https://github.com/smallhingelabs/vynvori/pull/28) merged. Next eligible steps start without a per-step go, until the founder halts |
| W2 | M4 sandbox commerce + M6a mock studio | M1b PASSED, M3 PASSED | 2 | blocked |
| W3 | M5, M7 top-ups, M8a, M8b | M4 (and M6a for M8b) | 2–3 | blocked |
| — | M6b, M9 | doc 15 gates; production, financial, rights, vendor and SSO flags stay OFF | — | blocked |

## Founder decisions log

| Date | Decision |
|---|---|
| 2026-11-02 | W1 authorized. M7 manager = `session_01CowtxkLZEcmhjncVjGLGqK`. |
| 2026-11-02 | M7 Q1/Q2/Q6 defaults accepted: funding only via a registered grant source (none in W1); no promo re-offer after a verified-uncharged failure; fixed quoted charges only. |
| 2026-11-02 | Q7 contract gap: root fixes it. Additive: guarded C-02 reopen edge plus the internal → customer package-state mapping. No rename, because the canonical v1.1 reference contract and protected fixtures use `refinements_open`. |
| 2026-11-02 | CI Postgres coverage: root wires the M3 composition suites and the M1b identity harness into `m2.yml`, sets `CI_REQUIRE_PG_TESTS=1` and `max_connections=250`. The flag avoids the reserved `VYNVORI_*` prefix, which must always be `false`. |
| 2026-11-02 | Local PG16 binaries allowed for feedback only; such results are NOT_RUN as evidence. |
| 2026-11-02 | M7 plan rev 4 (#20) approved and merged; implementation round 1 (S1–S9) authorized, serial, one worker at a time, founder starts workers and merges each PR. Q9 (pre-dispatch cancellation release) not in W1. |
| 2026-11-03 | M3-closure manager confirmed (`session_01CowtxjZHg48RKM7XdfDfsf`). Rulings: (QB) the editor's local preview of the user's own file may stay; server-sourced pixels require scan status `clean`. (QC) no scanner chosen; manager brings an options paper, M3 stays at LOCAL CLOSURE COMPLETE and W2 stays blocked until the founder picks a scanner and enables uploads. (QA) browser fixture: flags-OFF scenarios only, C1b not approved. (Q1) M3's built-in numeric limits (24 h guest TTL, 25 MiB / 36 MP / 20 000 px, 24 assets, 150 MiB, 256 KiB) are unapproved: C2 removes the defaults, runtime fails closed until the founder supplies values. |
| 2026-11-03 | M7 S1 approved by the founder and merged ([#23](https://github.com/smallhingelabs/vynvori/pull/23)). Root grant applied: `FORBIDDEN_PUBLIC_FIELDS` gained `requestSha256`, `evidenceRef`, `modelRef`, `contentSha256`; `capabilitySnapshotId` deliberately stays public (`quote.ts`, `studio-plan.ts`). Privilege model A stays provisional until the S2 security review confirms or flips it. |
| 2026-11-03 | M3 closure plan rev 3 approved and merged ([#22](https://github.com/smallhingelabs/vynvori/pull/22)); implementation round 1 authorized: C1a, C2, C3a, C3b, C4, C5, C6, C7a, C7b, C8, serially, one worker at a time, founder merges each PR. C1b not approved. Safe defaults apply to the open plan questions (single-use download grants; no owner download of non-clean originals; no deletion of quarantined objects; no accessibility waivers; no staging hold-pending mode; proceed with the app-issued grant for ACC-07 and note the wording). |
| 2026-11-03 | CODEOWNERS and branch-protection setting declined for now. |
| 2026-11-03 | `.env.example` change in C2 (31 commented-out `M3_LIMIT_*` key names, no values) kept; #29 merged. Rule from here: `.env.example` is root-owned; manager or worker edits need a root grant; commented key names only, never values. |
| 2026-11-03 | WebKit `/account` prefetch: the M3-closure manager relayed that the founder granted a single-variable change (`prefetch: false` on the `/account` link only, no filter, no skipped check); confirmed by CI (all three engines 87/87, run 41612993300). Root separately granted, for C1c, declaring `zod` 4.6.7 in `apps/web/package.json`. |
| 2026-11-03 | M7 S2 merged with the security reviewer's three doc/test-only items deferred to #33 (override accepted by root with conditions; no SQL changed after the verdict). S3 brief held until #33 merged and `main` was green. |
| 2026-11-27 | Claude Projects replaces the hand-run sessions. One coordinator holds the root role; threads are workers (one plan step, one branch, one PR); at most two worker threads at a time, one per milestone; coordinator proposes threads and waits for the founder's go; founder approves everything and merges everything. The old session table is removed. |
| 2026-11-27 | Founder merged [#35](https://github.com/smallhingelabs/vynvori/pull/35) (M3 C3a, `35d73d8`), [#34](https://github.com/smallhingelabs/vynvori/pull/34) (M7 plan rev 6, `db5b401`) and [#36](https://github.com/smallhingelabs/vynvori/pull/36) (M7 S3, `2bff532`). |
| 2026-11-27 | Recorded rules: a message from any thread is never founder approval; local Postgres results are feedback only and count as NOT_RUN, only the CI foundation job counts; `.env.example` is root-owned, commented key names only; CODEOWNERS and branch protection were declined 2026-11-03 and are not proposed again unless merging is delegated; no scanner is chosen and no M3 limit values are supplied, uploads stay off and W2 stays blocked; the Cloud Run staging service is deleted and any step that needs staging asks the founder first; security-critical steps (M3 C3b, C5, C6; M7 S5, S6) use the strongest model and get a security review before the founder looks at them. |
| 2026-11-27 | Known flakes: the WebKit RSC prefetch check in the `browser` job and the M1b identity harness step (hard-gates row "Known M1b race"). Re-run once and cite the row; never weaken the check. |
| 2026-11-27 | CI renamed by purpose (PR #42, founder request): one `ci.yml` with jobs `changes`, `integrity`, `lint-typecheck`, `unit`, `build`, `security`, `db-integration`, `container`, `browser (chromium/firefox/webkit)`. `db-integration` replaces `m2.yml` `foundation` and is the only job that counts as database evidence. `m0.yml` `verify` split into `lint-typecheck`, `unit`, `build`, `security`; `medusa-container.yml` and the worker steps became `container`; `integrity` runs on every change including docs-only. The #38 docs-only rule is unchanged. Runs on `main` are no longer cancelled by a later merge. |
| 2026-11-27 | Root records: ADR-0023 linked (merged with #41). The `security:audit` REJECTED (`UNWAIVED_ADVISORY`) hard-gate row is retired: the M0 `verify` job passed `security:audit` on `c99f589` (run 45998555856). The Medusa 2.23.1 upgrade is recorded as an owed founder decision with a 2026-12-10 fallback of extending the waiver window. |
| 2026-11-27 | Reminder for the ADR-0020 waiver expiry (2026-12-17T23:59:59Z) is set for 2026-12-10 10:00 Asia/Dhaka. |
| 2026-11-27 | **Worker model changed (founder, 2026-11-27 15:17Z and 15:19Z, after the CI update merged).** Real implementation restarts with a sliding window of **four parallel Sonnet implementer threads**. When one is reviewed and merged, the next eligible step starts, until the founder asks to halt for the day. Replaces "at most two worker threads, one per milestone track" and the per-step confirmation. The founder agreed that moving the project to Claude cloud (no strain on the local machine) makes the faster pace possible. Slots are filled only with steps whose dependencies are merged and whose files and journals do not overlap. Security-critical steps (C3b, C5, C6, S5, S6) run on Opus with a security review before the founder looks at them. A plan is still not permission to implement, and nothing else in the authority rules changed. |
| 2026-11-27 | Founder merged [#42](https://github.com/smallhingelabs/vynvori/pull/42) (CI rebuild and the WebKit prefetch settle fix, `2797614`), [#46](https://github.com/smallhingelabs/vynvori/pull/46) (M3 C7a, `4f32f80`), [#44](https://github.com/smallhingelabs/vynvori/pull/44) (M7 S4, `3f51f3a`) and [#45](https://github.com/smallhingelabs/vynvori/pull/45) (M3 C3b, `165b645`). Follow-ups recorded: S4 (bind events to command kinds; bind the `reconciled_*` evidence kinds to a reconciliation actor with M6b/M8a; keep the table owner distinct from the runtime role in the S9 grants) and C7a (below, owed decisions). C3b hands gates to C4 and C5 (hard-gates table). |

## Hard gates carried forward (do not lose)

These are conditions found in review that must hold before the named point. Each is also recorded in the owning ADR; the registry keeps them visible across sessions.

| Gate | Applies before | Owner | Recorded in |
|---|---|---|---|
| **No real credit grant source** may be registered by any means (migration, seed, runtime, operator script) until grant writes sit behind a SECURITY DEFINER command function bound to verified external evidence. Under the S2 design the runtime role keeps INSERT on ledger entries; with a source registered it could mint credits. W1 registers none, and tests prove the runtime role has no privilege on the source table, the table is empty, and an entry referencing no registered source is rejected. | M4, W3 top-ups, any wallet funding | M7 | ADR-0021 (S2 fix round), S9 grants proposal |
| **Dedicated definer owner role.** The ledger's SECURITY DEFINER functions run with their owner's privileges. The known staging migration owner holds CREATEDB, CREATEROLE and BYPASSRLS, so rollout is not authorized until a dedicated NOLOGIN, NOSUPERUSER, NOBYPASSRLS, NOCREATEROLE role owns them (`ALTER FUNCTION ... OWNER TO`, founder-executed). | any non-synthetic ledger rollout | M7 | ADR-0021, S9 grants proposal |
| **S9 grants proposal contents** (founder-executed, never in migrations): column-level `GRANT UPDATE (user_id)` on wallets for the runtime role (needed for `SELECT ... FOR UPDATE`), EXECUTE grants on the definer functions, `REVOKE TEMPORARY` for the runtime role (PUBLIC holds TEMP by default, and revoking from a role alone does nothing), the dedicated owner role, and the grant-source gate above. | any non-synthetic ledger rollout | M7 | S9 |
| **S9 owner-role steps (from the S2 security review, executed attacks).** (1) The definer owner role has NO members and the runtime role cannot `SET ROLE` to it (a `GRANT <owner> TO <runtime>` plus a temp-table trigger minted credits in review). (2) The owner-change steps must be executable as written by the role that runs them (transient SET membership and transient CREATE on the schema, both revoked afterwards; end state exactly USAGE on the schema and SELECT, UPDATE on wallets, no CREATE). (3) Rollback order after the re-own: re-own the function back before `DROP FUNCTION`. (4) Break-glass is the table owner's `DISABLE TRIGGER` or a backup restore; re-owning alone does not permit an UPDATE. | any non-synthetic ledger rollout | M7 | ADR-0021 (docs PR before S3), S9 |
| **S5 reservation guards** must use the SECURITY DEFINER + function-owner pattern, never a trigger-depth check alone. | M7 S5 | M7 | ADR-0021 binding sentence |
| **S8 invariants check** that the apply trigger exists and is enabled (`DROP OWNED BY ... CASCADE` drops it silently, executed in review). | M7 S8 | M7 | S8 |
| **Known M1b race (open, awaiting founder authorization of M1b-fix-1).** `reserve()` in `packages/db/src/commerce-mappings.ts` uses `ON CONFLICT (user_id,project_id) DO NOTHING` while the table also has `UNIQUE (project_id, entity_id)`; concurrent first-commerce calls raise 23505 on the second constraint (35 of 400 local rounds). It makes the M1b harness step flaky in CI. Not contention or pool size. Until fixed, re-run and cite this row. **2026-11-27:** `db-integration` on `4f32f80` failed at the step "M1b identity Postgres harness" ([job 140682402122](https://github.com/smallhingelabs/vynvori/actions/runs/46051113296/job/140682402122)); the log readable through the API held only the PostgreSQL service output, so the failing assertion is unconfirmed and this is not established as the race. The same step passed on `165b645` ([run 46051173948](https://github.com/smallhingelabs/vynvori/actions/runs/46051173948)), whose diff against `4f32f80` touches no M1b, identity or commerce-mapping file, which is consistent with the race. | cleaner CI; real double-click risk | root / M1b | M1b-fix-1 brief |
| **Scanner chosen and uploads enabled; the 31 M3 limit values supplied.** M3 stays at local closure and W2 stays blocked until both. | M3 PASSED, W2 | founder | M3 closure plan section 5.1, P1 |
| **Topology-dependent assertions** must be validated against CI's Docker-service layout before being relied on (an `inet_server_addr()` loopback check failed CI in M7 S1). | every PG test step | all managers | ADR-0021 |
| **Known flake: WebKit RSC prefetch check** in the `browser (webkit)` job (formerly the M0 `browser` job's WebKit step). The `/account` prefetch variable was changed by founder grant on 2026-11-03 (decisions log) and all three engines passed on `61c261e`. It has since failed on other header links: `/` and `/cart` on `0880cbe`, `/studio` and `/gallery` on `c99f589` ([run 45998555856](https://github.com/smallhingelabs/vynvori/actions/runs/45998555856)). Cause named in the log: WebKit reports `Fetch API cannot load http://127.0.0.1:<port>/<route>?_rsc=<token> due to access control checks.` as a console error when the harness's `page.goto` cancels an in-flight Next.js link prefetch, and the harness fails on any console error. The fix (`e76c8ed`, in #42, merged as `2797614`) makes the harness wait for in-flight prefetches before each hard navigation; nothing is filtered or skipped. `browser (webkit)` has passed on `2797614` and on the PR heads of #44, #45 and #46, and on `165b645` (run 46051173948; the run of `4f32f80` also reached its three browser jobs before it failed on `db-integration`, but their results were not read here). Keep this row until the check has stayed green across more runs on `main`. If it fails again: re-run once and cite this row. Never filter, skip or loosen the check. | any PR whose only red job is `browser (webkit)` | root | decisions log 2026-11-03, 2026-11-27 |
| **C3b gates for C4 and C5** (from the C3b security review; text in [ADR-0022, "Gates this step hands to later steps"](ADR-0022-M3-Closure-Asset-Access-Scanning-and-Limits.md)). **C5 hard gate: scanner-side calls are not user-side calls.** `completeScanAttempt` and `expireScanAttempt` are gated only by the owner or guest access predicate, so the store cannot tell a scanner's verdict from a self-attested one. They must be reachable only from the server-side scan path that called `ArtifactScanPort`, never from a route that accepts a verdict, evidence or a time from the client. C5 also defines what happens when a guest expires or is claimed during a scan (today the attempt stays open and the asset stays `pending`, fail-closed but stuck). **C5:** the HTTP view of scan history whitelists its fields (status, seq, time, a coarse reason) and never passes `ScanEventRecord` through, because `evidenceRef` and scanner identifiers are internal. **C5:** late detection (`clean` to `quarantined`) needs its own primitive and takes `lockAsset` first. **C4:** access is verified before any charge, because `consumeRateToken`, `countLiveGuestDrafts` and `pruneRateBuckets` are not access-scoped; the test that invalid or foreign subjects create no bucket rows is mandatory; the live-guest cap check and the creation insert share one transaction under one lock. **Minimum PostgreSQL 14** (`date_bin`; CI runs 17.6). | M3 C4, C5 | M3 | ADR-0022 C3b section ([#45](https://github.com/smallhingelabs/vynvori/pull/45)) |
| **S4 promo follow-ups** (from the S4 security review; [ADR-0021 S4 addendum](ADR-0021-M7-Core-Ledger-Foundation.md)). (a) The `promo_claim_events` evidence gate is a caller-asserted label check: bind events to command kinds (`promo_claim` for seq 1, `promo_outcome` after) in a later migration, and bind the `reconciled_*` evidence kinds to a reconciliation actor or record, together with M6b/M8a. (b) The S9 grants must keep the table owner distinct from the runtime role (an owner can disable triggers). (c) The runtime role needs `SELECT, INSERT` on both promo tables and column `UPDATE (state, event_seq)` on `promo_claims`, and nothing else on them. No credit grant source is registered by S4. | M7 S9 and any non-synthetic rollout; M6b/M8a for the reconciliation actor | M7 | ADR-0021 S4 addendum ([#44](https://github.com/smallhingelabs/vynvori/pull/44)) |
| **M3 C7a findings (not fixed in #46, no owner yet).** (1) The route-level axe scans omit the `wcag21a` tag; with it, the site header `.brand` link fails `label-content-name-mismatch` on every page. It belongs to the header component, outside the M3 editor lane, and the editor scans are scoped to `.ed`, so they do not hide it. (2) `role="tabpanel"` wraps the canvas only; the Layers list and fields sit outside it, and an empty side has no focusable content in the panel. C7b or the screen-reader pass can judge it. (3) **B4, the manual screen-reader pass, was NOT RUN** and is a founder checklist. Findings that cannot be fixed inside the approved design become founder questions, never silent waivers (plan Q7). | C7b, M3 PASSED | M3 / founder | [#46](https://github.com/smallhingelabs/vynvori/pull/46) body |

## Open governance item

| Item | Status |
|---|---|
| CODEOWNERS plus required code-owner review for security-critical paths (`scripts/security/**`, `security/**`, `.github/**`, the protected-files manifest, `packages/db/ledger-migrations/**`, `packages/contracts/src/ledger-internal.ts`) | **Declined by the founder for now (2026-11-03).** Residual risk: a single PR could change a security check together with its own fingerprint (ADR-0020), or a ledger migration, and only the founder's manual review stands in the way. Revisit if merging is ever delegated or more reviewers are added. |

## Owed founder decisions (the coordinator reminds, never decides)

| Decision | Gates |
|---|---|
| A malware scanner (or an interim approach) and the 31 `M3_LIMIT_*` values | M3 PASSED, W2 |
| Authorize M1b-fix-1 (concurrent first-commerce race in `packages/db/src/commerce-mappings.ts`) | cleaner CI; real double-click risk |
| Remaining M1b acceptance: central trust remedy, live migration and grants, live negatives, sign-off | M1b PASSED, W2 |
| The dedicated ledger owner role and grants (S9 proposal) | any non-synthetic ledger rollout; no real credit grant source may be registered before then |
| **Three M7 S5 questions on open [#47](https://github.com/smallhingelabs/vynvori/pull/47)** (ledger `0005_reservations`; the S5 addendum in ADR-0021 holds the detail). (1) **One or two definer owner roles:** should one dedicated role own both SECURITY DEFINER functions (the wallet apply function and the reservation apply function), or one role each? Founder-executed, not in a migration; it shapes the S9 grants proposal. (2) **Q9, never-dispatched reservations:** a reservation that was never dispatched stays reserved for a human (release needs a recorded `workflow_ref`, and the S8 orphan finder picks these up); Q9 stays deferred out of W1 unless the founder says otherwise. (3) **Definer command path (review finding MEDIUM-1):** with the runtime role's raw-SQL privileges a caller can forge an authorization for a user's latest quote, set the dispatch marker and release with caller-asserted evidence. Nothing is minted and nothing moves across users, but it matters more once S6 adds settle. Should `reservation_authorize`, `reservation_dispatch` and `reservation_release` move behind a SECURITY DEFINER command function with its own owner (decided together with the no-real-grant-source hard gate), or should S6 restrict who can set `workflow_ref`? | S5 merge; S6; any non-synthetic ledger rollout |
| **Two findings from the scanner options paper P1** ([#48](https://github.com/smallhingelabs/vynvori/pull/48), `docs/implementation/M3-Scanner-Options-Paper.md`, open at the time of writing; not independently checked here). (1) **Upload size ceiling:** Vercel's default 4.5 MB request-body limit makes the 25 MiB structural ceiling unreachable on the default platform setting. The options are a 4 MiB limit, Vercel's 20 MiB beta, or a direct-to-storage upload. (2) **Guest-object storage growth:** nothing garbage-collects expired guest objects, so only the global upload rate bounds storage. Both feed the 31 `M3_LIMIT_*` values and the scanner decision above; the paper also separates two flag paths (staging env opt-in versus the typed `assets.production_uploads` literal). | the 31 limit values; enabling uploads; M3 PASSED |
| M3 C7a founder items: the manual screen-reader pass B4 (founder checklist, NOT RUN), and who owns the site-header `.brand` link `label-content-name-mismatch` finding (outside the M3 editor lane; see hard gates) | M3 PASSED (B4); the header fix needs an owner |
| Medusa 2.21.2 to 2.23.1 upgrade: a planned future step that needs the founder's go, an ADR number from this registry, a security review and CI evidence. It clears the glob, minimatch and i18next waivers (esbuild stays, via drizzle-kit). Scope: project file `triage-20261127/Medusa-2.23.1-Upgrade-Scope.md`. Fallback if it is not ready by **2026-12-10**: extend the waiver window instead, as a reviewed policy change. (The `next`/`i18next` triage that sat here was closed by #41 and ADR-0023.) | `security:audit` after the waiver ceiling 2026-12-17T23:59:59Z |

## Deadlines

| Date | Item | Owner |
|---|---|---|
| founder, before W2 | Choose a malware scanner (or an interim approach) and supply the M3 limit values; both gate M3 PASSED and therefore W2 | founder |
| 2026-12-10 10:00 Asia/Dhaka | Reminder to the founder: waiver expiry in one week. Re-triage the dependency waiver (remove fixed advisories, re-check Medusa releases) | coordinator → founder |
| 2026-12-17T23:59:59Z | Dependency waiver expires; `security:audit` fails closed afterwards ([ADR-0020](ADR-0020-Dated-Dependency-Advisory-Waiver.md)) | founder decision |
