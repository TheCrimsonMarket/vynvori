# 09 — Dedicated Medusa Cloud commerce project

## Deployment and responsibility

Founder locked a **new dedicated Medusa Cloud project** for Vynvori, not the existing organization's store. Code under `apps/medusa`; independent Medusa database, deploy credentials, payments, webhooks, admin users, inventory and sales config. Vynvori front end remains Next.js. Medusa version/API behavior must be pinned and validated before coding customizations; do not infer unchanged starter samples.

## Initial catalog

One black oversized T-shirt product family with approved size variants; no color selector beyond black at MVP. Configurable garment unit pricing (test anchors $29/$39/$49 are **research anchors**, not go-live prices). Size guide/version, stock location in Bangladesh, variant-level stock and low-stock alerts, labels and images. Stock consists of 50–100 intended unprinted blanks; custom designs printed per order, not preprinted SKU per design. Inventory reservation semantics should be tested for preorder/backorder setup. Do not permit oversell unless fulfillment policy explicitly approves.

## Personalized cart representation

Medusa line item or custom priced item refers to frozen Vynvori `composition_version_id`, artifact/rights validation receipt (opaque signed quote ID), print zones requested, garment variant and validated price components. Do not attach raw image bytes or trust browser-provided amount to line-item metadata. Same variant with different frozen compositions must remain distinct priced line items; verify Medusa merging behavior and apply unique personalization key if needed.

### Trusted cart API

1. BFF authenticates central identity→Medusa customer bridge, validates composition ownership, version lock, source rights, supported print zones and supplier profile.
2. Vynvori returns short-lived price quote with deterministic hash of composition, print profile, size, print-zone prices, tax policy, currency and expiration.
3. Medusa custom workflow revalidates signed quote and applies **server-authoritative** print/add-on charges. No trust in client price, discount or owner ID.
4. Cart line item records immutable references. Validate again before final payment/order creation to defend mutation, stale pricing, deleted composition or stolen refs.
5. Commerce owns taxes, shipping, payment provider, capture/refund and order state; Vynvori listens to authoritative lifecycle events.

## Payments and digital products

Credit packages and high-res composition exports are legitimate commerce SKUs/product types with entitlements granted only after verified successful capture. No provider selected until legal merchant and payment eligibility approved. Avoid direct custom wallet payments bypassing Medusa for now. Maintain refund/chargeback reconciliation. Credit packages and physical garments may have distinct tax treatment requiring verified rules.

## Human QA hold and fulfillment

Every personalized order is placed on Vynvori production hold after paid verification; Medusa Admin extension shows pending QA/proof. Fulfillment cannot create print release for these line items until Vynvori records human approved state. When partner reports print/pack/shipping events, Medusa fulfillment records updated through verified service connection. Keep production state in Vynvori, commerce fulfillment state in Medusa, reconcile transitions.

## Shipping

- US: Bangladesh direct to customer. Actual carrier quotations, customs/duty handling, rates, return sender, transit ETA and packaging need approval.
- Australia: default economical consolidated shipments via Marcus; dispatch by minimum economical batch or maximum wait deadline, whichever first. At deadline choose lowest cost feasible method meeting customer promise; otherwise customer agrees alternate or refunded/cancelled. Do not silently delay/add fees. International/import/GST and local Australian postage are cost inputs and must be valid at checkout.
- EU deferred operational prioritization; module should remain extensible.
- Initially admin-verified/manual rate tables and dispatch procedures, not fabricated dynamic carrier API integrations; ensure storefront ETA grounded in effective rate table version.

## Promotions

One print placement included in configured base price; additional supported print placements charged separately. Founding customer discounts capped. Credit design-spend redemption validated by Vynvori with single-use benefit ID, delegated to Medusa pricing/promotion with correct financial ledger reconciliation. No duplicate redemption, discounts exceeding approved contribution floor, or automatic refund of spent credits.

## Identity and admin

Centralized SSO through **verified LuckyLittleDevil bridge**. Customer identity mapping cannot be based on email alone. Medusa Admin staff access separately controlled and audited; do not grant customer sessions Medusa Admin privileges. Pending review of exact Lucky Medusa extension.

## Non-goals

Multiple businesses on shared Medusa instance; fully custom checkout/order engine; creator marketplace payouts; real-time shipping APIs before validation.

## Medusa references

Start at https://docs.medusajs.com/ for current Medusa v2 modules/workflows and custom pricing, customer authentication provider, order module, Medusa Cloud monorepo deployment; verify actual installed APIs before authoring code.

## Medusa quote, consent and paid-offer boundaries (v1.1)

Medusa is authoritative for actual merchandise/cart/order/payment/shipping/discount/refund; Neon owns CreativeBrief, design versions, wallet and credit receipts, project rights, print proof/QA and supplier release. A `compositionQuote` references a frozen scene/version, validated size/placement/zone, authoritative product variant and verified region/tax/carrier rule, with server-generated signed expiry and Medusa custom-priced cart line. Never trust browser-submitted personalization price or market zone. Digital art final/paid composition export are distinct Medusa product/entitlement contracts; no double charging unchanged owner originals.

For AI credit top-ups, Medusa payment capture must be verified via fetch-and-reconcile before single Neon grant. Buying credits never auto-consents to an old Studio quote; new quote/approval required. Full-journey bundle may be sold only when qualified final and a rights/region-valid downstream use are available; checkout orders require their own supplier/merchant/shipping readiness. Partial redemption of eligible consumed design spend is versioned and margin-gated, not an automatic unrestricted wallet discount. [F-R02,F-R07,E01–03]
