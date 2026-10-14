# M1a — Central identity and Medusa source audit

Audit date: 2026-10-15 (Asia/Dhaka). Status: source review complete for the client, SDK, commerce bridge and founder-identified local central authority; deployed configuration and secure reuse acceptance **BLOCKED**. No production authentication implemented. Read together with [threat model](M1a-identity-threat-model.md), [contract](M1a-bridge-integration-contract.md) and [gates](M1a-open-gates.md).

## Baseline and evidence limits

- Initial clean checkout: `e0b063f43e9f5a138d620a9e119caf93585e313e`, branch `fix/full-bleed-editorial-layout`.
- Fetched `origin/main`: `2e04dae4bb21835b84fe21d052c43396cfbbd300`. Initial checkout and main have identical trees. Main's parent is the supplied M0 baseline `8cb46a15cf9c99e69497894c1487d7a802db3964`; the intervening merged PR preserves the editorial storefront. Audit branch: `feat/m1a-central-auth-audit`, based on fetched main.
- Read repository instructions, startup guide, root manifests/lockfile, M0 report, shared configuration, web tree, retained reference manifest, canonical master and architecture/auth/data/commerce/security/tests/milestone/API/config/routes/acceptance/registry chapters. Historical cleanup and M0 prohibitions are superseded only for this explicitly authorized documentation audit and publication.
- GitHub connector returned 404 for LuckyLittleDevil. Authenticated GitHub CLI succeeded; the repository is private with default branch `main`. Read-only Contents/Tree APIs were used, with immutable refs. No deployment environment values, customer records, credentials or private art were requested. No other repository was modified.
- Source evidence proves code behavior, not deployed behavior. Source tests were inspected as test definitions; **NOT_RUN** against LuckyLittleDevil/Medusa/SDK. No SSO, token exchange or production endpoint was exercised.

## Immutable source reference keys

Every reference below uses one of these repository/commit pairs. Paths and line spans identify the reviewed functions; links remain permission-dependent.

| Key | Repository / default branch | Audited commit |
|---|---|---|
| L | [TheCrimsonMarket/LuckyLittleDevil](https://github.com/TheCrimsonMarket/LuckyLittleDevil/tree/6dc55ca3c2007d53d926773124d3851720f1b2c8) / main | `6dc55ca3c2007d53d926773124d3851720f1b2c8` |
| M | [TheCrimsonMarket/Medusa](https://github.com/TheCrimsonMarket/Medusa/tree/0babd565fa94f0771a18a89e2fd117a7b68ade3d) / main | `0babd565fa94f0771a18a89e2fd117a7b68ade3d` |
| S | [TheCrimsonMarket/oauth-react](https://github.com/TheCrimsonMarket/oauth-react/tree/de3252ef8f3c31b54c49101c62af2d93aa5bae12) / main | `de3252ef8f3c31b54c49101c62af2d93aa5bae12` |
| P | Founder-identified `D:\dev\raum\tcm\Portal.Service`, Azure DevOps repository `mg23/Portal.Service`; local branch `developmerger` | `3e91f57f9755be269cf13f718126a4abef620eb1` |

Related M/S repositories were discovered through the authenticated organization repository inventory and inspected because L imports the SDK and calls the custom commerce route. P was supplied directly by the founder during this audit; its checkout was clean and read only. P remote main/default/deployed revision was not fetched or inferred; manifest repository spelling differs from configured Git remote, so source identity here is the exact local Git SHA. Association with the *deployed* Lucky service is not established by source alone.

## Actual flow

```mermaid
sequenceDiagram
  participant B as Lucky browser
  participant L as Lucky Next.js server
  participant T as Configured TCM OAuth authority
  participant F as Lucky Firestore
  participant M as Organization Medusa
  B->>L: Login start (popup or redirect)
  L-->>B: Signed transaction cookie and authorization redirect
  B->>T: Authorization code flow, Google, S256 challenge
  T-->>L: Callback code and state
  L->>T: SDK token exchange then bearer userinfo
  L->>F: Resolve local identity; encrypt refresh token per session
  L-->>B: Signed app session cookie; sanitized account view
  B->>L: Commerce request
  L->>F: Read encrypted cached customer JWT
  L->>M: On cache miss, TCM bearer exchange
  M->>T: Bearer userinfo validation
  M->>M: Provider identity, customer mapping, customer JWT
  M-->>L: Customer token and customer record
  L->>F: Encrypt/cache customer token
  L->>M: Store API with customer bearer and publishable key
```

This is the source flow for L/M/S/P, not VYNVORI's deployed integration. The configured central web UI's browser login/cookie issuance is not fully audited by the backend source alone.

| Finding | Implementation and source evidence |
|---|---|
| Login | L `src/ui/auth/TcmAuthFlowProvider.tsx:90–105,183–255`, `resolveInteractionMode/startGoogleLogin`: desktop popup, mobile-like redirect, popup-blocked fallback; initiates `/api/auth/tcm/start`. Callback messages check origin, but do not check `event.source` or an active transaction. Browser state is not server authorization. |
| Authorization | L `src/app/(nolayout)/api/auth/tcm/start/route.ts:27–96`, `buildAuthorizeUrl/GET`: configured web base + `/oauth/authorize`, code response, client ID, exact callback, `profile email roles`, Google requirement, prompt login, state, S256 PKCE. No `openid` scope, ID-token or nonce validation is visible; do not label this a verified OIDC implementation. |
| Transaction | L `src/server/auth/tcmOAuthTransaction.ts:25–113`: random verifier/state, SHA-256 challenge; signed JWT transaction, ten-minute expiry; HttpOnly, Lax, `/`, Secure in production, no Domain. `normalizeReturnTo` checks a leading slash and rejects `//` and `/auth/`; it is not a normalized-origin/path allowlist. |
| Callback | L `src/app/(nolayout)/auth/tcm/callback/route.ts:105–193`, `GET`: verifies transaction cookie and state equality, sends saved verifier/redirect to SDK; clears transaction on success/error, applies app session. Cookie clearing alone is not durable single-use consumption across concurrent callbacks. Popup response is no-store and targets its own origin. |
| SDK exchange | S `src/server/exchange.ts:111–179,272–331`, `exchangeTcmAuthorizationCode/fetchTcmUserInfo/exchangeTcmPopupCode`: client authentication via Basic plus form client fields; POST configured API `/oauth/token`; then bearer GET `/oauth/userinfo`. Alternative redirect candidates are retried only on explicit redirect-mismatch errors. No local central JWT signature, issuer, audience or revocation validation. Trust is delegated to configured HTTP authority. |
| Alternate login route | L `src/app/(nolayout)/api/auth/tcm/oauth-exchange/route.ts:5–63` delegates POST to S `src/nextjs/createTcmOAuthExchangeRoute.ts:67–179`. SDK accepts code/state/verifier/redirect in JSON, requires nonempty fields, and uses process-local single-flight. It does not bind state to L's signed transaction cookie or enforce Origin. This route remains exported even though current UI uses start/callback. |
| Local identity | L `src/server/auth/tcmOAuthUser.ts:7–65`, `resolveTcmGoogleUserSession`: requires `googleId`, passes `sub` to local upsert, normalizes roles. L `src/server/services/authService.ts:29–122`, `upsertGoogleUser`: canonical Firestore document is string TCM subject, with legacy Google-ID lookup/migration. Email is mutable profile data, not the local lookup key. No explicit issuer field. Counter/user writes are not one transaction; concurrency protection is not shown. |
| Session | L `src/server/auth/session.ts:9–14,51–124`, `createSessionToken/verifySessionToken`: 30-day signed JWT includes user ID, roles, session ID and central access token/expiry. Signature and JWT expiry checked; no app issuer/audience/algorithm allowlist supplied. JWT signing is not encryption. S `src/server/session.ts:110–145` defaults to host-only HttpOnly/Lax/Secure-in-production cookie, `/`; L app ID is product-specific. |
| Server ownership view | L `src/server/auth/ownerAccountSession.ts:123–194,303–356`: checks numeric central expiry, loads current user, separates 401 and role-based 403. Missing central expiry does not fail the expiry check; active session-document/revocation lookup is absent on this path. Low-level `requireSession` only verifies the local JWT. |
| Refresh | L `src/server/auth/renewAuthSession.ts:20–160`: five-minute buffer; transactional 15-second lease in `authSessionStore.ts:97–128`; SDK refresh, encrypted rotation, best-effort old-token revoke; missing/invalid grant clears session, transient releases lease. Roles are retained from prior cookie. S `exchange.ts:182–225` sends refresh grant to `/oauth/token`. |
| SSR renewal | L `src/proxy.ts:8–36` invokes proactive renewal and admin CSRF guard. L `src/middleware/proactiveRenewal.ts:26–93`: verifies local cookie, self-fetches Node refresh route with cookies, forwards changed cookie into request and response. L refresh route exports GET and POST, both capable of renewal. Vercel self-fetch behavior has not been tested. |
| Credential storage | L `src/server/auth/refreshTokenCipher.ts:12–60`: AES-256-GCM, random 12-byte IV, configured base64 32-byte key. L `authSessionStore.ts:27–45,195–247` stores encrypted refresh and Medusa credentials per user/session. Key rotation/versioning is not visible. Cache uses merge-set, which can recreate a deleted document after logout races. |
| Logout | L `src/app/(nolayout)/api/auth/logout/route.ts:15–22` clears cookie and calls `terminateAuthSession`; `terminateAuthSession.ts:19–45` best-effort revokes refresh token and deletes only this device's session record. S logout helper clears standalone app session. Global central logout, access-token invalidation and Medusa JWT revocation are not demonstrated. A copied signed cookie is not checked against deleted session records by the ordinary ownership path. |
| Staff | L `src/server/auth/adminPageAuthorization.ts:20–36`, `requireOwnerAccountRoles` and `src/shared/rbac.ts:8–22`: server identity roles, customer login does not automatically imply admin; admin role satisfies any required role. L `src/middleware/adminCrossSiteGuard.ts:98–120` guards admin mutations; ordinary customer auth routes are outside that guard. Forwarded headers depend on trusted ingress. Separate Medusa admin credentials are server-side in `src/server/medusa/adminClient.ts:19–98`. This is not proof that every admin caller checks authorization. |

## Medusa bridge findings

**Versions:** L lockfile resolves Next `16.2.10`, OAuth SDK `1.4.0`, Medusa JS SDK `2.17.2`, jsonwebtoken `9.0.3`, jose `4.15.9`, firebase-admin `12.7.0`. L manifest ranges alone would misleadingly suggest JS SDK `2.8.0`. M manifest and lockfile pin Medusa/framework/CLI `2.15.5`. Deployed versions **BLOCKED**; matching S manifest version `1.4.0` does not establish byte-level provenance of L's published SDK tarball.

| Topic | Source-backed conclusion |
|---|---|
| Provider | M `medusa-config.ts:115–123,154–171` registers `./src/modules/tcm-auth`, identifier `tcm`, auth module dependencies; customer methods include both emailpass and tcm. VYNVORI must not copy the customer password method. |
| Token validation | M `src/modules/tcm-auth/service.ts:82–118,135–235`, `TcmAuthService.authenticate/fetchUserInfo_`: bearer header or body token → configured API `/oauth/userinfo`; requires string subject/email, maps provider `entity_id=sub`. No issuer namespace or client/audience check in this provider. Authority validation might exist upstream but is unverified. |
| Exchange | M `src/api/auth/customer/tcm/exchange/route.ts:9–46`: authenticate provider, ensure customer, sign **customer** actor JWT, return token and selected customer fields. L `src/server/medusa/medusaCustomerToken.ts:44–65` calls that exact POST path with central bearer and publishable key. This is a real custom endpoint, not a standard Medusa endpoint assumed from docs. |
| Customer linking | M `src/modules/tcm-auth/exchange.ts:56–148`: existing `app_metadata.customer_id` retrieves customer; otherwise email lookup takes first match, allows linking when identity metadata is empty, allows legacy Google match, rejects conflicting nonempty subject metadata, or creates customer. Updates AuthIdentity separately after customer write. No transaction/lease/idempotency journal/reconciliation visible across these operations. |
| Token claims | M `exchange.ts:150–183`, `generateCustomerJwt`: actor_id, actor_type customer, auth_identity_id, app_metadata.customer_id, provider metadata. JWT expiry comes from config/default framework behavior; no fixed production lifetime established here. No admin token minted by this flow. |
| Current session boundary | L `medusaCustomerToken.ts:78–152`: lazy encrypted server cache, 60-second freshness buffer based on decoded exp, Store bearer + publishable key, no connect.sid. Decode is used for freshness, not signature authorization; Medusa must validate bearer. `medusaStoreBearerFetch` permits init overrides; VYNVORI contract locks no-store and path allowlist. |
| Errors/retry | L `medusaCustomerTokenMutation.ts:30–75`: initial resolve, one refresh/re-exchange on failure, typed reauth/unavailable. M catches provider errors and route returns unauthorized; network vs invalid identity classification is incomplete. No uncontrolled billable call appears in this auth path; first-customer writes can still be uncertain and require reconciliation before retry. |
| Customer API example | L `src/app/(nolayout)/api/account/orders/route.ts:21–63` resolves server cookie and customer bearer then calls Store orders; 401/503 states. Does not use browser-provided customer ID. Actual cross-customer enforcement is a required Medusa integration test, not proven by frontend intent. |
| Extra protected commerce routes | M `src/api/middlewares.ts:54–76` explicitly authenticates customer bearer/session for relic/cart extensions. Framework Store/Admin defaults and all extension ownership still need version-specific runtime tests. |
| Events | Reviewed auth provider/exchange paths have no transactional outbox, webhook revocation receiver or delivery dedupe. Do not interpret cache comments calling exchange idempotent as proof of concurrent first-customer safety. |

Historical L ADR-0005/0007 described eager Medusa cookie sessions; ADR-0012 explicitly supersedes them with lazy cached bearer JWTs. Current code agrees with the latter. Its claim that exchange is idempotent is not a concurrency test or database invariant.

## Reuse decision and feasibility

### Central authority source findings (P)

P's lockfile resolves Express `4.22.3`, jsonwebtoken `9.0.2`; source is Node/ES modules, not a .NET service. No central UI, deployment environment or database rows were read.

| Area | Verified backend behavior / exact P source |
|---|---|
| Routes | `src/routes/oauthRoutes.js:8–67`: authorization, Google credential authorization, token, revoke, logout and userinfo; `/mana` aliases exist. Existing `/oauth/*` paths match SDK/M calls. Actual ingress base remains unverified. |
| Authorization | `src/controllers/oauthController.js:196–419`, `authorizeGet`: active interactive client, exact registered redirect, permitted scopes/providers and PKCE policy; current `req.user`; verified clients may skip consent. `src/models/oauthClientModel.js:228–235` uses exact redirect inclusion. `authorizeGooglePost:441–610` resolves Google credential through userService and issues code. P central UI usage is unverified. |
| Google check | `src/service/userService.js:328–372`: code exchange/userinfo and ID-token tokeninfo; ID-token audience compared to configured Google client when configured. This is not a complete Google login/account-linking audit; no VYNVORI direct Google flow is proposed. |
| Authority session | `src/service/appService.ts:234–278` sets `req.user` from legacy bearer or authToken cookie signed with TOKEN_SECRET. `src/controllers/userController.js:1079–1085` loginRequired checks req.user. `appService.ts:101–107` configures express-session with a literal placeholder secret and only explicit production Secure cookie option; literal omitted. Store, max-age/SameSite and deployed override evidence not established; do not reuse central browser cookies. |
| Code lifecycle | `src/models/oauthAuthorizationCodeModel.js:6–56` random unique code, client/user/redirect/state/PKCE, ten-minute expiry. `src/service/oauthService.js:488–577`, `exchangeAuthorizationCode`: active client/current grant/scope/redirect policy, PKCE verification and atomic update of unused/unexpired code before issuing tokens. Central replay protection is proven in code; local callback binding remains separately necessary. State is not an input to this token exchange. |
| Access claims | `oauthService.js:590–605,694–756`: signed JWT contains sub=user ObjectId string, client_id, optional aud, scope, type access_token and random jti; one-hour expiry and SHA-256 token-hash database record. No iss claim or configured issuer signing option in this path. OAUTH_TOKEN_SECRET falls back to TOKEN_SECRET; only names are recorded. Do not share this symmetric secret with VYNVORI. |
| Userinfo verification | `oauthService.js:838–862`, `verifyAccessToken`: JWT signature/time verification, required access-token type, token-hash record and isValid expiry/revocation. **No issuer/audience/client restriction**, nor current client-active policy check in this function. `oauthController.js:1224–1263` accepts that result; `oauthService.js:867–956` returns scoped profile/email/platformRoles with stable sub. Audience is not returned for downstream verification. |
| Refresh | `oauthService.js:766–800`: valid refresh/client, active interactive client/current scope policy, record use, new token pair. `oauthRefreshTokenModel.js:62–75` use increments usage but does not revoke or atomically consume old token. L subsequently best-effort revokes the old token; central one-use rotation/reuse detection is not shown. Record default lifetime 30 days. |
| Revoke | `oauthController.js:1136–1179` authenticates a client, then calls `revokeToken(token,hint)` **without passing authenticated client ID**. `oauthService.js:806–832` finds by refresh token or access hash, revokes only that record; no client ownership filter or token-family cascade. Controller returns 200 even if service reports failure. Cross-client revocation requires a possessed token but is not ownership scoped; actual exploit NOT_RUN. |
| Logout | `oauthController.js:1189–1215` clears central auth/refresh/connect.sid cookies, destroys current express session best-effort, returns no-store; no OAuth token-family or Medusa revocation. GET completion message targets wildcard origin and conveys no credentials. Global logout guarantees remain absent. |

P source resolves access-token revocation verification and central authorization-code concurrency unknowns. It confirms issuer/audience and refresh/revoke gaps rather than closing those production gates. Client registration, ingress/cookie issuance, deployed keys/version and global revocation policy still require owner evidence. P source tests for client policy, PKCE, token policy and scoped userinfo were inspected as definitions only, **NOT_RUN**.

Reuse the **protocol boundary and selected SDK primitives**, after authority trust-contract remediation and package provenance verification. Preserve centralized login, server token exchange/userinfo, product-local session, lazy customer bearer, typed unavailable/reauth states and server-only credentials. Rewrite issuer+subject mapping, customer provisioning, persistent session verification, callback binding, revocation and concurrency controls. Do not copy Firestore identity records, Google legacy migration, cookie/app ID, keys, commerce configuration or email-based linking.

VYNVORI Next `16.4.0` / React `19.3.0` / Node `22.23.3` can plausibly host the SDK's Node crypto/fetch server boundary; SDK React peers are >=18. This is **design feasibility**, not executed adapter compatibility. Keep Node code in Node Route Handlers/server-only services, request-specific ownership checks close to reads/mutations and no shared private cache. Do not transplant Edge self-fetch renewal without Vercel Preview tests. [Next auth guidance](https://nextjs.org/docs/app/guides/authentication), [Vercel Node runtime](https://vercel.com/docs/functions/runtimes/node-js).

M's provider subclasses the documented Medusa v2 abstraction. Current official-source lookup corroborates provider/AuthIdentity architecture, but does not certify its implementation at `2.15.5` or a future dedicated project version. M2 must pin and validate the actual service. [Medusa auth provider documentation](https://docs.medusajs.com/resources/commerce-modules/auth/auth-providers).

Future Neon/Drizzle profiles replace product-specific Firestore mapping; all commerce provisioning remains via Medusa modules/workflows in a **new dedicated VYNVORI Medusa Cloud project**. Separate DB/customers/sessions/inventory/admin users/secrets. Guest BYO remains independent of both identity and commerce outages. Proposed contracts and negative cases are in the companion documents. No migrations, runtime APIs or events changed in M1a.
