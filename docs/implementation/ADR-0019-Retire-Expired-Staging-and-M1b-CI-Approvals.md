# ADR 0019 — retire the expired M2 staging and M1b source-CI approvals

2026-11-02. Status: accepted by founder decision on 2026-11-02. Starting commit `1ea5f9a` (`main` after PR #17).

## Context

Two time-boxed approvals expired on 2026-10-24 and turned CI red on every branch (see `MILESTONE-PROGRESS.md`):

1. The M2 Cloud Run remote-staging approval (`apps/medusa/scripts/remote-staging-policy.json`, `STAGING_*` selectors in `scripts/security/run-audit.mjs`, ADR-0005/0006).
2. The M1b GitHub source-CI exception (`security/m1b-source-ci-policy.json`, `M1B_*` selectors in `scripts/security/m1b-source-policy.mjs`, ADR-0016).

A four-voice advisory council (2026-11-02) recommended retiring both instead of renewing them. The founder decided:

- The private synthetic Medusa staging service `vynvori-medusa-staging` has been **deleted** (founder confirmation; not independently verified from this repository, which has no cloud access in this change).
- The M1b source-CI exception is **retired**, not renewed.

## Decision

- `STAGING_IMPLEMENTATION_COMMIT` and `STAGING_POLICY_DIGEST` return to `"UNACTIVATED"`. `apps/medusa/scripts/remote-staging-policy.json` is restored byte-for-byte to its unapproved form from `7236066` (`approved: false`, `approvedBy: null`, `sourceCommit: null`). Any future staging needs a new founder approval, new policy and new selectors.
- `M1B_IMPLEMENTATION_COMMIT` and `M1B_POLICY_DIGEST` return to `"UNACTIVATED"`. `security/m1b-source-ci-policy.json` is kept unchanged as the historical record of the reviewed proposal; with both selectors unactivated, `run-audit.mjs` no longer evaluates it.
- No policy is renewed, widened or re-sealed. No exception, advisory or risk is newly accepted.

Both values are exactly what the existing tests and the staging/M1b policy code already define as the "not activated" state (`medusa-staging.test.mjs` expects `REMOTE_APPROVAL_REQUIRED` and `STAGING_NOT_ACTIVATED`).

## Consequences

- `npm test` passes (`test:staging` no longer fails on `REMOTE_APPROVAL_EXPIRED_OR_INVALID`).
- **`npm run security:audit` stays red, with a different, more fundamental code.** With the staging and M1b paths unactivated, the runner evaluates only the base M2 exception (`security/m2-exception-policy.json`) and then the PR5 local policy. The base M2 exception rejects with `LOCK_FINGERPRINT_MISMATCH`: the sealed lockfile fingerprint predates lockfile changes merged in PRs #10, #11 and #15. The unfiltered production audit currently reports 76 advisory entries (1 critical, 16 high, 55 moderate, 4 low), so the follow-up dependency work is larger than "two advisory roots".
- Both remaining policies (`m2-exception-policy.json`, `pr5-local-preparation-policy.json`) expire 2026-11-15. The founder-approved follow-up is a single orchestrator-run dependency PR that remediates production advisories and replaces the byte-for-byte seal with a reviewed lockfile allowlist plus a dated waiver for anything not fixable; it requires its own security review and founder approval of the exact residual risk.
- Until `security:audit` is green, no milestone implementation merges (founder decision, 2026-11-02). Docs-only and blueprint changes are exempt.

## Rollback

Revert this commit. That restores the expired selectors, which fail closed again on the expired windows. Re-activation of either approval requires a new, dated founder approval; reverting does not grant one.

## Security review notes

- Change only removes trust: four selector literals become `"UNACTIVATED"`, and one policy file loses its approval fields. No new code path, dependency, secret, endpoint or flag.
- No feature flag changes; all production, financial, rights, vendor and SSO flags remain OFF.
- Live cloud deletion of the staging service rests on founder confirmation. Residual risk if the service were still running: it is private (no public IAM) and holds synthetic data only, per M2 closure evidence; the repo no longer authorizes any operation against it.

## Evidence (local, 2026-11-02, Node 22.23.4)

| Check | Result |
|---|---|
| `npm ci` | PASS, lockfile unchanged |
| `npm test` | exit 0 (all groups pass; 18 environment-dependent skips, unchanged) |
| `npm run lint`, `npm run typecheck` | exit 0, exit 0 |
| `npm run security:audit` | REJECTED `LOCK_FINGERPRINT_MISMATCH` (expected; see Consequences) |
