# M1a — Open gates and evidence

2026-10-15 (Asia/Dhaka). Source review and integration design are delivered for review; **M1b and production auth remain BLOCKED**. No auth configuration or feature flag enabled. [Audit](M1a-auth-source-audit.md), [threat model](M1a-identity-threat-model.md), [proposed contract](M1a-bridge-integration-contract.md).

| Gate | Status / owner / actionable evidence |
|---|---|
| Lucky source access | VERIFIED through authenticated CLI, private main at `6dc55ca3c2007d53d926773124d3851720f1b2c8`; connector 404 is connector-access limitation |
| Source bridge/SDK | REVIEWED at pinned M/S SHAs in audit; published SDK byte provenance and deployed revision NOT_VERIFIED |
| Central authority source | REVIEWED: founder supplied clean local Portal.Service at `3e91f57f9755be269cf13f718126a4abef620eb1`, branch developmerger. Remote default/deployed ref not verified; no source modified |
| Central trust/config | BLOCKED: source mints no issuer and userinfo enforces no audience/client binding. Approve validation remedy, issuer namespace, dedicated registration/callback, central domains, token-family policy and deployment evidence. Source access alone cannot close these gates |
| Linking policy | BLOCKED for reuse: source email-based empty-metadata linking and Google legacy migration must be replaced by issuer+subject and controlled migration |
| Provisioning safety | BLOCKED: no proven first-login race/orphan reconciliation; require dedicated workflow invariants and AUTH-13 fault injection |
| Session/callback safety | BLOCKED: persistent active-session checks, bound alternate exchange, nonce consumption, fenced renewal/logout, cache resurrection prevention; AUTH-03–07/14–18/21 |
| Dedicated Medusa | M2 NOT_STARTED by this task. Owner provisions separate VYNVORI staging project/database/admin/test identities; verify installed module/API/JWT compatibility, Store/Admin boundaries, provider-only customer methods |
| Vercel/SDK compatibility | NOT_RUN: Node SDK integration, SSR refresh, same-site callback, Preview origin registration, private cache isolation and no secrets in bundle |
| Staff policy | BLOCKED: explicit VYNVORI staff permission authority, grant freshness/revocation and separate Medusa Admin policy |
| Guest claims/assets | PROPOSED_ONLY: signed scoped capabilities, atomic claim/replay/ownership/revision tests require future persistence |
| Source tests | NOT_RUN: L/M/S/P tests inspected, no installation or remote production tests. Test names are source evidence only |
| Deployment verification | NOT_RUN: source versions do not establish active deployment; owner provides SHA/version evidence without customer data |
| Reviewer approval | PENDING: review audit, proposed ADR/interfaces and open gates before implementing M1b |

## Acceptance status overlay

Canonical `docs/technical/00`–`25`, including `20-acceptance-matrix.md`, remain byte-for-byte unchanged under the founder's preservation instruction and this request's no-rewrite restriction. This supplemental ledger records actual milestone status without changing historical canonical claims. The historical ACC-02 repo-access blocker is partly resolved: accessible source reviewed, but complete central validation/deployed configuration/reviewer gates remain blocked. No ACC row is promoted to PASSED by documentation or mock tests.

| Acceptance | Actual status for this audit |
|---|---|
| ACC-02 | IN_PROGRESS: client/bridge/SDK/authority source audit + threat model delivered; BLOCKED on secure trust remediation, deployment evidence and reviewer approval |
| ACC-03 | BLOCKED: live issuer/audience/logout/customer isolation tests not run |
| ACC-04 | NOT_RUN: guest claim design only |
| ACC-08 | BLOCKED: dedicated project not provisioned here |
| ACC-22 | NOT_RUN: proposed security tests, no VYNVORI auth implementation |
| ACC-24 | Existing M0 CI remains separate; no auth deployment/rollback drill |

## Checks and preservation

Only M1a documentation, ADR and required research pointer may be staged. No M0 code, root manifest/lockfile, approved asset, design/reference runtime, canonical chapter, existing proposed contract or CI workflow change. No migrations or API/event changes; signatures are nonexecutable proposals. Integrity, diff and secret checks are recorded after execution below; source test execution and live auth tests remain NOT_RUN. CI evidence must refer to the PR's exact commit and must not be described as production acceptance.

Executed locally on the unchanged M0 runtime with Node `22.23.3` / npm `10.9.9`:

| Check | Result |
|---|---|
| `npm run verify` | PASSED: lint, shared/web/reference typechecks, 7/7 M0 unit tests, 108/108 corrective and 104/104 legacy reference simulation checks, Next web build, reference integrity and security smoke |
| `npm run build` | PASSED: external-temp offline reference rebuild matches shipped bundle byte-for-byte |
| Protected bytes | PASSED: 202 protected files, 146 reference payloads, nine app asset/font/license copies; canonical chapters unchanged |
| Documentation links/fences | PASSED: six new Markdown documents, relative targets resolve and code fences balanced |
| Credential review | PASSED scoped review: no credential values, private source file copies, customer records, private art, JWTs or known key/token patterns in new documents. Not a comprehensive secret scanner |
| Git whitespace/scope | `git diff --check` passed before staging; final staged scope checked against explicit six-file allowlist |
| Fresh `npm ci` | NOT_RUN locally to preserve current dependencies; existing PR CI independently runs fresh npm ci and required full checks |
| Auth compatibility/security tests | NOT_RUN: no authentication implementation or live endpoint testing |

External build evidence: `%TEMP%/VYNVORI-M0-next-5XnaFq`; unchanged reference tests/build under `%TEMP%/VYNVORI-FINAL-runs/1792011590134-25220` and `1792012003414-27380`. These are local results, not auth/deployment acceptance. GitHub checks must be read after PR creation.

## Rollback and escalation

Documentation rollback is a normal revert of the M1a commit after review; no database or service rollback needed. Preserve source references and check evidence. Future M1b requires backup/restore and migration reversal/forward-fix plans, credential revocation/key rotation and feature-off operational rollback. Do not silently restore unsafe email linking as a fallback.

Founder/identity owner next action: approve a client/issuer-bound validation and refresh/revocation remedy, and confirm dedicated app trust policy against the audited Portal.Service source. No credentials are needed in chat. M2 must be separately authorized and completed before M1b. Stop at the M1a PR; no automatic merge, deployment, M1b or M2.
