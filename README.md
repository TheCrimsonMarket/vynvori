# VYNVORI — Phase 6 technical blueprint handoff

**Status:** founder-approved technical design, implementation pending. **Snapshot:** 2026-10-13. **Target repository:** `TheCrimsonMarket/vynvori` (`main`), private. **No repository mutation performed as part of this handoff.**

This package is a **documentation overlay** to copy into the existing repository. It is not a complete application and does not replace `packages/ai-benchmark` or its tests, fixtures, scripts, reports, or the existing `package-lock.json`.

Start with `docs/technical/00-master-specification.md`, then read `AGENTS.md`, the domain specifications and the milestone plan. Execute in vertical slices; do not attempt a massive one-shot rewrite.

## Critical prerequisite: LuckyLittleDevil source audit

Founder decision **T03**: The Crimson Market centralized authentication is the identity authority for Vynvori. Implement its **existing LuckyLittleDevil-to-Medusa bridge**, adapting it to the new dedicated Vynvori Medusa Cloud project. The repository `TheCrimsonMarket/LuckyLittleDevil` was inaccessible to the connected GitHub app (404) during authorship, while `TheCrimsonMarket/vynvori` was accessible. **The actual bridge implementation was not inspected.** Consequently, implementation milestone M1 contains a mandatory source audit and contract-verification gate. No endpoint names, token format, provider name, session mechanism, or code locations are asserted as facts about LuckyLittleDevil.

Have an authorized coding agent inspect that repository, prepare an auth sequence diagram, list secret requirements and documented auth decisions, and implement/test the faithful secure pattern. If source access is unavailable, **halt customer-auth bridge implementation** and ask the founders for access; other modules can proceed with test doubles. Never improvise trust relationships to unblock development.

## Hard blocked gates

Production payment activation: legitimate legal seller/payment account/provider verified. DTF final approval: manufacturer-provided print profiles, samples and human signoff. US/Australia paid-order promises: validated shipping costs/lead times/customs terms. AI paid release: model license/provider rights, output qualification and effective credit rates validated. Public trademarks/brand IP: clearance before launch. Details: `17-configuration-open-gates.md`.

## File map

- `AGENTS.md`: operating instructions for coding agents.
- `00` scope, non-negotiable invariants, cross references.
- `01–04`: architecture, repository, centralized auth and database domains.
- `05–09`: AI, credit accounting, composition, assets/print, Medusa commerce.
- `10–13`: events, operations, security, deployment.
- `14–16`: tests, milestones, API contracts.
- `17–20`: launch gates, UX routes, notifications, acceptance matrix.

All examples are prescriptive contracts or proposals for implementation, **not claims that the code already exists**. Framework/library APIs must be checked against installed versions in the implementation PR.
