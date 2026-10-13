# 18 — Storefront routes, UX states and accessibility

## Public routes

Canonical proposed Next.js customer-facing paths; stages ST-04..ST-17 are **server-derived view states on one owned project route**, not unique security URLs:

| Route | Auth / entry | Scope |
|---|---|---|
| `/` | public | storefront home with equally visible AI/BYO entry |
| `/studio` | public | Guide Me vs Create Freely; truthful capability display |
| `/studio/guide` | guest or identity | wizard drafting, no billed generation |
| `/studio/free` | guest or identity | prompt-first drafting, no billed generation |
| `/studio/brief/[draftId]` | valid signed guest capability | review/claim draft, expiry/reconnect |
| `/studio/projects/[projectId]` | verified owner | all creative stages ST-04–ST-17, current server-derived stage on reload |
| `/customize` | public/guest | independent BYO upload/editor, zero AI credits |
| `/customize/[compositionId]` | owner or valid scoped guest capability | own layer-based editor/resume |
| `/customize/[compositionId]/review` | owner or valid scoped guest capability | immutable composition review; checkout independently gated |
| `/studio/projects/[projectId]/history` | verified owner | immutable version history; no new generation |
| `/products/black-oversized-tshirt` | public | product/size guide; verified inventory/price if checkout enabled |
| `/collections/gaming` | public | original noninfringing ARPG themes |
| `/gallery`, `/gallery/[postId]` | public sanitized approved only | view/likes/share (no resale/remix) |
| `/cart`, `/checkout` | valid commerce session | Medusa quote/cart/checkout, no free-login barrier to BYO |
| `/policies/[slug]` | public | disclosed availability, refunds, rights and shipping terms |

No hash-based design prototype route (`#results`, `#bag`) is canonical. Stage query hints cannot bypass server guards. US and AU ship modes gated independently. Marketing audience scope is not shipping availability. [R05,F-R01–08]

## Authenticated routes

`/account/projects`, `/account/orders`, `/account/credits`, `/account/exports`, `/account/settings`, `/account/gallery` and `/account/orders/[id]` require valid org SSO and owner mapping. `/studio/projects/[projectId]` requires the verified authenticated owner. `/customize/[compositionId]` permits the authenticated owner or explicitly scoped guest preview; no public project URLs by ID alone. Staff operations are authenticated Medusa Admin extension routes with separate operator role enforcement; customer SSO is never enough. Auth callback/logout URLs must be discovered from audited LuckyLittleDevil source, not invented. Return-path allowlist and claim nonce protect SSO deep-link resumes.

## Main app navigation and semantics

- Top-level navigation: Shop, AI Design Studio, Customize, Community, Account/Cart.
- BYO editor should not redirect through AI Studio or require a credit wallet.
- AI guided start has visual choices and optional moodboard; free start has prompt/ref uploads. Both persist same normalized brief.
- Three generated concepts and iterative versions visible in accessible history. Model tier Standard/Premium choice with advanced model selection optional, informative capabilities and upfront credits.
- Editor desktop: layer list, center canvas front/back, right-side properties, bottom version history and checkout summary; responsive mobile tab/panels and touch controls.
- Storefront product gallery original photography and representative accurate print mockups. A4/A3/A2 sizes are printer constraints, not arbitrary canvas presets.
- Gallery posts explicitly ask consent; explain that visibility ≠ merchandise resale rights; opt-out/unpublish prominent.

## UX state machines

State registry is **only** `22-canonical-state-machines.md`; route/stage contract is `21-studio-ux-screen-contract.md`. All customer-facing statuses are server-derived read models, not direct provider billing rows. Per-direction pending/1-of-3/2-of-3/3-of-3 cards must remain inspectable with stable operation IDs even on reconnect, while unfinished bundle cannot proceed to the normal concept selection/final path. Wallet quote accessible with insufficient balance; authorizing requires verified funds/rights/fresh explicit consent. Promo is distinct from bundle, including repeated direction. Studio final choices (`Use`, `Save`, `Request quoted revision`, `Report problem`) cannot cause implicit financial reversal. Vendor cost labels hidden. Final art acceptance is not provider financial settlement and not printer human QA. No blind paid retry and no fake completion percent.

Each stage must render loading, blank, persisted partial, error, case/reconciliation and revoked-capability states where relevant. For accessibility test mobile 320x480,390x568,390x844, keyboard open, 200% resize, stable ARIA live and numerical mm controls. Customer cannot use paid bundle when no rights-qualified Standard final and downstream digital/physical use. Guest brief drafting and BYO editor remain independently available; bounded nonbillable Director execution requires verified identity as specified by ST-04. [E01–06]

## Accessibility and reliability

Semantic labels, keyboard manipulation/alternative numeric placement controls, text contrast, responsive 320+ width, touch dragging guard rails, input validation, autosave conflict messages, WCAG 2.2 AA aspiration with measured automated/manual audits. UI must not render hidden exclusive content in image-only non-accessible form; mockup alt text and captions where appropriate. Avoid unexpected expensive generation on Enter or automatic rerenders while adjusting layers.

## SEO and indexing technical policy

Server-render crawlable home/catalog/collection content, canonical URLs, robots disallow private drafts/account/checkout, noindex unmoderated gallery drafts, OpenGraph cards only for approved public derivatives, structured product data from Medusa only when real prices/availability verified, sitemap incremental. User prompts and private artwork never indexed. Use analytics and UTM attribution only with appropriate user consent.
