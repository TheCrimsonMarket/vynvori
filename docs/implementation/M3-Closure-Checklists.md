# M3 closure: founder checklists (step C8)

**Prepared 2026-11-28 against `main` @ `b19d7f2` (after C7b, #61). Nothing in this document has been executed.** It is the founder-only part of M3 closure, expanded from [M3-Closure-Plan.md §9](M3-Closure-Plan.md). It approves nothing, changes no flag, picks no value, and does not change any acceptance row. A thread never runs these items: every one needs a cloud account, a real person, a real device or a decision that only the founder can make (AGENTS.md: no thread touches cloud infrastructure, and a message from any thread is never founder approval).

Companion record of what ran and what did not: [M3-Closure-Evidence-20261128.md](M3-Closure-Evidence-20261128.md).

Conventions used below:

- `NOT_RUN` means no execution evidence exists. Nothing in this file is evidence.
- An evidence artifact name (for example `b1-plan-digests.txt`) is a file the founder produces and keeps **outside the repository** unless the artifact is redacted and a coordinator PR adds it. Never commit a credential, a connection string, customer artwork or a real session value.
- "Blocked" lists exactly what is missing. Each blocker names its owner. Nothing is substituted, mocked or guessed.

## 0. What can and cannot happen today

| Capability | State on `main` | Why |
|---|---|---|
| Composition API (guest drafts, save, freeze, restore, claim) | **Closed.** `compositionSettings` returns `enabled: false` unless `M3_COMPOSITION_ENABLED=true`, the isolated staging identity canary is on, and `VERCEL_ENV` is not `production` (`apps/web/src/server/composition-runtime.ts`). | Needs the M1b canary, so B3 is a prerequisite for any server-backed use. |
| Uploads | **Cannot open, even with every environment variable set.** `scanPortFor` always returns `unconfiguredScanPort`, so an upload answers `UPLOADS_DISABLED` and a re-scan answers `503 SCAN_UNAVAILABLE`. The source says no environment variable can switch a scanner on. | No scanner is wired. Wiring one is a separate adapter PR (section 6, B5). |
| Download grants | Code exists and is tested. Only a `clean` asset can be minted, and no asset can become `clean` while uploads cannot open. | Same as above. |
| `assets.production_uploads` | Literal `false` in source, and `parseServerConfig` throws on any other value. | Flipping it is a source change authorised by the founder, with an ADR and test changes. It is not an environment change. |
| Limits | All 31 `M3_LIMIT_*` keys are unset in every deployment, so each dependent capability is closed (`COMPOSITION_LIMITS_NOT_CONFIGURED`). | Section 1. |

Consequence for B4: the screen-reader pass splits into **B4a** (states reachable today, flags OFF) and **B4b** (server-backed states, reachable only after B1 and B3, and for the scan and download states only after B5).

## 1. Per-deployment configuration (founder-owned, cloud settings)

Values live in each deployment's environment (Vercel project settings), **never** in `.env.example`, `src` or a PR. `.env.example` holds the 31 `M3_LIMIT_*` names as commented, value-less lines.

**Where the values come from** (founder decisions recorded in the project on 2026-11-28; the registry record is a coordinator PR that had not merged when this was written, so confirm each value against your own record before setting it):

1. Keys 1 to 7 and 11 to 31: the proposals in [M3-Scanner-Options-Paper.md §6](M3-Scanner-Options-Paper.md), accepted as written.
2. Keys 9 and 10 (`M3_LIMIT_SCAN_TIMEOUT_SECONDS`, `M3_LIMIT_SCAN_LEASE_SECONDS`): accepted, **to be revisited once a scanner exists and its latency is measured**. No scanner exists, so there is nothing to measure yet.
3. Download-grant keys (8, 20, 21, 28, 29): the C6 values in [ADR-0022, "C6 follow-up"](ADR-0022-M3-Closure-Asset-Access-Scanning-and-Limits.md): grant TTL 120 s; guest 120 per 3600 s; owner 240 per 3600 s. They replace the paper's proposals for those keys.
4. `M3_LIMIT_IMAGE_MAX_BYTES` stays under Vercel's default request-body limit (paper §5 item 1; the stage-1 scanner decision caps uploads through Vercel at 4 MiB). A larger value needs the Vercel 20 MiB beta or a direct-to-storage design, which is a separate decision.

Checklist (each a founder action; none can be done by a thread):

| # | Action | Expected result | Evidence artifact |
|---|---|---|---|
| K1 | In the staging Vercel project, set the 31 keys listed in `.env.example` (`# M3_LIMIT_*`), as **Preview/staging-scoped** variables only. Never Production. | Variable list shows 31 `M3_LIMIT_*` names, no Production scope. | `k1-env-names.txt` (names only, values removed) |
| K2 | Redeploy staging, then call any composition route with the canary on. | The API no longer answers `503 COMPOSITION_LIMITS_NOT_CONFIGURED`. A missing key closes only its own capability, and a response names a key at most, never a value. | `k2-status-transcript.txt` |
| K3 | Confirm Production has none of: `M3_COMPOSITION_ENABLED`, `M3_COMPOSITION_UPLOADS`, any `M3_LIMIT_*`, any `VYNVORI_*` flag set to true. | None present in Production. | `k3-production-env-names.txt` |
| K4 | Redact `x-vynvori-download-grant` and `grantToken` in any APM, log drain or error tool that is ever set to capture headers or bodies (ADR-0022 C6 follow-up). | No such tool captures them. | `k4-redaction-note.txt` |

Rollback for K1: delete the variables and redeploy. The runtime returns to closed, because every unset key fails closed.

## 2. B1: staging Neon migration and rollback drill

**Status: BLOCKED.** What is missing, and who owns it:

1. **A staging-capable apply path.** `applyCompositionMigrations` (`packages/db/src/composition-migrations.ts`) accepts only a loopback client (`127.0.0.1`), the role `synthetic` and a database name matching `^vynvori_m3_[a-z][a-z0-9_]{2,24}_test$`, and rejects everything else with `TARGET_REJECTED`. That is deliberate. A reviewed staging variant is a separately authorised work item, not part of W1. Owner: coordinator proposes, founder authorises.
2. **Separate founder approval of the exact remote database target**, added to the plan. The `M2-Neon-Migration-Procedure.md` rules apply: pinned direct host, `sslmode=verify-full`, no pooler, scoped role, no owner login.
3. **Runtime-role grants** for `0001` and `0002`. ADR-0022 C3a contains a grant proposal and nothing grants it. Owner: founder, as a reviewed step.
4. The Cloud Run staging service is deleted. Anything that needs it asks the founder first.

Prerequisites once unblocked: a backup or Neon restore point recorded per the procedure; a separate empty synthetic recovery branch for the rollback drill; nothing customer-derived in the target.

Steps (the apply and grant commands are intentionally not written here, because the reviewed path does not exist):

| Step | Command or action | Expected result |
|---|---|---|
| 1. Verify the plan files have not drifted | `sha256sum packages/db/composition-migrations/0001_composition_scene.sql packages/db/composition-migrations/0002_asset_access_and_limits.sql` | `7d8a5257b7bde95c3cc445cbb106205d023e20f5c17049f98e9458d500134002` and `f066494fcbce66f4851340aafcbd0b5c6b3d01116f0db63623a7ca9479e113c8`, equal to `packages/db/composition-migrations/plan.json`. (Both were reproduced on 2026-11-28.) |
| 2. Back up | A recorded Neon restore point, plus `pg_dump --format=custom --schema=vynvori_composition --schema=vynvori_composition_migrations --file=b1-composition.dump` through a protected libpq service file (never a password in a URL, history or log). | A restore point id and a dump file whose `pg_restore --list` runs. |
| 3. Apply `0001` then `0002` | **Blocked** (item 1). | n/a |
| 4. Read-only inspection (psql, `-v ON_ERROR_STOP=1`, as the scoped login) | `SELECT current_database(), current_user, session_user;` then `SELECT file, sha256, applied_at FROM vynvori_composition_migrations.applied ORDER BY file;` then `SELECT table_name FROM information_schema.tables WHERE table_schema = 'vynvori_composition' ORDER BY 1;` | Exactly two journal rows whose hashes equal step 1; the tables include `asset_scan_events`, `asset_scan_attempts`, `asset_download_grants`, `rate_limit_buckets`. |
| 5. Synthetic row round trip | Create a synthetic guest draft through the API (needs B3's canary), or a reviewed SQL insert of one clearly synthetic composition; read it back; check `rate_limit_buckets` gets a row after one request. | Row written and read back; no customer data. |
| 6. Rollback drill, on the **empty recovery copy only** | `psql -v ON_ERROR_STOP=1 -f packages/db/composition-migrations/rollback/0001_composition_scene.down.sql` first, **while `0002` is applied**. | Refuses (a later journal row exists). |
| 7. | `psql -v ON_ERROR_STOP=1 -f packages/db/composition-migrations/rollback/0002_asset_access_and_limits.down.sql` with a scan event, attempt or grant row present. | Refuses with `refusing rollback: scan events, scan attempts or download grants exist`. |
| 8. | Same script on a copy where those three tables are empty. | Succeeds; the `0002` journal row is deleted; `0001` is intact. |
| 9. | `0001` down, then re-apply both through the reviewed path. | `0001` down succeeds when no composition data exists and drops the empty journal schema; re-apply is not read as `HISTORY_OR_SCHEMA_DRIFT`. |
| 10. Restore drill | Restore the dump or restore point into a separate branch and re-run step 4. | Same journal rows and hashes. |

Steps 6 to 9 mirror the rollback subtests of `packages/db/tests/composition-0002-ddl.test.ts`, which CI proves on disposable PostgreSQL only. That is not staging evidence.

Rollback of this checklist: never run a down script against a database holding real composition data. Recovery from a bad apply is a restore into a recovery branch, never an automatic native down migration (procedure document).

Evidence artifacts: `b1-plan-digests.txt`, `b1-journal-inspection.txt`, `b1-drill-transcript.txt`, `b1-backup-restore-transcript.txt`. Redact hosts, ids and passwords.

## 3. B2: R2 private round trip

**Status: partly covered by M2 (2026-10-18, synthetic, US-jurisdiction bucket), not repeated for M3.** What exists is [M2-R2-Result-20261018.md](M2-R2-Result-20261018.md). What M3 still owes is the plan's items that the existing script does not exercise (below).

Prerequisites: R2 credentials scoped to the staging bucket (ADR-0007) and the control-plane token. The M2 record names the bucket `vynvori-staging-assets` in jurisdiction `us`; verify that, do not assume it.

| Step | Command or action | Expected result |
|---|---|---|
| 1. Put the secrets in a protected shell only | Export `M2_ENV=staging`, `M2_R2_ACCOUNT_ID`, `M2_R2_BUCKET`, `M2_R2_JURISDICTION`, `M2_R2_ACCESS_KEY_ID`, `M2_R2_SECRET_ACCESS_KEY`, `M2_R2_CONTROL_API_TOKEN` (the names `r2Target` and `privateR2Proof` read). Do not load an `.env` file; the script does not. | n/a |
| 2. Run the probe | `node --conditions=react-server --import tsx scripts/r2-staging.mjs b2-journal.json` | JSON with the control-plane proof (`publicDevelopmentEnabled: false`, `customDomains: []`, bucket and jurisdiction matching), then a journal in phase `COMPLETE`: one synthetic PNG written at `private/staging/synthetic/v1/<runId>/<sha256>.png`, read back with size and SHA-256 verified, deleted, and absent. On an uncertain outcome it prints `BLOCKED_PRESERVE_JOURNAL`: keep the journal, reconcile, and never rerun blindly. |
| 3. Second write refused | The conditional write (`IfNoneMatch: "*"`) answers `412` for an existing key, which the protocol treats as "exists, verify the bytes". Observe it only through a recovery re-run of the same journal. | No overwrite; original bytes unchanged. |
| 4. Unauthenticated read | `curl -sS -o /dev/null -w '%{http_code}\n' "https://<account>.us.r2.cloudflarestorage.com/<bucket>/<key>"`, and the same against the bucket root. | A 4xx (the M2 run saw `400 InvalidArgument / Authorization`). No bytes, no listing. |
| 5. CORS | In the Cloudflare dashboard: R2, the bucket, Settings, CORS policy. | Empty. (Manual: the script does not read CORS.) |
| 6. The API read path is not used | Do not use a composition route for this checklist. | The API now requires a `clean` asset, so it could not read a probe object anyway. |

What the script does **not** do, so it must not be reported as done: it does not write an object at a key built by the composition upload path (that key shape is proven by unit tests only), and it does not test a hash mismatch against a live bucket (covered by `packages/commerce/tests/storage-recovery.test.ts`, local only).

Rollback: the probe deletes its own object. If a journal is preserved, only the exact owned key it names may be deleted, by the same operator, after reading the journal.

Evidence artifacts: `b2-probe-output.json` (redact the account id), `b2-anonymous-status.txt`, `b2-cors-screenshot.png`, `b2-bucket-privacy.txt`.

## 4. B3: real identity claim

**Status: BLOCKED on the M1b live gates.** It needs the isolated staging identity canary, which `identitySettings` accepts only for `https://staging.vynvori.com` with the central issuer, the pooled `vynvori_creative_staging` runtime login and the `M1B_*` configuration (`M1B_CENTRAL_CLIENT_ID`, `M1B_CENTRAL_CLIENT_SECRET`, `M1B_CURRENT_KEY_ID`, `M1B_CREDENTIAL_KEYS_JSON`, `M1B_CREATIVE_DATABASE_URL`, `M1B_CREATIVE_DATABASE_HOST`). It also needs B1 (the composition schema must exist in the staging database), K1 and K2. Owner: founder (M1b acceptance is an owed founder decision in the registry).

Cookies and headers the routes use (from `packages/commerce/src/composition-http.ts`): guest capability `__Host-vynvori_guest` (HttpOnly, Strict); session `__Host-vynvori_session`; double-submit CSRF cookie `__Host-vynvori_csrf` with header `x-vynvori-csrf`; every mutation needs `Origin: https://staging.vynvori.com`.

| Step | Action | Expected result |
|---|---|---|
| 1. Guest draft | In a browser on staging, open `/customize`, add text, wait for autosave. | A guest draft; the status line reads "Guest draft — kept …" (expiry text derived from `M3_LIMIT_GUEST_TTL_SECONDS`). |
| 2. Sign in | In the same browser, open `/account` and use its sign-in button (it calls `POST /api/auth/tcm/start`; the callback is `/auth/tcm/callback`), then return to `/customize`. | A verified session. |
| 3. Claim | Use the editor's "Keep in my account" button, which calls `POST /api/v1/compositions/:id/claim`. | `200`; the draft is owned; the response clears the guest cookie (`Max-Age=0`). |
| 4. Old guest cookie dead | Replay `GET /api/v1/compositions/:id` with the old cookie value in a private window. | Uniform `404 NOT_FOUND`, not `403`. |
| 5. A second real user | Sign in as a different real user and request the same composition, one of its assets and a download-grant mint URL. | `404 NOT_FOUND` each time (no existence oracle). |
| 6. State check | Read-only SQL on `vynvori_composition.compositions` for that id. | Owner set, no guest capability usable. |

Evidence artifacts: `b3-transcript-redacted.txt` (cookie and CSRF values removed), `b3-screenshot-claim.png`, `b3-state-query.txt`.

Rollback: the draft is synthetic; let it expire. Do not delete rows by hand (several tables are append-only by trigger).

## 5. B4: manual screen-reader pass

The automated checks (axe, ARIA snapshots, keyboard-only scenarios, live-region assertions, the C7b visual sweep) do **not** replace this pass. Playwright's WebKit is not Safari. Run it on the final labels, which are on `main` now (C7a and C7b merged).

Matrix (record every combination; write "n/a" rather than leaving a blank):

| Reader and browser | Platform |
|---|---|
| NVDA + Firefox | Windows |
| NVDA + Chrome | Windows |
| VoiceOver + Safari | macOS |
| VoiceOver + Safari | iOS |

Also: browser zoom 200 %; the OS "reduce motion" setting on; real Safari cookie behaviour for the guest cookie (plan F12: Playwright WebKit may differ).

### B4a: reachable today (flags OFF, no server)

Open the production build (a Vercel preview, or `npm run build:web` then `npm run start:web` on a trusted machine, then `/customize`). The expected words come from the labels in `apps/web/src/components/editor/editor.tsx`; if a reader says something materially different, record the actual words.

| # | Step | Expected announcement or behaviour |
|---|---|---|
| 1 | Land on the editor | A region named "Garment composition editor". |
| 2 | Move to the side tabs | A tablist named "Garment side" with tabs FRONT and BACK; arrow keys move between them; the tab panel is announced. |
| 3 | Choose "Add text" | A polite status announces the new layer; focus lands on a sensible control; the layer appears in the list named "Layers, top first". |
| 4 | Tab to the canvas layer | The group is named "<side> print zone, W by H mm"; the layer is announced as "Text layer: <text>"; the key help is read as a description. |
| 5 | Arrow, Shift+arrow and Alt+arrow nudges | A debounced polite announcement of the new position; no per-keystroke flood. |
| 6 | Numeric X, Y and size fields | Names like "X (mm)"; typing an invalid value announces an inline error (`role="alert"`) and marks the field invalid. |
| 7 | Reorder (↑/↓), Hide layer, Duplicate, Delete | Each button's name includes the layer ("Move up: …", "Hide layer: …"); the result is announced; focus is restored sensibly after Delete and Duplicate. |
| 8 | Undo, Redo | Announced; focus stays put. |
| 9 | Switch to BACK and add a layer there | Front and back stay independent; the switch is announced. |
| 10 | Make a layer extend outside the zone | The "Preview checks" list gets an item; the polite summary announces a count, not each item. |
| 11 | 200 % browser zoom, then 320 px width | No loss of content or function; no horizontal scroll of the page. |
| 12 | OS reduced motion on | No animation anywhere in the editor. |

### B4b: server-backed states (blocked)

Blocked until B1 and B3 (a staging canary with the composition schema). The scan and download states are blocked further, until B5: no upload can reach a scan state while the scan port is unconfigured. Script them then, using the expected words from `model.ts` and `editor.tsx`:

- Autosave states; the conflict alert ("This draft changed in another tab or device." plus a Reload button); "Frozen versions", Freeze version, Restore.
- Scan states, which never name a scanner or a reason: "safety check pending", "safety check did not finish", "blocked by the safety check"; sentences such as "<name>: safety check passed." and "<name>: the safety check could not finish. Choose Check again to try once more."; the "Check again" button; "Download original" (offered only for a `clean` asset).
- The guest-draft expiry text.

Evidence artifacts: `b4-results.csv` (one row per step per reader: pass, fail, notes), recordings named `b4-<reader>-<browser>-<step>.mp4`, and defects filed as issues. A defect that conflicts with the approved design is a founder question (plan Q7), never a silent waiver. The editor accessibility acceptance row stays IN_PROGRESS until B4a passes, and B4b passes where reachable.

## 6. B5: scanner decision and drill

**Status: BLOCKED. No scanner is chosen or wired.** The decision on record (stage 1, 2026-11-28): zero cost now; uploads on private Cloudflare R2; the existing structural inspection as an interim for **invite-only staging only**, never labelled antivirus; the ACC-07 "scans" clause stays **not passed**; the boundary stays inline; uploads through Vercel are capped at 4 MiB. Stage 2 (ClamAV in Cloudflare Containers, an async boundary, an ADR-0022 amendment, a presigned or Worker upload path) comes only after launch with real customers, and bring-your-own art for real customers should wait for it. Source: `M3-Cloudflare-Free-Scanning-Research.md` §5.1 (a project file, not in the repository).

What is missing before any drill can run:

1. An adapter PR that implements `ArtifactScanPort` and wires it. Even the interim structural check is not wired: `scanPortFor` returns `unconfiguredScanPort` unconditionally. Owner: a separately authorised step. It may need an ADR number, `.env.example` names and a security review; a scanner client library would need the dependency lane and must clear `security:audit` (ADR-0020).
2. The timed-out-scan step (a `scan_timeout` must quarantine and wait for a human, AGENTS rule 7). It has no owner yet and must exist before uploads open.
3. B1, B2 and B3.
4. The founder's approval of the flag path. The staging opt-in is environment-only (`M3_COMPOSITION_ENABLED=true`, `M3_COMPOSITION_UPLOADS=true`, canary on, not Production). `assets.production_uploads` itself needs a source change and an ADR.

When unblocked, the drill: record the decision; integrate; a clean file gives `clean`; the standard antivirus test string, **assembled at run time from its published specification and never written to a file in the repository**, gives `quarantined` and is never servable; a scanner outage gives `unknown`; the rescan path and the lease-expiry procedure work. An interim structural run is recorded as `structural-inspect`, not as malware scanning. Evidence artifacts: `b5-decision-record.md`, `b5-drill-transcript.txt`, `b5-scan-event-rows.txt`.

## 7. B6: edge controls (only if plan Q5 is chosen)

**Status: not chosen, nothing to run.** Plan Q5 asks for edge controls the repository cannot provide (IP- or device-aware limits, challenge or step-up). Disclosed gap while unset: one client can exhaust the global `guest_create` budget, so there is no public exposure. If chosen: configure the rule or challenge at the edge, replay the C4 rate-limit scenarios against staging, and keep `b6-rule-export.json` and `b6-test-transcript.txt`.

## 8. Items only the founder can clear

| Item | Needed for | Where it stands |
|---|---|---|
| Manual screen-reader pass (B4a, then B4b) | Editor accessibility evidence (ACC-05) | Not run |
| A scanner decision made real (adapter PR, security review, B5 drill) | M3 PASSED, W2 | Stage 1 decided; nothing wired |
| Per-deployment values (section 1, K1 to K4) | Any use of the composition API | Not set |
| B1, B2 (M3 part) and B3 | Staging use; notes on ACC-04, 06, 07 and 22 | Blocked as above |
| A step for the timed-out scan | Enabling uploads | No owner |
| An owner for the site-header `.brand` `label-content-name-mismatch` finding (outside the editor lane) | Route-level axe with `wcag21a` | No owner |
| Q5 edge controls | Public exposure | Not chosen |

## 9. Acceptance rows: proposals for the founder (no matrix edit here)

`docs/technical/20-acceptance-matrix.md` is protected and is not edited by this step. These are proposals for the coordinator, each requiring the evidence cited in [M3-Closure-Evidence-20261128.md](M3-Closure-Evidence-20261128.md). **No row may be marked passed.**

| Row | Proposed note | Still open |
|---|---|---|
| ACC-04 | Capability, owner and global rate limits, the live-draft cap and authorize-before-read are enforced and tested in CI `db-integration` (C4). | Real SSO claim (B3); edge controls (Q5); limit values (section 1). |
| ACC-05 | Flags-OFF interactive and visual-accessibility checks pass on Chromium, Firefox and WebKit in CI `browser` (C1a, C1c, C7a, C7b). No server-backed browser journey exists (ruling QA). | B4a and B4b. |
| ACC-06 | Unchanged. | B1. |
| ACC-07 | Scan boundary and expiring, owner-checked, single-use grants (a grant, not a presigned URL: plan Q9) tested in CI. **No scanner exists.** | B2, B5, B1; the "scans" clause stays not passed. |
| ACC-22 | Owner and BOLA tests for the new routes contribute. | Live identity (B3). |
