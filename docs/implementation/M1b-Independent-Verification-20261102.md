# M1b independent verification — 2026-11-02

Starting commit: `dc30fd49c62969fb8cb29d1d31fb1db04e788d37` (`main`, after PR #12). Verified code: PR #10 squash `8d53fcc`. This is a read-and-run audit by a fresh session; **no production code was changed, no gate was promoted, no flag was enabled, and no live/GCP/Neon/Portal system was touched.**

## Verdict

The M1b **local implementation is real and matches the canonical identity rules**. Full M1b is **IN_PROGRESS** and cannot be marked PASSED: every remaining gate is external (central authority, live infrastructure, expired CI approvals), not a code gap found here.

## Correction to the handoff premise

PR #10 *did* ship its paper trail: ADR-0010 to ADR-0016 (durable state, fenced provisioning, web session boundary, private Medusa transport, customer credentials/owned reads, revocation reconciliation, CI approval), four `M1b-*-20261019.md` review documents, 16 receipts under `docs/implementation/evidence/M1b-*`, and dated M1b checkpoints in `docs/technical/20-acceptance-matrix.md`. Each ADR has a rollback section. No new ADR is warranted because this audit made no architecture change. Housekeeping only: `ADR-0008` exists twice (M2 closure and Typed Contracts) and `ADR-0009` does not exist.

The one stale item was the `MILESTONE-PROGRESS.md` M1b row (`NOT_STARTED`), corrected in this change.

## What was executed (all synthetic, loopback)

| Check | Result |
|---|---|
| `npm ci` (Node 22.23.4 / npm 10.9.9) | PASS |
| `packages/db` + `packages/commerce` tests, no database | 89 tests: 86 pass, 3 skip (the PostgreSQL-gated ones), 0 fail |
| Same two PostgreSQL-gated files against a throwaway **PostgreSQL 16** cluster on 127.0.0.1, 4 migrations applied, runtime tests run as a NOSUPERUSER/NOINHERIT role with SELECT/INSERT/UPDATE only | 45 / 45 pass, 0 skipped |
| `apps/medusa`, `apps/web`, `packages/shared` tests | 39 / 39 pass |
| `npm run lint`, `npm run typecheck` | PASS |
| `npm run test:security-policy` | 34 / 34 pass |

The prior receipts used PostgreSQL 18.6, so the 16.x run is an independent engine-version reproduction. Reproduce with `scripts/test-m1b-identity-state.mjs` (needs Docker `postgres:18-alpine`) or by applying `packages/db/auth-migrations/000{1..4}_*.sql` to a loopback database and exporting `M1B_TEST_POSTGRES_URL` / `M1B_TEST_MIGRATION_POSTGRES_URL`. The two expired-approval checks (`test:staging`, `security:audit`) were deliberately not run or touched.

## Canonical-rule review (docs/technical/03, 04; AGENTS.md rules 5–6)

| Rule | Finding |
|---|---|
| Global key is `issuer + subject` | HOLDS. `profiles UNIQUE(issuer, subject)`; commerce entity id is `sha256(["vynvori-central-identity-v1", issuer, subject])`; adapter rejects any response whose `iss`, `client_id`, `aud` or `sub` differ from configuration. |
| No email-based linking | HOLDS. Email only populates the Medusa customer record. In `inspectCentralCustomer`, an email collision with a customer lacking exact identity+operation metadata throws a conflict (no guest conversion, no silent merge). The Medusa provider rejects caller-supplied email, roles, customer IDs and body overrides. |
| Medusa customer IDs are commerce mappings | HOLDS. `commerce_mappings` has `UNIQUE(project_id, customer_id)` and `UNIQUE(project_id, auth_identity_id)`, so two identities cannot share one customer. |
| No Drizzle writes into Medusa's DB | HOLDS. `packages/db` writes only `vynvori_identity.*` in the creative database. Customer creation uses Medusa's native `createCustomerAccountWorkflow` through a private transport. |
| No uncontrolled retry of uncertain outcomes | HOLDS. Create dispatch is claimed once per durable operation; reconcile mode cannot create; a refresh whose outcome is unknown revokes the session and is never retried. |
| Feature flag OFF by default | HOLDS. `identity.central_sso` defaults `false`; `.env.example` has `VYNVORI_IDENTITY_CENTRAL_SSO=false`. |

## M1a-open-gates closure

| Gate | Status after M1b |
|---|---|
| Linking policy | CLOSED in code: issuer+subject, email never links. Local evidence only. |
| Provisioning safety | CLOSED locally: fenced single dispatch, raced-login and lost-response tests. Live fault injection NOT_RUN. |
| Session / callback safety | CLOSED locally: single-use PKCE transactions, generation-fenced refresh, no-retry-on-unknown, revocation reconciler. Live Portal behavior NOT_RUN. |
| Guest claims | PARTIAL: atomic claim primitive exists; full BYO persistence belongs to M3. |
| Central trust / config | **STILL BLOCKED.** The client calls `/mana/oauth/strict/v1/{introspect,profile,token,revoke}`. I found no audit or doc recording that these exist in the audited Portal source, and the M1a threat model says that source lacked audience/client enforcement. These endpoints are exercised only against the synthetic test authority. Needs a founder-approved central remedy plus provenance of the deployed Portal. |
| Dedicated Medusa / Vercel compatibility | Native Medusa HTTP tests pass locally; the live dedicated project, IAM and enabled Next bootstrap are NOT_RUN. |
| Staff policy | NOT addressed by M1b (customer path only). |
| Deployment verification, reviewer approval | OPEN. |

## Acceptance overlay (matrix rows intentionally not edited)

`docs/technical/20-acceptance-matrix.md` is hash-pinned in `M0-protected-files.json`, and its recorded change reason says requirement rows stay unchanged with status in dated prose, so row text was left alone.

| Row | Actual status | Evidence / blocker |
|---|---|---|
| ACC-02 | IN_PROGRESS (matrix row still reads `BLOCKED: repo access`, stale since M1a) | Source audit and threat model exist. Missing: reviewer approval, deployed-provenance evidence, central remedy. |
| ACC-03 | IN_PROGRESS, local only | Tests above plus `evidence/M1b-Connected-Browser-Stack-20261019.json`. Blocked on live issuer/audience/logout tests. |
| ACC-22 (auth subset) | IN_PROGRESS, local only | IDOR (foreign-cart 404, staff token 401, owner-filtered orders), CSRF, session, cookie and revocation tests pass locally. Admin, object-access and user-data deletion subsets remain NOT_RUN. |

## Open observations (no change made)

1. **`email_verified` is parsed but never consulted.** An unverified central email can become the Medusa customer email (used for receipts). The spec does not require gating, so this is a founder policy question, not a defect. Recommend deciding before enabling auth.
2. `customer()` runs three central introspections per owned read (`checked` twice plus `lookup`). This is an efficiency matter only, not a correctness one.
3. The rollback for the four migrations is "disable and retain rows"; there is no down-migration, which is intentional and non-destructive. A tested backup/restore of the live creative database is still required before any live apply.

## Remaining before M1b can be PASSED

1. Founder-approved central trust remedy and provenance for the strict endpoints, then real issuer/audience/rotation/revocation negatives against a registered dedicated client.
2. Separately authorized live migration, grants, staging target and rollback drill.
3. Renewal of the two expired CI approvals (M2 Cloud Run window, M1b source exception) by a human with GCP access and fresh founder approval.
4. Fresh dependency risk decision (two production advisory roots, plus esbuild in development).
5. Reviewer sign-off.

M3's owned-persistence track depends on M1b only through the verified-session interface, which is stable and locally tested. Guest and scene work in M3 already depends only on M2, so it can start independently.
