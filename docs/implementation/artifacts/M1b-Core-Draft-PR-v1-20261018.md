Adds explicit server-owned provenance for the new strict OAuth cohort and removes credential-bearing diagnostic logging from the shared authorizer proxy. Existing legacy GET/POST success, consent, public 4xx and exception contracts retain the shared upstream. Draft source review only: no merge, release tag, registration, storage/config activation or deployment is authorized.

## Architecture decision and security
Use server enrollment and exact approved HTTPS web/API origins for strict clients. The browser cannot choose provenance or strict upstream. Reject hostile/missing POST Origin, duplicate query fields, unknown body parameters and supplied credentials/context. Disable redirects; unexpected strict responses are generic/no-store. Strict cookies cannot fall back to shared API_URL. Malformed strict settings preserve legacy response behavior.

Legacy calls send no usable strict provenance. Preserve the real consent POST shape, which may omit response_type; reject conflicting strict values. Diagnostic logs contain safe status events, without cookies, credential prefixes, payload/state or raw exceptions. No browser profile value supplies identity/roles.

Server-only settings: CORE_STRICT_OAUTH_CLIENT_IDS (empty/unset by default), CORE_STRICT_OAUTH_WEB_ORIGIN, CORE_STRICT_OAUTH_API_BASE_URL. No public variables, dependencies, schema/event/migration changes. Rollback: disable/deny the strict cohort without legacy fallback; keep the legacy shared API_URL unchanged.

## Scope, target and validation
Exactly three reviewed files: existing authorizer route, strict helper and 19 new proxy tests. Tested base: 2c7f0113dd0c2b1566ad88f69fb9a7cc675387fc. Live developmerger at publication: cb7668f4e770bc7b6a916b141e0766f2f4fbd011, 14 commits ahead with no authorizer, manifest/lock or Jest changes. Preserve the reviewed branch without rewriting its tested base; validation against current target remains a merge gate.

Fresh owner npm ci passed (Node 22.23.3/npm 10.9.9; independent dependencies). All 19 new proxy assertions pass. Full Core: 25 suites PASS / 2 FAIL; 176 assertions PASS / 22 FAIL. Baseline: 24 PASS / 2 FAIL suites; 157 PASS / 22 FAIL assertions. Every old assertion identity/status/count and exact failure identity is preserved. Existing failures are unresolved, not waived. Affected lint, source/lock hashes, staged allowlist, whitespace and patch checks pass.

Companion Portal: 281/281 OAuth assertions and three paired Core/Portal/MongoDB source-flow cases pass, including scoped current contact and central revocation. Next request/response context and transport routing are test adapters, not deployed/browser acceptance. Full consumer coverage, exact-head CI and deployed synthetic negatives remain open.

## Publication boundary
The checked-in pipeline builds/pushes images and deploys Kubernetes workloads. The review commit uses [skip ci] to prevent release execution for this source-only publication. No tags or remote job intentionally queued; no pipeline/policy weakened. No auto-complete.

Companion Portal draft: https://dev.azure.com/raum-au/mg23/_git/Portal.Service/pullrequest/137
This Core change alone does not implement VYNVORI sessions, guest ownership, commerce provisioning or complete M1b.
