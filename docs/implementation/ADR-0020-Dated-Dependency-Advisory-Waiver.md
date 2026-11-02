# ADR 0020 — replace the whole-tree M2 seal with a dated dependency-advisory waiver

2026-11-02. Status: accepted by founder decision on 2026-11-02 (exact advisory list and 45-day expiry). Base: PR #18 head after `9c22667`.

## Context

`npm run security:audit` accepted known advisories only through `security/m2-exception-policy.json` (ADR-0003/0008, evaluator `scripts/security/audit-policy.mjs`). That policy byte-for-byte sealed the lockfile, every manifest, the dependency ancestry and every file under `apps`, `packages`, `services`, `scripts`, `.github/workflows`. Any code change failed CI, so parallel milestone work could never be green. Its PR5 and M1b successors were similarly sealed, and all of them expire on or before 2026-11-15.

PR #18 already removed every critical and high production advisory (Next.js 16.4.3, `zod` 4.6.7, in-range updates). The remaining findings trace to four advisories, none of which has a non-major fix (see [triage](Dependency-Triage-20261102.md)).

## Decision

A new, separate gate, `scripts/security/dependency-waiver-policy.mjs` + `security/dependency-waiver-policy.json`, is evaluated first by `scripts/security/run-audit.mjs`. It waives exactly:

| GHSA | Package | Severity | Reviewed nodes |
|---|---|---|---|
| GHSA-3g3m-2fjr-6pw4 | glob | moderate | `node_modules/glob` 13.0.6 (production) |
| GHSA-g3hv-75wg-m249 | minimatch | moderate | `node_modules/minimatch` 10.2.6 (production); four ESLint copies 3.1.5 (development) |
| GHSA-gcqx-w48m-w2h4 | deepmerge | low | `node_modules/deepmerge` 4.3.1 (production) |
| GHSA-67mh-4wv8-2f99 | esbuild | moderate | `node_modules/@esbuild-kit/core-utils/node_modules/esbuild` 0.18.20 (development) |

Owner: VYNVORI founder. Window: `2026-11-02T00:00:00Z` ≤ now < `2026-12-17T23:59:59Z`. The ceiling is also hard-coded in the evaluator. Scope: CI and local audit gate only (`deploymentAuthorized: false`).

The gate **rejects** (fail-closed) when any of the following holds:
- the policy JSON's canonical digest differs from the reviewed anchor `WAIVER_POLICY_SHA256`, or its metadata differs;
- the time is outside the window;
- any record in either audit is high or critical;
- any originating advisory is not waived, or its package, severity or range differs from the waiver;
- a waived package is vulnerable at an unreviewed path or installed version, or a waived node's lockfile `dev` flag contradicts its context;
- a development-only node appears in the production audit;
- any propagated record does not trace to a waived origin, or is more severe than that origin;
- either audit has an execution error, a signal, an inconsistent exit code, malformed JSON or inconsistent counts;
- `.npmrc` or `npm-shrinkwrap.json` exists, the registry is unreviewed, the workspace audit is partial, the context is remote (Vercel or Cloud Run), or any `VYNVORI_*` flag is not `false`.

**Intentionally removed:** the lockfile, manifest, ancestry and source-tree fingerprints. Dependency changes that introduce **no** new advisory now pass; any change that makes an advisory-relevant difference fails through the checks above. This is the founder-approved trade-off ("allowlist plus dated waiver").

The historical policies, evaluators and fixtures are unchanged and remain fallbacks. If the waiver rejects and every fallback also rejects, the waiver's code is reported and the fallback's result is kept as `historicalResult` in the evidence.

## Consequences

- `npm run security:audit` → `ACCEPTED_WITH_DATED_WAIVER` (63 production / 82 total findings), exit 0.
- Parallel PRs no longer collide on a sealed lockfile. Each still fails if it adds an advisory, which then needs a reviewed policy change: new JSON, new anchor and a founder decision.
- On 2026-12-17T23:59:59Z the gate fails closed. Before then, re-triage: remove waivers that were fixed, or bring a fresh founder decision.

## Rollback

Revert the commit. The runner falls back to the historical sealed policies, which reject (expired or lock mismatch), so CI fails closed. No data or infrastructure is involved.

## Security review notes

- Removes a control (the whole-tree seal) by explicit founder decision. Compensating controls are listed under Decision; 18 unit tests cover them. Mutation checks: removing the severity, unwaived-advisory, node/version, dev-in-production, counts, mapping, severity-propagation, environment, anchor or expiry checks each fails at least one test. Removing only one of the two equivalent expiry comparisons is masked by the other.
- No feature flag, secret, endpoint or deployment change. The waiver grants nothing outside the audit gate.
- An independent `security-reviewer` agent pass over this diff is recorded in the PR.

## Evidence (local, 2026-11-02, Node 22.23.4, clean `npm ci`)

| Check | Result |
|---|---|
| `npm run security:audit` | **ACCEPTED_WITH_DATED_WAIVER**, exit 0 |
| `npm run test:security-policy` (including 18 new waiver tests) | PASS |
| `npm test` | exit 0: 282 pass, 0 fail, 18 skipped |
| `npm run lint` / `npm run typecheck` | exit 0 / exit 0 |
| `npm run verify` | **fails at `verify:reference`**: `docs/technical/20-acceptance-matrix.md` no longer matches its anchor in `M0-protected-files.json`. Pre-existing on `main` since PR #10, and unrelated to this change; it needs a founder decision to re-anchor. |
