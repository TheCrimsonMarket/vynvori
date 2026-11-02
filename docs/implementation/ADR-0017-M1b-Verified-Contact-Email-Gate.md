# ADR 0017 — only a centrally verified email may become the Medusa contact email

2026-11-02. Founder decision, recorded and not re-litigated. Implemented with `identity.central_sso` unchanged (OFF). Closes the `email_verified` open item from [the independent verification](M1b-Independent-Verification-20261102.md).

## Decision
If the central response's `email_verified` is not `true`, Vynvori does not write that email onto the Medusa customer. The customer's contact email is left blank until the customer verifies one through a Vynvori flow (not yet built). Login, session, guest ownership and commerce account creation are unchanged; identity remains keyed on issuer+subject only.

## Reason
Identity already cannot be taken over by email. But the Medusa email drives real outbound communication (receipts, shipping, print-adjacent data), and the M1a audit found the audited Portal source had incomplete audience/client enforcement, so upstream verification cannot be assumed. An unconfirmed address would be an unnecessary privacy exposure.

## Implementation
- Wire form: `originalEmail: ""` means "no contact email". The key stays required, so omission cannot be mistaken for intent. The signed bridge-proof canonicalization is unchanged.
- Vynvori tier (`commerce-identity.ts`): the sealed provisioning request and every dispatch send the email only when the current verified contact has `emailVerified === true`, so verification revoked after reservation also blanks it.
- Medusa tier, independent of the web tier: `provision()` rejects a `create` with 409 `BRIDGE_CONTACT_REQUIRED` unless `originalEmail === verifiedContactEmail(identity)` from its own fresh central read. `ProvisionSchema` accepts only `""` or a valid address.
- Medusa workflow: a verified email follows the unchanged stock `createCustomerAccountWorkflow`. A blank contact uses stock `createCustomersWorkflow` (`has_account: true`, identity+operation metadata) and the single existing `setAuthAppMetadataStep` link. The stock account workflow cannot be used because its validator throws "Email is required to create a customer".
- Reading a customer already tolerated a null email in the types and UI; no change.

## Consequences and limits
- With no email there is nothing to narrow the native lookup by, so it is skipped (a blank email cannot collide). A create that commits natively but whose link step is lost cannot be proven as an orphan by reconciliation: it stays `reconcile_required`, never creates a second customer, and needs operator review. Verified-email customers keep the existing exact-orphan repair.
- A contact that is entirely missing still returns `contact_required` and blocks commerce provisioning, as before (ADR-0011). Not redesigned here; see the follow-up note.
- No update path from blank to a verified email exists yet. Checkout (M4) must collect and verify an email itself rather than assume the Medusa customer has one.
- No data migration: nothing is provisioned while the flag is off, so there are no existing customers to backfill.

## Rollback
Revert the commit. It is code-only; no schema or migration changed. Customers created with a blank email under this rule remain valid Medusa customers and are not touched by a revert.
