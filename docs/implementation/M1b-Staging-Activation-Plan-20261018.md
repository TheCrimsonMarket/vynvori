# M1b staging activation plan

## Verified local image result — 2026-10-19

Owner local image validation completed on 2026-10-19. Both network-disabled image probes PASS on Node 20.17.0; independently checked image IDs, revision labels, linux/amd64 platforms and private log hashes match the receipt. Core build exit is 0. Portal reused its verified completed image; the earlier runner did not capture its build exit. [Executed result](evidence/M1b-Local-Image-Validation-Result-20261019.json). No rerun is needed. Full application startup, deployed legacy compatibility and M1b acceptance remain unproven. Registry publication, release tags/pipelines, registration, storage/config changes and deployment remain blocked pending separate authorization.

Earlier preparation and recovery instructions below are historical; do not repeat the completed build batch.

2026-10-18, Asia/Dhaka. **SOURCE-ONLY MERGES COMPLETE; LOCAL OWNER-RUN IMAGE PROBES COMPLETED 2026-10-19.** The founder separately authorized the merges and local build/probe scope. This authorizes no image push, Git release tag, pipeline, registration, storage/config mutation, new live credentials, IAM, domains or deployment. M1b remains incomplete.

## Approved source and newly prepared follow-up

| Component | Reviewed source | Current target / evidence |
|---|---|---|
| Portal draft #137 | `b23f3d5c366438d056b0a68f91d303c395f7d0be`, parent `e54028d0a3a9fa22fdac2acca1f84744df115225` | Live developmerger equals the reviewed parent; 281 OAuth assertions pass; fresh full suite preserves existing 30 failed suites / 19 failed assertions |
| Core draft #138 | `0f875346466f9257ffa1fc7624ed76aba94fd1c3`, parent `2c7f0113dd0c2b1566ad88f69fb9a7cc675387fc` | Live developmerger `cb7668f4e770bc7b6a916b141e0766f2f4fbd011`; disposable target comparison completed below |
| Core build-log follow-up | **Separately approved and published** | [Exact two-line Dockerfile deletion](artifacts/M1b-Core-Build-Log-Sanitization-20261018.patch): remove environment-file heading and `cat`; retain file selection/copy/removal and runtime configuration behavior |

Core current-target baseline: 27 suites PASS / 2 FAIL; 165 assertions PASS / 22 FAIL. Applying the exact reviewed three-file patch: 28 suites PASS / 2 FAIL; 184 assertions PASS / 22 FAIL. All target baseline assertion identities/statuses/counts and exact failures are preserved. Manifests/lock and the three reviewed source bytes match the sealed candidate; dependencies reuse the owner's fresh independent install. During that comparison no dependency installation, remote merge, branch rewrite or deployment occurred. Subsequent source-only merges are recorded in the [merge receipt](evidence/M1b-Source-Merge-Result-20261018.json). [Exact target receipt](evidence/M1b-Core-Current-Target-Validation-20261018.json).

Both Dockerfiles specify Node `20.17.0`; local unit/integration evidence used Node `22.23.3`. Bounded Node 20.17.0 image probes passed; full application/runtime compatibility remains NOT_RUN. The Core Dockerfile environment-file printing was removed by the separately approved two-line follow-up, now included in merged source `30efb9e2`. This patch does not remove the runtime environment file or change public/private variable semantics.

## Sequential execution and permission boundaries

| Stage | Concrete action / executor | Required evidence before moving on | Current status |
|---|---|---|---|
| A: source follow-up | Founder approved the exact two-line patch; commit/push to existing Core draft completed; source hashes and staged patch verified | Only Dockerfile logging removed; all three reviewed auth files remain byte-identical; no release tag or build queued | Published to #138 as `422095fc`; no build |
| B: source-only merges | Separately authorize PR #137 at b23f3d5c and #138 at 422095fc into their pinned developmerger targets; preserve all reviewed commits and required policies | Exact allowlisted merge previews and live ref rechecks; no image/deployment job queued; final merged tree must equal preview | COMPLETE: Portal 35a47c9d / Core 30efb9e2; exact trees/parents verified, branches retained |
| C: build preparation / build only | Against the exact resulting merged source pins, prepare isolated credential-safe contexts and owner-run commands; owner performs dependency-consuming builds under the parent AGENTS install rule only after separate approval | Build logs sanitized; image digests/source SHAs and actual Node/runtime recorded; strict-off legacy bootstrap and strict synthetic checks in the image | COMPLETE for bounded local image probes only; Portal prior build exit unknown, Core build exit 0. [Review and prepared script](M1b-Build-Only-Review-20261019.md); no release tag/pipeline |
| D: strict-off dev rollout | Separately authorize exact validated merged source/images and development config/workloads; obey all gates, with no bypass or inferred failure waiver | Current target/source verification, image/runtime checks, legacy consumer baseline, rollback images and workload/config inventory | BLOCKED; source-only merge/local build approvals do not authorize dev deployment |
| E: strict registration/storage/config | Separately authorize one dedicated staging client, additive storage, private secret custody and cohort configuration | Backup/preflight; exact client ID; no legacy client edit; strict storage readiness; exact dev issuer/web/API and workload bindings | BLOCKED; registration/config proposals below |
| F: central synthetic acceptance | Execute synthetic-only authority/consent/token/profile/revocation/legacy compatibility checks on the approved dev deployment | Executed positive/negative evidence, no secret/customer artifacts, precise source/image/config receipt and rollback drill | NOT_RUN |
| G: VYNVORI bridge / isolated staging | Implement locally with synthetic adapters using the audited Lucky pattern; enable only after central gates close. Separately provision the isolated web origin/domain/grants | Source/schema review, fault/replay/concurrency and A/B isolation tests, exact-head CI and actual staging acceptance | LOCAL_IMPLEMENTATION_IN_PROGRESS; staging NOT_RUN |

This sequence is not blanket authorization. Existing full-suite failures remain visible and unresolved; founder source approval does not waive them or mark a milestone acceptance row passed. Review relevant failures and required policies before a merge/release decision. The tag-triggered pipelines build/push images and deploy workloads; a Git release tag is an operational action, including a nonzero development suffix. No tag value is reserved by this plan.

## Dedicated strict client proposal (not a registration)

| Field | Proposed or already approved value |
|---|---|
| Name / owner | Dedicated VYNVORI staging interactive client; identity owner supplies/uses the authenticated development developer account |
| Client ID | Unassigned; use native registration output, not an invented identifier |
| Issuer / central web | Approved `https://dev.portal.raum.au` |
| Central API base | `https://dev.portal.raum.au/mana` |
| Audience | Approved `urn:vynvori:staging`; trusted strict enrollment supplies it without modifying legacy registrations |
| Exact callback | Approved `https://staging.vynvori.com/auth/tcm/callback` |
| Grants / scopes / PKCE | Exactly `authorization_code` + `refresh_token`; approved `profile email`; `required_s256` |
| Providers | Proposal: credentials only for initial synthetic checks; expansion requires reviewed central provider policy |
| Rate limit | Proposal: explicitly retain the model's existing 1000 requests/hour for this new client; operational approval still required |
| Webhooks | Disabled; no webhook execution authorized |
| Client/signing secrets | Native registration/private vault custody plus a separate strict signing-key reference; no values in chat, screenshots, source, public env or logs; never distribute Portal's existing refresh key |
| Lifetimes | Approved access 300s; family/app absolute 28800s; app idle 1800s; login transaction 600s; maximum 96 rotations; no authorization cache |

The current authority's reviewed unknown-outcome response requires reauthentication and does not claim a successful revoke from cookie clearing. Future VYNVORI logout UX/persistence must implement and test truthful local/central outcomes. Central profile email remains mutable contact data; missing/conflicting email must block commerce mapping without placeholders or email-based linking.

## Storage and configuration bounds

Before any Mongo write, the owner must privately establish that the selected connection is the database actually used by Portal development. The name `portaldb` alone is not independent environment proof. Obtain a usable backup/restore receipt and read-only metadata preflight; never send connection strings, documents or credentials.

Only two new strict collections are proposed: `oauth_strict_families_v1` and `oauth_strict_rate_windows_v1`. The reviewed operator function requires the exact database name plus additive acknowledgement. Required family indexes are unique authorizationCodeId, unique (clientId,currentRefreshHash), unique (clientId,currentAccessHash), and nonunique (clientId,spentRefreshHashes); normal `_id` constraints apply. Inspect existing collection/index ownership first; fail on conflicts instead of dropping, rebuilding or weakening anything. Existing full code uniqueness is supported by the owner metadata. The legacy invalid boolean compound-index source declarations are unchanged and are not repaired by this plan.

Portal remains `PORTAL_STRICT_OAUTH_ENABLED=false` until the dedicated registration, keys and storage are ready and activation is separately approved. Its versioned config pins the approved web origin plus the assigned client ID, issuer, audience, callback and lifetime/rotation values. Core remains an empty/unset strict enrollment list until its exact server-side web/API bindings are ready. No public-prefixed secret variables or legacy shared API_URL change is proposed. Current VYNVORI public Vercel project is shared with public domains, so it is not accepted as isolated staging evidence; no domain/project change is authorized now.

## Acceptance checks and rollback

On synthetic identities only, verify consent with the real Core DTO; exact callback/state/S256; wrong issuer/audience/client/type/signature; missing granted email scope; changed contact without identity relinking; missing/conflicting contact; client disable; central token-version revoke; expired access/family; one-use code/refresh; race, replay and lost-response fencing; authenticated scoped revoke; no browser token RPC; bounded parsers/no-store/sanitized failures and rate limits. Preserve representative existing interactive/service OAuth consumers, their legacy response contracts and active sessions. Source fixtures do not substitute for these deployed checks.

Before a development rollout, record both current workload specs/config references and immutable images. Portal owner-supplied rollback image is `cr.raum.au/service.portal@sha256:22cb14daec819ab158c6dbf43325b83cff1d03f114eaf278ea41624a40a4bac7`, source `e54028d0a3a9fa22fdac2acca1f84744df115225`; verify it is still current immediately before use. Core owner metadata now supplies `cr.raum.au/core.ui:015.375.000.000` / `sha256:4c9c6e031d86a061fe29bb9655a6f88b5f761a80987a71842073449dcde53e44`; ready=true, zero restarts. Live tag `V015.375.000.000` maps to `cb7668f4`, exactly the target tested locally. [Rollback metadata](evidence/M1b-Core-Development-Rollback-20261018.json). Build URL/independent build-to-image attestation remains unavailable; no further owner source-SHA query is needed for the live tag. The checked-in pipeline names namespace `dev-raum-au`, Portal workload `service-portal`, and Core `service-ui-diablo`; these are source configuration, not independently verified live inventory.

If strict validation fails, disable/deny the dedicated strict client/cohort, preserve family lineage, and revert the development image/config to verified prior receipts if needed. Never route failed strict requests through legacy verification, change existing client credentials/grants or drop legacy indexes. New strict collections are retained for reconciliation until an explicit retention decision; no destructive cleanup is part of rollback. Deployed rollback testing remains NOT_RUN.

## Next owner action

The approved local image probes are complete; no rerun is needed. The projected client inventory is received: 19 active registrations. Development connection binding is owner-confirmed and the owner can execute tests. Follow the [baseline smoke checklist](M1b-Owner-Legacy-Smoke-Checklist-20261019.md); consumer locations and results are pending. The [development rollout readiness proposal](M1b-Development-Rollout-Readiness-20261019.md) records the remaining consumer coverage, configuration and artifact publication gates. Keep raw logs/images/private configuration local. No image push, Git tag, release pipeline, registration, storage/config change or deployment is authorized.
