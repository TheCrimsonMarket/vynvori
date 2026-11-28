# M3 closure: evidence ledger (step C8, 2026-11-28)

**This is a record, not an acceptance pass.** It satisfies no `ACC-xx` row, changes no status, and sets no flag. Base: `main` @ `b19d7f2` (merge of #61). Companion: [M3-Closure-Checklists.md](M3-Closure-Checklists.md) (the founder-only items).

Rules applied (plan §10, AGENTS.md):

- **Counts:** only CI-executed results, cited by run and job. `ci.yml` `db-integration` for PostgreSQL and commerce suites, `unit` for contracts and web, `browser (<engine>)` for the harness.
- **Does not count:** any local run, any local PostgreSQL run, any local Chromium run (reported `NOT_RUN`).
- Every figure below was read from GitHub in this step, or is marked "recorded" with its source (a registry row, an ADR section or a PR body written at the time). Where a row says "recorded", this step did **not** re-read the job log.
- Merge dates are 2026-11-27 unless stated. All merges are the founder's.

## 1. Where M3 stands

The closure plan's serial order is C1a, C2, C3a, C3b, C4, C5, C6, C7a, C7b, C8, with C1c inserted and P1 as a docs-only deliverable. **Every code step has merged.** C8 (this PR) is the last. The plan's stated outcome is *LOCAL CLOSURE COMPLETE*, with M3 PASSED and W2 gated on a scanner decision made real and the limit values being supplied.

| Closure criterion | State | Evidence |
|---|---|---|
| All plan steps C1a to C7b and P1 merged | **Met** | Section 2 |
| `main` CI green at the C7b merge | **Met** | Run [46138535662](https://github.com/smallhingelabs/vynvori/actions/runs/46138535662), event `push`, head `b19d7f2`, conclusion `success` (read 2026-11-28). It was `in_progress` an earlier time the same day; the conclusion above is the final read. |
| Firefox and WebKit results from CI | **Met** | Section 3 |
| Manual screen-reader pass (B4) | **NOT_RUN** | Founder checklist |
| A scanner wired and drilled (B5) | **NOT MET.** No scanner exists; the scan port is `unconfiguredScanPort` unconditionally. | Checklists §6 |
| `M3_LIMIT_*` values set per deployment | **NOT MET** (founder accepted proposals; nothing is set anywhere) | Checklists §1 |
| Staging Neon, R2 round trip, real identity claim (B1, B2, B3) | **NOT_RUN** | Checklists §2 to §4 |
| Timed-out scan goes to quarantine plus a human | **NOT IMPLEMENTED**, no owner | Registry hard gates |
| Acceptance rows | **Unchanged.** 0 of 27 rows passed; proposals only. | Checklists §9 |

M3 therefore closes **locally** and stays short of PASSED. That is the plan's own outcome, not a shortfall of this step.

## 2. Per step: PR, merge commit, CI, what executed, NOT_RUN

`PR head` is the head SHA of the last CI-verified commit before merge. "11 jobs" means integrity, changes, build, lint-typecheck, unit, security, container, db-integration and browser on chromium, firefox and webkit. Older runs (before the CI rebuild in #42) used the `m0.yml` and `m2.yml` workflows instead.

| Step | PR | Merge commit | PR head | CI evidence | Executed (CI) | NOT_RUN |
|---|---|---|---|---|---|---|
| C1a engine-parameterised harness | [#25](https://github.com/smallhingelabs/vynvori/pull/25) | `37021ba` | recorded in PR | Recorded: Chromium run in `m0.yml` `browser`; Firefox and WebKit came later (C1c) | 36 flags-OFF editor scenarios per engine (recorded in plan §6 C1c: 108 `PASS Editor (flags OFF)` lines across three engines) | Firefox and WebKit at the time of #25 |
| C2 ADR-0022 and typed limits | [#29](https://github.com/smallhingelabs/vynvori/pull/29) | `06f68e8` | recorded in PR | Recorded: `m0.yml` `verify`, `m2.yml` | Config and limit-parser tests; a test keeps `.env.example` equal to the 31 exported keys | No runtime path changes (flags OFF) |
| C1c cross-engine triage | [#32](https://github.com/smallhingelabs/vynvori/pull/32) | `b84ad68` | recorded | Recorded: run 41612993300, all three engines **87/87** (registry decision log, 2026-11-03) | Chromium, Firefox and WebKit full harness; a single-link `prefetch: false` change on `/account` granted by the founder | none recorded |
| C3a migration `0002` | [#35](https://github.com/smallhingelabs/vynvori/pull/35) | `35d73d8` | `4316dcd` | Read: `m2.yml` run [41794768201](https://github.com/smallhingelabs/vynvori/actions/runs/41794768201) success and `medusa-container.yml` run [41794768166](https://github.com/smallhingelabs/vynvori/actions/runs/41794768166) success (both 2026-11-04) | `composition-0002-ddl.test.ts` and `composition-0002-concurrency.test.ts` on disposable PostgreSQL: DDL, immutability triggers, rate-bucket admission race, lock order, `0002` up/down/up, full `0002`-then-`0001` chain | Staging or production apply (no path exists); runtime grants (proposal only) |
| C3b store port | [#45](https://github.com/smallhingelabs/vynvori/pull/45) | `165b645` (18:40Z) | `ecef2a4` | Recorded: all 11 jobs green, run [46028562572](https://github.com/smallhingelabs/vynvori/actions/runs/46028562572); `db-integration` 346 pass, 0 fail, 2 skipped | Store-port conformance on the in-memory port and PostgreSQL; race tests | none new |
| C7a editor core accessibility | [#46](https://github.com/smallhingelabs/vynvori/pull/46) | `4f32f80` (18:39Z) | `d0d7c79` | Recorded: all 11 jobs green, run [46029584529](https://github.com/smallhingelabs/vynvori/actions/runs/46029584529) | axe and ARIA-snapshot, keyboard-only, focus and live-region checks on three engines | Manual screen reader (B4). Its two findings (header `.brand` link, `tabpanel` wrapping) are not fixed (registry hard gates) |
| P1 scanner options paper | [#48](https://github.com/smallhingelabs/vynvori/pull/48) | `76c0054` (18:53Z) | `966b848` | Docs only; main run cancelled and covered by #49's | Docs-only skip path | none |
| C4 quota, rate limits, authorize-before-read | [#50](https://github.com/smallhingelabs/vynvori/pull/50) | `fd5b7ee` (19:16Z) | `38a9048` | Read: PR run [46054498849](https://github.com/smallhingelabs/vynvori/actions/runs/46054498849) success; main run [46055490767](https://github.com/smallhingelabs/vynvori/actions/runs/46055490767) success | `composition-limiter-suite.ts` (in-memory and PostgreSQL), C4 store-suite cases, C4 races in `composition-0002-concurrency.test.ts` (cap, count and byte quota, same-bytes dedupe, lock queueing) | Edge controls (Q5, B6) |
| C5 scan boundary | [#55](https://github.com/smallhingelabs/vynvori/pull/55) | `9bf2307` (20:02Z) | `a8d0590` | Read: PR run [46059049024](https://github.com/smallhingelabs/vynvori/actions/runs/46059049024) success; main run [46060843368](https://github.com/smallhingelabs/vynvori/actions/runs/46060843368) success | `composition-scan-suite.ts` (result mapping, four concurrent rescans give one attempt and one port call, lease expiry, pre-`0002` row, non-clean cannot be read, frozen or granted, mid-scan claim, late detection) on both stores; `composition-scan.test.ts`; `editor-scan.test.ts` | **A real scanner, a timed-out-scan quarantine, B5** |
| C6 download grants | [#56](https://github.com/smallhingelabs/vynvori/pull/56) | `f9daf00` (20:35Z) | `9f035a8` | Read: PR run [46062739874](https://github.com/smallhingelabs/vynvori/actions/runs/46062739874) success; main run [46064700883](https://github.com/smallhingelabs/vynvori/actions/runs/46064700883) success | `composition-download-suite.ts` (happy paths with byte and SHA-256 equality and every header; second redeem; expired; wrong asset; other session; prefetch, cross-site, HEAD; concurrent redeems with one winner) on both stores; `composition-download.test.ts`; `editor-download.test.ts` | Redemption against a real R2 object (B2); a real `clean` asset |
| C6 follow-up | [#59](https://github.com/smallhingelabs/vynvori/pull/59) | `b72b972` (20:52Z) | `3d9e465` | Read: PR run [46065491326](https://github.com/smallhingelabs/vynvori/actions/runs/46065491326) success; main run [46066545054](https://github.com/smallhingelabs/vynvori/actions/runs/46066545054) success | Redeem rate limit shared with mint (429 with `Retry-After`), header-borne link code, query string refused with the uniform `404` | Setting the download keys per deployment (K1) |
| C7b visual accessibility sweep | [#61](https://github.com/smallhingelabs/vynvori/pull/61) | `b19d7f2` (2026-11-28 11:09Z) | `a52b7c6` | Read: PR run [46138057668](https://github.com/smallhingelabs/vynvori/actions/runs/46138057668), all **11 jobs success**; main run [46138535662](https://github.com/smallhingelabs/vynvori/actions/runs/46138535662) success | See section 3 | Manual screen reader (B4); every state that needs a server (ruling QA) |

Migrations in M3 closure: `0002_asset_access_and_limits.sql` only (C3a). C2, C3b, C4, C5, C6, the C6 follow-up and C7b added none. Composition journal: the next number is `0003`, unallocated.

## 3. The most recent full CI evidence (C7b, run 46138057668, head `a52b7c6`)

Read from the job logs on 2026-11-28. Job conclusions: `changes`, `integrity`, `security`, `unit`, `lint-typecheck`, `build`, `container`, `db-integration`, `browser (chromium)`, `browser (firefox)`, `browser (webkit)`: all `success`.

| Job | Executed steps (as named in the run) | Result line read |
|---|---|---|
| `browser (chromium)` | `npm run build:web`, `npm run test:browser:web` (also `scripts/tests/browser-settle.test.mjs`) | `130/130 checks passed.` |
| `browser (firefox)` | same harness, Firefox | `130/130 checks passed.` (the settle unit test step shows `skipped`, as designed: it runs in the Chromium job) |
| `browser (webkit)` | same harness, WebKit | `130/130 checks passed.` (settle test `skipped`, as above) |
| `db-integration` | `npm run db:check`; "Migrations apply, and re-apply as a no-op"; `npm run test:m2`; "M1b identity Postgres harness (disposable container, restricted role, backup/restore drill)"; "Build Medusa for the boot test"; "Medusa boots against Postgres" | Every step `success`. **Per-test counts were not re-read in this step**; the last count recorded in the registry for this job is C3b's 346 pass, 0 fail, 2 skipped. |
| `unit` | `npm test`; "Tests left the checkout unchanged"; "Design reference rebuild matches the shipped bundle"; `npm run verify:reference` | Every step `success` |
| `lint-typecheck` | `npm run lint`, `npm run typecheck` | Both `success` |
| `security` | `smoke:security`, `smoke:m2-security`, installed dependency tree check, `npm run security:audit` | Every step `success` |
| `container` | Medusa image build and readiness, image-processing worker container | Every step `success` |
| `build` | `npm run test:deployment` | `success` |

The 130 checks include the six flags-OFF editor states swept at 1280, 390 and 320 px (reduced motion, target size, reflow, colour contrast, axe on the notice states, 200 % text) and a per-engine focus-ring pixel check. The C7b PR body records the proof the sweep bites: 112/130 on the old editor code on local Chromium, 130/130 after the fixes. That local figure is feedback, not evidence. The CI figure is the evidence.

## 4. What did not run, in one place (NOT_RUN)

| Item | Why |
|---|---|
| Manual screen-reader pass (B4a, B4b) | Needs real readers on real devices; founder checklist |
| Any server-backed browser journey (upload, reload, freeze, restore, scan caption, Check again, Download original, saved or conflict states) | Needs the composition API on, which needs the staging canary (ruling QA). Covered by handler tests, the palette test and B4. |
| B1 staging Neon apply and rollback drill | No staging apply path exists by design; needs the founder's separate remote-database approval |
| B2 R2 round trip for M3 | Cloud account; the M2 run (2026-10-18) is a separate, older, synthetic result |
| B3 real identity claim | Blocked on the M1b live gates |
| B5 scanner drill | No scanner is wired; the adapter PR does not exist |
| B6 edge controls | Not chosen (plan Q5) |
| A real malware scan of any file | Does not exist. The structural inspection is not antivirus and must never be labelled so. |
| Any upload to R2 through the product | Closed: the scan port is unconfigured, so `UPLOADS_DISABLED` |
| Per-deployment `M3_LIMIT_*` values | Not set anywhere |
| Safari (real), iOS Safari, NVDA, VoiceOver | Outside CI by nature |
| Database-backed tests in this step's local run | Skipped locally (no database in the sandbox: 123 skipped of 438 in the commerce and db suite). They count only from CI `db-integration`. |

## 5. Open items carried forward (not fixed, not waived)

Owner is "none" where no step owns it today.

| Item | Owner | Blocks |
|---|---|---|
| Timed-out scan to quarantine plus a human before any re-check (AGENTS rule 7); today the next explicit rescan is a new call | none | enabling uploads |
| Site-header `.brand` link `label-content-name-mismatch` (route-level axe with `wcag21a`) | none | route-level axe parity |
| `role="tabpanel"` wraps the canvas only; the Layers list and fields sit outside it (C7a finding 2; C7b did not record a fix) | B4 / none | B4 judgement |
| No garbage collection of expired guest objects; the storage adapter has no delete | none (Q6b) | long-run storage growth |
| Vercel 4.5 MB body limit against the 25 MiB structural ceiling | decided for stage 1: 4 MiB | larger originals |
| Edge controls (Q5) | founder | public exposure |
| Keys 9 and 10 (scan timeout and lease) to be revisited after measured scanner latency | founder | a scanner |
| ADR-0022 amendment for an async boundary and a presigned or Worker upload path | stage 2 | after launch |
| Registry and ledger records of the founder decisions of 2026-11-28 (limits accepted, stage-1 scanner), the M1b flake retirement and the #54 and #60 merges | coordinator PR | records only |

## 6. Questions for the founder

1. Is "local closure complete, M3 not PASSED" the state you want recorded, with B4 and B5 as the two items that gate PASSED? (The checklists assume yes.)
2. Who owns the timed-out-scan step? It must exist before any upload is enabled, and it has no home in the plan.
3. Do you want the `.brand` header finding and the `tabpanel` wrapping finding sent to one small editor-and-header step, or left until B4a shows whether a reader is affected?
