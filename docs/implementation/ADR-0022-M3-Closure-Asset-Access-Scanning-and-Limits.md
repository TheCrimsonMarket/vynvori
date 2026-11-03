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

**D4 — Download access (C6).** Short-lived, principal-bound, single-use (founder default) application grants stored as token hashes; mint requires a `clean` asset; redeem validates, fetches and verifies bytes, consumes in one atomic statement repeating every condition, and only then sends; prefetch never redeems; attachment disposition, `nosniff`, sandbox CSP, `no-store`; unchanged original bytes; no wallet, entitlement or payment coupling. Details are appended by C6.

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
