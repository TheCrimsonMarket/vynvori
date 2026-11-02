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

## Not done in this triage

No `npm ci`, build, test or Medusa/web run against the trial lockfiles. Runtime compatibility of zod 4.6.x under Medusa 2.21.2 and of Next 16.4.3 is unverified. Vercel and Medusa deployment state were not checked, because this session has no cloud access.
