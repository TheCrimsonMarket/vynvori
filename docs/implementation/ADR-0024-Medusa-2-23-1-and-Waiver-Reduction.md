# ADR 0024 — move Medusa 2.21.2 to 2.23.1 and reduce the dated waiver to esbuild

2026-11-27. Status: **proposed**. The founder authorized the upgrade in the project thread on 2026-11-27 ("Lets do medusa upgrade first"); it is not accepted until the founder merges. Amends [ADR-0020](ADR-0020-Dated-Dependency-Advisory-Waiver.md) and [ADR-0023](ADR-0023-Waiver-Policy-Refresh-and-Next-16-4-6.md); supersedes the Medusa 2.21.2 pin approved in M2 ([ADR-0003](ADR-0003-M2-foundation.md)) for current code. Base: `main` at `147b529`. Scope: project file `triage-20261127/Medusa-2.23.1-Upgrade-Scope.md`.

## Context

Three of the four advisories that the ADR-0020 waiver still accepts come from Medusa 2.21.2's exact pins: glob 13.0.6 (GHSA-3g3m-2fjr-6pw4), minimatch 10.2.6 (GHSA-g3hv-75wg-m249) and i18next 23.7.11 through `@medusajs/dashboard` (GHSA-6jcc-5g8w-32mx). The waiver ceiling is 2026-12-17T23:59:59Z, after which `security:audit` fails closed. Medusa 2.23.1 (latest, released 2026-11-26) pins glob 14.0.2 and i18next 27.1.1. The fourth advisory, esbuild 0.18.20 (GHSA-67mh-4wv8-2f99), comes from drizzle-kit 0.31.11's `@esbuild-kit` loader and has no safe drizzle-kit move; it is out of scope.

Release notes read for this step: 2.22.0, 2.22.1, 2.22.2, 2.22.3, 2.22.4, 2.22.5 (deprecated), 2.22.6, 2.22.7 and 2.23.1 on GitHub, and the Medusa 2.23.0 upgrade guide (the 2.23.0 GitHub release page could not be fetched from the authoring session). No 2.21.3 exists on npm.

## Decision

1. **Versions.** `@medusajs/cli`, `@medusajs/framework`, `@medusajs/medusa` (apps/medusa and the root dev dependency) and `@medusajs/js-sdk` (packages/commerce) move to **2.23.1**. `@types/express` moves 4.17.21 → **5.0.6** (Medusa now runs Express 5.3.0). `react`/`react-dom` move 19.3.0 → **19.3.1** in `apps/web` and the root overrides, because `@medusajs/medusa` 2.23.1 declares a `react-dom ^19.3.1` peer and the upgrade guide forbids a stale override that would hold a second React. No other `apps/web` dependency changes.
2. **Root overrides re-baselined.**
   - `@opentelemetry/instrumentation-pg` 0.75.0 → **0.78.0** (`@medusajs/deps` 2.23.1 requires `^0.78.0`; 0.78.0 is the latest release).
   - `react`, `react-dom` → 19.3.1 (above).
   - **Removed** `bullmq@5.13.0 > uuid 11.1.1`. Medusa 2.23.1 uses BullMQ 6.7.6, which has no uuid dependency and calls `node:crypto` `randomUUID`; a keyed override for BullMQ 5.13.0 can never match again. No uuid package is installed anywhere in the tree.
   - **Removed** `postcss-selector-parser` 7.1.6. The package is no longer in the tree (it came in with the Tailwind 3 admin toolchain, which Medusa replaced with Tailwind 4). An override for an absent package is inert; if the package comes back at a vulnerable version, `security:audit` rejects it as an unwaived advisory.
   - Unchanged: `lodash` 4.18.1, `@graphql-tools/utils` 12.0.4, `@rushstack/node-core-library@5.13.0 > ajv` 8.20.0 (Rushstack 5.13.0 is still installed), `zod` 4.6.7 (Medusa 2.23.1 pins the same version).
3. **Waiver policy** (`security/dependency-waiver-policy.json` and its anchor `WAIVER_POLICY_SHA256`, the only evaluator line changed): the glob, minimatch and i18next waivers are **removed**; the esbuild waiver is unchanged (same node, version, `resolved`, `integrity`, development context). `amendmentRecord` points to this ADR and `previousAmendmentRecord` to ADR-0023. Authority, scope, `approvedOn`, `notBefore`, `expiresAt` and the code ceiling **2026-12-17T23:59:59Z are unchanged and not extended**. The audit fixture `security/fixtures/dependency-waiver-audits.json` is re-captured from real `npm audit --omit=dev --json` and `npm audit --json` output on the final tree.
4. **New Medusa default kept out.** Medusa 2.23 loads `@medusajs/cloud` as a default plugin even when self-hosted: it adds `/admin/cloud/announcements` and `/admin/cloud/announcement-preferences` routes (the first one calls `https://api.prod.medusajs.cloud` when no URL is set), a cloud table migration and an RBAC policy script. `apps/medusa/medusa-config.ts` disables it with the documented `{ resolve: "@medusajs/cloud", options: { disabled: true } }` entry, which restores the 2.21.2 plugin surface (only `@medusajs/draft-order`). Medusa adds the Audit module only on Medusa Cloud or with a licence, so it is not loaded here. No other default module changed between 2.21.2 and 2.23.1.
5. **Security-lane version pins.**
   - `scripts/medusa-runtime-inventory.mjs` (container job): asserts 2.23.1. Vite 8 bundles with Rolldown, so `@rollup/rollup-linux-x64-gnu` and `@napi-rs/lzma-linux-x64-gnu` left the tree; the native-binding check now loads `@rolldown/binding-linux-x64-gnu` and `msgpackr-extract`, and loads `lightningcss` through `vite`, because the production lightningcss copy is nested under vite.
   - `scripts/security/m1b-source-policy.mjs`: one constant `M1B_MEDUSA_VERSION = "2.23.1"` replaces the three literals used by diagnostic collection, the metadata check and the proposal. The sealed 2026-10 M1b policy JSON (UNACTIVATED, expired 2026-10-24) still records 2.21.2 and is rejected either way.
   - **Left unchanged on purpose:** `scripts/security/audit-policy.mjs` line 141 and `security/m2-exception-policy.json`, `security/m1b-source-ci-policy.json`, `security/pr5-local-preparation-policy.json`, `security/fixtures/pr5-reviewed-runtime.json` and `docs/implementation/evidence/*`. These are sealed historical approvals and evidence (all expired; ADR-0020 keeps them as fallbacks that reject). Editing them would break their anchors or rewrite history. They describe what was approved for 2.21.2, not the current tree.
6. **Historical M2 policy regression input.** `scripts/tests/security-policy.test.mjs` replays the sealed M2 evaluator against the PR4 baseline (`259d388`). It took workspace files from Git but third-party manifests from the live install, which worked only while the live tree still held the 2.21.2 dependency chain. That is no longer true. The third-party manifests for the 82 locations the evaluator reads are now captured once from a real `npm ci --ignore-scripts` of the baseline lockfile (`security/fixtures/m2-historical-install.json`, reproducible with `scripts/tests/capture-historical-install.mjs`); the capture is bound to the baseline commit and to the policy's lock hash. The captured state was checked equal to a snapshot of the full real install (installed manifests, 163 resolutions, 163 ancestry edges, lock hash). All 25 assertions of that test are unchanged.
7. **Tests.**
   - `scripts/tests/dependency-compat.test.mjs`: the BullMQ/uuid case now asserts BullMQ 6.7.6 declares no uuid dependency, no shipped BullMQ file imports `uuid`, its job-id helper is `node:crypto` `randomUUID` and yields v4 UUIDs, and no installed uuid copy anywhere is below the patched 11.1.1. This keeps the original guarantee (no uuid below 11.1.1 reachable from BullMQ) without the override.
   - `scripts/tests/dependency-waiver-policy.test.mjs` is rewritten for the esbuild-only set (24 cases; see Consequences for the coverage change).
   - `apps/medusa/tests/config.test.ts`: the resolved config contains no `@medusajs/cloud` plugin, still contains `@medusajs/draft-order`, and keeps the admin disabled.
   - `scripts/test-medusa.mjs` (CI `db-integration`, real Medusa boot): five Express 5 boundary cases. Medusa rewrites the `"/*"` foundation matcher to `"/{*splat0}"`; nested, trailing-slash and percent-encoded Store writes and the unenrolled bridge route must still get 403, and `GET /store/regions` must still pass the boundary (200).

## What the release notes change for this repository

| Change | Applies? | Action |
|---|---|---|
| Express 5 / path-to-regexp 8 (and 9 in the framework since 2.22.4) | Yes: four matchers in `apps/medusa/src/api/middlewares.ts`. Medusa rewrites `"/*"` (`toExpressPath`) to `"/{*splat0}"`; the three plain POST paths are unchanged. No `req.params[0]`, no `bodyParser: false`, no `/x/*` body-parser config. | Boot-test cases above. `bodyParser.sizeLimit: "2kb"` is valid, so the 2.22.2 "invalid sizeLimit now throws" change does not apply. |
| BullMQ 6 / ioredis 6, Redis session store on node-redis | No Redis is configured (no `redisUrl`, `redisOptions` or Redis modules). BullMQ is installed only as a transitive of the Redis modules. | None. No downgrade risk, because no Redis holds BullMQ state. |
| OpenTelemetry SDK 3 | No `instrumentation.ts`. | Override bumped only. |
| React 19.3.1, Vite 8, Tailwind 4, TanStack, i18next 27 (admin) | Admin is disabled (`admin.disable: true`), no `src/admin`. | React pin and override only. |
| Cart completion requires a shipping method for shipping-profile items (2.23.1) | Store writes are 403 at the foundation boundary in M2. | None now. Record for the M4/M5 checkout steps. |
| Query-parameter hardening (2.22.5), proxy-addr 2.0.8 (2.22.7), security headers on responses (2.22.7), cart ownership and customer email checks (2.22.1), refresh/MFA password-change validation (2.23.1) | Inherited fixes. | None. |
| New default `@medusajs/cloud` plugin | Yes. | Disabled (Decision 4). |
| Node.js 22.22.0 or later (2.22.0) | The repo requires `>=22.23.0 <23`; the image pins 22.23.3. | None. |
| A failed migration script now exits non-zero (2.22.0) | Strengthens the CI boot. | None. |
| RBAC policies, Loyalty Plugin, Index Module deprecation, Adyen | Not used. | None. |

New Medusa module migrations (2.22 and 2.23) run in the CI `db-integration` boot (`medusa db:migrate` before `medusa start`). There is no persistent Medusa database: staging was deleted and no production exists.

## Lockfile summary

Generated with `npm install` after removing only the `@medusajs/*` lock entries (a plain install hit `ERESOLVE` against the 2.21.2 entries). Compared as resolved package sets, not lines: 1,264 → 1,247 entries; 499 `name@version` added and 533 removed (340 packages changed version, 151 new names, 160 names gone, mostly Rollup → Rolldown, Babel, Tailwind 3 tooling and `uuid`). Every non-bundled entry resolves to `https://registry.npmjs.org/` with an integrity hash; the six entries without one are `inBundle` files inside the registry tarball of `@tailwindcss/oxide-wasm32-wasi` (the same pattern already exists for its 4.3.3 copy). No new package with an install script; `@medusajs/telemetry` and `msgpackr-extract` only moved versions. `npm ci` followed by `npm ls --all --omit=optional` is clean.

## Consequences

- `npm run security:audit` → `ACCEPTED_WITH_DATED_WAIVER` with **0 production findings** and 4 full-audit findings (esbuild and its three dependents `@esbuild-kit/core-utils`, `@esbuild-kit/esm-loader`, `drizzle-kit`), all moderate. Before: 61 production and 65 total.
- The waiver now covers one development-only advisory. The 2026-12-17 ceiling still stands, and the esbuild waiver will still be needed then, so a founder decision (extend the window for esbuild only, or move drizzle-kit) is still owed before that date.
- **Test coverage change, for reviewers to accept explicitly.** With no production waiver left, any production finding is rejected (`UNWAIVED_ADVISORY`, `UNWAIVED_VULNERABLE_NODE` or `DEVELOPMENT_NODE_IN_PRODUCTION_AUDIT`) before the evaluator's superset comparison, so `FULL_AUDIT_NARROWED` joins `ADVISORY_GRAPH_CHANGED` (since ADR-0023) as defence in depth that no test can reach. The test proves that a production finding missing from the full audit is still rejected. Production-side cases (new advisory, high or critical record, development waiver at a production node, return of the glob, minimatch, i18next and Next.js advisories) inject a record at a synthetic production node. Mutation check of the evaluator: neutralising each of the other 20 rejection codes checked fails at least one test; `AUDIT_INCOMPLETE` needed a new precise case, which is added.
- The historical M2 regression test no longer reads the live install (Decision 6).
- Express 5 runtime behaviour is proven only by CI (`db-integration` Medusa boot and the `container` job). It is NOT_RUN in the authoring sandbox (no Docker, no Postgres).

## Rollback

Revert the commit and run `npm ci`. Medusa 2.21.2, the old overrides and the four-waiver policy return, and `security:audit` accepts again under the same ceiling. There is no persistent Medusa database and no Redis, so nothing has to be downgraded in place. If a future environment has run 2.23.1 against a Medusa database, restore that database from the backup taken before the upgrade rather than running 2.21.2 against migrated tables.

## Security review notes

Recorded in the pull request after the independent review pass.
