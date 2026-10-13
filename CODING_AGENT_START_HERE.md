# Coding-agent initial task — VYNVORI

You are working in `TheCrimsonMarket/vynvori`, an existing private npm-workspace TypeScript repository containing the AI benchmark harness. When separately authorized, incrementally implement the Vynvori platform as specified in the accompanying `docs/technical` directory. The current Phase 6C authorization is local documentation only; stop after applying and validating it. This is a technical specification package, **not a request to implement the entire platform in one commit**.

**First:** read `AGENTS.md`, `docs/technical/00-master-specification.md`, `02-monorepo-and-development.md`, `03-centralized-authentication.md`, `15-implementation-milestones.md`, `17-configuration-open-gates.md`, `20-acceptance-matrix.md` and inspect the actual existing source/branch. Verify framework API versions in the project you install. Do not erase `packages/ai-benchmark`, scripts or fixtures.

**Authentication blocker:** The Crimson Market has centralized SSO. The actual Medusa identity-bridge implementation must be obtained from `TheCrimsonMarket/LuckyLittleDevil`; the blueprint author could not read that private repository. Do not guess tokens/endpoints or invent a new password system. Request repository access if needed, audit and document the real bridge, and reuse it securely with a new dedicated Medusa Cloud project. This is founder-approved T03.

**Phase 6 decisions:** T01–T02 and T04–T21 approved as originally recommended. T03 overridden to use centralized org auth + verified LuckyLittleDevil Medusa bridge. Vendor roles: Next.js/Vercel UX+BFF, dedicated Medusa commerce, Neon+Drizzle+pg creative/credit domains, R2 assets, Cloud Run deterministic production image processing, AI SDK 7/Workflow SDK 5 bounded agents, React-Konva editor; PostHog/Sentry; GitHub CI. Initial product black oversized DTF tee; BYO editor must work without AI.

**Start with milestone M0.** Deliver: repository baseline report, architectural diff vs blueprint, non-destructive docs proposal, CI baseline and a PR. Before implementing M1 identity bridge, produce the LuckyLittleDevil code audit and seek review. For subsequent milestones produce small reviewable PRs, real test evidence, versioned migrations, runbooks and updated acceptance matrix. Implement all unknown supplier/payment/model/shipping values as disabled, versioned configuration, not fake production defaults.

**Report each milestone:** implemented changes, tests run and results, known limitations, blocking gates, security concerns, migration/deployment steps, links to PRs/commits, next task proposal. Stop on cross-system money/identity/printing ambiguity rather than bypassing a gate.

## Phase 6C v1.1 canonical documentation (applied locally; implementation pending)

- Founder approvals F-R01–F-R08, E01–E06 and UX-C01–UX-C07 are integrated into the canonical v1.1 chapters `docs/technical/00`–`25`. The founder authorized this local documentation application on 2026-10-13. Application implementation, commits, pushes, deployment and Design Release 1.1 changes require separate authorization.
- Verify source SHA `83056750fe599d6a7c6b9df9ce199574b6de6eff` before applying any later diff; stop for three-way review if current GitHub `main` differs. Preserve `packages/ai-benchmark`, existing logo, approved Archivo/Monumental Atelier, and intentionally ignored Phase05 `output/` artifacts.
- Never assume paid concept-only packages are allowed; require qualified Standard final + licensed digital export or eligible garment route for full 3+2 authorization. Promotional preview is separate; Director is bounded/nonbillable; final render is a separately quoted operation.
- The studio UI stage, provider execution, customer ledger and production/Medusa authorities are separate; no unknown-state billable retries, no unsupported customer debit inference from vendor charges.
- `M1a + M2 -> M1b` and `M6a + M7 + M8a -> M6b` are prerequisites. Financial/rights/vendor/SSO operational launch blockers remain OFF. Further implementation requires explicit authorization. Acceptance may be marked passed only with executed evidence; this documentation update passes no production gate.
