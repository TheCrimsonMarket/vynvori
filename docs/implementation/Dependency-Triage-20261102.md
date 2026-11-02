# Dependency advisory triage — 2026-11-02 (W0, read-only)

Scope: triage for the founder-approved W0 dependency / seal-replacement PR. **No lockfile or manifest in the repository was changed.** Trials ran on a `git archive` copy in a session scratch directory using `npm install --package-lock-only --ignore-scripts`; nothing was built or executed from them. Base: `4305e15` (PR #18 head). Node 22.23.4, npm 10.9.9.

## Baseline (current lockfile)

`npm audit --omit=dev`: **76 entries — 1 critical, 16 high, 55 moderate, 4 low**. Full graph (`npm audit`): 95 entries. These collapse to **9 production advisory roots + 1 dev-only root**; everything else is a dependent of a root. The braces/sprintf roots named in ADR-0016 no longer appear.

| Sev | Root (installed) | Advisory | Reached via | Fix |
|---|---|---|---|---|
| **critical** | `next` 16.4.0 | Unauthenticated RCE (×2) and App Router DoS, `>=16.0.0 <=16.4.0` | `apps/web` direct pin | **16.4.3** (patch) |
| high | `zod` 4.2.0 | Memory exhaustion on oversized input, `<4.6.6` | our `packages/contracts` pin **and** Medusa 2.21.2 exact pin (`@medusajs/deps`, `dashboard`, `draft-order`) | contracts → 4.6.7; Medusa side needs override or Medusa 2.22.2 (pins 4.6.6) |
| high | `body-parser` 1.20.8 | DoS, `<1.20.9` | Medusa/express | in-range update |
| high | `follow-redirects` 1.16.1 | cross-realm sensitiveHeaders, `>=1.16.0 <=1.16.1` | transitive | in-range update |
| high | `multer` 2.4.0 | DoS, `>=2.0.0 <2.5.0` | Medusa | in-range update |
| moderate | `fast-uri` 3.1.8 | URI spoofing / path / host confusion, `<3.1.9` | ajv | in-range update |
| moderate | `glob` 13.0.6 | AbortSignal bypass, `>=9.0.0 <=14.0.1` | `@medusajs/cli` exact pin (also in 2.22.2) | **major only** (14.x) |
| moderate | `minimatch` 10.2.6 | glob-pattern DoS, `<11.0.1` | via glob 13 | **major only** (11.x) |
| low | `deepmerge` 4.3.1 | prototype poisoning, `>=4.2.0 <=4.3.1` | `@medusajs/notification-sendgrid` → `@sendgrid/helpers` | **no patched release exists** |
| moderate (dev) | `esbuild` ≤0.24.2 | dev-server request forgery | `drizzle-kit` | npm's suggestion is a drizzle-kit downgrade (reject) |

npm's other "fixes" (`@medusajs/medusa@2.2.0`, `@medusajs/cli@2.2.0`, `@medusajs/framework@2.8.4`) are **downgrades** from 2.21.2 and are rejected.

## Trial results (scratch copy, lockfile-only)

| Trial | Changes | Production audit | Full audit |
|---|---|---|---|
| T1 | `next` 16.4.0→16.4.3; contracts `zod` 4.2.0→4.6.7; `npm update` body-parser, follow-redirects, multer, fast-uri, deepmerge | 71: 0 critical, **13 high** (Medusa's zod 4.2.0), 54 moderate, 4 low | not run |
| T2 | T1 + root override `zod: 4.6.7` + nested override `@medusajs/cli → glob 14.0.3` | **62: 0 critical, 0 high**, 58 moderate, 4 low | 81: 0 critical, 0 high |

In T2, the remaining advisories are only `glob`/`minimatch` (moderate), `deepmerge` (low), and dev `esbuild` (moderate). The nested `glob` override **did not take effect**; a second path still resolves glob 13. That needs investigation, not a broader override.

`eslint-config-next` is pinned at 16.4.0 in the root `package.json` (dev). Bump it with `next` to keep them aligned.

## Recommended split

1. **Hotfix PR now — `next` 16.4.0 → 16.4.3 + `eslint-config-next` 16.4.3.** Critical unauthenticated RCE. `vercel.json` only disables deployments for `codex/m1b-central-identity`, so `main` and other branches may be deploying to Vercel on 16.4.0. M3 evidence also recorded a Next.js "security upgrade" gate message on build. Founder should check Vercel for live deployments now. This is a security fix, not milestone code; it still changes the lockfile, so it lands under the founder's explicit approval while CI stays red.
2. **Dependency PR (orchestrator) — the rest of T2:** contracts `zod` 4.6.7, root `zod` override 4.6.7 (within Medusa's major; run all Medusa tests plus the native Medusa HTTP probe), in-range updates for body-parser, follow-redirects, multer and fast-uri.
3. **Dated waivers, approved by the founder, in the replacement policy:**
   - `glob`/`minimatch` in `@medusajs/cli`: operator-run CLI, operator-supplied patterns, moderate. Re-check on each Medusa release.
   - `deepmerge` via the SendGrid notification module: no fix exists, low, and the module is not configured (verify before approving).
   - `esbuild` via `drizzle-kit`: dev-only, no dev server exposed.
4. **Do not** upgrade Medusa 2.21.2 → 2.22.2 inside this PR. It would fix zod natively, but it reopens M2 source pins and evidence. Consider it a separate, later decision.
5. **Seal replacement:** the M2 policy's byte-for-byte tree and lockfile fingerprint (`LOCK_FINGERPRINT_MISMATCH` today) is replaced by a reviewed allowlist of advisory IDs, with expiry and owner, evaluated against a fresh audit. This is a security-policy change: ADR, `security-reviewer` pass, `npm run test:security-policy` updated, and founder approval of the exact residual list. It must land before 2026-11-15, when `m2-exception-policy.json` and `pr5-local-preparation-policy.json` expire.

## Status update — Next.js hotfix applied (2026-11-02)

Founder approved item 1. `next` and `eslint-config-next` are now pinned at 16.4.3. The lockfile diff is exactly 12 `next`/`@next/*`/`eslint-config-next` entries, changed in place: same hoisted paths, nothing else touched. `npm install --package-lock-only` reproduces the lock byte-for-byte. An in-place `npm install` initially nested `next` under `apps/web`, which broke the root `eslint-config-next` parser; restoring the original hoisted placement fixed it.

| Check (clean `npm ci`, Node 22.23.4) | Result |
|---|---|
| `npm run lint` / `npm run typecheck` | exit 0 / exit 0 |
| `npm test` | exit 0: 264 pass, 0 fail, 18 skipped (unchanged environment skips) |
| `npm run build:web` | exit 0; the earlier Next.js "security upgrade" build message is gone |
| `npm audit --omit=dev` | 75 entries: **0 critical**, 16 high, 55 moderate, 4 low; `next` no longer flagged |
| `npm run security:audit` | REJECTED `LOCK_FINGERPRINT_MISMATCH` (unchanged; awaits seal replacement) |

`security/pr5-local-preparation-policy.json` still records `next` 16.4.0 as a sealed spec. It is deliberately not edited here, because the seal-replacement PR supersedes it. Not run: browser checks and Vercel preview.

## Status update — dependency remediation applied (2026-11-02)

Founder approved item 2. Changes:

- `packages/contracts`: `zod` 4.2.0 → 4.6.7 (exact pin).
- Root `overrides.zod = "4.6.7"`. This forces Medusa 2.21.2's exact `zod` 4.2.0 pin (`@medusajs/deps`, `dashboard`, `draft-order`) onto a 4.x minor. `npm ls zod` shows a single 4.6.7.
- In-range updates: `body-parser` 1.20.9, `fast-uri` 3.1.9, `follow-redirects` 1.16.2, `multer` 2.5.0.
- The lockfile diff is exactly these 5 packages plus the `packages/contracts` entry. `npm ci` leaves it unchanged, and `npm install --package-lock-only` reproduces it byte-for-byte.

**glob/minimatch: no override (changed from the T2 trial).** `glob` 13.0.6 is pinned exactly by `@medusajs/framework` (runtime module loading), `@medusajs/admin-bundler` and `@medusajs/cli`. No 13.x or 10.x release fixes the advisories, so the only fix is a major upgrade forced into Medusa's runtime loader. The patterns are Medusa-internal, not user input. Recommended disposition: dated waiver, re-checked on every Medusa release.

| Check (clean `npm ci`, Node 22.23.4) | Result |
|---|---|
| `npm run lint` / `npm run typecheck` | exit 0 / exit 0 |
| `npm test` | exit 0: 264 pass, 0 fail, 18 skipped (unchanged environment skips) |
| `npm run build:web` / `npm run build:m2` (incl. Medusa backend build) | exit 0 / exit 0 |
| `npm audit --omit=dev` | **63 entries: 0 critical, 0 high**, 59 moderate, 4 low. Roots: `glob` ([GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4)), `minimatch` ([GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)), `deepmerge` ([GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4)) |
| `npm audit` (all) | 82 entries: 0 critical, 0 high; adds dev-only `esbuild` via `drizzle-kit` |
| `npm run security:audit` | REJECTED `LOCK_FINGERPRINT_MISMATCH` (unchanged; awaits seal replacement) |

Not run: the native Medusa HTTP probe (`scripts/test-m1b-native-medusa.mjs`, since no Docker daemon is available in this session) and the disposable-PostgreSQL scenarios. Run both before relying on the `zod` override at runtime: Medusa request validation now executes on zod 4.6.7 instead of the 4.2.0 it pins.

The remaining waiver candidates for the seal-replacement policy are `glob`, `minimatch`, `deepmerge` (production) and `esbuild` (dev).

## Not done in this triage

No `npm ci`, build, test or Medusa/web run against the trial lockfiles. Runtime compatibility of zod 4.6.x under Medusa 2.21.2 and of Next 16.4.3 is unverified. Vercel and Medusa deployment state were not checked, because this session has no cloud access.
