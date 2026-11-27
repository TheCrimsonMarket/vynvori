# ADR-0022 — M3 closure: asset access, malware-scan boundary, quotas and typed limits

Status: **accepted by the founder 2026-11-03** (M3 closure plan, revision 3). **Implemented stepwise; NOT deployed.** Step C2 (this section's first PR) implements D1 only (typed limits, scan-port types, editor cleanup). Steps C3a to C8 append their own sections below; they do not rewrite this document. Source plan: `docs/implementation/M3-Closure-Plan.md` (section 5 is the proposed text of this ADR). Related: ADR-0018 (M3 scene persistence), ADR-0021 (M7 ledger; separate lane).

## Context
M3's own code shipped policy numbers no founder approved: a 24-hour guest TTL, 25 MiB / 36 MP / 20 000 px images, 24 assets and 150 MiB per composition, a 256 KiB JSON body, and a second copy of the image limits inside the browser editor. The founder ruled (Q1, relayed by root, 2026-11-03) that these are removed and that the runtime fails closed until typed configuration supplies a founder-approved value. **This ADR supplies no replacement numbers, not even temporary ones.**

## Decisions

**D1 — Typed limits, no defaults (implemented in C2).** `parseCompositionLimits(env)` (`packages/commerce/src/composition-limits.ts`) reads the 31 `M3_LIMIT_*` variables below. A value is valid only as a canonical positive decimal integer string (no sign, spaces, leading zeros, decimals, exponents or underscores) that is a safe integer. `M3_LIMIT_IMAGE_MAX_BYTES` and `M3_LIMIT_IMAGE_MAX_SIDE_PX` above their structural ceilings (the `0001` CHECKs), and any `*_SECONDS` key above the Date-range bound, are invalid. The closed check runs after authentication, so unauthenticated callers get 401/403, not a configuration answer; the flag answer (`UPLOADS_DISABLED`) comes before the configuration answer. The result lists missing and invalid **keys** and never echoes a value. Invalid counts as missing for closing purposes. Capabilities and the keys each needs:

| Capability | Keys | Closed answer |
|---|---|---|
| `api` (every route while the composition API is enabled) | `JSON_MAX_BYTES` | `503 COMPOSITION_LIMITS_NOT_CONFIGURED` |
| `guestCreate` | `api` + `GUEST_TTL_SECONDS` | same |
| `uploads` | `api` + `IMAGE_MAX_BYTES`, `IMAGE_MAX_PIXELS`, `IMAGE_MAX_SIDE_PX`, `MAX_ASSETS_PER_COMPOSITION`, `MAX_BYTES_PER_COMPOSITION` | same (the flag-off answer stays `UPLOADS_DISABLED`) |

The remaining keys (download-grant TTL, scan timeout and lease, live-guest cap, rate policies) are parsed and validated now and consumed by C4 to C6. A configured-but-incomplete set never behaves as unlimited. The closed answer is `503`, not `429`, with `retryable: false`. The editor receives the parsed image limits from the same parse through `editorCapabilities` and its `uploadLimits` prop; its three pre-checks (file size, pixel count, longest side) and the numbers in its messages use only that prop. With limits unset the upload control stays unavailable and the page says so. The guest-draft wording derives from the API's `expiresAt` (a formatted date, never a number of hours). The server stays authoritative. There is no second constant and no contracts constant.

**D2 — Rate limiting and quota (C4).** Atomic bucket admission in SQL (`INSERT … ON CONFLICT … WHERE count < max RETURNING`), windows from the database clock, IP-independent keys (global and per guest capability or owner), authorize before charge before reading the body (invalid or foreign subjects create no bucket rows), per-composition quota and the live-guest cap enforced in SQL under advisory locks, `429` with `Retry-After`, fixed-window burst trade-off accepted, operator-run pruning only. Details are appended by C4.

**D3 — Scan lifecycle (C3a to C5).** Append-only `asset_scan_events` (current status is the latest `seq`; no event means `pending`), enforced edges (`pending→clean|quarantined|unknown`, `unknown→pending`, `clean→quarantined`; `quarantined` is terminal and never auto-released), scan attempts as reservations (one open attempt per asset, committed before the port is called, expired leases closed only by explicit request, never an uncontrolled billable retry), per-asset advisory serialization, no result sharing across compositions. `ArtifactScanPort` is declared as **types only** in `packages/contracts/src/composition-port.ts` by C2: `ArtifactScanStatus`, `ArtifactScanRequest`, `ArtifactScanResult`, `ArtifactScanPort`. Every outcome other than a well-formed `clean` or `infected` verdict for the same bytes (error, timeout, throw, malformed, wrong hash) maps to `unknown`. The default wiring will be `unconfiguredScanPort` (always an error), so uploads stay disabled until a founder-chosen scanner is wired. **No scanner vendor, binary, SDK or service is chosen or vendored (ruling QC).**

**D4 — Download access (C6).** Short-lived, principal-bound, single-use (founder default) application grants stored as token hashes; mint requires a `clean` asset; redeem validates, fetches and verifies bytes, consumes in one atomic statement repeating every condition, and only then sends; prefetch never redeems; attachment disposition, `nosniff`, sandbox CSP, `no-store`; unchanged original bytes; no wallet, entitlement or payment coupling. Details: section "C6" below.

**D5 — Fail-closed choke points (C3b to C6).** Inline `readAsset`, download mint and redeem, and `freeze` require `clean` (freeze checks inside its transaction, including the idempotent re-point branch). Draft saves may reference a `pending` asset; preflight reports `ASSET_NOT_SCANNED`. Browser pixels from bytes the user's device already holds (local preview) are allowed (ruling QB). **Downstream contract note for M4 and M5:** a frozen version that pins an asset later found `quarantined` must be refused for quote, proof and print by those milestones. M3 cannot enforce it.

**D6 — Migration `0002` (C3a).** `0002_asset_access_and_limits.sql` creates the scan-event, scan-attempt, download-grant and rate-bucket tables, their triggers and the live-guest partial index; it grants nothing; its rollback refuses while any of those rows exist and leaves `0001` re-appliable. C2 contains no migration.

**D7 — Flags and wiring.** No new feature flag. New routes sit behind the existing composition gate (isolated staging identity canary and `M3_COMPOSITION_ENABLED=true`, never production). `M3_COMPOSITION_UPLOADS=true` additionally needs complete limits (D1) and, from C5, a wired scanner. `assets.production_uploads` stays `false` and unsettable. No `VYNVORI_*` variable is introduced.

**D8 — Test databases, locks and connection budget (binding on C3b).**
- Each new database test file creates and drops its own database (`vynvori_m3_<name>_test`); the fixture and runner allow-lists become a strict name pattern plus loopback plus user `synthetic` (C3a).
- Lock class 4 (granted by root, registry): per-subject transaction locks use the single-bigint form `pg_advisory_xact_lock(bigint)` whose high 32 bits are the constant 4: `(4::bigint << 32) | (hashtext(subject)::bigint & 4294967295)`. The **explicit unsigned mask is mandatory** (a negative `hashtext` would otherwise sign-extend over the class bits; a test proves a negative-hash subject still yields class 4). This form is a different lock-type space from the two-integer form, so it cannot collide with `(742110,1|3|7)`; a hash collision only adds harmless waiting.
- **One acquisition order: composition lock before asset lock**, tested with two callers requesting opposite orders. Transaction-scoped locks only (`pg_advisory_xact_lock`); no session-level advisory locks. `hashtext` is internal and not stable across major PostgreSQL versions: acceptable for transient locks computed at runtime on one server; its output is **never persisted**.
- Connection budget (the fixture asserts the sum against `250 − 20` for tooling): **40** across at most five PostgreSQL test files. Each figure is the file's total peak, counting its pool, the fixture's own persistent client and one transient admin client: `composition.test.ts` 5, `composition-0002-ddl.test.ts` 5, `composition-0002-concurrency.test.ts` 20 (pool 18), `composition-pg.test.ts` 5, at most one further commerce PostgreSQL file 5. A sixth file or a larger pool requires re-declaring the budget here first.

## Values the founder must supply (31 keys)
No value has a default in production code. Until the founder supplies one, the capability that needs it stays closed. Keys are environment variables; values are positive safe integers. **This ADR supplies no replacement numbers.** The right-hand column shows what C2 deletes so the founder can see what is being replaced. `.env.example` lists the 31 key names as commented, value-less lines (a test keeps it equal to the exported key list). Any example value would be a number nobody approved, so none is given.

| # | Key | Unit | Used where | Code value removed, or new |
|---|---|---|---|---|
| 1 | `M3_LIMIT_GUEST_TTL_SECONDS` | seconds | guest draft expiry (`createGuest`), guest cookie `Max-Age`, editor expiry text | 24 h (`composition.ts:31`; "24 hours" strings in `editor.tsx:146,201`) |
| 2 | `M3_LIMIT_IMAGE_MAX_BYTES` | bytes | server image inspection, HTTP upload body limit, editor client pre-check and its message | 25 MiB (`composition.ts:32`, `composition-runtime.ts:33`, `editor.tsx:14,84`) |
| 3 | `M3_LIMIT_IMAGE_MAX_PIXELS` | pixels (width × height) | server image inspection, editor client pre-check | 36 000 000 (`composition.ts:32`, `editor.tsx:87`) |
| 4 | `M3_LIMIT_IMAGE_MAX_SIDE_PX` | pixels | server image inspection, editor client pre-check (the side check is new) | 20 000 (`composition.ts:32`) |
| 5 | `M3_LIMIT_MAX_ASSETS_PER_COMPOSITION` | count | upload quota (enforced in SQL by C4) | 24 (`composition.ts:33`) |
| 6 | `M3_LIMIT_MAX_BYTES_PER_COMPOSITION` | bytes | upload quota (C4) | 150 MiB (`composition.ts:33`) |
| 7 | `M3_LIMIT_JSON_MAX_BYTES` | bytes | HTTP JSON body limit; also closes the whole API while unset | 256 KiB (`composition-runtime.ts:33`) |
| 8 | `M3_LIMIT_DOWNLOAD_GRANT_TTL_SECONDS` | seconds | download grant expiry (C6) | new |
| 9 | `M3_LIMIT_SCAN_TIMEOUT_SECONDS` | seconds | one scanner call (C5) | new |
| 10 | `M3_LIMIT_SCAN_LEASE_SECONDS` | seconds | scan-attempt lease (C5) | new |
| 11 | `M3_LIMIT_LIVE_GUEST_DRAFTS_MAX` | count | global cap of unexpired, unclaimed guest drafts (C4) | new |
| 12 | `M3_LIMIT_RATE_GUEST_CREATE_GLOBAL_WINDOW_SECONDS` | seconds | rate-limiter window for `GUEST_CREATE_GLOBAL` (C4) | new |
| 13 | `M3_LIMIT_RATE_GUEST_CREATE_GLOBAL_MAX` | count per window | rate-limiter maximum for `GUEST_CREATE_GLOBAL` (C4) | new |
| 14 | `M3_LIMIT_RATE_ASSET_UPLOAD_GLOBAL_WINDOW_SECONDS` | seconds | rate-limiter window for `ASSET_UPLOAD_GLOBAL` (C4) | new |
| 15 | `M3_LIMIT_RATE_ASSET_UPLOAD_GLOBAL_MAX` | count per window | rate-limiter maximum for `ASSET_UPLOAD_GLOBAL` (C4) | new |
| 16 | `M3_LIMIT_RATE_GUEST_WRITE_WINDOW_SECONDS` | seconds | rate-limiter window for `GUEST_WRITE` (C4) | new |
| 17 | `M3_LIMIT_RATE_GUEST_WRITE_MAX` | count per window | rate-limiter maximum for `GUEST_WRITE` (C4) | new |
| 18 | `M3_LIMIT_RATE_GUEST_ASSET_UPLOAD_WINDOW_SECONDS` | seconds | rate-limiter window for `GUEST_ASSET_UPLOAD` (C4) | new |
| 19 | `M3_LIMIT_RATE_GUEST_ASSET_UPLOAD_MAX` | count per window | rate-limiter maximum for `GUEST_ASSET_UPLOAD` (C4) | new |
| 20 | `M3_LIMIT_RATE_GUEST_DOWNLOAD_GRANT_WINDOW_SECONDS` | seconds | rate-limiter window for `GUEST_DOWNLOAD_GRANT` (C4) | new |
| 21 | `M3_LIMIT_RATE_GUEST_DOWNLOAD_GRANT_MAX` | count per window | rate-limiter maximum for `GUEST_DOWNLOAD_GRANT` (C4) | new |
| 22 | `M3_LIMIT_RATE_GUEST_RESCAN_WINDOW_SECONDS` | seconds | rate-limiter window for `GUEST_RESCAN` (C4) | new |
| 23 | `M3_LIMIT_RATE_GUEST_RESCAN_MAX` | count per window | rate-limiter maximum for `GUEST_RESCAN` (C4) | new |
| 24 | `M3_LIMIT_RATE_OWNER_WRITE_WINDOW_SECONDS` | seconds | rate-limiter window for `OWNER_WRITE` (C4) | new |
| 25 | `M3_LIMIT_RATE_OWNER_WRITE_MAX` | count per window | rate-limiter maximum for `OWNER_WRITE` (C4) | new |
| 26 | `M3_LIMIT_RATE_OWNER_ASSET_UPLOAD_WINDOW_SECONDS` | seconds | rate-limiter window for `OWNER_ASSET_UPLOAD` (C4) | new |
| 27 | `M3_LIMIT_RATE_OWNER_ASSET_UPLOAD_MAX` | count per window | rate-limiter maximum for `OWNER_ASSET_UPLOAD` (C4) | new |
| 28 | `M3_LIMIT_RATE_OWNER_DOWNLOAD_GRANT_WINDOW_SECONDS` | seconds | rate-limiter window for `OWNER_DOWNLOAD_GRANT` (C4) | new |
| 29 | `M3_LIMIT_RATE_OWNER_DOWNLOAD_GRANT_MAX` | count per window | rate-limiter maximum for `OWNER_DOWNLOAD_GRANT` (C4) | new |
| 30 | `M3_LIMIT_RATE_OWNER_RESCAN_WINDOW_SECONDS` | seconds | rate-limiter window for `OWNER_RESCAN` (C4) | new |
| 31 | `M3_LIMIT_RATE_OWNER_RESCAN_MAX` | count per window | rate-limiter maximum for `OWNER_RESCAN` (C4) | new |

The ten rate-limited operations are `GUEST_CREATE_GLOBAL`, `ASSET_UPLOAD_GLOBAL`, `GUEST_WRITE`, `GUEST_ASSET_UPLOAD`, `GUEST_DOWNLOAD_GRANT`, `GUEST_RESCAN`, `OWNER_WRITE`, `OWNER_ASSET_UPLOAD`, `OWNER_DOWNLOAD_GRANT` and `OWNER_RESCAN` (`WRITE` covers save, freeze, restore and claim). 11 single values plus 10 operations × 2 gives **31 numbers**. A test asserts that the exported `COMPOSITION_LIMIT_KEYS` equals exactly the keys in this table.

Related decisions that are not numbers: single-use grants (default in force), the scanner (ruling QC, options paper P1), edge controls (Q5).

## Classification of every other number in the code
**Structural ceilings** (contracts and database CHECKs; additive-only, they stay): `SCENE_LIMITS` in `composition-scene.ts` (5000 mm position and size, 64 layers per scene, 2000 text characters, 360° rotation); the 2000 mm zone-size schema cap; the `0001` CHECKs of 26214400 bytes and 20000 px on `assets`, mirrored by `IMAGE_BYTES_STRUCTURAL_CEILING` and `IMAGE_SIDE_STRUCTURAL_CEILING` in `composition-limits.ts` (a test reads the SQL and fails on drift); and the synthetic preview profile's 16 layers per zone, 280 text characters and 150 PPI, all labelled synthetic and not supplier data.
Also a **technical bound, not policy**: any `*_SECONDS` key above `SECONDS_STRUCTURAL_CEILING` is invalid, because it would make an expiry an invalid JavaScript `Date` (a request-time error instead of a closed capability).
**Engineering constants** (documented, not policy): the 30 s request-body deadline; R2 request timeouts of 20 s and 5 s; `LIMIT 100` on owned-composition listing; the 1500 ms autosave debounce; the 100-step undo depth.

## Rejected options
- **R2 presigned GET URLs:** a bearer URL that bypasses the app's ownership and scan checks at fetch time; the official presigner would also need a new dependency.
- **Stateless HMAC download tokens:** needs a new signing secret and cannot be revoked or made single-use without state.
- **Permanent per-asset public URLs:** forbidden.
- **Scan-then-store (reject infected bytes before `put`):** cannot support asynchronous scanners and loses quarantine evidence.
- **Temporary placeholder limit values:** rejected by the founder (Q1); closed is the only safe unset state.

## Rollout and rollback
- **Rollout is not authorised.** All flags stay OFF. With no limits configured the composition API, guest creation and uploads answer `503 COMPOSITION_LIMITS_NOT_CONFIGURED`. Supplying values is a separate founder decision.
- **Rollback of C2:** revert the PR. Flags are OFF, so no production runtime path depends on it, and C2 contains no migration or data change.

## Security notes
- Fail closed: a missing or invalid limit never degrades to unlimited. Error bodies and logs name keys at most, never values.
- No new network call and no `localStorage` in the editor; the editor reads the limits from a server-rendered prop only.
- Structural ceilings mirror the database CHECKs, so a configured value above them is rejected at parse time instead of failing at insert time.
- The scan-port types add no runtime code and choose no vendor.

## Consequences
Until the founder supplies the 31 values, M3 uploads and guest drafts stay closed in every environment. Later steps (C3a to C8) depend on these keys and append their sections here.

## C3a — Migration `0002` DDL, rollback, `0001` down repair

Implements D6 and the D8 test-database/lock arithmetic in `packages/db/composition-migrations/0002_asset_access_and_limits.sql`. Additive only: creates new objects in schema `vynvori_composition`, adds one index to the existing `compositions` table, grants nothing, seeds nothing. No scanner is named, depended on or approximated (ruling QC); this migration only stores scan facts a future adapter reports. No store or service code is in this step (C3b).

### Table-by-table summary

| Table | Shape | Mutability |
|---|---|---|
| `asset_scan_events` | `(asset_id, composition_id, seq, from_status, to_status, asset_sha256, attempt_id, scanner_id, engine_version, definitions_version, evidence_ref, reason_code, recorded_at)`. `PRIMARY KEY (asset_id, seq)`; `FOREIGN KEY (composition_id, asset_id) REFERENCES assets(composition_id, id) ON DELETE RESTRICT`; `attempt_id` nullable `REFERENCES asset_scan_attempts(attempt_id)`. | Append-only: `UPDATE`, `DELETE` and `TRUNCATE` rejected by trigger. |
| `asset_scan_attempts` | `(attempt_id, asset_id, composition_id, started_at, lease_expires_at, finished_at, outcome)`. Same composite FK to `assets`. `CHECK (lease_expires_at > started_at)`; `CHECK ((finished_at IS NULL) = (outcome IS NULL))`. Partial unique index `(asset_id) WHERE finished_at IS NULL` enforces at most one open attempt per asset. | `INSERT` always allowed; `UPDATE` limited by trigger to the one-way `finished_at NULL -> non-null` (with `outcome`); `DELETE`/`TRUNCATE` rejected. |
| `asset_download_grants` | `(grant_id, token_hash, asset_id, composition_id, principal_kind, principal_hash, issued_at, expires_at, redeemed_at)`. `token_hash` and `principal_hash` are 64-hex SHA-256 digests; the raw token is never stored. `CHECK (expires_at > issued_at)`. | `INSERT` always allowed; `UPDATE` limited by trigger to the one-way `redeemed_at NULL -> non-null`; `DELETE`/`TRUNCATE` rejected. |
| `rate_limit_buckets` | `(bucket_key, window_start, count)`, `PRIMARY KEY (bucket_key, window_start)`; index on `window_start` for operator pruning. `bucket_key` CHECK restricts it to the ten operations named in D1/D2 with the correct subject shape (`global`, or a UUID). `count >= 1`. | Mutable by design: the atomic admission statement below upserts it. No immutability trigger. |
| `compositions` (existing table) | One new partial index, `compositions_live_guest_drafts (guest_draft_id) WHERE owner_user_id IS NULL AND guest_draft_id IS NOT NULL`, for the D2 live-guest-draft count. No `ALTER TABLE`, no other change. | Unchanged. |

### Trigger invariants

- **Scan lifecycle** (`check_scan_event`, `BEFORE INSERT` on `asset_scan_events`): takes the per-asset advisory lock first (below), then enforces, in order: `asset_sha256` equals the asset row's `sha256`; `from_status` equals the current status (the `to_status` of the row with the highest `seq` for that asset, or `pending` when no row exists); `seq` equals the previous `seq + 1` (gap-free); and the edge `from_status -> to_status` is one of `pending->clean`, `pending->quarantined`, `pending->unknown`, `unknown->pending`, `clean->quarantined`. Every other edge, including `clean->pending` and `quarantined->anything`, is rejected — `quarantined` is terminal and never auto-released. Table-level `CHECK`s additionally require `scanner_id`, `engine_version`, `definitions_version`, `evidence_ref` and `attempt_id` for `clean`/`quarantined` events, and a non-empty `reason_code` for `unknown` events and for an explicit `pending` (rescan-request) event.
- **Scan attempts** (`check_scan_attempt_update`, `BEFORE UPDATE`): rejects any change to a column other than `finished_at`/`outcome`, rejects re-closing an already-closed attempt (`OLD.finished_at IS NOT NULL`), and rejects setting `finished_at` to anything but a value when it was `NULL`. Nothing in SQL expires a lease automatically; closing a timed-out lease is an explicit application action, never a trigger or a timer.
- **Download grants** (`check_download_grant_update`, `BEFORE UPDATE`): the same shape — only `redeemed_at` may change, and only one-way from `NULL`.
- All three mostly-immutable tables reuse `vynvori_composition.reject_mutation()` (from `0001`) for `DELETE`/`UPDATE`/`TRUNCATE` rejection where the table is fully or partially immutable.

### Lock helpers (D8, RR-2)

```sql
m3_lock_key_from_hash(h integer) RETURNS bigint IMMUTABLE AS
  SELECT (4::bigint << 32) | (h::bigint & 4294967295);

m3_lock_composition(composition_id uuid) RETURNS void AS
  SELECT pg_advisory_xact_lock(m3_lock_key_from_hash(hashtext(composition_id::text)));

m3_lock_asset(composition_id uuid, asset_id uuid) RETURNS void AS
  SELECT m3_lock_composition(composition_id);   -- always first
  SELECT pg_advisory_xact_lock(m3_lock_key_from_hash(hashtext(asset_id::text)));  -- always second
```

The explicit unsigned mask (`& 4294967295`) stops a negative `hashtext` result from sign-extending over the class-4 high word; a test (`composition-0002-ddl.test.ts`) proves the high word stays `4` for `-1`, `INT_MIN`, `INT_MAX` and other inputs. `m3_lock_asset` takes the composition lock before the asset lock **by construction** — there is no code path through these helpers that acquires them in the other order — so two callers can never form a circular wait on this pair; a test proves the order with `pg_locks` from a second connection, and a concurrency test proves two simultaneous callers on the same composition/asset serialize without a `deadlock_timeout` error. Both helpers use `pg_advisory_xact_lock` (transaction-scoped) only; no session-level advisory lock is taken. `hashtext`'s output is never stored or compared across servers — it is used only as a same-process, same-transaction lock key.

### Atomic rate-bucket admission (D2; the exact statement C4 reuses)

```sql
INSERT INTO vynvori_composition.rate_limit_buckets AS b (bucket_key, window_start, count)
VALUES ($1, $2, 1)
ON CONFLICT (bucket_key, window_start) DO UPDATE SET count = b.count + 1
WHERE b.count < $3
RETURNING count;
```

No row returned means the caller is rate-limited for that window. `$3` (the maximum) is supplied by the caller from typed config (`M3_LIMIT_RATE_*_MAX`, D1); no value is stored in this migration. The concurrency test proves that `N` callers past `SYNTHETIC_LIMIT` admit exactly `SYNTHETIC_LIMIT`.

### Runtime-role GRANT proposal (documentation only; nothing is granted by this migration)

| Table / function | Proposed grant | Holder |
|---|---|---|
| `asset_scan_events` | `SELECT`, `INSERT` | runtime role |
| `asset_scan_attempts` | `SELECT`, `INSERT`, `UPDATE` (restricted in practice to `finished_at`/`outcome` by the trigger) | runtime role |
| `asset_download_grants` | `SELECT`, `INSERT`, `UPDATE` (restricted in practice to `redeemed_at` by the trigger) | runtime role |
| `rate_limit_buckets` | `INSERT`, `UPDATE` | runtime role |
| `rate_limit_buckets` | `DELETE` | a separate operator-prune role only, not the runtime role |
| `m3_lock_key_from_hash`, `m3_lock_composition`, `m3_lock_asset` | `EXECUTE` | runtime role |

As with `0001` and `0002`'s own apply path, no `GRANT` statement exists in this migration or any test; applying these grants to a real role is a future, separately reviewed step.

### Rollback procedure and caveats

- `rollback/0002_asset_access_and_limits.down.sql`: refuses while any row exists in `asset_scan_events`, `asset_scan_attempts` or `asset_download_grants` (checked independently — a test seeds each table alone and confirms the refusal). `rate_limit_buckets` rows may be dropped; the table holds no customer-facing fact, only a rolling admission counter. When it proceeds, it drops only `0002`'s tables, functions and the `compositions` partial index, and deletes only the `0002` journal row, leaving `0001` intact and re-appliable.
- **Caveat:** because the scan-event, attempt and grant tables are append-only (or one-way) by trigger, there is no SQL path that empties them short of a superuser disabling the triggers. Operationally, if those rows must ever be cleared, recovery is **restore from backup**, not an in-repo script; this migration deliberately provides no delete path (plan ruling: no deletion of quarantined objects, no delete path anywhere in this step).
- **`0001` repair (F8):** `rollback/0001_composition_scene.down.sql` now also refuses while any journal row other than `0001` exists (so `0002` must be rolled back first, or a `DROP SCHEMA ... CASCADE` on `vynvori_composition` would silently destroy `0002`'s tables too), and, after dropping the data schema and the `0001` journal row, drops the now-empty journal schema `vynvori_composition_migrations` itself. Before the repair, the old script left that empty journal schema behind; the runner's `hasJournal !== hasSchema` drift check then read it as `HISTORY_OR_SCHEMA_DRIFT` and blocked every future apply. A test reproduces the old failing `up -> down -> up` with the pre-repair script text and shows the same sequence passing with the repaired script.
- Both rollback scripts are run by hand only; no runner executes either of them. Tests exercise them with `client.query(...)` directly.

### Test databases and connection arithmetic actually used

Per ADR-0022 D8 and the M3-closure plan §6 C3a: the runner's and fixture's database allow-list widened from the two hard-coded names to the pattern `^vynvori_m3_[a-z][a-z0-9_]{2,24}_test$` plus the existing loopback/synthetic/plan-digest checks (`packages/db/src/composition-migrations.ts`). `packages/db/tests/composition-fixture.ts` gained a fixed allow-list of M3 test names (`migration`, `service`, `ddl`, `concurrency`), `databaseFor(name)`, and — mirroring M7's `ledger-fixture.ts` — `assertDisposableTarget`, `assertServerIsDisposableSynthetic`, a `freshCompositionDatabase(name)` that drops and (re)creates its own database through a maintenance connection (`DROP DATABASE ... WITH (FORCE)`; `CREATE DATABASE`) rather than relying on the CI workflow to pre-create it, and pool helpers (`compositionPool`, `poolBudget`) capped per D8. `freshComposition(database)` is unchanged in signature and behaviour for `composition.test.ts` and `composition-pg.test.ts`, whose databases (`vynvori_m3_migration_test`, `vynvori_m3_service_test`) are still created by the `m2.yml` foundation workflow.

| Test file | Pool cap | + persistent client | + transient admin | Peak |
|---|---|---|---|---|
| `composition.test.ts` (existing) | n/a (single client) | 1 | 1 | 5* |
| `composition-pg.test.ts` (existing) | 4 | — | 1 | 5* |
| `composition-0002-ddl.test.ts` (new) | 3 | 1 | 1 | 5 |
| `composition-0002-concurrency.test.ts` (new) | 18 | 1 | 1 | 20 |
| reserved for a later M3 step | — | — | — | 5 |
| **M3 total, at most five files** | | | | **40** |

\* Existing files' exact internal shape predates C3a and is unchanged; the figures above are the D8-declared peaks already recorded in §5 of this ADR. A static test (`composition-0002-ddl.test.ts`) asserts `DECLARED_PEAK_CONNECTIONS` sums to no more than the 40-connection M3 budget, and the fixture's `compositionPool`/`poolBudget` read `SHOW max_connections` and return a `degraded` pool (capped to what fits, minus `RESERVED_SUPERUSER_SLOTS = 3`) rather than exceeding the server's limit.

### What is NOT deployed

No rollout is authorised by this step. All flags stay `OFF`. `0002` is applied only to the disposable, loopback, `synthetic`-owned test databases named above; no staging or production target exists in the plan or the runner's allow-list. No `GRANT` is issued to any role. No scanner, store method, HTTP route or contract change is introduced — C3b (store/service), C4 (quota/rate limiting wiring), C5 (scan boundary) and C6 (download grants) consume this schema in later, separately reviewed steps.

## C3b — Store port, PostgreSQL and in-memory implementations, conformance

Implements the store half of D3, D4, D5 and D8 on the `0002` schema. **No migration** (the step needs none), no route, no runtime wiring: nothing in `apps/web` or `packages/commerce/src` calls the new primitives yet (C4 to C6 do). Flags are unchanged; `assets.production_uploads` stays `false`; no scanner is chosen or approximated (ruling QC).

### Port changes (`packages/contracts/src/composition-port.ts`, additive)

- `AssetRecord.scanStatus: ArtifactScanStatus` is **required** and store-derived: every asset query joins the latest scan event (`to_status` of the highest `seq`, else `pending`) in the same statement. `insertAsset` no longer accepts the field from callers. F9 grep in the PR shows the only `AssetRecord` users are `commerce/src/composition.ts`, `commerce/tests/composition-suite.ts`, `db/src/composition-store.ts` and `composition-port.ts`; the only `CompositionStore` implementers are the PostgreSQL store and the in-memory harness.
- `freeze` returns the new outcome `asset_not_clean` (named type `FreezeOutcome`); the service maps it to the new code `ASSET_NOT_CLEAN` (HTTP `409 COMPOSITION_ASSET_NOT_CLEAN`).
- New methods: `listScanEvents`, `openScanAttempt`, `completeScanAttempt`, `expireScanAttempt`, `requestRescan`, `createDownloadGrant`, `validateDownloadGrant`, `consumeDownloadGrant`, `consumeRateToken`, `countLiveGuestDrafts`, `pruneRateBuckets`, and their record/outcome types.

### Decisions

- **Ownership in SQL, uniform `not_found`.** Every asset-scoped method runs the existing access predicate in SQL. Absent, foreign, expired, claimed, wrong-composition and malformed ids (including upper-case UUIDs) all answer `not_found` / `null`, and a caller without access never takes an advisory lock (access check, then lock, then the authoritative re-read under the lock).
- **Scan reservation.** `openScanAttempt` is allowed only from `pending` and only when no attempt is open (`busy` otherwise). The attempt row commits before any scanner call can happen. Its result is recorded only by `completeScanAttempt` on that same open attempt, which closes it and appends `pending -> clean | quarantined | unknown` in one transaction. A late result after an explicit expiry is refused (`attempt_not_open`) and never lands. `expireScanAttempt` is an explicit request that succeeds only once `now >= lease_expires_at` and records `unknown(reason_code = lease_expired)`; the store never expires a lease by itself. `requestRescan` records `unknown -> pending`. Invariant: an open attempt implies status `pending`.
- **`clean -> quarantined` (late detection)** is a legal edge in `0002`, but no C3b primitive produces it, because opening an attempt on a `clean` asset is a C5 policy question (what a repeated `clean` or an `error` verdict means for a `clean` asset). The tests inject the edge through the real trigger to prove that freeze, mint and redeem refuse a quarantined asset.
- **Edge table duplicated on purpose.** Both stores check the edge before writing; in PostgreSQL the `0002` trigger re-verifies sha, `from_status`, `seq` and edge under the same lock.
- **Grants.** The principal is computed by the store from the access: SHA-256 of the verified user id (owner) or the guest capability hash (guest), matched together with `principal_kind`. Mint requires `clean` under the asset lock. Validate is one read-only statement with every redeem condition. Consume validates first (no lock for a caller who cannot redeem), then takes the asset lock and runs one `UPDATE … WHERE` that repeats every condition, including `clean` and the access predicate, so a wrong principal gets `null` and leaves the grant spendable, and N concurrent redeems give one winner. Returned records never include `token_hash` or `principal_hash`.
- **Rate tokens.** `consumeRateToken({ operation, subject, windowSeconds, max, at? })` is one statement: the window is `date_bin` over `at` or, when omitted, the database clock, followed by the D2 atomic upsert. Operation names are the ten D1 operations; `_GLOBAL` operations take the subject `global`, the rest a UUID. Unset, zero, negative or non-integer policy throws (`RangeError`); it is never unlimited.
- **`pruneRateBuckets({ olderThan, now, longestWindowSeconds })`** has no default cut-off and refuses any cut-off later than `now - longestWindowSeconds`, so a window that is still active can never be deleted (which would reset a live limit). It is operator-run (the runtime role is not proposed a `DELETE` grant).
- **`countLiveGuestDrafts(now)`** counts unowned compositions whose M1b guest draft is unexpired and unclaimed (`owner_id IS NULL`), matching the access predicate. The cap decision and its lock are C4.
- **Freeze (D5).** Inside the freeze transaction the store takes each pinned asset's lock (ids sorted) and requires `clean` for every pinned hash. On the insert branch the pins are the caller's list **plus** every image hash the scene itself references, so a dropped pin cannot skip the check. On the idempotent re-point branch it checks the pins of the **existing** version it would re-point to (no insert trigger fires there), not the caller's list. Nothing is written on refusal.
- **One lock order for every M3 writer: advisory composition lock, then the `compositions` row, then advisory asset locks.** Freeze checks access without a lock, then takes `lockComposition`, then reads the row `FOR NO KEY UPDATE` (which does not block FK `KEY SHARE` checks), then the asset locks. A test holds `lockComposition` in another transaction, inserts an asset under it while a freeze waits, and shows that the freeze completes after the writer commits. With the earlier order (`FOR UPDATE` first) the same test fails. C4's quota writer must follow the same order.
- **Lock helpers.** `lockComposition` and `lockAsset` call the `0002` SQL helpers, which use the class-4 high word, the explicit unsigned mask, and composition before asset by construction. They refuse at runtime any client that is not inside `withCompositionTransaction`. That is the only way to obtain a `CompositionTx`, so an xact lock can never be taken in autocommit mode, where it would be released at once. No session-level lock exists.
- **Lease expiry uses two clocks.** `expireScanAttempt` succeeds only when both the caller's `now` and the database clock are past `lease_expires_at`. A skewed or request-influenced `now` therefore cannot end a running scan early and trigger a second billable call (AGENTS rule 7). For grant and guest expiry the store keeps its existing convention: `now` is the service's injected clock and is never derived from a request.
- **Structural ceilings (engineering constants, not policy).** Rate `windowSeconds` and `max` are bounded to the PostgreSQL `integer` range (`2147483647`) that the statement casts to. Scanner-reported text (scanner id, engine and definitions versions, evidence reference, reason code) is capped at 512 characters, because those tables are append-only.
- **Duplicate caller-chosen ids** (attempt id, grant id, token hash) raise `RangeError` on both stores. A raw unique-violation error that echoes key values is never surfaced.
- **Input validation.** Programming errors (malformed attempt/grant ids, a lease or expiry not after `now`, missing scanner evidence, a reason code outside `^[a-z][a-z0-9_]*$`, invalid dates) throw `RangeError` on both stores. No numeric policy value exists in `src`; every number in the C3b tests is a `SYNTHETIC_*` fixture in `tests/`.

### Gates this step hands to later steps (from the C3b security review)

- **C5 (hard gate): scanner-side calls are not user-side calls.** Every scan primitive is gated only by the owner or guest access predicate. The store cannot tell a scanner's result from a self-attested one. So `completeScanAttempt` and `expireScanAttempt` must be reachable only from the server-side scan path that called `ArtifactScanPort`, never from a route that accepts a verdict, evidence or a time from the client. C5 must also define what happens when a guest expires or is claimed during a scan. Today the attempt stays open and the asset stays `pending` (fail-closed, but stuck) until an explicit expiry by a principal that has access.
- **C5: the HTTP view of scan history whitelists its fields** (status, seq, time, a coarse reason). It never passes `ScanEventRecord` through, because `evidenceRef` and scanner identifiers are internal.
- **C5: late detection (`clean -> quarantined`)** needs a primitive and must take `lockAsset` first. The trigger takes it anyway.
- **C4: access before charge.** `consumeRateToken`, `countLiveGuestDrafts` and `pruneRateBuckets` are not access-scoped by design. C4 must verify access before charging, so invalid or foreign subjects create no bucket rows; that C4 test is mandatory. The live-guest cap check and the creation insert need their own transaction under one lock, which C4 adds.
- **Minimum PostgreSQL 14** (`date_bin`). CI runs 17.6.
- **Not addressed (LOW):** audit timestamps (`recorded_at`, `finished_at`) take the caller's `now` and are not forced to be monotonic. Ordering is by `seq`, so correctness is unaffected.

### Tests and connection budget

One scenario list (`packages/commerce/tests/composition-store-suite.ts`) runs on the in-memory port (`composition.test.ts`) and the PostgreSQL store (`composition-pg.test.ts`, `db-integration`). The two existing service-suite freeze tests now clean their asset first, as D5 requires. The race tests (grant single-use with mixed wrong-principal callers, attempt reservation, attempt completion, store serialisation behind a held asset lock, rate admission, negative-`hashtext` class bits through the TS helper, opposite helper orders) are in `composition-0002-concurrency.test.ts` and share its 18-client pool; a sampler asserts the pool never exceeded 18. `composition-pg.test.ts` now uses one 4-client pool for the whole file instead of a new pool per test, so its declared peak of 5 holds. The D8 budget (40 total, five files) is unchanged.

## C4 — Quota, rate limits, authorize-before-read

Implements D2 and the C4 half of D1 on the C3b store primitives. **No migration** (the `0002` tables and the live-draft index already exist), no new dependency, no new environment variable, no flag change; `assets.production_uploads` stays `false`. Every number is read from the existing `M3_LIMIT_*` keys; this section supplies none.

### The order of operations (the C3b hard gate "access before charge")

For every mutating route that reads a body: format-check ids and credentials, **verify access in SQL**, resolve configuration, **charge the bucket**, and only then read the body.

- `compositionService.authorize(id, access)` runs the store's SQL access predicate (a guest capability is checked against the M1b `guest_drafts` row, not only its cookie format) and answers the uniform `NOT_FOUND`. `compositionService.admit(kind, id, access)` is authorize plus charge, so it is safe by construction: a subject without access never reaches the limiter and creates no bucket row. Tests count bucket rows and limiter calls, and a throwing body stream proves the body is never read, for no credentials, a malformed cookie, an unknown capability, another draft's capability, an expired draft, a claimed draft, a wrong or invalid owner session and a malformed id.
- Upload order is: ids and credentials, `UPLOADS_DISABLED` (flag), SQL access, configuration (`LIMITS_NOT_CONFIGURED`), charge, body. The configuration answer therefore comes only after access, so a caller without access learns nothing about configuration (D1).
- Keys (all IP-independent): `GUEST_*` operations are keyed by the composition id (the guest capability), `OWNER_*` operations by the verified user id, the two `_GLOBAL` operations by `global`. An upload charges its per-subject bucket first and `ASSET_UPLOAD_GLOBAL` second, so a caller limited on its own bucket never spends the shared one; the reverse cost (a subject token spent when the shared bucket refuses) is accepted.
- `save`, `freeze`, `restore` charge `*_WRITE`. **Two decisions beyond the plan's wording ("save, freeze, restore, claim")**, flagged for the founder: creating an owned composition (`POST /compositions` with a session) is also an `OWNER_WRITE`, because an unbounded durable-row creator would otherwise sit next to a limited one; and `claim` charges `OWNER_WRITE` to the **verified user** after the session check and before the M1b `claimGuest` call (the guest capability itself is proven by M1b inside that call, which also keeps the replay-after-lost-response path working). A user probing other people's draft ids in a claim is charged for each probe.
- `GUEST_DOWNLOAD_GRANT`, `*_RESCAN` and the owner download key have no route yet; `admit("downloadGrant" | "rescan", …)` exists and is tested for all ten operations so C5 and C6 only call it.
- A policy is **present only when both its window and its maximum are valid** (`resolveRatePolicies`); an absent policy answers `503 COMPOSITION_LIMITS_NOT_CONFIGURED` (`retryable: false`) before anything is charged. Each operation closes on its own. Rate windows and maxima above the PostgreSQL `integer` range (`2147483647`) are invalid (a structural ceiling, like the C2 ceilings).
- A refused caller gets `429 COMPOSITION_RATE_LIMITED` with `Retry-After` (whole seconds, clamped to `[1, window]`, derived from the database-clock window and the service clock) and the same number as `retryAfterSeconds` in the body. The window itself always comes from the database clock; the service never passes `at`.

### Quota and live-guest cap, in SQL

- **Per-composition quota.** `CompositionStore.insertAsset(id, access, now, asset, quota)` returns `inserted | existing | quota_exceeded | not_found`. In one transaction: access probe without a lock, `lockComposition` (class 4, per subject), authoritative access re-read, duplicate lookup (the same bytes are idempotent and never count against the quota), `count(*)` and `sum(byte_size)`, then the insert. Concurrent uploads therefore cannot overshoot either maximum. The service keeps its cheap pre-check only to avoid a pointless storage write; the SQL decision is authoritative (a concurrent loser can still leave one unreferenced private object, and no garbage collection exists in W1).
- **Lock order.** The quota writer takes the advisory composition lock and no `compositions` row lock, so it cannot wait on a row held by a freeze that is itself queued on the advisory lock (the C3b order: advisory composition lock, then the row, then asset locks, is unchanged). A test queues a freeze and an insert behind one held composition lock and releases them together without a deadlock.
- **Live-guest cap.** `CompositionStore.createGuest({ …, now, liveGuestDraftsMax })` returns `created | cap_reached`. One transaction takes a **single global class-4 lock** (`lockLiveGuestCap`: the same `m3_lock_key_from_hash(hashtext('m3:live-guest-drafts'))` form with the unsigned mask), counts live drafts with the same population as the guest access predicate, decides, and inserts both rows. It takes no other lock, so it cannot join a lock cycle. Cost: guest creations serialise globally for the length of two inserts. M1b's direct writes to `guest_drafts` are not counted and not blocked (accepted, D2). A refused creation writes nothing, sets no cookie, and answers `503 COMPOSITION_GUEST_CAPACITY` (`retryable: true`), not 429, because a global capacity is not the caller's request rate.
- Unset, zero, negative or fractional maxima and caps throw `RangeError` in both stores; the service closes the capability first (`LIMITS_NOT_CONFIGURED`), so nothing is ever unlimited.

### Editor

`classifyApiFailure` (pure, in `model.ts`) reads the status and error code. A 429 pauses autosave (`autosave: "limited"`) and arms **one** timer from the server's own `retryAfterSeconds` (clamped to what a browser timer can hold); with no hint nothing retries automatically and the Save button still works one click per attempt. The closed-capability 503 sets `unavailable` and is never retried. The debounced autosave effect now also skips `limited` and `unavailable`. Freeze, restore and claim show the wait in the status line and do not retry. All numbers shown come from the server.

### Gates handed on and limits

- C5 and C6 must call `admit("rescan" | "downloadGrant", …)` for their routes and must keep authorize before read. `pruneRateBuckets` stays operator-run; nothing schedules it.
- The editor loop is now closed for client errors. Previously every `pending -> failed` transition re-armed the autosave effect, so a persistent failure retried about every 1.5 s. Terminal 4xx answers (not 408/429) now set `autosave: "blocked"`, which the effect skips; only 5xx and network errors keep the old retry. Each retry costs a write token, so the limiter still bounds that remaining loop. A successful upload is remembered per composition (`uploaded` ref), so a later save attempt never uploads the same artwork twice. A 429 with no `Retry-After` arms no timer, and the message says to press Save.
- The fixed window allows a boundary burst of up to twice the limit (D2, accepted). With no IP signal one client can exhaust the global `GUEST_CREATE` and `ASSET_UPLOAD` budgets (D2 "known limit"; edge control Q5).
- Access before configuration (review M1, L1): save, freeze, restore and upload prove access in SQL before they answer 503 for an unset JSON limit or disabled uploads. A caller with a well-formed but forged credential gets 404 and creates no bucket row; the rightful holder still gets the honest 503.
- Claim limbo (review L2): claim charges the verified user's `OWNER_WRITE` after the session check and before M1b `claimGuest`. If `claimGuest` succeeds and a later step fails, the token is spent and the draft is already owned; a retry reports the ordinary not-found for the guest credential. No state is lost, and the founder may want a cheaper path.
- No global write bucket (review L3): guest writes are limited per composition only. The arithmetic bound is (live guest cap) x `GUEST_WRITE_MAX` writes per window. Bucket rows are never auto-pruned; `pruneRateBuckets` stays operator-run (above), so row growth is bounded only by how often it is run.
- Orphan objects (review L4): an object stored and then refused by the SQL quota or a failed insert is left in private storage, as in C3b. The volume is bounded by the upload budget (per-subject plus global `ASSET_UPLOAD`) times the maximum upload size; C5/C6 own garbage collection.
- Retry-After and clock skew (review L5): the wait is computed from the database clock. A browser clock that differs from it only changes when the timer fires, never what the server admits.
- A flags-OFF browser scenario for the 429 message is **not reachable**: with every flag off the API answers 503 `DISABLED` before any limiter, and the plan forbids a server-backed fixture (ruling QA). The editor mapping is covered by `apps/web/tests/editor-api-failure.test.ts` and the HTTP behaviour by the shared limiter suite.

### Rollback

No schema change: revert the PR. The `0002` tables are untouched. With the PR reverted the limiter, quota-in-SQL and the cap disappear together and `uploadAsset`/`createGuest` return to the C3b behaviour (which is why uploads and guest creation must stay closed in any deployment until the founder supplies the limits).

### Tests and connection budget

`composition-limiter-suite.ts` (service and HTTP, one list run on the in-memory port and on PostgreSQL), the C4 cases appended to `composition-store-suite.ts`, and the C4 races in `composition-0002-concurrency.test.ts` (cap, count quota, byte quota, same-bytes dedupe, lock queueing, no-access without a lock). No new database file: the D8 budget (40, five files, pool caps 18 and 4) is unchanged; the races use at most 14 concurrent store calls inside the 18-client pool and the sampler assertion still holds.

## C5 — Scan boundary (fail-closed port, strict parser, lifecycle wiring)

Implements D3 and the C5 half of D5 on the C3b store primitives. **No scanner vendor, binary, SDK or service is chosen, integrated or approximated** (founder ruling QC). **No migration**, no new dependency, no new environment variable (the two scan keys, rows 9 and 10, already exist), no flag change; `assets.production_uploads` stays `false`. Every number comes from the existing `M3_LIMIT_*` keys; this section supplies none.

### The boundary (`packages/commerce/src/composition-scan.ts`)

- **`unconfiguredScanPort` is the only `ArtifactScanPort` in the repository.** It is frozen, never answers `clean`, and every call rejects with `SCANNER_NOT_CONFIGURED`. `isScanPortConfigured` is false for it, for a copy under the same id, and for any port whose `scannerId` is empty or padded. `apps/web` wires it unconditionally (`scanPortFor`), so in every deployment of this PR uploads stay refused (`UPLOADS_DISABLED`) and rescans answer `503 COMPOSITION_SCAN_UNAVAILABLE` (`retryable: false`). A static test fails if any other file in `src` defines both `scannerId:` and `scan`.
- **Strict parser instead of a Zod schema.** The plan named "a Zod schema in commerce". `@vynvori/commerce` does not declare `zod` and dependencies are a root lane, so the parser is hand-written and stricter than a default object schema. The port's answer is untrusted. It must be a plain or null-prototype object with exactly six own **data** properties (`verdict`, `sha256`, `engineVersion`, `definitionsVersion`, `evidenceRef`, `scannedAt`). A symbol key, an extra key, a class instance or an accessor is malformed, and getters are never invoked. A verdict of exactly `clean` or `infected` for the **same** lower-case SHA-256 maps to `clean` or `quarantined`. `error` maps to `unknown(scanner_error)`, a well-formed other hash to `unknown(scan_hash_mismatch)`, and everything else (case variants, non-strings, text outside the C3b 512-character cap, with padding or with anything but printable ASCII, a `scannedAt` that is not RFC 3339 with an offset) to `unknown(scan_result_malformed)`. The recorded `scannerId` is always the port's own, never a field of the answer.
- **`runScan` makes one bounded call.** It uses an `AbortController` and the typed timeout. A timeout aborts the signal and returns `unknown(scan_timeout)` without waiting for the port, and an answer that arrives later is ignored. A throw maps to `unknown(scanner_threw)`, or to `unknown(scanner_not_configured)` for the default port. Nothing in the module retries (AGENTS rule 7). The module imports only the contracts types and `server-only`, and makes no network or process call (static test).
- **Scan limits.** `resolveScanLimits` needs both keys, requires the lease to be **strictly longer** than the timeout (otherwise a lease could lapse while the one call is still running, and a second explicit request could start a second billable call), and refuses a timeout above what a JavaScript timer can hold (`2147483647` ms, a structural ceiling, not policy). Any other combination is "not configured": upload and rescan close with `LIMITS_NOT_CONFIGURED`, and the editor never offers upload. The lease is anchored when the attempt is opened, so the service checks again just before the call: if the call could no longer finish inside the lease (opening took longer than the margin), the attempt is closed as `unknown(scan_not_started)` and the scanner is not called.

### Service wiring (`packages/commerce/src/composition.ts`)

- **Uploads are enabled only when the flag is on, storage exists and the port is configured** (`uploadsEnabled`); `assertUploadsAvailable` also requires the scan limits. The upload route keeps the C4 order: ids and credentials, SQL access, flag, configuration, charge `*_ASSET_UPLOAD`, body. Then it inserts the row and **scans inline once** with the bytes it already holds. The upload charge covers that one call. A non-clean outcome is still a stored upload (`201`) with its status.
- **The scan path** (`scanPending`) reads and verifies the bytes first. Bytes from storage must match the recorded size and SHA-256 (`STORAGE_UNAVAILABLE` otherwise), so a storage failure never leaves an attempt open and mismatched bytes never reach the scanner. Next it opens the attempt (the reservation commits before the call), calls `runScan`, and records the result with `completeScanAttempt` on that same attempt. Times come only from the service clock and the lease from configuration.
- **Explicit rescan** (`POST /api/v1/compositions/:id/assets/:assetId/scan`, new route). The order is: ids and credentials, SQL access (`authorize`), `assertScanningAvailable`, configuration, charge `*_RESCAN` (the C4 bucket, `admit("rescan")`), then the body check, where **any byte at all is `413`**. The route accepts no outcome, evidence, reason or time. `clean` and `quarantined` are only reported (quarantine is terminal on this path). `unknown` goes through `requestRescan` (`reason_code = rescan_requested`) and is then scanned once; the bytes are read and verified before that edge is recorded, so a storage failure leaves the asset `unknown`. A `pending` asset with no open attempt (a pre-`0002` row, or one stranded by a crash) is scanned once. A `pending` asset whose lease is still running answers `pending` without a call. A lapsed lease is closed as `unknown(lease_expired)` by this explicit request, with **no** call in the same request. Each request makes at most one scanner call.
- **Choke points (D5).** `readAsset` serves only `clean` and re-reads the status after the storage fetch; every other status gets the same `NOT_FOUND` as a foreign id, which answers Q6(a) with its strict default. Freeze (`ASSET_NOT_CLEAN`) and grants (`asset_not_clean`) were already enforced by C3b and are covered again by the C5 suite. Preflight reports `ASSET_NOT_SCANNED` (hard error, detail = status) for every pinned asset whose known status is not `clean` (`AssetFacts.scanStatus`, additive and optional, so callers that do not know a status are unchanged).

### C3b gates, answered

- **Scanner-side calls are not user-side calls (hard gate).** `completeScanAttempt` and `expireScanAttempt` are named in exactly one file of `packages/commerce/src` and `apps/web/src`: the service. There is exactly one `completeScanAttempt(` call, and its result is the `runScan` result. `composition-http.ts` names no scan primitive and no internal scan field. Static tests in `composition-scan.test.ts` enforce all of this.
- **Whitelisted HTTP view.** `assetView` returns `assetId`, `sha256`, `mime`, `widthPx`, `heightPx` and `scanStatus` only. The rescan route returns `{ assetId, scanStatus }`. Scan history is not exposed at all, and tests assert that no scanner id, evidence reference, engine or definitions version, or reason code is serialised.
- **Late detection (`clean -> quarantined`).** A new store primitive, `recordLateDetection`, takes `lockAsset` first (inside `underAssetLock`: access check, lock, re-read). It refuses unless the asset is `clean` with no open attempt, then writes a born-closed attempt row and the `quarantined` event in one transaction. Both stores implement it, and the conformance suite covers it. **It has no caller.** What triggers a late re-scan of a `clean` asset (new definitions, a vendor callback, a schedule), and which bucket or reservation pays for it, depends on the scanner the founder chooses. The static test fails if the service starts calling it without that decision.
- **Guest expired or claimed during a scan.** `completeScanAttempt` runs the access predicate again. If the guest expired or was claimed while the call ran, the result is **dropped** (`NOT_FOUND` to that request). The asset stays `pending` and the attempt stays open, which is fail-closed. Once the lease passes, the rightful principal (the new owner after a claim) recovers in two explicit requests: the first closes the attempt as `unknown(lease_expired)` without a call, and the second scans. An expired guest draft is unreachable by design. Both cases are tested.

### Editor (`apps/web/src/components/editor`)

`EditorAsset` gains an optional `scanStatus`, and hydration reads it with `parseScanStatus`, which treats any unrecognised value as `pending`, never as clean. `previewHref` decides what the canvas draws:

- Bytes this browser already holds (`data:` URLs) are drawn unchanged, per ruling QB. After an upload the local preview is kept and only the status is updated.
- Server pixels are drawn only when the status is `clean`.
- `pending`, `unknown` and `quarantined` server assets render a placeholder rectangle (quarantined has its own styling), so their bytes are never requested.

Layer names and the canvas `aria-label` carry the state, for example "Image · Artwork (safety check pending)". The outcome of an upload or a check is announced in the polite status line. Each status has its own sentence, and none of them names a scanner, a reason or evidence. A selected uploaded layer whose status is `pending` or `unknown` offers **Check again**: one request per press, with no automatic retry. A 429 shows the server's wait. Preflight shows `ASSET_NOT_SCANNED` as "Artwork has not passed the safety check."

### Limits and open items

- **C1b limitation (ruling QA).** No server-backed browser journey exists. Upload, the inline scan, the placeholder states, the announcements and Check again are not reachable with every flag off, so they are covered by handler and PostgreSQL tests and by the editor helper tests. The axe sweep of these states belongs to C7b.
- **Retention (Q6b).** Nothing deletes `pending`, `unknown` or `quarantined` objects. Storage has no delete, and that is unchanged.
- **Open for the founder.**
  - The late-detection trigger, and what pays for it (above).
  - Recovery after a mid-scan claim costs two explicit requests, and two `*_RESCAN` tokens.
  - The parser is hand-written instead of Zod (above).

### Security review (C5)

The `security-reviewer` pass on the diff found no CRITICAL or HIGH issue. Dispositions:

- **Fixed (MEDIUM-LOW): the lease could lapse before the call started.** With a small margin between lease and timeout, a slow attempt open could leave less lease than the call needs, and a later explicit request could then expire the attempt and start a second, concurrent call. The pre-call check described above closes this. Tested with a synthetic delayed store.
- **Fixed (LOW): a storage failure on rescan moved `unknown` to `pending`.** The bytes are now read first. Tested.
- **Fixed (LOW): scanner text could carry control characters or newlines into append-only rows and logs.** The parser now accepts printable ASCII only. Tested.
- **Fixed (LOW): the "only implementer" static test missed some `src` roots.** It now walks every `src` root, and it asserts that the contracts file only declares the port type.
- **Handed to the scanner-choice step (LOW): provider state after a timeout.** `scan_timeout` aborts the signal, but a port that ignores the abort may still be running or billing. The next explicit rescan is a new call. This stays within "at most one call per explicit request", and that request is rate-limited, but AGENTS rule 7 asks for provider-state reconciliation. The real port must offer idempotency or a cancel or status call, and the founder decides whether a `scan_timeout` asset needs a human before it can be rescanned.
- **Handed to the scanner-choice step (LOW): `scannedAt` is validated for format, not for freshness.** A replayed older `clean` for the same hash would be accepted. The port is server-side and trusted, and a freshness bound needs a chosen scanner.
- **Accepted (INFO): an inline upload scan that loses access mid-call answers `404`.** The row and object exist, and the asset stays `pending`. This is the documented mid-scan recovery above.

### Rollback

No schema change: revert the PR. `recordLateDetection` is additive and has no caller. With the PR reverted, the C4 behaviour returns: uploads stay `pending` and are never scanned. Uploads must therefore stay closed in every deployment until a scanner and the limits exist. They are closed today in any case, because the only port is `unconfiguredScanPort`.

### Tests and connection budget

- `composition-scan-suite.ts` runs one scenario list on the in-memory port (`composition.test.ts`) and on PostgreSQL. On PostgreSQL it reuses `composition-pg.test.ts` and its single 4-client pool, under `db-integration`. Its scenarios:
  - the full result-mapping table, including a timeout followed by a late answer
  - four concurrent rescans give one attempt and one port call
  - lease expiry never auto-closes, and the lapsed-lease recovery
  - a pre-`0002` row is scanned
  - non-clean assets cannot be read, frozen or granted
  - scan results are not shared across compositions
  - upload is refused with `unconfiguredScanPort`, after access
  - mid-scan expiry and claim
  - the rescan route's order, credentials and body refusal
  - late detection
- `composition-scan.test.ts` covers the parser edge cases, `runScan`, the default port, the scan limits and the static gates.
- `apps/web/tests/editor-scan.test.ts` covers the editor helpers and the canvas binding.
- The scan double (`syntheticScanPort`) and every number are `SYNTHETIC_*` fixtures in `tests/`.
- No new database file: the D8 budget (40 connections, five files, pool caps 18 and 4) is unchanged.

## C6 — Download grants (mint, redeem, editor control)

Implements D4 and the C6 half of D5 on the C3b grant primitives. **No migration** (`asset_download_grants` exists since `0002`), no new dependency, no new environment variable (the grant TTL is row 8, `M3_LIMIT_DOWNLOAD_GRANT_TTL_SECONDS`, and the two `*_DOWNLOAD_GRANT` rate pairs already exist), no flag change; `assets.production_uploads` stays `false`. Grants are **single-use** (the founder's safe default recorded in the registry, 2026-11-03), and the app-issued grant stands in for ACC-07's "expired presigned URL" (Q9 default: "grant, not presigned"). Every number comes from the existing `M3_LIMIT_*` keys; this section supplies none.

### Mint (`POST /api/v1/compositions/:id/assets/:assetId/download-grants`)

- Order: ids and credentials (same origin; CSRF double submit for sessions), **access in SQL** (`authorize`), availability (`DOWNLOAD_UNAVAILABLE`, `503`, when the deployment has no storage), configuration (`LIMITS_NOT_CONFIGURED` when the TTL is unset), **charge `*_DOWNLOAD_GRANT`** (`admit("downloadGrant")`, the C4 bucket), then the body check, where any byte is `413` (no client-chosen expiry or anything else), then the mint. A caller without access gets the uniform `404`, creates no bucket row and learns nothing about configuration.
- The store re-checks access and `clean` under the asset lock, binds the grant to the principal (SHA-256 of the verified user id, or the guest capability hash) and stores only `SHA-256(token)`. The token is 32 random bytes in base64url. A non-clean asset answers `409 COMPOSITION_ASSET_NOT_AVAILABLE`, reachable only after the ownership predicate, so it is no cross-tenant oracle. Download grants are never issued for `pending`, `unknown` or `quarantined` artwork.
- The answer is `201 { downloadUrl, expiresAt }`. `downloadUrl` is the relative path `/api/v1/compositions/:id/assets/:assetId/download?grant=<token>`; the token appears there and nowhere else. A grant can be minted again (each mint is charged).

### Redeem (`GET /api/v1/compositions/:id/assets/:assetId/download?grant=<token>`)

1. Standard authentication. No credentials, a malformed cookie, an invalid session (never downgraded to guest) or a guest cookie for another draft id: `401 AUTH_REQUIRED`, before any lookup.
2. Request context, before any lookup. `Sec-Fetch-Site` other than `same-origin`, `none` or absent is `403` (defence in depth; the grant is principal-bound in any case). A method other than `GET` (Next answers `HEAD` through the GET handler) and a speculative request (`Sec-Purpose`, `Purpose`, `X-Moz` or `X-Purpose` naming prefetch or prerender) are the uniform `404` and never spend a grant. So is a missing or repeated `grant` parameter.
3. Access in SQL (`authorize`), then availability (`DOWNLOAD_UNAVAILABLE` without storage).
4. Read-only validation of every condition (`validateDownloadGrant`: token hash, principal, composition, asset, unexpired, unredeemed, access predicate, latest scan status `clean`). Then the asset row, which must be `clean`.
5. Fetch the object and verify its size and SHA-256 **before** anything is consumed. A storage failure or mismatched bytes answer `503 STORAGE_UNAVAILABLE` and the grant stays spendable.
6. Consume with the one atomic C3b statement whose `WHERE` repeats every condition of step 4, under the asset lock. A different valid principal presenting a leaked token, a late quarantine between steps 4 and 6, and every concurrent loser get `null`, which is the uniform `404`. Only the winner gets the bytes.
7. The unchanged original: `Content-Type` of the stored (sniffed) type, `Content-Length`, `Content-Disposition: attachment; filename="original-<sha12>.<png|jpg|webp>"` (server-generated, from a three-entry map; the user's filename is never stored or echoed), `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cache-Control: private, no-store, max-age=0`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`. The response is built from the fetched bytes without a second copy.

Every authenticated-but-not-entitled case (absent, foreign, expired, redeemed, wrong principal, claimed guest, expired guest, non-clean, unknown or malformed token, wrong asset, speculative, `HEAD`) has the identical `404` body apart from its correlation id, and no error body carries the token. There is no wallet, entitlement, ledger, payment or Medusa check on this path (doc 06: originals are never gated behind export payment); a static test asserts that none of the files on the path imports such a module, that only the service names the grant primitives, that the consume comes after the byte fetch, and that nothing on the path logs.

### Editor (`apps/web/src/components/editor`)

A selected image layer whose uploaded asset the server reports `clean` offers **Download original** (`canDownloadOriginal`). One press mints one grant. The plan's wording was "navigates programmatically"; the security review showed that a refused redeem (expired grant, late safety block, storage fault) would then replace the editor tab with a JSON error page and lose unsaved edits. So the editor **redeems the grant with its own same-origin `fetch`** (allowed in `editor.tsx` by the fetch policy, constraint 10), accepts the response only with the exact server filename shape (`downloadFileName`), and hands the bytes to the browser through a detached, never-rendered `<a download>` on a revoked-after-use object URL. The navigation target is accepted only as this composition's and asset's exact download path with one well-formed token (`downloadPathFrom`), so a malformed answer cannot send the browser elsewhere. There is no rendered link and no `<Link>`, so nothing can prefetch a grant. Outcomes are announced in the polite status line; no sentence names a token, a grant or an internal reason.

### Security review (C6)

The `security-reviewer` pass on the diff found no CRITICAL or HIGH issue. Dispositions:

- **Fixed (MEDIUM): a failed redeem navigated the editor away.** Replaced by the editor's own fetch, above. Static test.
- **Fixed (LOW): `HEAD` spent the grant.** Redeem now refuses every method but `GET` with the uniform `404`. Tested.
- **Fixed (LOW, efficiency): the redeem response copied the original a second time.** The response body is the fetched bytes.
- **Accepted (LOW): the token is in the query string.** Platform access logs, proxies and browser history may record it. Mitigations: single use, principal binding, the typed short TTL, `Referrer-Policy: no-referrer`, no application logging. Any log sink that keeps query strings should redact `grant=` (an operational note for B2/staging, not code in this step).
- **Accepted (LOW): redeem has no bucket of its own.** One principal holding one valid grant can make N concurrent requests, each of which fetches and hashes the object before one wins. N is bounded by the principal's own requests and the object size by the upload limit; adding a redeem limiter would need new founder values (new `M3_LIMIT_*` keys), which this step may not invent.
- **Accepted (INFO): grant rows accumulate.** Expired and redeemed rows are not deleted (D4: operator-run prune, none in W1). Growth is bounded by the mint bucket.
- **Accepted (INFO): mint reveals `clean` to the principal** (`409`), which the editor already shows; redeem answers `404` for every non-clean asset.

### Limits and open items

- **C1b limitation (ruling QA).** No server-backed browser journey exists, so the download control, its announcements and the browser's handling of the object-URL download are not reachable with every flag off. They are covered by handler and PostgreSQL tests and by the editor helper and static tests; the axe sweep of the control belongs to C7b.
- **Q9** stays as recorded: ACC-07's row note says "grant, not presigned". The acceptance matrix is not edited here.
- The coordinator relayed, on the founder's delegation, that a timed-out scan should be treated as quarantined pending human reconciliation before any re-check. That changes the C5 scan path, not this step. C6 needs no change for it, because grants issue only for `clean`; the C5 change is left for a separate step.

### Rollback

No schema change: revert the PR. Grants already minted stay in `asset_download_grants` (append-only by trigger) and expire by their own TTL; with the PR reverted no route can redeem them. Downloads are closed in every deployment today in any case: no storage is wired unless uploads are enabled, and uploads need a scanner that does not exist.

### Tests and connection budget

- `composition-download-suite.ts` runs one scenario list on the in-memory port (`composition.test.ts`) and on PostgreSQL (`composition-pg.test.ts`, `db-integration`, the same single 4-client pool): owner and guest happy paths with byte and SHA-256 equality and every header; second redeem; expired; unknown, malformed, padded, repeated and missing tokens; wrong asset; a different valid session presenting the owner's token (grant left unspent, then redeemed by its owner); claimed and expired guests; pending and quarantined mints; late quarantine after mint; unauthenticated `401`; prefetch variants, cross-site and same-site, `HEAD`; storage failure and corrupted bytes leaving the grant spendable; four concurrent redeems with one winner; mint closed without TTL or storage, after access and without charging; mint rate limits and the closed policy for guest and owner; body refusal; origin and CSRF guards.
- `composition-download.test.ts`: the TTL resolver and the static gates (no payment coupling, only the service names grant primitives, consume after fetch, no logging, route files).
- `apps/web/tests/editor-download.test.ts` (helpers and static checks) and the C6 case in `composition-config.test.ts`.
- Every number is a `SYNTHETIC_*` fixture in `tests/`. No new database file: the D8 budget (40 connections, five files, pool caps 18 and 4) is unchanged.

## C6 follow-up — Download rate limit and link-code log stripping (founder decisions 2026-11-27)

The founder answered the two C6 open questions on 2026-11-27: downloads should be rate limited, configurable so the limit can scale later ("at the beginning traffic would be small so we can be generous while making sure nobody can spam the system"), and logs should strip the link code. **No migration, no new environment variable, no contracts change, no flag change.**

### Rate limit: every redeem attempt is charged to the existing `*_DOWNLOAD_GRANT` bucket

- A separate redeem operation would need a new operation name. The `0002` CHECK on `rate_limit_buckets.bucket_key` lists the ten operations by name, so a new one needs migration `0003` (a registry allocation), two new `M3_LIMIT_*` keys in the `.env.example` shared lane, and an edit to `RateLimitOperation` in `packages/contracts`. All of that sits outside this step's lanes.
- Instead, **redeem charges the same `GUEST_DOWNLOAD_GRANT` / `OWNER_DOWNLOAD_GRANT` bucket as mint**, through the C4 `admit("downloadGrant")` path. A download therefore costs two tokens, one for the mint and one for the redeem. The limit scales with the four existing keys (rows 20, 21, 28 and 29 of the values table) and needs no code change.
- Order on redeem: ids and credentials (`401`), method, `Sec-Fetch-Site`, speculative request, no query string and a token header present (uniform `404`), **access in SQL**, availability, **charge**, then the grant lookup, the object fetch and the consume. A caller without access is never charged and creates no bucket row. Every redeem attempt by an entitled caller is charged, including one with a wrong token, so guessing is bounded too. A limited redeem answers `429` with `Retry-After` and does not touch the grant. An unset policy closes redeem (`503 LIMITS_NOT_CONFIGURED`), just as it closes mint.
- Separate redeem keys remain possible later through a coordinator-owned PR (migration `0003` plus `.env.example`) if the founder wants mint and redeem to be tuned independently.

### Values chosen under the founder's delegation (2026-11-27)

The founder delegated the numbers ("Configure the values based on that"). These are the values to set in each deployment's environment. They are **not** code defaults: production code still has no default, and an unset key still closes downloads. `.env.example` keeps commented key names only.

| Key | Value | Why |
|---|---|---|
| `M3_LIMIT_DOWNLOAD_GRANT_TTL_SECONDS` | `120` | The editor redeems in the same click, so two minutes covers a slow connection. A leaked grant dies quickly. |
| `M3_LIMIT_RATE_GUEST_DOWNLOAD_GRANT_WINDOW_SECONDS` | `3600` | A one-hour window. |
| `M3_LIMIT_RATE_GUEST_DOWNLOAD_GRANT_MAX` | `120` | 60 downloads per hour per guest draft (each download is a mint plus a redeem). |
| `M3_LIMIT_RATE_OWNER_DOWNLOAD_GRANT_WINDOW_SECONDS` | `3600` | A one-hour window. |
| `M3_LIMIT_RATE_OWNER_DOWNLOAD_GRANT_MAX` | `240` | 120 downloads per hour per signed-in account. |

A person rarely downloads the same original more than a few times, so these values are generous. A script is held to 60 or 120 downloads an hour per subject. More guest subjects cost a guest creation each, which `GUEST_CREATE_GLOBAL` and the live-draft cap bound. Egress per subject is at most that count times the image size limit. To scale, raise the `_MAX` values or shorten the window in the environment; no code change is needed. The other 26 limit values are still unsupplied, so uploads, and with them downloads, stay closed.

### The link code never appears in a URL

- In-repository code logs nothing on this path (C6 static test). The remaining exposure was the platform's own request logs, proxies and browser history, which record query strings and which no thread may configure (cloud infrastructure).
- So the token **no longer travels in a URL at all**. The mint answers `201 { downloadUrl, grantToken, expiresAt }`, where `downloadUrl` is the bare `/api/v1/compositions/:id/assets/:assetId/download`. The editor already redeems with its own same-origin `fetch` (C6), so it sends the token in the `x-vynvori-download-grant` request header.
- Redeem **refuses any query string** with the uniform `404` and does not charge or spend anything, so the earlier `?grant=` form can never redeem. A repeated header arrives comma-joined and fails the token check.
- Because the request needs a custom header, it can only come from a same-origin script. A cross-origin page cannot send it without a CORS preflight that the app never grants. `Sec-Fetch-Site: none` (address bar) is now refused as well, since such a request could not carry the header anyway.
- `Referrer-Policy: no-referrer` and `no-store` are unchanged.

### Security re-review (C6 follow-up)

The `security-reviewer` pass on this change found no CRITICAL, HIGH or MEDIUM issue. Dispositions:

- **Fixed (LOW): a malformed token was charged.** The token's shape (43 base64url characters) is now checked before the charge, using no stored data, so it is no oracle. A well-formed but wrong token is still charged, which bounds guessing. Tested.
- **Accepted (LOW): one shared budget.** Failed redeems (wrong, expired or repeated tokens) use the same bucket as mints. For an owner the bucket covers all of their compositions; for a guest, the one draft. A client stuck in a retry loop can therefore lock itself out of minting for the window. Only the entitled principal can do this, so a third party cannot. The editor never retries automatically, and the values above leave room for many retries.
- **Operational note (LOW):** standard access logs record neither headers nor bodies. If a platform, APM or error tool is ever set to capture them, add the `x-vynvori-download-grant` header and the `grantToken` field to its redaction list.
- The C6 finding "N concurrent redeems each fetch the object" is now bounded by the per-redeem charge.

### Rollback

Revert the PR. The C6 behaviour returns: redeem is no longer charged, and the token travels in `?grant=`. No data changes.

### Tests

- `composition-download-suite.ts` (in-memory and PostgreSQL):
  - every redeem goes through the header;
  - a token in the query string, or any other query, is refused and leaves the grant spendable;
  - guest and owner redeems charge `*_DOWNLOAD_GRANT`, including wrong tokens; mint and redeem share one budget;
  - a limited redeem answers `429` and leaves the grant spendable;
  - callers without access are never charged;
  - an unset policy closes redeem;
  - `Sec-Fetch-Site: none` is `403`.
- `composition-download.test.ts`: static, no token is ever put in a URL.
- `editor-download.test.ts`: `downloadTargetFrom` accepts only the bare route plus a well-formed token, and the editor sends the token in the header and never in a URL.
- No new database file: the D8 budget is unchanged.
