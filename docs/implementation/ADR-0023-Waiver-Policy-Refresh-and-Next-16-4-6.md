# ADR 0023 — refresh the dated dependency-advisory waiver and move Next.js to 16.4.6

2026-11-27. Status: **proposed**, founder approval of the approach recorded in the project thread on 2026-11-27 ("go ahead as recommended noting the biomejs migration"). Not accepted until the founder merges. Amends [ADR-0020](ADR-0020-Dated-Dependency-Advisory-Waiver.md). Base: `main` at `0880cbe`.

## Context

On a clean install of `main`, `npm run security:audit` is `REJECTED (UNWAIVED_ADVISORY)`. Three groups of findings published or changed after the ADR-0020 waiver:

1. Seven moderate Next.js advisories covering `>=16.0.0 <=16.4.4` (the repo pins 16.4.3): GHSA-mfr8-8qww-v76h, GHSA-vc7v-qv4w-wrv8, GHSA-7qx7-33qx-rqx2, GHSA-f3mh-rxg3-f5g2, GHSA-pc58-hwjq-p385, GHSA-rhh4-g77r-r9qj, GHSA-vvgp-ww4w-46vf. All are fixed in the patch release 16.4.6.
2. One moderate i18next advisory, GHSA-6jcc-5g8w-32mx (`<26.3.4`), reached only through `@medusajs/dashboard` 2.21.2 (Medusa admin UI). `apps/medusa` sets `admin.disable: true` and no repository code imports i18next. The fix is a major bump.
3. Two upstream data changes that the ADR-0020 evaluator treats as failures, hidden behind (1) and (2):
   - The minimatch advisory GHSA-g3hv-75wg-m249 is now reported as `>=7.0.0 <11.0.1`; the policy said `<11.0.1`, so the exact-range check rejects with `ADVISORY_ORIGIN_MISMATCH`. The new range also takes the four ESLint minimatch 3.1.5 development nodes out of the audit, which the completeness check rejects (`AUDIT_GRAPH_INCOMPLETE`).
   - The deepmerge advisory GHSA-gcqx-w48m-w2h4 is no longer reported although deepmerge 4.3.1 is still installed and is the latest release (same rejection code). It appears withdrawn; that was not confirmed on GitHub from the authoring session.

## Decision

1. `next` 16.4.3 → **16.4.6** in `apps/web/package.json`. The lockfile changes exactly eleven entries: the `apps/web` workspace entry, `next`, `@next/env` and eight `@next/swc-*` (versions, `resolved` URLs, hashes). Nothing else. `eslint-config-next` and `@next/eslint-plugin-next` stay at 16.4.3, because the ESLint to Biome migration removes them in a separate PR. A plain `npm install --package-lock-only` nests `next` and breaks the root ESLint parser (as the 2026-11-02 triage found), so the entries were patched in place. After `npm ci`, `npm install --package-lock-only` leaves the lockfile byte-identical.
2. `security/dependency-waiver-policy.json` and its anchor `WAIVER_POLICY_SHA256` (in `scripts/security/dependency-waiver-policy.mjs`; that anchor line is the only evaluator change):
   - minimatch: `range` becomes `>=7.0.0 <11.0.1`; the four ESLint 3.1.5 development nodes are removed; only `node_modules/minimatch` 10.2.6 (production) remains.
   - deepmerge: waiver removed.
   - i18next: new waiver for GHSA-6jcc-5g8w-32mx, moderate, `<26.3.4`, node `node_modules/i18next` 23.7.11 (production), with its `resolved` URL and `integrity` pinned.
   - glob and esbuild waivers unchanged. Authority, scope, `notBefore` and the window are unchanged, and the ceiling `2026-12-17T23:59:59Z` is neither moved nor extended. Two informational fields (`amendedOn`, `amendmentRecord`) point to this ADR.
3. The Next.js advisories are **not** waived. A patch release exists and `apps/web` is the internet-facing surface.
4. i18next is waived, not overridden. An override to 26.3.4 passed the same checks in a trial, but it is a lockfile major bump in a package that never runs.
5. Medusa stays at 2.21.2. Moving to 2.23.1 would fix glob and i18next natively but leaves minimatch and esbuild, failed one BullMQ test in a trial, changes about 11,700 lockfile lines and reopens the M2 source pins hard-coded in `scripts/security/audit-policy.mjs`, `scripts/security/m1b-source-policy.mjs`, `scripts/medusa-runtime-inventory.mjs` and the M1b evidence. It needs its own decision.
6. `security/fixtures/dependency-waiver-audits.json` is re-captured from real `npm audit --omit=dev --json` and `npm audit --json` output on the final tree (production 61, full 65, no high or critical; captured on `main` at `b49b0d1` plus this change, after the Biome migration). `scripts/tests/dependency-waiver-policy.test.mjs` is updated for the new counts and waiver set, and gains regression cases (see Consequences).

## Exposure of the Next.js advisories (source read of `apps/web/src` and `next.config.mjs`)

Not a penetration test. Four advisories concern `use cache`, `unstable_cache` and Cache Components, none of which the app uses. The Edge-runtime cookie advisory does not apply (routes declare `runtime = "nodejs"`; no middleware or proxy file). The self-hosted response-forwarding advisory does not apply (no code forwards an upstream `Response` body; no self-hosted deployment is active). The image-optimization SVG bypass is low today: `next/image` serves five repo-owned static SVGs, with no `images` config and no remote patterns. It becomes relevant once users upload images (M3/M4), which is one more reason to take the patch now.

## Consequences

- `npm run security:audit` returns `ACCEPTED_WITH_DATED_WAIVER` (61 production, 65 total findings).
- **Test coverage change, for reviewers to accept explicitly.** The case "a propagated record cannot exceed the severity of its waived origin" relied on the low-severity deepmerge origin. Every remaining waiver is moderate, so exceeding an origin now means high or critical, which is rejected first as `UNWAIVABLE_SEVERITY`. The `ADVISORY_GRAPH_CHANGED` comparison stays in the evaluator as defence in depth, but no test can reach it with the current waiver set. The case now asserts the escalation is still rejected, with a comment saying so. The "missing waived node" case previously removed ESLint's minimatch nodes; it now removes the esbuild origin and its dependents.
- The amendment keeps `approvedOn` (2026-11-02), the window and the code ceiling by design: the evaluator hard-codes them, and this ADR changes only what is waived, not the approval envelope. The founder's merge of this PR is the approval of the 2026-11-27 amendment, including the new i18next waiver.
- Added cases (security review follow-up included): production-audit omission of each of the reviewed glob, minimatch and i18next nodes is rejected as incomplete; the waiver set is exactly glob, minimatch, esbuild and i18next; a minimatch range change upstream fails closed; none of the seven Next.js GHSAs is waived and each is rejected if it appears; the i18next waiver covers only its reviewed path and version.
- The waiver window is unchanged. On 2026-12-17T23:59:59Z the gate still fails closed. The glob, minimatch, esbuild and i18next waivers will still be needed then, so a founder decision (extend the ceiling in code and policy, or move Medusa and drizzle-kit) is owed before that date; the 2026-12-10 reminder covers it.
- ESLint to Biome (separate thread): `eslint-config-next`, `@next/eslint-plugin-next` and ESLint's minimatch copies leave the tree with that PR. This ADR already stops waiving the ESLint minimatch nodes, so nothing in the policy depends on ESLint remaining. The Biome PR (#40) merged first and this change was merged onto it, so the tree no longer contains ESLint.
- Governance, unchanged from ADR-0020: the evaluator, anchor and ceiling live in files one PR can change together, and CODEOWNERS was declined on 2026-11-03. This PR edits a security policy on an explicit founder decision. It is not an edit made to turn a failing check green, and the independent review below exists for that reason.

## Rollback

Revert the commit and reinstall. The old policy and `next` 16.4.3 return, and the gate rejects again (`UNWAIVED_ADVISORY`), so CI fails closed. No data, flag or infrastructure is involved.

## Security review notes

Independent `security-reviewer` pass on 6a42be6 (2026-11-27): **no blocking findings**. Confirmed: the evaluator diff is only the anchor and the digest matches it; window, ceiling, authority, scope unchanged; every waived node (path, version, resolved, integrity, context) matches the lockfile, and the i18next and minimatch integrity values match independent npm-cache entries; the lockfile diff touches only next-related entries, with no install scripts and no non-registry URLs; removing the four ESLint nodes and the deepmerge waiver cannot hide an advisory (re-injecting either returns `UNWAIVED_ADVISORY`; widening the minimatch range returns `ADVISORY_ORIGIN_MISMATCH`); the `ADVISORY_GRAPH_CHANGED` check is dead code to the tests, as disclosed. Follow-ups applied here: a per-package production-omission test (closing a gap that mutation testing found for the production-node loop, which pre-dated this change), the entry count (eleven, not ten), the stale full-audit fixture (re-captured), and the `approvedOn` statement above. Not applied: naming `@typescript-eslint/typescript-estree` in the minimatch rationale, which is moot now that ESLint is gone. Not verifiable offline by the reviewer: the registry hashes of six `@next/swc-*` platform packages (CI `npm ci` checks them) and the GitHub withdrawal status of the deepmerge advisory.

## Evidence

See the pull request evidence table (commands, results and the NOT RUN column).
