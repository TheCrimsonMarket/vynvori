# 06 — Credits, paid operations and digital entitlements

## Locked commercial product behavior to encode

Minimum $5 credit package; credits for paid AI generation; guided bundle discounts; optional free first preview; Standard/Premium credit prices by qualified model; 4× normal **target** markup on **measured effective cost**, provisional 3× promotion/bundle floor, not hardcoded currency denomination. Eligible AI design spend can partially discount a later garment purchase, with cap and exact rule pending supplier margins. Free garment composition previews; paid high-resolution **composition** export; customers may retrieve their original unchanged uploaded file without a forced export payment.

## Ledger accounting

Define whole-number `credit_units`. Persist rate cards and purchase snapshots; use `quote_id`, `operation_kind`, `model`, `max_charge_units`, expiry, price_version. Reserve, settle or release in one Neon ACID transaction per state transition. An immutable ledger entry describes each debit/credit with a unique cause. Do not simply set wallet balance without a corresponding ledger entry and audited grant source.

### Transaction: authorize generation

1. Verify owner, price quote, eligibility, cancellation window and idempotency key.
2. `UPDATE credit_wallets SET available_units=available_units-:max, reserved_units=reserved_units+:max WHERE user_id=:id AND available_units>=:max RETURNING ...` executed in same `pg` transaction as reservation + ledger insertion.
3. If no wallet row updated, reject insufficient funds; if idempotency key already exists, return prior result, never reserve twice.
4. Trigger external provider only after durable transaction committed and workflow persisted. If enqueue fails, job stays recoverable; don't lose reservation.

### Settle

After artifact persisted and provider status reliable: decrement reserved by reserved amount, capture actual fixed customer charge (normally quoted, unless explicitly permitted pricing policy), return unused hold, append settlement entries. If failed uncharged, release hold. For unknown billed outcome, keep hold under limited grace and notify user while reconciling; explicit policy for eventual release/chargeback. If customer cancels after call started, provider may charge; define an upfront disclosed cancellation rule.

### Top-ups

Medusa records product purchase and authoritative payment capture. Ingest signed, verifiable event ID; verify payment/order/SKU with Medusa; `UNIQUE(order_line_item_id, entitlements_type)` for granting purchased credit units. Refund/chargeback creates reversing ledger entries according to policy (if spent, establish negative receivable/fraud workflow rather than writing wallet negative), never delete history.

### Digital exports

Medusa purchased digital export SKU/order line item → independently verified payment capture → idempotent Neon entitlement keyed to `(medusaOrderLineId, exportKind, exactSourceVersionId, exportProfileVersion)` and owner → approved rights/region check → Cloud Run immutable export → private R2 artifact ID/SHA256 verified → short-lived owner-checked download route. **Two different paid products:** `artwork_export` from a chosen immutable generated artwork version and `composition_export` from a chosen immutable frozen composition version (including typographic transforms). The source hash, kind, render profile, and finalized artifact hash are bound to the grant; `latestVersion` is never a download target. A newer artwork or scene does not inherit the older export grant unless separately approved published terms say otherwise. A captured payment with unpersisted artifact is `paid_pending_artifact`, not `ready`; export persistence failure enters `under_review` and a case without an automatic second charge. The user can download the *same entitled artifact* repeatedly during its disclosed validity window without recharging. Retrieving the user's unchanged original uploaded bytes remains free under normal owner checks; it is not a purchased export.

### Physical shirt partial redemption

Eligible credits are **spent** on the customer's own design project and separately tracked as potential order discount; this is **not** re-crediting wallet. Quote stage validates project ownership, eligible consumed spending, max applicable %/USD, fixed order, currency and remaining entitlement. Reserve redemption for a single cart (TTL), atomically consume after captured Medusa payment, release on abandoned cart, and reconcile on refund/partial refund. Discount never exceeds configured garment contribution guardrail. Do not double-redeem across carts/claims.

## Post-closure remedy policy boundary (E6E-08 — F-R04 Option A founder-approved; execution blocked)

F-R04 ordinary closure is unchanged. Verified final delivery closes the original package; objective quality/billing cases do not automatically reopen included refinements or refund settled credits. The founder **has approved Option A**: any upheld post-closure case may receive a **separately authorized replacement-service entitlement**, **immutable credit ledger adjustment** or **Medusa monetary refund**; the original package stays closed and unchanged. Every effect is case-bound, audited, idempotent, and associated with the original package/final version and approved policy. Internal staff authorization/evidence and payment identifiers are stored in protected records, **never** projected to customers; customer-facing case progress is a separate allowlisted status. Unique case-decision and scoped idempotency constraints prevent duplicate grants; retries return the prior effect or reject conflicting payloads. **Live execution remains BLOCKED** until compensation eligibility/caps, staff roles, notification and consent rules, numeric SLAs and applicable consumer-rights controls are approved. This candidate is not an implementation authorization.

## Reporting and reconciliation

Keep (a) actual API/provider usage vs invoice, (b) customer credits charged, (c) promotion cost, (d) payment and FX fees, (e) redemption liability, (f) model acceptance/retry rates, (g) digital export storage costs. Daily wallet invariant check and orphaned reservation recovery. Alert any mismatch of payment to grant, consumed credits to executions, and Medusa discount to redemption entitlement.

## Test matrix

Simultaneous requests against 1-credit wallet; duplicated payment capture; provider timeout after billing; provider returns artifact but DB write fails; webhook replay/out-of-order; refund after partial credit consumption; unauthorized redemption; concurrent carts reuse entitlement; digital export paid then failed render; guest attempts credit purchase without account; rounding of fractional USD costs; package fee scenario.

## Bundle entitlements, customer receipts, quote validation and remedies (v1.1)

Credit `quote` and financial `receipt` are versioned, per-operation contracts; internal provider USD invoices/costs never appear as a customer charge. Use one customer-visible reservation, settlement and release trail per operation with immutable cause/idempotency refs. Any provider expense alone is insufficient to prove customer liability.

**Quotes:** authenticated customer can inspect full 3+2 quote with insufficient balance. Authorize only after quote/capability/rights/policy/plan current, funds sufficient, exact three distinct direction IDs and explicit consent. Credit top-up from Medusa does not authorize generation; return to renewed quote and require another press. Package price/credits remain pending actual measured economics. Customer sees reserve/max charge, remaining available/held, final **separate**, digital/garment products **separate**, promo distinct. Never invent final prices.

**Entitlements:** one verified-identity promo preview separate from three paid concepts; two included refinement slots bound to same package and chosen source version, optional skip reversible while package open. No automatic debit for included refinements beyond approved bundle terms; deliveries consume eligible slot, with objective defects reviewed under remedy. Package close/expiry requires approved versioned terms and explicit pre-final forfeiture disclosure. During final uncertain/persistence failure, keep closure pending and unused slots held, not forfeited; verified final delivery triggers closure subject to disclosure. No hidden time-based expiration.

**Partial bundle:** 3/3 durable, rights-permitted artifacts is complete fulfillment; 0/3–2/3 show saved usable parts with resolution status, prohibit normal final advancement, and initiate verified-zero-charge recovery or operational remedy. Unknown provider charge keeps reconciliation hold; no blind retry, auto customer charge or arbitrary auto release. **Post-purchase route loss** freezes affected expiry and preserves artifacts; notice/case and consented comparable option or approved compensation/refund. Quantified hold SLA, partial compensation, case response deadlines and operator assignment are externally blocked until formally set. [F-R02,F-R04–08,E02,E04]

### Uncharged final failure versus original package closure (C-02)

Reconciliation must load the authoritative **pre-attempt original package state** by `originalPackageId`, plus its verified prior delivered-final record, before projecting failure. A verified-uncharged **first final attempt** on an open original package may return to `open` with eligible unused refinements intact once the reservation-release ledger receipt is durable. Failure of a **later separately purchased final revision** after an already delivered final never reopens its `closed` original package and never recreates/refunds old included slots. Show the revision failure and release receipt separately; replacement service or financial relief requires a new, case-bound authorization under approved operational terms. Duplicate compensation commands must be idempotent, with at-most-one effect per approved case decision.
