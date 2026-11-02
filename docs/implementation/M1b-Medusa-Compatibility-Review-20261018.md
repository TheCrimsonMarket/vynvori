# M1b — installed Medusa compatibility and open decisions

2026-10-18, Asia/Dhaka. **READ-ONLY SOURCE REVIEW / BRIDGE NOT_IMPLEMENTED.** The installed framework is `2.21.2`, matching root/Medusa manifests. No Medusa configuration, route, provider, workflow, schema or deployment was changed by this review. Source compatibility does not establish deployed integration acceptance.

## Verified extension surface

| Surface | Installed source evidence | Implication |
|---|---|---|
| Custom auth provider | `node_modules/@medusajs/utils/dist/auth/abstract-auth-provider.d.ts`, `authenticate(data, authIdentityProviderService): Promise<AuthenticationResponse>`; optional register/callback methods | Use the 2.21.2 contract and server-only central verification; do not copy the unaudited legacy linking/session implementation |
| Provider registration | `@medusajs/auth/dist/loaders/providers.js`, `@medusajs/modules-sdk/dist/loaders/module-provider-loader.js`, auth types constants | Explicit configured provider ID is the selectable ID; an inert installed-loader probe registered `au_probe-config` for config ID `probe-config` and class identifier `probe-class` |
| Identity uniqueness | `@medusajs/auth/dist/models/provider-identity.js` declares unique index `IDX_provider_identity_provider_entity_id` on `(entity_id, provider)` | Versioned collision-free issuer+subject encoding is a candidate entity ID; physical deployed constraint/concurrency/recovery evidence still required |
| Actor providers | `@medusajs/types/dist/common/config-module.d.ts`, `projectConfig.http.authMethodsPerActor` | Customer-only central auth must preserve the separately verified native Admin/user policy. Do not replace actor defaults blindly |
| Native account workflow | `@medusajs/core-flows/dist/customer/workflows/create-customer-account.js` and `steps/validate-customer-account-creation.js` | Stock workflow requires email, creates customer via native workflow, then sets auth app metadata. It rejects email conflicts; no email lookup may become account ownership proof |
| Lower-level customer model | `@medusajs/customer/dist/models/customer.js`, nullable email field | Model nullability does not waive the stock account workflow's contact requirement or authorize a custom email-less account flow |
| Current application boundary | `apps/medusa/src/api/middlewares.ts` | M2 still denies all `/auth/customer` and Store writes. A future M1b exception needs explicit server/actor ownership and activation review; removing the boundary wholesale is not authorized |
| Current creative persistence | `packages/db/src/schema.ts` | Only synthetic probes exist. Profiles, sessions, transactions, mappings, guest ownership, outbox and fenced provisioning require reviewed additive schema and separately approved runtime grants |

The [registration probe receipt](evidence/M1b-Medusa-Registration-Probe-20261018.json) uses an inert provider class and fake container; no provider instance, database or network operation is activated. The [official provider reference](https://docs.medusajs.com/resources/references/auth/provider) and [actor-provider options](https://docs.medusajs.com/resources/commerce-modules/auth/module-options) were checked. The reference's storage-ID prose describes a composite name; the installed loader probe and the reference's public route example support selecting the explicit configured ID. Use tested 2.21.2 behavior rather than deriving a route from prose. This is not permission to change versions or bypass the required bridge review.

## Contact-email approach approved; central candidate implemented locally

Portal v9 now provides the approved strict contact response requiring consented `profile email`, current authority state and a scoped central profile adapter. [Contract and executed local evidence](M1b-Strict-Contact-Contract-20261018.md). A `profile`-only grant is insufficient for the stock Medusa account workflow. No placeholder email, email-based linking or silent account merge is permitted.

Founder approved on 2026-10-18: request `profile email` for the new dedicated staging client and add a client/scope-bound contact-profile response to the strict authority. Email remains mutable contact data; issuer+subject remains the identity key. Missing/conflicting contact information must yield a truthful setup/conflict state until resolved. A separate authenticated VYNVORI contact-collection step is an alternative requiring its own reviewed data/UX contract. The founder explicitly selected central profile + email. This approves the scoped contact approach; client registration and deployment remain blocked.

The current Portal v9/Core patches remain reviewable local candidates. Central contact support is implemented and tested locally; automatic customer creation, email-conflict resolution and full M1b remain unimplemented. Registration and deployment are still blocked.

## Remaining evidence before implementation/acceptance

Obtain central source-to-deployment attestation, reviewed strict registration/transport/contact contract and executed synthetic deployed trust/revocation negatives. Then review Medusa workflow/idempotency/fencing, durable provisioning and orphan reconciliation, server IAM/customer bearer transport, scoped creative schema/grants, backup/rollback and guest ownership. Required first-login race/crash, A/B isolation and logout propagation tests remain NOT_RUN. No acceptance gate is promoted by this source review.
