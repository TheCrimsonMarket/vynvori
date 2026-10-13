# 00 — Master technical specification

**Project:** VYNVORI. **Repo:** https://github.com/TheCrimsonMarket/vynvori. **Decision baseline:** founder approvals Phases 1–6, 20/21 initial T decisions A; **T03 overridden** with organization centralized auth patterned on LuckyLittleDevil. **Document status:** implementation handoff; subject to verifiable external gates.

## Product goal

Build a globally accessible premium customizable-apparel platform that initially sells **black oversized DTF-printed T-shirts** (mixed sizes). Customers can (1) create original art through guided or freeform AI, (2) upload their own art and customize a shirt **without using AI**, and (3) browse an optional moderated community showcase. Creative workflows, commerce, print production and fulfillment are independently modular. Launch geography focuses on US direct shipping and Australian batch consolidation, configured from actual supplier/carrier evidence.

## MVP paths (both required)

**BYO:** anonymous visitor → upload original PNG/JPEG/WebP → separate free Garment Composition Editor (layers, exact text, position/scale/rotate, multi-zone as supported) → preview → sign in via organization SSO → persist and lock composition → choose size → Medusa personalized cart → checkout (when enabled) → automated print preflight → internal human QA → release to DTF partner → US direct or Australian consolidation → tracking. Paid high-resolution composition export is optional; no export charge to place an order. Original unchanged upload remains retrievable by owner.

**AI:** anonymous visitor → `Guide Me` wizard or `Create Freely` prompt → account required to claim one free preview or generate paid art → CreativeBrief and bounded Creative Director → three concept directions (bundle policy; free promotional preview where eligible) → revisions (two in guided bundle) → qualified Standard final or Premium if a truly differentiated qualified model exists; Advanced Model Selection optional → original art/version in R2 → optional Garment Editor → digital artwork purchase or physical order → partial eligible AI-design spending redemption on physical shirt where economically allowed.

**Gallery:** all projects private by default. Creator explicitly publishes a sanitized representation, moderated and removable, with browse/like/share; no buy-someone-else's-design, download originals, remix or royalties in MVP. Architect future explicit licensing/marketplace as separate optional grants.

## Tech ownership (locked)

- **Vercel:** Next.js App Router/TypeScript, Tailwind, shadcn/ui storefront, AI Studio, guest UX, account, public gallery, secure application BFF.
- **Dedicated Medusa Cloud project:** product, size variants, inventory, cart, calculated prices, payments, orders, promotions, refunds, fulfillment. Separate from organization’s other Medusa service.
- **Organization centralized authentication (T03):** sole human login/credential authority; reuse verified LuckyLittleDevil→Medusa bridge; Vynvori profile and Medusa customer mapping, no parallel passwords.
- **Neon PostgreSQL + Drizzle ORM/Kit + node-postgres** pooled server connection: Vynvori-specific durable business state, particularly ACID ledger and design records. Not used to write Medusa tables.
- **Vercel AI SDK 7 + Workflow SDK 5 / bounded WorkflowAgent:** provider integration and durable non-commerce jobs. Image-provider qualification via benchmark; no assumption of preferred model or rates.
- **Cloudflare R2:** original art, derivatives, mockups, print artifacts; private by default.
- **GCP Cloud Run + Sharp and appropriate deterministic renderers:** high-res layer composition, safe SVG rasterization where enabled, font embedding, print checks, derived artifacts.
- **React-Konva:** focused versioned layer-based garment editor, independent of AI Studio.
- **Existing `packages/ai-benchmark`:** preserve source/tests/fixtures. Reuse proven adapters only after production hardening and provider-contract validation.
- **PostHog, Sentry, GitHub Actions:** product analytics, errors and CI as approved (verify plans and SDK releases before installation).

## Non-negotiable invariants

1. External access is authorized by real identity/ownership; guest resources are constrained by unforgeable scoped session identifiers. Publishable API keys are NOT authorization tokens.
2. Source images and composition version IDs are immutable once attached to a paid order. All final printing comes from source assets/transforms, never from a mockup screenshot.
3. Wallet available balance cannot go below zero; every mutation is a balanced append-only ledger transaction; unique idempotency keys govern grants, holds, charges and reversals.
4. Payment is confirmed by authoritative Medusa/provider state before wallet entitlements or print jobs. All cross-system deliveries tolerate duplicate, delayed, missing or out-of-order events.
5. Paid physical orders cannot be released to print without validated manufacturing profile, allowed customer proof, and a recorded authorized HUMAN pre-print approval.
6. Rights checks and ownership are enforced separately for private creation, public showcase, digital export and possible future commercial reproduction.
7. Unknown external price, legality, provider entitlement or quality must block production operation rather than be replaced by a plausible estimate.
8. Customers see prices in applicable currency, total charges/duties responsibilities and defensible delivery estimates before final checkout.
9. No cross-request raw private artwork caching or public exposure; signed asset URLs expire; retain/version and delete data according to policy.
10. A centralized auth logout/revocation must affect Vynvori and associated Medusa access under the verified bridging model.

## Not MVP

Advanced Photoshop-style masking/brushes; generative virtual try-on; creator marketplace, buying or remixing others' public designs and royalty payouts; multi-color apparel; DTG printing; automatically approving production without a human; real-time carrier API integration where manual verified rate tables suffice; native mobile apps; subscriptions; bulk B2B automation.

## Feature flags and gates

Use typed flags: `commerce.checkout_live`, `payments.live`, `studio.ai_generation_paid`, `studio.premium_final`, `studio.advanced_model_selector`, `studio.free_promo`, `exports.paid`, `production.print_release`, `gallery.publication`, `shipping.australia_batch`. Default dangerous flags to OFF. Model qualifications and supplier profiles are data-driven, never environment-hardcoded.

## Cross references

`01` architecture, `02` workspace, `03` T03 identity bridge, `04` schema, `05` AI, `06` wallet, `07` editor, `08` assets/DTF, `09` Medusa, `10` events, `11` QA logistics, `12` security, `13` operations, `14` tests, `15` milestones, `16` APIs, `17` external gates, `18` routes, `19` notifications/events, `20` acceptance.
