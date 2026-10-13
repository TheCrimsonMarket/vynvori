# Agent instructions — VYNVORI

You are evolving **an existing private repository**, `TheCrimsonMarket/vynvori`, not creating a replacement repository or rewriting the existing benchmark harness. Read `docs/technical/00-master-specification.md` and its links before changing code.

## Required operating method

1. Inspect repository tree, `package.json`, root lockfile, benchmark package, existing branches and current tests. Record the starting commit SHA. Protect existing work.
2. Audit the canonical **LuckyLittleDevil** authentication/Medusa integration before implementing customer authentication. The source was not accessible to the blueprint author. Produce verified findings under `docs/technical/research/lucky-little-devil-auth-audit.md`. Do not infer or fabricate authentication endpoints, tokens or secrets.
3. Follow founder-locked decisions exactly. For external unknowns, implement typed configuration with disabled production feature flags; do not insert invented supplier prices, print dimensions, model qualifications, shipping quotes, legal entities, or payment processors.
4. Implement milestone by milestone. Each PR must contain an ADR where architecture changes, migrations, tests, security review notes, and changes to APIs/events. Never make destructive migrations without a documented rollback/backup plan.
5. Keep Medusa as the system of record for catalog, variants, inventory, cart, payments, orders, refunds and fulfillment. Keep Neon/Drizzle as the system of record for creative projects, compositions, AI ledger, assets, rights permissions and print QA. Never write directly into the Medusa database from Vynvori's Drizzle package.
6. Use a verified central identity `issuer + subject` as the global user key; do not use an email address as proof of account ownership or automatic linking. Treat Medusa customer IDs as commerce actor mappings.
7. No uncontrolled billable provider retry. Use idempotency/reservation and reconcile uncertain outcomes; human intervention if a provider's execution state is unknown.
8. A successful checkout is **not** permission to print. Paid custom orders stay on QA hold until Vynvori human pre-print approval; material edits require a new proof and explicit customer approval.
9. Build testable failure and replay paths (events, payments, wallet, production, export entitlements). Enforce ownership on all IDs and signed asset access.
10. Never commit live credentials, user-uploaded private art, identifiable customer data or third-party original provider binaries. Review generated docs for secrets. The root `.env.example` contains placeholders only.

## Definition of done for each milestone

- Proposed interfaces/DB migrations reviewed; `npm ci`, affected lint/typecheck/unit tests and relevant integration tests pass; CI is green; tests cover permissions, idempotency and failure; operational rollback documented; feature flag defaults safe.
- Attach evidence: PR, changeset or commit, test output, API examples, screenshots for UX, performance/cost reports for AI, and reconciliation results for commerce.
- Update `docs/technical/20-acceptance-matrix.md` with actual statuses (do not claim untested gates passed).

## Stop and escalate

Escalate when (a) LuckyLittleDevil auth source is not available, (b) a Medusa version-specific extension mechanism differs from docs, (c) checkout can't safely price validated compositions, (d) post-payment outbox/reconciliation invariants aren't met, (e) rights/print/shipping/payment production gates are absent, or (f) any proposed change breaks previously approved product requirements.
