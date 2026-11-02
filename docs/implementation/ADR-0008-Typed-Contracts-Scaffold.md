# ADR-0008 — `@vynvori/contracts`: runtime-validated typed contracts and state-machine guards

Status: implemented as cross-milestone prep scaffolding, not itself a milestone acceptance pass. Date: 2026-10-18.

## Context

M2 (dedicated staging infrastructure) is actively in progress on `main` (most recently "Add private staging recovery controls", `12a6ab3`). Per `docs/technical/15-implementation-milestones.md`'s dependency graph, every later milestone (M1b, M3, M4, M5, M6a, M6b, M7, M8a, M8b, M9) chains through M2 directly or via M1b, so none of them can be driven end to end yet. `docs/technical/23-typed-contracts-runtime-validation.md` and the companion proposals under `docs/technical/reference-contracts/v1.1/*.proposed.ts` are explicitly "proposal only" — hand-rolled shallow shape checks over plain TypeScript union types, not a deployed package, with the doc itself calling for "strict Zod/equivalent schemas... expanded to cover every externally supplied fixture before Design Release 1.1 typed acceptance." `docs/technical/15-implementation-milestones.md` also states that unmet (external) gates "do not prevent implementing safe mocks or non-billable drafts."

This is pure application-layer code: no database, no cloud provider, no deployment, no feature flag to flip. It does not touch any file M2's work is currently in (`packages/commerce/src/storage.ts`, `apps/medusa`, `scripts/r2-*`, `scripts/security/*`, `deploy/`).

## Decision

Add a new workspace package, `packages/contracts` (`@vynvori/contracts`), that ports the proposed TypeScript contracts into real Zod schemas with strict object parsing (unknown fields rejected), plus:

- `src/state-machines.ts` — Plane A–E transition-validity graphs from `docs/technical/22-canonical-state-machines.md`, as pure guard functions with no persistence or side effects.
- `src/invariants.ts` — the 8 "key invariants for schema tests" named in doc 23, as pure functions, several also enforced structurally by the Zod schemas' own `.refine()`s (noted per-function).
- `src/internal.ts` — provider execution evidence and remedy authorization/execution commands, gated behind the `server-only` import (mirroring `packages/shared/src/server.ts`'s existing pattern) and excluded from the public barrel (`src/index.ts`).
- `src/errors.ts` — `findLeakedInternalFields`, a recursive scanner asserting that internal-only fields (`providerJobId`, `privateVendorCostUsd`, `verifiedCaptureId`, staff/idempotency identifiers, etc.) never appear in a public projection.

30 unit tests (`node --test`) cover strict-shape rejection, discriminant/screen-stage agreement, the 8 invariants, Plane A–E transition legality, and the internal-field leak scan. `npm run typecheck`, `npm run lint` and `npm run test --workspace @vynvori/contracts` are clean, and so is the full repo `npm run typecheck` and `npm run lint`.

**Known, expected `npm test` failure — not a defect, requires founder action.** `security/m2-exception-policy.json` is a founder-approved, time-boxed (`expiresAt: 2026-11-15T23:59:59Z`), repo-wide file-integrity seal, `scope: "synthetic-only-local-M2"`, reviewed at head `34c55cbe...`. Its `fingerprint.securityRoots` covers `apps`, `packages`, `services`, `scripts`, `.github/workflows`, `package.json` and `.env.example` — the whole tree — and `scripts/security/audit-policy.mjs` fingerprints `package-lock.json` byte-for-byte plus every `apps|packages|services/*/package.json`'s projected fields. Adding `packages/contracts/package.json` (any new workspace, regardless of content) and the resulting `package-lock.json` change trip `LOCK_FINGERPRINT_MISMATCH`/`MANIFEST_FINGERPRINT_MISMATCH`/`SECURITY_BOUNDARY_CHANGED` in `npm run test:security-policy`, and therefore in the `npm test` and `npm run verify` composites. Confirmed by diffing: `test:security-policy` passes 25/25 on a clean `origin/main` checkout and fails at module load on this branch purely because of this addition — not because of a bug in the new package. The evaluator's own comment is explicit: "Updated only by an explicitly reviewed policy change, never by the runner/tests." Re-sealing `security/m2-exception-policy.json` (new fingerprints, new `reviewedHead`, same founder authority) is therefore a separate, explicit decision for whoever holds that approval — this ADR does not request or perform it.

## Scope and non-goals

- No Neon/Drizzle migration, no BFF route, no Medusa integration, no UI. This package is a dependency other milestones' implementations will consume once their own gates clear — it does not itself satisfy any `ACC-xx` row in `docs/technical/20-acceptance-matrix.md` or `24-traceability-acceptance-v1.1.md`, and no acceptance status is changed by this PR.
- Does not implement the BFF-side authoritative re-validation, ownership checks, quote-expiry/nonce cryptography, or durable idempotency doc 23 requires at the real trust boundary — this package provides the shape layer those future call sites will validate against.
- Does not decide or alter founder-locked business rules; every schema and guard is a direct, mechanical port of existing canonical-documentation language, cited per module.

## Consequences

Future M3 (editor/scene persistence), M4 (commerce quote/cart), M6a (mock Studio workflow) and M7 (credit ledger) implementations can import `@vynvori/contracts` instead of re-deriving these shapes, reducing drift between doc 21/22/23 and actual code. If the canonical documentation changes, this package's schemas and its tests are the first thing to update — `tests/*.test.ts` doubles as a regression guard against future ADR/doc revisions. No runtime API, event or database change in this PR; no migrations; nothing to roll back beyond reverting the package (it is not imported by any other workspace yet). All existing feature flags and M0/M1a/M2 functionality are untouched.
