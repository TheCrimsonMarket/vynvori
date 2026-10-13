# 18 — Storefront routes, UX states and accessibility

## Public routes

`/` editorial storefront home and two primary CTAs: **Create with AI** and **Upload Your Design**. `/customize` independent garment composer. `/studio` AI onboarding choose `Guide Me`/`Create Freely`. `/gallery` published moderated works browse/like/share. `/products/black-oversized-tshirt` initial product description/size guide. `/collections/gaming` original non-infringing ARPG-inspired curated designs. `/cart`, `/checkout` tied to valid Medusa customer identity. `/policies/*` shipping, returns, privacy, intellectual property/licensing, digital exports.

## Authenticated routes

`/account/projects`, `/account/orders`, `/account/credits`, `/account/exports`, `/account/settings`. Central auth callback/logout routes sourced from **audited Lucky pattern**, not guessed. `/studio/projects/[id]` and `/customize/[id]` resume private drafts. All projects initially private, require owner checks even if IDs are not sequential.

## Main app navigation and semantics

- Top-level navigation: Shop, AI Design Studio, Customize, Community, Account/Cart.
- BYO editor should not redirect through AI Studio or require a credit wallet.
- AI guided start has visual choices and optional moodboard; free start has prompt/ref uploads. Both persist same normalized brief.
- Three generated concepts and iterative versions visible in accessible history. Model tier Standard/Premium choice with advanced model selection optional, informative capabilities and upfront credits.
- Editor desktop: layer list, center canvas front/back, right-side properties, bottom version history and checkout summary; responsive mobile tab/panels and touch controls.
- Storefront product gallery original photography and representative accurate print mockups. A4/A3/A2 sizes are printer constraints, not arbitrary canvas presets.
- Gallery posts explicitly ask consent; explain that visibility ≠ merchandise resale rights; opt-out/unpublish prominent.

## UX state machines

Each screen must render distinct loading/empty/success/error/pending-unknown states. For paid AI, show `charged/held/unknown` clearly without claiming provider execution success. For preorder, show actual charge and shipping window with delay obligations. For QA, `awaiting review` not `printing` before approval. For digital export, differentiate `purchased`, `processing`, `ready`, `failed recoverable`, `expired link`.

## Accessibility and reliability

Semantic labels, keyboard manipulation/alternative numeric placement controls, text contrast, responsive 320+ width, touch dragging guard rails, input validation, autosave conflict messages, WCAG 2.2 AA aspiration with measured automated/manual audits. UI must not render hidden exclusive content in image-only non-accessible form; mockup alt text and captions where appropriate. Avoid unexpected expensive generation on Enter or automatic rerenders while adjusting layers.

## SEO and indexing technical policy

Server-render crawlable home/catalog/collection content, canonical URLs, robots disallow private drafts/account/checkout, noindex unmoderated gallery drafts, OpenGraph cards only for approved public derivatives, structured product data from Medusa only when real prices/availability verified, sitemap incremental. User prompts and private artwork never indexed. Use analytics and UTM attribution only with appropriate user consent.
