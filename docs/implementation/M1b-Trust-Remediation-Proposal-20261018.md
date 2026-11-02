# M1b central trust remediation — owner review

**Execution update:** the founder subsequently authorized continued local work toward complete M1b and approved the staging issuer/audience/callback identifiers. Local Portal prerequisites are IN_PROGRESS; VYNVORI bridge implementation has not started. Registration/deployment remain BLOCKED. [Current execution/evidence](M1b-Prerequisite-Progress-20261018.md), [ADR-0009](ADR-0009-M1b-Strict-Identity-and-Legacy-Isolation.md). The initial proposal-only restrictions and observations below are historical where superseded by that explicit mandate; legacy compatibility requirements remain binding.

2026-10-18, Asia/Dhaka. **REMEDIATION DIRECTION AND LEGACY COMPATIBILITY REQUIREMENTS APPROVED. M1b implementation NOT_STARTED. Registration and deployment BLOCKED.** After requiring additive enhancements, complete legacy support and no regressions for dependent services, the founder approved the updated proposal in this chat ("that I approve"). This records approval of the direction and release requirements; exact trust configuration, central-source implementation scope and operational actions are not approved by this record. The earlier registration/deployment block remains in force. No new client, migration, credential, live login or service activation is authorized here.

## Verified baseline

- Starting/current VYNVORI HEAD: `262489d8a5c367e579839806d7e8554a394dcd2a`, clean `main`, equal to freshly fetched `origin/main`. Existing branches, root package/lockfile, test inventory, retained reference tree and canonical master/authentication chapters inspected.
- [PR #8](https://github.com/TheCrimsonMarket/vynvori/pull/8) is MERGED. Final head `5a343bc9255a0a6001e5c393521139cc7cfa90b3`; merge `94d1a3615fd2f7e1b4dc1b7a8ef44ee7eb89a018` is an ancestor of current HEAD. Final-head verify, foundation, local-container, browser and Vercel contexts all SUCCESS. Subsequent main change is PR #9, acceptance integrity across checkout line endings. This verifies M2 publication; it does not verify live auth.
- Read [M1a audit](M1a-auth-source-audit.md), [threat model](M1a-identity-threat-model.md), [bridge contract](M1a-bridge-integration-contract.md), [open gates](M1a-open-gates.md), [canonical source pointer](../technical/research/lucky-little-devil-auth-audit.md) and [M2 handoff](M2-to-M1b-Handoff-20261018.md).
- Fresh authenticated GitHub default-main pointers: LuckyLittleDevil `d1b8e13c1334faa85f019204f12daea3d1ee0ca3`; Medusa `0babd565fa94f0771a18a89e2fd117a7b68ade3d`; oauth-react `de3252ef8f3c31b54c49101c62af2d93aa5bae12`. Lucky's nine-file delta since the M1a pin concerns brand media/build/layout; no audited auth file changed. Medusa and SDK pins are unchanged. These are source pointers, not deployment attestations.
- Founder-identified local `D:\dev\raum\tcm\Portal.Service` is clean at `dd6f673a11b2a2d34a688bb01729ea5a25f45d2e`. Read-only comparison against M1a pin `3e91f57f9755be269cf13f718126a4abef620eb1` and focused source inspection performed. This is a local source snapshot; remote default branch and deployed revision are NOT_VERIFIED.

## Refreshed central-source findings

Paths below are relative to that Portal.Service checkout at the current pin. No environment values or database/client records were read.

| Finding | Current source evidence | Gate |
|---|---|---|
| Human access token has `sub`, `client_id`, optional `aud`, type and jti, but no `iss` | `src/service/oauthService.js:592–609`, `createAccessToken` | BLOCKED |
| Verification checks JWT signature/time, access-token type and persisted token validity; no expected issuer/audience/client or current client-active check | `src/service/oauthService.js:844–867`, `verifyAccessToken` | BLOCKED |
| Userinfo uses that verifier then returns scoped profile; it does not enforce the requesting product/client boundary | `src/controllers/oauthController.js:1225–1256` | BLOCKED |
| Refresh validates matching active interactive client and scopes, then marks use and issues tokens; old refresh token is not atomically consumed | `src/service/oauthService.js:772–805`; `src/models/oauthRefreshTokenModel.js:62–76` | BLOCKED |
| Revoke authenticates client but does not pass its identity to token revocation; revocation changes one record without family cascade; controller ignores service result | `src/controllers/oauthController.js:1165–1179`; `src/service/oauthService.js:812–837` | BLOCKED |

The controller, refresh model and OAuth routes have no delta from the M1a pin. Changes in oauthService concern membership data and formatting, not these trust controls. These findings reconfirm blockers through source inspection; exploit, integration and deployed-auth tests remain NOT_RUN.

## Founder-required legacy compatibility

The founder requires any Portal change to be an additive enhancement with complete legacy support and no regressions for dependent services. This is a release-blocking requirement. Existing clients are not implicitly migrated to stricter policy.

- Inventory dependent clients/services and their supported flows before implementation, including interactive OAuth, service grants, SDK consumers, route aliases and browser sessions. Unknown consumers or undocumented behavior remain unresolved compatibility gates.
- Preserve existing endpoint contracts, request/response and error shapes, claims, scopes, redirect rules, cookies, token lifetimes, refresh/revoke behavior and existing valid tokens for legacy clients. Do not globally require issuer/audience claims on previously issued legacy tokens, rotate shared signing keys, or enable one-use refresh/family revocation across legacy clients as part of VYNVORI work.
- Prefer a separate additive validation contract and explicit server-controlled client policy for new guarantees. Default existing registrations to legacy behavior; enable strict validation/rotation/revocation only for a separately approved client cohort. A caller cannot select legacy mode for a strict client. Missing or invalid strict policy fails closed for that client.
- Keep VYNVORI's strict contract mandatory: legacy support cannot become a fallback accepting unbound identity in VYNVORI. Any shared security change that alters legacy behavior requires a separate impact review and authorization; do not silently bundle it into this enhancement.
- Use additive optional schema fields/indexes with reviewed defaults and backup/forward-fix plans. Preserve old records and verify both old/new application versions can safely use the resulting schema during rollback.
- Capture existing behavior before changing code, using sanitized synthetic fixtures and existing consumer contract suites. Compare the baseline and candidate across supported flows, including still-valid pre-change tokens, refresh/revoke, code replay, failures, concurrency, service grants, SDK parsing and cookie/callback handling. Existing suites alone do not establish complete consumer coverage.
- Require all inventoried dependent services' compatibility evidence, strict-client negative tests, full affected regression checks and exact-head CI before a separately approved rollout. Missing coverage, changed legacy behavior or any regression blocks release. No-regression is a requirement to demonstrate, not a guarantee inferred from code review.
- Prepare independently reversible client activation and application rollback. Disable new-client activation on regression; keep strict clients denied while disabled rather than reverting them to legacy validation. Verify legacy consumers continue operating and retain migration/token lineage evidence.

## Proposed owner decisions

The recommended direction is authority-owned validation for a dedicated VYNVORI staging client, retaining central login and exact `(issuer, subject)` identity. No issuer, registration value or API endpoint is assigned by this proposal.

| Decision | Recommendation for review | Required owner evidence |
|---|---|---|
| Authority namespace | Choose one stable, exact issuer namespace for strict clients; authority stamps and verifies it. Keep subject immutable. Preserve legacy token issuance and acceptance | Approved issuer plus ownership, source contract and deployment provenance |
| Product/client validation | Authority validates expected client and audience against signed claims, persisted token and active client policy; bind validation to authenticated VYNVORI server identity | Approved client/audience contract and wrong-client/product rejection evidence |
| Validation transport | Prefer a separate additive authority-owned server validation contract returning validated identity/binding/expiry/revocation context. Preserve legacy userinfo behavior; select path/schema separately | Reviewed request/response/error schema and server authentication policy. No invented endpoint or OIDC/JWKS claim |
| Staging registration | Dedicated confidential interactive client, exact approved HTTPS callback, S256 PKCE and least scopes. Isolate staging from production; no wildcard Preview callbacks or Lucky client reuse | Nonsecret client ID, audience/product, callback, web/API origins, allowed grants/scopes and registration receipt |
| Refresh | Atomic one-use rotation, family lineage and replay policy for explicitly enabled strict clients; fence concurrent use. Preserve legacy refresh behavior. Unknown strict outcome requires reconciliation or reauthentication | Approved family/reuse policy and concurrency/lost-response tests, plus legacy regression evidence |
| Revocation | For the strict contract, enforce authenticated client ownership and define access/refresh family revocation and global logout separately. Preserve legacy contracts; distinguish internal failures from successful cleanup without disclosing token existence | Approved semantics, propagation SLA and deployed negative tests, plus legacy regression evidence |
| Local sessions | Opaque host-only secure cookie, durable active/revoked session store, encrypted server credential references, fenced refresh and no-store private responses | Approved absolute/inactivity/transaction TTL, skew, revocation SLA, key custody and rotation policy |
| Staff | Keep customer identity separate from staff grants and Medusa Admin. Deny staff access until its authority/freshness policy is approved | Named grant authority, permission model, revoke/step-up policy and provenance |

An audience claim alone does not close the gate: the trusted authority must enforce the expected client/product and return verifiable binding context. VYNVORI must not decode an unverified token, invent an issuer from a hostname, share the central symmetric signing key or brand the existing userinfo result as fully verified identity.

## Bounded remediation sequence

1. **Owner review, no execution:** approve the direction and supply the nonsecret trust/registration/deployment evidence above. Confirm authorization and review ownership for any central-source changes separately. No registration or deployment proceeds under this proposal.
2. **Separately authorized authority change:** complete the dependent-service inventory and baseline compatibility evidence first. Review additive API/schema and explicit client policy; implement strict-client issuer/client/audience/active-client validation, atomic rotation and scoped revocation with synthetic tests. Meet every founder-required legacy compatibility gate above, never a VYNVORI fallback accepting unbound tokens. Review data backup, indexes and additive migration/forward-fix plan before any database mutation.
3. **Separately authorized staging registration/deployment:** use approved exact values and secret-manager references. Establish immutable source/artifact/deployed revision correspondence and trusted ingress. Test only synthetic accounts against the approved target; retain sanitized receipts. Do not infer deployment from a source commit.
4. **Gate review before bridge implementation:** owner/reviewer accepts the central contract and executed negative evidence. Recheck M2 installed Medusa `2.21.2`, server IAM transport/token lifecycle and staging expiry; M1a's older `2.15.5` observations are not a compatibility certificate. Prepare VYNVORI/Medusa interfaces, scoped schema/grants, ADR and rollback for separate review.
5. **Authorized M1b implementation:** follow the existing bridge contract for profiles, immutable identity mapping, idempotent Medusa provisioning/reconciliation, durable sessions, guest claims and ownership. No email linking or Admin-token substitution. New executable code requires its own review/security gate; M2's exact-tree exception does not cover it.

## Evidence required to close the trust gate

- Strict-client authority source tests: missing/wrong issuer, wrong/missing audience, wrong client/product, inactive client, bad signature/type, expired/revoked token and persisted-record mismatch all fail closed. Valid synthetic identity succeeds only for its approved binding. Prove strict clients cannot downgrade to legacy policy; separately demonstrate preserved legacy contracts and pre-change token support across the dependent-service inventory.
- Rotation/revocation tests: parallel refresh has one effect; old-token replay follows approved family policy; lost response cannot trigger blind retry; cross-client revoke fails; central outage does not yield false global-logout confirmation. Run AUTH-01/02/15/16/21/23 from the M1a threat model as applicable.
- Registration/deployment receipt: exact source/artifact/revision, sanitized configuration metadata, exact callback/client/audience, secret references without values, TLS/ingress evidence and approved synthetic test identities. No customer records or raw bearer tokens in logs/evidence.
- Before M1b acceptance: execute the full AUTH-01–23 coverage as applicable, including first-login crash/race recovery, callback/CSRF/replay binding, local logout/refresh fencing, customer A/B isolation, staff denial and guest editing while auth is unavailable. Compile-time brands and mocks alone do not close runtime gates.
- Record tests against exact source/deployed pins. Fresh install, affected lint/typecheck/unit/integration checks and green exact-head CI are required for executable changes. Every unexecuted check stays NOT_RUN.

## Rollback and operational boundaries

No runtime rollback is needed for this proposal. Removing this new document reverses the local change; historical M1a/canonical documents remain intact.

For any future authorized authority rollout, first capture recoverable data/config backups and existing-client compatibility evidence. Roll back or disable VYNVORI integration independently; invalidate its credentials/sessions according to approved policy. Preserve token lineage, mappings and reconciliation records; no destructive down migration or unsafe email-link fallback. Verify existing central clients remain operational without weakening VYNVORI validation.

All auth/financial/printing/publication operational gates remain OFF. M2 synthetic infrastructure PASS is unchanged. Central trust/registration/deployment gates remain BLOCKED; ACC customer-auth/ownership gates are not promoted. Canonical chapters and acceptance matrix are preserved byte-for-byte.

The M2 exception expires **25 October 2026, 05:59:59 Bangladesh time** (`2026-10-24T23:59:59Z`); operator stop/revocation remains required. This proposal neither renews that exception nor authorizes live staging use.

## Review result and next action

Read-only GitHub/source checks above executed successfully after retrying restricted network access through the authorized CLI path. No auth test, credential read, live auth call, install, migration, registration, deployment, commit or push was performed. Documentation validation is recorded in the session response.

**Exactly one next action:** prepare the bounded central-source implementation scope, starting with the dependent-service inventory and baseline compatibility coverage, for review against the approved requirements. Exact trust contract/policies and nonsecret registration/deployed-evidence references remain outstanding. Bridge implementation remains blocked until its required gates close.
