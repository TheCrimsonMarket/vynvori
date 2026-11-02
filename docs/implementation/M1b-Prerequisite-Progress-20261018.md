# M1b prerequisite execution — 2026-10-18

## Verified local image result — 2026-10-19

Owner local image validation completed on 2026-10-19. Both network-disabled image probes PASS on Node 20.17.0; independently checked image IDs, revision labels, linux/amd64 platforms and private log hashes match the receipt. Core build exit is 0. Portal reused its verified completed image; the earlier runner did not capture its build exit. [Executed result](evidence/M1b-Local-Image-Validation-Result-20261019.json). No rerun is needed. Full application startup, deployed legacy compatibility and M1b acceptance remain unproven. Registry publication, release tags/pipelines, registration, storage/config changes and deployment remain blocked pending separate authorization.

Earlier preparation and recovery instructions below are historical; do not repeat the completed build batch.

## Source-only merges verified; build-only execution handed to owner (2026-10-19)

Portal `35a47c9d` and Core `30efb9e2` are merged into developmerger via approved no-fast-forward PR completion. Exact source trees and parent commits match the reviewed previews; source branches retained. The existing red test sets remain recorded and unwaived. The founder separately approved local owner-run image build/probe validation only. Script/probe syntax and read-only PowerShell preview passed; no image build or container probe was run by the agent. [Build review and owner command](M1b-Build-Only-Review-20261019.md), [preparation evidence](evidence/M1b-Build-Only-Preparation-20261018.json), [executed source merge evidence](evidence/M1b-Source-Merge-Result-20261018.json). Actual Node 20 runtime evidence and every deployed/M1b acceptance gate remain open. Earlier snapshots below are historical.

## Draft source publication completed

The founder approved dedicated commits/branch pushes and draft PRs only. Portal commit `b23f3d5c366438d056b0a68f91d303c395f7d0be` is [draft #137](https://dev.azure.com/raum-au/mg23/_git/Portal.Service/pullrequest/137); Core commit `0f875346466f9257ffa1fc7624ed76aba94fd1c3` is [draft #138](https://dev.azure.com/raum-au/mg23/_git/service.core-ui/pullrequest/138). Both target developmerger with exactly 24 / 3 reviewed paths and one commit. UI confirms Draft and no merge conflicts; auto-complete was not selected. Source parents/hashes and remote SHAs were verified. Browser publication followed founder sign-in after REST 401. No merge, release tag, registration, storage preparation or deployment was performed by the agent. Remote run state remains NOT_VERIFIED; no job intentionally queued. Existing failures and all M1b activation/acceptance gates remain open. [Publication receipt and screenshots](evidence/M1b-Draft-Publication-20261018.json).

## Latest v9 execution: fresh dependencies and scoped contact

Owner fresh npm ci completed in both isolated candidates using Node 22.23.3/npm 10.9.9. Source/lock hashes were unchanged and dependency directories are independent. Fresh v8 full suites preserved all prior assertions and failures. Portal v9 then added the approved central profile/email contract: 281 OAuth cases PASS; full suite 748 PASS / 19 FAIL in 114 PASS / 30 FAIL suites. Core fresh full suite: 176 PASS / 22 FAIL in 25 PASS / 2 FAIL suites. Exact failure identities and all earlier assertions remain unchanged. The 16 new passing cases cover contact scopes/current data/revocation/errors, strict server transport and the actual three-case Core/Portal/Mongo source integration. Affected lint and patch reverse checks pass. Owner-supplied development code uniqueness metadata satisfies that prerequisite; source auto-index defects remain unchanged. [Fresh evidence](evidence/M1b-Fresh-Validation-20261018.json), [contact contract](M1b-Strict-Contact-Contract-20261018.md), [current review](M1b-Central-Candidate-Review-20261018.md). Registration/deployment remain BLOCKED; VYNVORI bridge NOT_STARTED; M1b NOT_COMPLETE. Earlier snapshots below are historical.

## Continuing execution update

### Latest verified candidate

**Current authoritative source-pair receipt v8:** [central candidate review and owner actions](M1b-Central-Candidate-Review-20261018.md), [Portal receipt](evidence/M1b-Portal-Release-Candidate-20261018.json), [core receipt](evidence/M1b-Core-Proxy-Candidate-20261018.json). Portal now has **265 OAuth checks PASS**; full suite **732 PASS / 19 pre-existing FAIL**, with all old assertion identities/statuses/counts preserved and 145 added passing cases. Core's new proxy suite has **19 PASS**; full suite **176 PASS / 22 pre-existing FAIL**, with all original assertions preserved. Both candidates pass their added-file lint checks and scoped whitespace checks. No failed check was waived.

Core now has explicit server-owned strict enrollment, exact HTTPS origin/API target selection, browser-origin checks, caller-header override rejection, duplicate-query/body validation, strict no-redirect/no-store/sanitized-error handling, and credential-log redaction. Legacy success/consent/4xx/exception-response contracts are preserved, including malformed new enrollment settings. Original core source remains unchanged; the candidate is in its own worktree. Local review patches are durably retained under `artifacts/`, with SHA-256 and reverse applicability checks; isolated indexes contain intent-to-add entries only and no staged file contents.

The anonymous public dev `/mana/oauth/authorize` probe returned 404. A new default-off, strict-cohort-only public alias is implemented in the candidate, with a separate bounded JSON consent parser; legacy clients cannot use the alias. The actual core handler → Portal controller/service/model → local HTTP/MongoDB joint test passes, including the real consent DTO without POST `response_type` and persisted token-version revoke. Next context and upstream transport are test adapters; this is not deployed/browser acceptance.

Fresh automatic legacy model initialization exposed pre-existing boolean index directions rejected by MongoDB. The joint fixture explicitly disables that legacy auto-DDL, prepares valid unique client/code indexes, and does not claim the legacy defect was fixed. Strict runtime readiness now verifies existing authorization-code uniqueness read-only and rejects missing/sparse/partial constraints without repair. The founder has been asked for development index metadata; no legacy index migration has been executed.

Fresh `npm ci` is delegated to the owner by `D:\dev\raum\tcm\AGENTS.md`. The prepared owner-run script's read-only preview passes; a disposable Windows junction test proves entry removal preserves its target. Its install mode remains NOT_RUN. The original dependency directories are untouched. Build-to-image attestation remains pending after a registry metadata read returned 401; local tag agreement alone is not that attestation.

A [read-only Medusa 2.21.2 review](M1b-Medusa-Compatibility-Review-20261018.md) confirms the installed provider/workflow surfaces and an inert explicit-ID registration probe. It also confirms the stock account workflow requires contact email while the current strict identity candidate exposes none. The founder has been asked to choose scoped central `profile email` contact retrieval or a separate VYNVORI contact step. No email/registration policy or extra scope is inferred from silence. VYNVORI bridge implementation and all remote activation remain gated.

Older v5 and first-candidate observations below are historical snapshots superseded by this v8 source-pair summary.

**Latest v5 receipt:** the default-off runtime/bootstrap and strict prefix pre-parser are now wired locally in the isolated Portal release worktree. An absent/false `PORTAL_STRICT_OAUTH_ENABLED` performs no strict model lookup, creates no strict endpoint and retains the legacy authorization path. Invalid strict configuration fails strict requests closed while legacy routes remain usable. Explicit operator preparation of the two new strict collections/indexes is separate from startup/request handling; request paths never create/repair storage. Strict token endpoints and validated authorization requests obey the registered client's hourly rate budget; strict authorizer/token state is not cached.

The complete local HTTP/MongoDB fixture now verifies central refresh-session context → code → token exchange → introspection → refresh rotation → family revocation. The earlier global body-parser ordering issue is fixed with an enabled-only parser mounted on strict prefixes before shared parsers; a regression check proves the stricter body cap does not restrict legacy paths. Existing mixed line endings in `appService.ts` were preserved outside the four added lines; new files use CRLF. Whitespace verification treats CR at EOL as the existing Windows line-ending convention, without changing Git configuration.

Full v5 comparison: **113 suites PASS / 30 FAIL; 726 assertions PASS / 19 FAIL**, versus release baseline **102 PASS / 30 FAIL; 587 PASS / 19 FAIL**. All **259 OAuth tests across 23 suites pass**. Every pre-existing assertion's status/count and all failure identities are preserved; there are **139 additional passing assertions**. All added JavaScript/test files pass the existing ESLint configuration; affected source syntax checks pass. The five tracked files changed in this isolated worktree are `oauthController.js`, `oauthAuthorizationCodeModel.js`, `oauthRoutes.js`, `appService.ts`, and `oauthService.js` (42 added / 5 removed lines before new files). No tracked file in the original Portal checkout changed. This is bounded local evidence, not full release/deployed acceptance.

The core UI source remains unchanged. A focused source baseline at `2c7f0113dd0c2b1566ad88f69fb9a7cc675387fc` passes **4 suites / 36 tests** for OAuth intent/login/consent/iframe behavior. The next local slice is an isolated authorizer proxy-origin and credential-log change against this baseline. The proxy must send validated same-origin provenance for strict consent; without that change, the new strict guard intentionally denies that path. Its legacy behavior must be preserved and tested.

The earlier snapshots below remain historical. Use [the v5 receipt and exact candidate file hashes](evidence/M1b-Portal-Release-Candidate-20261018.json) and the `codex/m1b-portal-strict-identity` release worktree as the authoritative candidate. Untracked early helper copies in the original Portal checkout are historical local scratch, not the prepared release candidate. No tag, commit, push, live preparation, registration, secret generation, domain change or deployment has occurred.

After the founder requested resume, local work continued on branch `codex/m1b-portal-strict-identity` in the separate release worktree at source `e54028d0a3a9fa22fdac2acca1f84744df115225`. Three existing files there have a minimal additive patch: optional `strictContext` subdocument in the authorization-code model, an optional validated server context argument in code creation, and forwarding that argument from the two standard consent-controller paths. Legacy calls retain their exact record shape; browser body fields cannot supply the context. No existing file in the founder's original Portal checkout was modified.

The expanded candidate full suite, with disposable real MongoDB tests enabled, produced **110 suites PASS / 30 FAIL; 713 assertions PASS / 19 FAIL**. The release baseline was **102 suites PASS / 30 FAIL; 587 assertions PASS / 19 FAIL**. Failure identities are unchanged, and every baseline assertion was checked individually for preserved status/count; none was removed or weakened. The candidate adds **126 passing assertions**. Existing red tests still block a fully green release claim. Candidate syntax and Git whitespace checks pass. [Exact file hashes and comparison receipt](evidence/M1b-Portal-Release-Candidate-20261018.json).

The founder approved staging policy values: strict access tokens 300 seconds, family and application absolute lifetime 28,800 seconds, app idle limit 1,800 seconds, login transaction 600 seconds, no authorization cache (central recheck for every protected operation), and at most 96 refresh rotations. These limits apply only to the new strict staging integration. Approval selects policy; it does not activate registration, a secret, migration, domain or deployment. The separate truthful strict-revocation handling question remains pending unless subsequently answered explicitly.

The route registrar and authorization guard remain unmounted. Strict runtime/bootstrap configuration, readiness/rate-limit adapters and authorizer proxy-origin forwarding still need implementation before the prepared strict flow can run through Portal. Core UI source at `2c7f0113dd0c2b1566ad88f69fb9a7cc675387fc` was inspected read-only: its authorizer proxy already forwards both central cookies, but does not yet forward strict origin provenance and currently logs an auth-token prefix. This must be addressed with compatibility tests before strict activation. No core UI source was changed.

The local candidate now also includes an isolated strict-family MongoDB adapter, strict code/token issuance and one-use refresh/family revocation service, HTTP route registrar and authorization-session guard. These additions remain unmounted; existing tracked Portal code and live services are unchanged. Candidate API paths `/oauth/strict/v1/{token,introspect,revoke}` and `/mana/oauth/strict/v1/{token,introspect,revoke}` exist only in the new unmounted registrar; they are not deployed endpoint claims.

Executed evidence: 25 strict authority tests plus 12 persistence tests pass against disposable real MongoDB 7.0.14 with downloads disabled; 16 isolated HTTP boundary tests and 18 authorization guard tests pass. Coverage includes 100-way code/refresh races, persisted client/owner checks, late-write revocation fencing, central token-version changes, lost acknowledgements and replay, exact callback/S256/state binding, forged/stale central refresh cookies, strict browser credential rejection and sanitized failures. Explicit policy values in these tests are synthetic fixtures, not activation defaults or founder-approved operational policy.

Local release tag `V005.3258.000.000` points to `e54028d0a3a9fa22fdac2acca1f84744df115225`, one commit ahead of the preserved Portal checkout. Its audited OAuth files have no delta from the prior local pin. A detached verification worktree under `%TEMP%/VYNVORI-M1b-20261018/portal-release-e54028d0` uses that exact release source and existing dependencies through a junction; no package installation. Before candidate additions: 102 passed / 30 failed suites, 587 passed / 19 failed assertions. The nine-file strict candidate snapshot (before the latest authorization guard additions) produced 685 passed / 19 failed assertions with identical failed-suite/assertion identities. The final expanded candidate still needs its own complete rerun.

Founder-supplied dashboard/YAML metadata confirms `service-portal-0`, namespace `dev-raum-au`, image `cr.raum.au/service.portal:005.3258.000.000`, digest `sha256:22cb14daec819ab158c6dbf43325b83cff1d03f114eaf278ea41624a40a4bac7`, one ready replica and matching current/update revision `service-portal-68d4fd86dd`. The founder clarified that a nonzero final tag segment deploys only to development; a final `000` proceeds through development and production. Therefore a `.000` image in development is intentional. Tags/pushes are deployment actions and remain unauthorized here. The image-digest-to-source build attestation is still PENDING; local tag agreement alone does not prove it.

The strict authority now requires authorization-time issuer/client/audience/token-version context and checks persisted current subject tokenVersion for each access/refresh. Existing codes without this context fail closed. Authorization-controller/schema/bootstrap plumbing and central proxy-origin forwarding remain unfinished; no existing code is yet described as issuing strict codes. Existing core UI source confirms global sign-out calls `/mana/auth/revoke`; Portal's handler increments persisted tokenVersion. This is distinct from `/oauth/logout`, which only clears cookies. The strict implementation must report uncertain revocation truthfully and cannot infer global logout from cookie clearing.

One lint-fix command was not executed when automatic approval review hit a usage limit. After the founder requested resume, the same bounded action was retried through normal approval and succeeded; lint and all 16 HTTP checks passed. No approval bypass was used.

The original first-candidate snapshot below is retained as historical evidence; this continuing update describes current work and remaining gaps.

**M1b IN_PROGRESS at local authority prerequisites. VYNVORI bridge NOT_STARTED. Registration/deployment BLOCKED.** The founder authorized continued work toward complete M1b, requiring additive Portal enhancements and complete legacy support. This report supersedes the proposal's initial no-implementation observation only for the local candidate described below.

## Local changes and evidence

VYNVORI base: `262489d8a5c367e579839806d7e8554a394dcd2a`. Portal base: `dd6f673a11b2a2d34a688bb01729ea5a25f45d2e`. No commit/push performed. Portal's existing tracked files remain byte-for-byte unchanged (`git diff --exit-code` passed); exactly three untracked candidate files were added:

- `D:\dev\raum\tcm\Portal.Service\src\__tests__\oauth-legacy-compatibility.test.js`: ten characterization checks for existing token shape/lifetime, optional audience, issuer-less token acceptance, invalid-token rejection, reusable legacy refresh and single-record revoke.
- `D:\dev\raum\tcm\Portal.Service\src\__tests__\oauth-strict-access-verifier.test.js`: 35 strict verifier checks using real JWT signing/verification and synthetic/stubbed storage. Includes issuer/audience/client/type/time/algorithm/owner/enrollment/revocation/scopes and sanitized storage outages.
- `D:\dev\raum\tcm\Portal.Service\src\service\oauthStrictAccessVerifier.js`: isolated strict verifier factory. No route or existing auth implementation imports it; no existing token issuance or policy changed.

The strict tests initially failed because the implementation module did not exist; the legacy checks passed before implementation. All new checks passed after implementation. Existing Portal lint configuration passes on all three candidate files with Node/Jest environments. Files use CRLF as required by `D:\dev\raum\tcm\AGENTS.md`. No package installation performed; that AGENTS delegates installations to the user.

| Check | Baseline | Candidate |
|---|---|---|
| Portal OAuth suites | 12 suites / 120 tests PASS | 14 suites / 165 tests PASS |
| Portal full suite | 101 suites PASS, 30 FAIL; 568 assertions PASS, 19 FAIL | 103 suites PASS, 30 FAIL; 613 assertions PASS, 19 FAIL |
| Failed suite/assertion identities | Captured before edits | Exactly unchanged; no new failures in executed suite |
| Shared SDK local regression suite | Local SHA `f60bde771cd6274e89162e4089830cb0998b6207` | 21 suites / 45 tests PASS; published package provenance remains NOT_VERIFIED |
| Existing tracked Portal source | Clean | Unchanged |
| Live development public catalog | Founder supplied dev target | GET `https://dev.portal.raum.au/mana/oauth/catalog` returned 200 JSON; no login/token request |
| Deployed strict/auth/ownership/Medusa tests | NOT_RUN | NOT_RUN |

Full-suite failures include missing historical normalizer imports, stale Mongoose/service mocks, missing synthetic test configuration and pre-existing assertion mismatches. No unrelated fixes, skipped checks, baseline resets or security-policy exceptions were introduced. See the [sanitized receipt](evidence/M1b-Portal-Prerequisite-20261018.json) for failed-suite inventory and candidate hashes. Raw test receipts/logs remain under `%TEMP%/VYNVORI-M1b-20261018`.

## Source consumer inventory and limits

| Consumer found in local source | Contract to preserve | Evidence / coverage |
|---|---|---|
| `sdk/oauth-react` | Token exchange/refresh/revoke payloads, server/Next adapters, popup/redirect, cookie/session exports | SDK 45 checks PASS on local pin; package bytes and deployed callers unresolved |
| `medusa-lld/web` and `service.medusa` | Server central exchange, userinfo and customer bridge; service-token calls | M1a audited source; dependent-app suites NOT_RUN in this slice |
| `service.socialriddle` | SDK/browser callback, exchange/logout, userinfo scope contract | Local source references and Portal contract tests; consumer runtime NOT_RUN |
| `service.discordmanager` | SDK route-backed exchange and cookie sessions | Local source references; consumer runtime NOT_RUN |
| `service.megaphone` | Independent transaction/callback; service principal audience/scope validation | Local source references, Portal service audience tests; consumer runtime NOT_RUN |
| `service.connects` / connect-client | Client credentials and per-resource audience requests | Local provider source and Portal service grant/audience tests; consumer runtime NOT_RUN |
| `service.developers` and core hosting | Client creation, exact redirects, PKCE policy, iframe/browser login compatibility | Founder-confirmed UI location and local docs; UI/regression checks NOT_RUN |

This is a source-derived partial inventory, not a complete list of registered or deployed clients. Owner confirmation is required before release.

## Approved staging identifiers and operator action

The founder approved issuer `https://dev.portal.raum.au`, audience `urn:vynvori:staging` and callback `https://staging.vynvori.com/auth/tcm/callback`. The founder confirmed development web origin `https://dev.portal.raum.au` and API base with `/mana`; production uses `https://www.thecrimsonmarket.com`. New strict issuer semantics are a configuration decision, not proof existing tokens contain `iss`.

Vercel was inspected read-only. Current project `prj_oVLpUzXxfvnQOO5aqeUJw9FUE12Y`, team `team_1p91m25QbR1Mqu1N5F4Uhj1N`, includes public domains and `vynvori-dev.vercel.app`; latest ready main deployment is `dpl_FmuKFMFM7EjzrYbfEKPonKEpQ8bN`, source SHA equal to this VYNVORI base, target production. `staging.vynvori.com` is an approved target, not an attached domain observed here. Separate staging isolation remains to be provisioned after authorization.

The local Kubernetes CLI has no current context. The founder can inspect the online dashboard. Obtain only:

1. Select the Portal development cluster and namespace. Source pipeline names are `dev-raum-au` / StatefulSet `service-portal`; adjust if the actual dev deployment differs.
2. In the StatefulSet details or YAML, copy the `service-portal` container image from `spec.template.spec.containers[].image`.
3. Open a Pod owned by that StatefulSet. Copy `status.containerStatuses[].imageID` for the `service-portal` container, plus the Pod name. Do not export a full workload YAML or environment section.
4. In Azure DevOps, locate the successful build that produced that image tag/digest. Copy its full source commit SHA and build ID/URL. Portal's pipeline builds `cr.raum.au/service.portal:<version>` from tags; do not create/push a tag to obtain evidence.
5. Report those nonsecret values here. If the workload/build cannot be found, report the visible workload name/image and the gap; do not guess the source SHA from an image tag.

No domain, client registration, schema, deployment, IAM or production mutation was performed. No secret values were read. Registration/deployment still require separate authorization; credentials must be configured directly in the approved secret store when that stage arrives.

## Remaining M1b work

Authority strict issuance/validation transport, atomic rotation and family revocation, explicit enrollment and policy review remain unfinished. The isolated verifier does not close those gates. Deployed provenance and dependent-service coverage are outstanding. No new endpoint is claimed to exist.

After central trust gates close, implement/review VYNVORI's durable profile/session/transaction/provisioning/guest schema and scoped grants; Medusa provider and idempotent workflow; server-only IAM/token transport and vault; callback, refresh/logout and account/guest ownership paths. Execute AUTH-01–23, real synthetic database/Medusa isolation/failure tests, CI and approved staging acceptance. No canonical acceptance row is promoted by this local candidate. See [ADR-0009](ADR-0009-M1b-Strict-Identity-and-Legacy-Isolation.md).

M2 exception expiry remains 25 October 2026, 05:59:59 Bangladesh time; no renewal or automatic shutdown has been created.
