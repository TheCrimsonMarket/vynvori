# v1.1 proposed reference contracts — documentation only

The original Phase 6C reference contracts and illustrative assertions are retained, with the authorized Phase 6E proposed contract corrections applied locally. They propose versioned data shapes and illustrative mock assertions; they are outside the benchmark compilation scope and are not installed in application code.

- [Proposed contracts](vynvori-v1_1-proposed.ts) define UI-safe read projections, quotes and internal-only provider evidence. Keep customer credits/receipts separate from vendor costs.
- [Illustrative assertions](proposed-contract-assertions.ts) exercise shallow mock shapes only. Strict TypeScript compilation and successful mock checks do not prove authorization, runtime safety or production readiness.
- Real trust boundaries require strict server-side Zod or equivalent validation, ownership, verified issuer/subject, quote expiry/signature, current plan/region/rights/terms, idempotency and authoritative ledger/Medusa checks. Client action lists and authorization hints grant no permission.
- Financial reservations, settlement, remedies, customer mapping, payments and security mutations are server-authoritative. Authentication, payment, billing, model, supplier and shipping production integrations remain unimplemented or blocked.

The [canonical runtime requirements](../../23-typed-contracts-runtime-validation.md), [acceptance traceability](../../24-traceability-acceptance-v1.1.md) and [registry](../../25-route-api-event-domain-matrix.md) govern future implementation. The review subdirectory preserves source gap/fixture provenance; the eleven declared BFF negative scenarios remain NOT_RUN. It contains no executed production acceptance evidence.

- [Phase 6E companion](vynvori-phase6e-companion.proposed.ts) proposes editor/account/commerce, exact-version export, recovery and separate internal/public remedy contracts. Internal entitlement capture evidence is omitted from customer export views. Runtime validators and PE6-01–25 remain NOT_RUN; see the [fixture inventory](../../review-fixtures/NEGATIVE-RECOVERY-ACCEPTANCE-CASES.csv).
