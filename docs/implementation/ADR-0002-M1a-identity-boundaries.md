# ADR-0002 — Central identity adapter and isolated customer bridge

Status: proposed for M1a review, not implementation approval. Date: 2026-10-15.

## Context

The source audit verifies centralized OAuth login and lazy Medusa customer bearer exchange, but finds email-based customer linking, incomplete product/audience binding, local session revocation gaps and unproven first-login concurrency. Lucky uses Firestore/product legacy identity semantics. VYNVORI requires issuer+subject, Neon creative identity records and a separate Medusa Cloud project.

## Decision

Reuse selected verified SDK protocol primitives after authority and package validation. Build a VYNVORI server-only adapter with opaque active sessions, immutable issuer+subject mappings, transaction-bound callbacks, durable guest claims and a dedicated idempotent Medusa customer workflow. Keep customer and staff authorization distinct. No direct Drizzle writes to Medusa. Never auto-link by email, share Lucky commerce state or install parallel customer passwords.

## Alternatives and consequences

Copying the bridge unchanged conflicts with locked identity rules. Sharing the existing Medusa instance conflicts with product isolation. A new credential provider conflicts with sole central login authority. Proposed wrapping minimizes protocol duplication but requires explicit central validation evidence, new persistence/workflow invariants and negative tests. Lazy commerce remains useful for login/BYO availability; active protected sessions must still fail closed during uncertain authority state.

Interfaces and trust configuration: [contract](M1a-bridge-integration-contract.md). Security review/required tests: [threat model](M1a-identity-threat-model.md). Source commits/evidence: [audit](M1a-auth-source-audit.md). Open prerequisites: [gates](M1a-open-gates.md).

No runtime API/event/database change in this PR. No migrations; future M1b migration and rollback/backup plan require review. M1a rollback: revert documentation commit. All feature defaults and M0 functionality retained. Reviewer approval pending; `M1a + M2 -> M1b` unchanged.
