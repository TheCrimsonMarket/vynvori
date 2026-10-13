# 15 — Dependency-ordered implementation milestones

The schedule is capability-driven, not a promise of completion within 90 days. A coding agent must finish each milestone's automated acceptance tests before merging and deploying to staging. Parallel work is permitted only when contracts are stable.

## M0 — Baseline and docs

- Inspect and report Vynvori `main` HEAD, node/npm versions, current benchmark commands and test status. Confirm no accidental live API use.
- Add this documentation overlay; preserve benchmarks/docs/fixtures and lockfile. Establish ADR template, CODEOWNERS, safe `.env.example`, initial CI. No production infrastructure required.
- **Done:** baseline tests pass, source/branch preserved, docs PR reviewed, no secrets present.

## M1 — Central authentication audit and bridge (critical)

- Obtain LuckyLittleDevil repo access; inspect real org SSO/Medusa bridge. Produce `research/lucky-little-devil-auth-audit.md` with verified code paths, sequence, threat model, claims, session/logout behavior, Medusa version differences, env secret list and tests.
- Scaffold `packages/auth-bridge`, implement integration against a dedicated Vynvori Medusa staging project using verified reused flow and immutable subject mapping.
- Guest session and draft migration with ownership/race conditions.
- **Done:** tests in section 03 pass, accounts don't duplicate, one org identity resolves to correct Medusa customer, no local credential copy. **Blocked until repo access.**

## M2 — Monorepo and deployment foundations

- Add `apps/web` Next.js, `apps/medusa` dedicated Medusa project, `packages/shared`, `packages/db`, `packages/commerce`, build/test scripts. Independent Dev/Staging/Production configs and deployment docs. Pin framework and runtime versions compatible with Medusa Cloud/Vercel.
- Neon Drizzle initial migrations and R2 presigned upload/validation service.
- **Done:** branch preview web + staging Medusa + migration CI + secure basic R2 asset roundtrip. No live checkout.

## M3 — Garment Composition Editor / Bring Your Own Art

- `packages/garment-editor` scene schema, React-Konva multi-zone independent editor, text overlays, asset uploads, guest drafts, account saves, immutable composition snapshot and 2D mockup.
- Server-side scene authorization, geometry/print profile config, flexible placeholder profile tagged unapproved for preview only.
- **Done:** user can complete BYO design without AI, zoom/scale/text/switch zone, save/restore; render consistent across screen sizes; no print release with placeholder profile.

## M4 — Medusa catalog, custom pricing and sandbox checkout

- Configure black oversized tee product/size variants, stock, shipping-region model, credit SKUs and digital export SKU; custom add-to-cart workflow with trusted immutable composition quote; quote/token TTL, server recalculation and cart ownership.
- Integrate verified centralized auth Medusa customer mapping; payment sandbox only; signed event relay/outbox/inbox. Include first redemption quote scaffolding disabled pending margin.
- **Done:** E2E BYO custom tee order in sandbox, price tampering rejected, double event doesn't duplicate order activation.

## M5 — Deterministic print assets, human QA and fulfillment

- Cloud Run image processor, R2 asset manifest/hashes, vector typography output, measured effective PPI, preflight checks; Medusa Admin QA workflow; human signoff and immutable proof; supplier handoff in test environment.
- Operational US direct/Australian consolidated batch state engine, configurable price/ETA, cost-aware fallback and customer contacts.
- **Done:** simulated paid order cannot print without QA; golden print tests; supplier-approved profile required for real production. Live shipping remains disabled until verified evidence.

## M6 — AI Studio and model workflows

- Extract production-safe pieces from benchmark to `packages/ai`; AI SDK 7/Workflow SDK 5 routes; controlled Creative Director, input normalization, three preview directions, revisions, image provider registry, artifact storage, versioning, metering, unknown-result reconciliation.
- Feature-flag actual provider routes, establish qualified Standard and Premium only with evidence. Exact editable typography via garment layer pipeline.
- **Done:** mocked AI E2E, single $-capped explicit paid smoke, cost and failure recovery test, no premium until qualified, user can transfer approved artwork into independent garment editor.

## M7 — Credit accounting, digital products and redemptions

- Drizzle wallet/ledger with ACID `pg` transactions; Medusa payment-confirmed grants and refunds, reservations/settlement, guided bundle, one-free-preview gate, digital composition entitlement and download, tentative physical-order redemption with safe calculation/expiry.
- **Done:** concurrency/duplicate/unknown billing tests, no negative balance, audited reconciliation. Live credits only with authorized processor and approved price list.

## M8 — Gallery, customer support, communication, analytics

- Private-by-default gallery publication workflow; moderation, like/share and unpublish. Customer account/order history, Sentry/PostHog integration, transactional notifications, support/refund/QA status.
- **Done:** no private source asset published; event tracking consistent and consent-aware; reporting does not leak private art.

## M9 — Staging acceptance and controlled release

- Full Playwright E2E, penetration-focused tests, load/performance checks, cross-system event replay, backup/restore rehearsal. Verify production gates `17` with actual provider/supplier/legal/carrier evidence. Run physical DTF sample tests. Pilot under feature flags. Record incident/rollback SOP and go/no-go signoff.
- **Done:** release checklist signed, no critical open bug, orders paid and shipped only where rates/payment/QA verified; staged rollout monitored.

## Milestone dependency graph

`M0 → M2 → M3 → M4 → M5 → M9`; `M1` is prerequisite for persistent authenticated user operations in `M3/M4/M7`; `M2 → M6 → M7`; `M2 → M8`; `M5/M7/M8 → M9`. AI model qualification and supplier physical signoff are independent external gates before corresponding **live** features, not reasons to block unrelated code development.

## PR requirements

Each implementation task has: goal, files/packages affected, contracts, migration plans, explicit security and race checks, tests, docs updates, deployment steps, rollback and measurement of completion. Keep changes small and reviewable, one primary architectural concern per PR.
