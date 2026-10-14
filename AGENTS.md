# Agent instructions — VYNVORI

You are evolving **an existing private repository**, `TheCrimsonMarket/vynvori`, not creating a replacement repository. Read `docs/technical/00-master-specification.md` and its links before changing code.

## Required operating method

1. Inspect repository tree, `package.json`, root lockfile, design/reference, existing branches and current tests. Record the starting commit SHA. Protect existing work.
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

## Phase 6C v1.1 canonical documentation (applied locally; implementation pending)

- Founder approvals F-R01–F-R08, E01–E06 and UX-C01–UX-C07 are integrated into the canonical v1.1 chapters `docs/technical/00`–`25`. The founder authorized this local documentation application on 2026-10-13. Application implementation, commits, pushes, deployment and Design Release 1.1 changes require separate authorization.
- Verify source SHA `83056750fe599d6a7c6b9df9ce199574b6de6eff` before applying any later diff; stop for three-way review if current GitHub `main` differs. Preserve `packages/ai-benchmark`, existing logo, approved Archivo/Monumental Atelier, and intentionally ignored Phase05 `output/` artifacts.
- Never assume paid concept-only packages are allowed; require qualified Standard final + licensed digital export or eligible garment route for full 3+2 authorization. Promotional preview is separate; Director is bounded/nonbillable; final render is a separately quoted operation.
- The studio UI stage, provider execution, customer ledger and production/Medusa authorities are separate; no unknown-state billable retries, no unsupported customer debit inference from vendor charges.
- `M1a + M2 -> M1b` and `M6a + M7 + M8a -> M6b` are prerequisites. Financial/rights/vendor/SSO operational launch blockers remain OFF. Further implementation requires explicit authorization. Acceptance may be marked passed only with executed evidence; this documentation update passes no production gate.

## Founder-authorized clean-slate baseline (2026-10-14)

- The founder superseded incremental cleanup and authorized removing historical benchmark/design/review/output/install workspaces from the active repository, including unarchived restricted material. Existing portable archives and Git history remain untouched. This latest direction overrides earlier active packages/ai-benchmark and Phase05 output retention instructions in this document.
- Canonical docs/technical and proposed contracts remain byte-for-byte intact, including historical descriptions. The current installed workspace is design/reference; root manifests/README govern executable paths. The Phase6C source SHA above is historical; record current HEAD and review divergence before new changes.
- Final runtime/mock/components/assets are retained. Historical screenshot galleries and report generators are omitted. Builds/tests use new external temporary destinations.
- This reset authorizes no commit, push, production scaffolding, deployment or M0 execution. Stop for founder review of the local changes.
