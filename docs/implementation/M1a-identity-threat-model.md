# M1a — Identity threat model

Date: 2026-10-15. Status: design review; every proposed security acceptance test below is **NOT_RUN**. Source keys L/M/S/P refer to exact commits in [source audit](M1a-auth-source-audit.md). Findings are code observations and risk assessments; no attack was performed against live services.

## Trust boundaries

Untrusted browser, callback parameters, return paths, message events and resource IDs → VYNVORI BFF → configured central identity authority → VYNVORI profile/session DB → dedicated Medusa customer provider → customer Store API. Staff authorization and Admin API form separate boundaries. Publishable keys establish store context, never account ownership. Guest capabilities grant only explicit draft/asset scopes. Signed cookies do not establish current session activity by themselves.

## Priority source findings and reuse blockers

| ID / priority | Evidence and scope | Required mitigation |
|---|---|---|
| ID-01 / high | M `exchange.ts:80–120` links email matches with empty identity metadata; tests explicitly endorse this case. Account takeover risk depends on authority/account history; exploit not executed. Violates VYNVORI's no-email-proof rule regardless. | Never auto-link by email. Unique verified issuer+subject/customer mapping; conflicts require controlled proof/migration and audit. |
| ID-02 / high | L alternate oauth-exchange + S `createTcmOAuthExchangeRoute.ts:82–165` accept caller-supplied state/verifier, without local signed transaction-cookie or origin binding. Login CSRF/session substitution risk if the authority accepts a valid attacker transaction. | One server-bound initiation/callback path; atomic consumed nonce, matching browser transaction, strict origin, redirect/client binding. Do not expose the generic JSON exchange unchanged. |
| ID-03 / high | L `session.ts:51–124`, `ownerAccountSession.ts:149–184` accept copied signed cookie without live session-record check; logout deletes record but cookie remains cryptographically valid. Central expiry only checked if numeric. | Opaque product-local cookie + active persistent session record, required finite expiries, central freshness/revocation policy. Revoke locally before remote cleanup; enforce at every sensitive operation. |
| ID-04 / high | M `service.ts:159–235` trusts userinfo, provider identity keyed only by sub. P `oauthService.js:590–605,838–862` mints no iss and verifies no audience/client binding at userinfo. Signature/type/database revocation checks exist. | Establish approved issuer namespace and product-bound validation contract; change authority/bridge in separately authorized implementation if required. Configuration alone does not prove missing checks. Wrong-product central token rejected. |
| ID-05 / high | M provider retrieve/create and `exchange.ts:80–142` split customer and AuthIdentity writes; L Firestore user/counter writes also nontransactional. Duplicate/orphan/link races not proven safe. | Dedicated service uniqueness, transactional workflow/locks + durable provisioning record; uncertain writes reconciled by immutable identity key, no email retry lookup. |
| ID-06 / high | L `terminateAuthSession.ts:19–45` best-effort cleanup; no access/commerce JWT revocation shown. `authSessionStore.ts:208–216` merge-set cache may recreate record after deletion; renewal lease has no fencing generation. | Durable revocation tombstone/session generation, conditional cache/refresh updates, token TTL/revocation contract, retry journal for cleanup. Prevent late writers from restoring authorization. |
| ID-07 / medium | L `session.ts:81–95` stores central bearer in signed browser JWT (readable payload); refresh token is encrypted server-side. | Server-only token vault; opaque session handle, minimal nonsecret account DTO; never bearer in HTML/browser storage/cookie payload. |
| ID-08 / medium | L `tcmOAuthTransaction.ts:42–51` string return-path checks, callback constructs URL. Backslash/control/encoded variants require URL normalization tests; redirect exploit not executed. | Parse against fixed approved app origin, reject ambiguous input, enforce route allowlist, discard auth/callback loops and secrets in query. |
| ID-09 / medium | L admin-only CSRF guard; L refresh exports GET with side effects; SDK logout/exchange do not visibly perform origin checks. | Require POST + strict origin/CSRF for cookie mutations, including claims/refresh/logout. SameSite alone is insufficient for sibling domains. |
| ID-10 / medium | L renewal preserves roles; owner view reloads current roles but low-level session consumers can retain cookie claims. M service logs subject/email/Google ID and upstream errors. | Fresh staff authorization by product role/version; redact PII and upstream bodies, use opaque correlation IDs. Inventory all privileged callers. |
| ID-11 / conditional high | L `src/server/middleware/auth.ts:14–42` contains a literal verification secret. Its call-site reachability/deployment is **NOT_VERIFIED**; literal is intentionally omitted. | Do not reuse; determine reachability privately and rotate if deployed. Audit secure secret sourcing. No claim of an exploitable live endpoint. |
| ID-12 / medium | L message receiver `TcmAuthFlowProvider.tsx:240–255` checks origin only; callback postMessage is same-origin. | Bind event.source and active transaction, validate DTO, re-read server session after completion. UI message never grants permissions. |
| ID-13 / high | P `oauthService.js:766–832` refresh leaves old refresh valid, while revoke selects token without client ownership or family cascade; controller `1136–1179` ignores service failure. L best-effort old-token revoke is not central replay/family protection. | Approved client-bound refresh rotation/reuse and token-family revocation semantics, atomic claims and honest uncertain outcome reporting; no blind retry. |
| ID-14 / conditional high | P `appService.ts:101–107` literal placeholder express-session secret, implicit store/lifetime/SameSite; deployed session usage/overrides not proven. | Central owner reviews actual session store/secret/attributes and rotation; VYNVORI never shares those cookies/keys. Literal omitted. |

## Required negative and recovery acceptance matrix

All outcomes below are M1b/M2 test requirements, not current VYNVORI behavior. Tests use synthetic identities and dedicated staging fixtures; no copied customer data.

| Test | Threat / input | Required measurable outcome |
|---|---|---|
| AUTH-01 | Tampered signature, unsupported algorithm, forged userinfo, token substitution | 401; no profile/customer/session mutation and no protected data |
| AUTH-02 | Wrong issuer, audience, client/resource or product; same subject under two issuers | Reject wrong trust; distinct qualified identities remain distinct; no cross-project Medusa call |
| AUTH-03 | Expired/not-yet-valid/revoked token; missing/malformed expiry; old cookie after logout | Deny; clear appropriate local session; no bearer/exchange access after revocation |
| AUTH-04 | Missing/mismatched state, attacker-owned valid code/verifier, changed callback/redirect | No session issued; existing session unchanged; consumed transaction cannot replay |
| AUTH-05 | Replay callback concurrently across instances | At most one transaction success; stable recovery result; one profile/mapping business effect |
| AUTH-06 | Session fixation; pre-login handle reused after login/account switch | Rotate handle; old guest/auth handle cannot authorize new owner's resources |
| AUTH-07 | Sibling origin cookie POST, absent origin, malformed/duplicate origin, untrusted forwarded host | Reject browser mutations; no cookie forwarded to unapproved origin; approved service auth separate |
| AUTH-08 | Email equality/change/recycled address, missing email, Google legacy match | Never ownership proof; existing subject keeps identity; commerce contact requirement explicitly handled without linking |
| AUTH-09 | Guest claim stolen draft ID, wrong capability/session, expiry, scope, audience, replay | Deny; no transfer; same valid claim replay gives same committed result only to same owner |
| AUTH-10 | Guest claim races with second account or upload/version edit | One owner + revision; preserve immutable assets; loser conflict; no partial transfer |
| AUTH-11 | Customer A substitutes B's cart/customer/order/design/asset/export IDs | No read/update/checkout/download; consistent nonrevealing response; Medusa independently validates actor |
| AUTH-12 | Customer central roles or browser role string presented to staff/Admin path | 403; no Admin token issued; separate current product staff grant and audit required |
| AUTH-13 | 100 concurrent first logins, duplicate exchange delivery, crash after customer write before mapping | One local profile and one dedicated customer; durable recovery reconciles same identity; no email match |
| AUTH-14 | Refresh lease expires while first writer still running; logout during refresh/cache write | Fenced late write rejected; tombstone remains revoked; no resurrected session or token cache |
| AUTH-15 | Rotating refresh succeeds remotely then response/save lost; identity authority timeout/outage | Unknown outcome recorded; bounded reconciliation/reauth; never blind old-token rotation retry; guests remain usable |
| AUTH-16 | Central revocation received twice/out-of-order/lost; Medusa bearer already issued | Inbox dedupe/versioning + reconciliation; all affected app sessions blocked within approved SLA; bearer policy tested |
| AUTH-17 | Return values with //, backslashes, escapes, controls, absolute URL, auth loop | Only approved same-origin canonical path returned; preserve safe BYO resume |
| AUTH-18 | Fake same-origin popup message from unrelated window | Ignored; no UI authenticated state until verified BFF session read |
| AUTH-19 | SDK/provider response with malformed token/customer/metadata, upstream body containing PII | Validate schema, fail closed; logs/DTO/HTML contain neither credentials nor raw upstream bodies |
| AUTH-20 | SSR navigation + expiry during render, two users on same worker, Preview/Production config swap | Node adapter verified; no cookie mutation from render; no shared private cache; environments isolated |
| AUTH-21 | Local logout with authority unavailable; retry cleanup after failure | Local revocation immediately durable; cleanup journal retained; no false claim of global logout |
| AUTH-22 | Anonymous BYO while SSO/Medusa disabled/unavailable | Public editing/preview permitted under scoped quotas; protected save/commerce fail closed; no forced AI/credit purchase |
| AUTH-23 | Refresh old-token replay, parallel rotation, client A attempts revoke of client B token; service failure under 200 revoke response | Product/client ownership enforced; one rotation effect; family policy tested; no false global-revocation confirmation |

## Security review conclusion

No unchanged bridge reuse is approved. Source architecture is useful; ID-01 through ID-06 and ID-13 block customer integration acceptance. P verifies central signature/revocation and atomic code consumption, but issuer/product binding and token-family guarantees need an approved remedy plus deployment/ingress evidence. Staff credential/claim policy requires separate operator approval. M1a publishes a proposed design only and passes no production security gate. No supplier/payment/financial flags change.
