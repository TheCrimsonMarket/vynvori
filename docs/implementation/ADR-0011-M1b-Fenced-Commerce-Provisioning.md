# ADR 0011 — fenced native commerce provisioning

2026-10-19. Local implementation and synthetic verification. No live migration, registration, grants or deployment authorized.

## Decision

Keep commerce creation inside Medusa's native workflows. The creative database stores only the identity-to-commerce mapping and provisioning journal; it never writes to Medusa tables. Each (VYNVORI user, dedicated Medusa project) has one durable operation ID. Native auth identity and customer IDs are unique within that project. The provider entity key uses the shared versioned issuer+subject digest, with exact issuer/subject provider metadata verified independently.

`0002_commerce_mappings.sql` adds the proposed journal. A reservation atomically transitions from reserved to dispatching once. There is no lease expiry that permits another create dispatch. A transport/process/commit uncertainty leaves the same operation pending reconciliation; ordinary ensure calls cannot retry creation. The original verified contact is encrypted with a versioned purpose/operation-bound vault context so later reconciliation can locate the original native operation even after contact changes.

The internal native workflow receives identity, auth identity ID, project ID, operation ID and contact email, never central access/refresh tokens. Its caller must first authenticate the central credential and enforce the private product/service boundary. It checks native provider identity metadata and rejects staff-linked identities. Existing customer links must carry the exact identity/project/auth-identity/operation markers. Email collision is a conflict, including an unrelated guest customer; email never authorizes account adoption.

For a first create, the workflow delegates to the installed `createCustomerAccountWorkflow`, including its native customer mutation, auth metadata association and compensation. It emits only the native workflow's normal customer event. Reconciliation mode cannot create. It can find an orphan using the original contact as a search filter, but repairs the link only when all identity and operation markers match exactly. Native auth metadata repair uses the installed `setAuthAppMetadataStep`; it does not delete or recreate the customer. Conflicting or absent proof stays pending/conflicted for controlled intervention.

Existing ready mappings are resolved using current verified issuer+subject identity, independently of current email availability. Missing contact blocks new provisioning, not login, guest ownership or resolution of an already established mapping. A changed email does not create another customer. Staff/Admin authentication policy and the currently closed M2 customer boundary remain unchanged.

## Rollback and operational review

The journal migration is additive and remains outside the active M2 migration journal. No runtime migration/grants are enabled. A live proposal must verify the creative target and schema ownership, test backup/restore, register reviewed migration checksums, apply minimum runtime grants and preserve a tested application/config rollback. A name collision stops execution; no schema or index is dropped or weakened.

Rollback disables the customer bridge and restores prior application/configuration. Retain mappings, encrypted requests and operation markers for reconciliation; never reset a dispatching/uncertain operation to reserved merely to retry. Never delete an existing customer or reassign its identity as a generic rollback. Compensation performed by the stock native workflow applies only to its own newly created records. A manual conflict reset needs proof that no native customer was created or linked and separate reviewed operator action.

No HTTP route or runtime provider enrollment is activated by this slice. Future transport must pin the dedicated Medusa project/origin, verify the BFF service identity at the private ingress, freshly authenticate the central bearer and prevent caller-supplied identity/actor overrides. Customer tokens must remain server-side. These transport and browser/cookie/CSRF integration gates remain open.

## Verification

Actual disposable PostgreSQL 16.12 verifies the creative journal's single dispatch, immutable encrypted contact recovery, operation binding and uniqueness preventing two identities from sharing one native customer. The session suite now includes 19 scenarios. Separately, the actual Medusa 2.21.2 compiler and native auth/customer modules run against a newly migrated disposable PostgreSQL database: physical provider/customer uniqueness indexes verified, twelve-way provider identity race gives one identity, repeat provisioning gives one customer, email collision is denied, changed contact preserves the customer, an exact orphan is repaired without creating another, and unresolved reconciliation creates nothing. Both labeled test databases are removed.

Framework workflow tests use actual Medusa composition and stock workflow code with in-memory service fixtures; the separate native-module run closes the local physical-storage gap. All fixtures are synthetic. These results do not prove Neon 18 staging behavior, live IAM/Portal enrollment, HTTP/browser integration, remote CI or full M1b acceptance.
