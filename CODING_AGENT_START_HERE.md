# Coding-agent initial task — VYNVORI

You are working in `TheCrimsonMarket/vynvori`, an existing private npm-workspace TypeScript repository containing the AI benchmark harness. Your mission is to incrementally implement the Vynvori platform as specified in the accompanying `docs/technical` directory. This is a technical specification package, **not a request to implement the entire platform in one commit**.

**First:** read `AGENTS.md`, `docs/technical/00-master-specification.md`, `02-monorepo-and-development.md`, `03-centralized-authentication.md`, `15-implementation-milestones.md`, `17-configuration-open-gates.md`, `20-acceptance-matrix.md` and inspect the actual existing source/branch. Verify framework API versions in the project you install. Do not erase `packages/ai-benchmark`, scripts or fixtures.

**Authentication blocker:** The Crimson Market has centralized SSO. The actual Medusa identity-bridge implementation must be obtained from `TheCrimsonMarket/LuckyLittleDevil`; the blueprint author could not read that private repository. Do not guess tokens/endpoints or invent a new password system. Request repository access if needed, audit and document the real bridge, and reuse it securely with a new dedicated Medusa Cloud project. This is founder-approved T03.

**Phase 6 decisions:** T01–T02 and T04–T21 approved as originally recommended. T03 overridden to use centralized org auth + verified LuckyLittleDevil Medusa bridge. Vendor roles: Next.js/Vercel UX+BFF, dedicated Medusa commerce, Neon+Drizzle+pg creative/credit domains, R2 assets, Cloud Run deterministic production image processing, AI SDK 7/Workflow SDK 5 bounded agents, React-Konva editor; PostHog/Sentry; GitHub CI. Initial product black oversized DTF tee; BYO editor must work without AI.

**Start with milestone M0.** Deliver: repository baseline report, architectural diff vs blueprint, non-destructive docs proposal, CI baseline and a PR. Before implementing M1 identity bridge, produce the LuckyLittleDevil code audit and seek review. For subsequent milestones produce small reviewable PRs, real test evidence, versioned migrations, runbooks and updated acceptance matrix. Implement all unknown supplier/payment/model/shipping values as disabled, versioned configuration, not fake production defaults.

**Report each milestone:** implemented changes, tests run and results, known limitations, blocking gates, security concerns, migration/deployment steps, links to PRs/commits, next task proposal. Stop on cross-system money/identity/printing ambiguity rather than bypassing a gate.
