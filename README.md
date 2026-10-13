# VYNVORI — Phase 6 technical blueprint handoff

**Status:** founder-approved technical design, implementation pending. **Snapshot:** 2026-10-13. **Target repository:** `TheCrimsonMarket/vynvori` (`main`), private. **Corrected v1.1 documentation applied locally on 2026-10-13; application implementation pending.**

These canonical chapters incorporate the approved **documentation overlay** in the existing repository. It is not a complete application and does not replace `packages/ai-benchmark` or its tests, fixtures, scripts, reports, or the existing `package-lock.json`.

Start with `docs/technical/00-master-specification.md`, then read `AGENTS.md`, the domain specifications and the milestone plan. Execute in vertical slices; do not attempt a massive one-shot rewrite.

## Critical prerequisite: LuckyLittleDevil source audit

Founder decision **T03**: The Crimson Market centralized authentication is the identity authority for Vynvori. Implement its **existing LuckyLittleDevil-to-Medusa bridge**, adapting it to the new dedicated Vynvori Medusa Cloud project. The repository `TheCrimsonMarket/LuckyLittleDevil` was inaccessible to the connected GitHub app (404) during authorship, while `TheCrimsonMarket/vynvori` was accessible. **The actual bridge implementation was not inspected.** Consequently, implementation milestone M1 contains a mandatory source audit and contract-verification gate. No endpoint names, token format, provider name, session mechanism, or code locations are asserted as facts about LuckyLittleDevil.

Have an authorized coding agent inspect that repository, prepare an auth sequence diagram, list secret requirements and documented auth decisions, and implement/test the faithful secure pattern. If source access is unavailable, **halt customer-auth bridge implementation** and ask the founders for access; other modules can proceed with test doubles. Never improvise trust relationships to unblock development.

## Hard blocked gates

Production payment activation: legitimate legal seller/payment account/provider verified. DTF final approval: manufacturer-provided print profiles, samples and human signoff. US/Australia paid-order promises: validated shipping costs/lead times/customs terms. AI paid release: model license/provider rights, output qualification and effective credit rates validated. Public trademarks/brand IP: clearance before launch. Details: [operational gates](docs/technical/17-configuration-open-gates.md).

## File map

- `AGENTS.md`: operating instructions for coding agents.
- `00` scope, non-negotiable invariants, cross references.
- `01–04`: architecture, repository, centralized auth and database domains.
- `05–09`: AI, credit accounting, composition, assets/print, Medusa commerce.
- `10–13`: events, operations, security, deployment.
- `14–16`: tests, milestones, API contracts.
- `17–20`: launch gates, UX routes, notifications, acceptance matrix.

All examples are prescriptive contracts or proposals for implementation, **not claims that the code already exists**. Framework/library APIs must be checked against installed versions in the implementation PR.

## Phase 6C v1.1 canonical documentation (applied locally; implementation pending)

- Founder approvals F-R01–F-R08, E01–E06 and UX-C01–UX-C07 are integrated into the canonical v1.1 chapters `docs/technical/00`–`25`. The founder authorized this local documentation application on 2026-10-13. Application implementation, commits, pushes, deployment and Design Release 1.1 changes require separate authorization.
- Verify source SHA `83056750fe599d6a7c6b9df9ce199574b6de6eff` before applying any later diff; stop for three-way review if current GitHub `main` differs. Preserve `packages/ai-benchmark`, existing logo, approved Archivo/Monumental Atelier, and intentionally ignored Phase05 `output/` artifacts.
- Never assume paid concept-only packages are allowed; require qualified Standard final + licensed digital export or eligible garment route for full 3+2 authorization. Promotional preview is separate; Director is bounded/nonbillable; final render is a separately quoted operation.
- The studio UI stage, provider execution, customer ledger and production/Medusa authorities are separate; no unknown-state billable retries, no unsupported customer debit inference from vendor charges.
- `M1a + M2 -> M1b` and `M6a + M7 + M8a -> M6b` are prerequisites. Financial/rights/vendor/SSO operational launch blockers remain OFF. Further implementation requires explicit authorization. Acceptance may be marked passed only with executed evidence; this documentation update passes no production gate.

Canonical v1.1 chapters: [master specification](docs/technical/00-master-specification.md), [screen contract](docs/technical/21-studio-ux-screen-contract.md), [state machines](docs/technical/22-canonical-state-machines.md), [proposed contracts](docs/technical/23-typed-contracts-runtime-validation.md), [acceptance traceability](docs/technical/24-traceability-acceptance-v1.1.md), [route/API/event registry](docs/technical/25-route-api-event-domain-matrix.md). The root consolidated blueprint is an explicitly historical v1.0 snapshot.
