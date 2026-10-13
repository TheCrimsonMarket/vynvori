# 19 — Transactional notifications, event taxonomy and data protection

## Channel policy

Email first for paid transactions and operational events, SMS optional later. Organization SSO may already own identity/verification emails; **do not duplicate those without reviewing its configuration**. Medusa or approved provider handles commerce notifications as appropriate, Vynvori Workflow SDK handles design/print-related status notifications; prevent double sends with notification idempotency key.

## Required transactional events

| Trigger | Recipient | Message semantics |
|---|---|---|
| Account or session issue | customer | SSO provider standard behavior (verify) |
| Credit top-up paid | customer | purchased units, balance, receipt/reference, contact link |
| AI job pending/completed/failed/unknown | customer | honest state, settlement/refund and next actions |
| Digital export purchase/ready/failure | customer | secure account link, no permanent artwork attachment |
| Paid T-shirt order | customer | composition snapshot, size, charges, duty/shipping statement, ETA |
| Artwork needs revision/proof consent | customer | signed-in approval, cancellation/fallback options |
| Print QA approved / dispatched / delivered | customer | accurate status from authoritative states |
| Shipping delayed or impossible | customer | consent options, updated date or cancellation/refund |
| Fraud/support/manual hold | authorized staff | secure dashboard link only, limited PII |

Notification log fields: event ID, template version, locale, recipient customer ID, delivery provider message ID, status, dedupe key, created_at; don't retain sensitive body unless needed under privacy policy. Dead-letter/retry for provider failure. Never place bearer tokens or signed production asset URLs in email.

## Analytics taxonomy

- Acquisition: `landing_viewed`, `campaign_attributed`, `waitlist_joined`, `product_viewed`.
- Studio: `studio_entered`, `entry_path_selected`, `brief_completed`, `concepts_requested`, `concept_selected`, `refinement_requested`, `final_tier_selected`, `final_delivered`, `version_used`, `quality_case_opened`.
- Composer: `composer_entered`, `asset_uploaded`, `layer_added`, `composition_saved`, `mockup_previewed`, `print_zone_selected`, `composition_quoted`.
- Commerce: `cart_started`, `checkout_started`, `payment_succeeded`, `order_created`, `order_refunded`, `shipment_dispatched` (from authoritative server state).
- Community: `gallery_viewed`, `publication_requested`, `publication_approved`, `design_shared`, `design_liked`.

Event data should include opaque session/user ID, source campaign, feature version, selected flow, region only at permitted granularity. Do not log user artwork URLs, raw prompts, address, phone or email into analytics. Track guest↔account identity migration with permission-compliant events and no duplicate conversion counting.

## Metrics

Acquisition funnel conversions and event loss, AI cost per accepted output, per-provider edit success/retry, credits purchased/spent/remaining, mockup-to-cart rate, BYO vs AI conversion, price/size selection, QA lead time, defect rate, fulfillment on time, contribution before acquisition and refund/chargeback rates. Payment-derived revenue only from Medusa captured/refunded records, not from client `purchase` events alone.

## Mandatory paid AI customer and operator notifications (v1.1)

Notifications are M8a critical prerequisite rather than deferrable M8b feature: package authorization receipt; per-slot partial failure; provider unknown/ledger hold under reconciliation; resolved verified outcome; route qualification revoked after purchase; case created/assigned/status/remedied; final delivered; objective nonconformance decision; artifact persistence failure; closure pending and verified closure; remaining-slot forfeiture disclosed before final submission. Messages show customer amount held/settled/released and action, not provider internal invoice/cost. Delivery logs must be immutable and replay-safe, with approved numeric response/max-hold deadline and assigned operator before enabling paid flags. Do not provide invented shipment ETAs. [F-R05–08,E02,E04]
