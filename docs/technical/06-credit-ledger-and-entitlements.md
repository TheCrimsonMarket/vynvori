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

Medusa purchased digital export SKU/order line item → confirmed payment → Neon entitlement linked to exact composition version/render profile → generate/export on Cloud Run → store private R2 object → short-lived owner-specific download link. No re-charge for downloading the same purchased artifact within entitlement window; re-render with changed artwork may require new entitlement under disclosed rules.

### Physical shirt partial redemption

Eligible credits are **spent** on the customer's own design project and separately tracked as potential order discount; this is **not** re-crediting wallet. Quote stage validates project ownership, eligible consumed spending, max applicable %/USD, fixed order, currency and remaining entitlement. Reserve redemption for a single cart (TTL), atomically consume after captured Medusa payment, release on abandoned cart, and reconcile on refund/partial refund. Discount never exceeds configured garment contribution guardrail. Do not double-redeem across carts/claims.

## Reporting and reconciliation

Keep (a) actual API/provider usage vs invoice, (b) customer credits charged, (c) promotion cost, (d) payment and FX fees, (e) redemption liability, (f) model acceptance/retry rates, (g) digital export storage costs. Daily wallet invariant check and orphaned reservation recovery. Alert any mismatch of payment to grant, consumed credits to executions, and Medusa discount to redemption entitlement.

## Test matrix

Simultaneous requests against 1-credit wallet; duplicated payment capture; provider timeout after billing; provider returns artifact but DB write fails; webhook replay/out-of-order; refund after partial credit consumption; unauthorized redemption; concurrent carts reuse entitlement; digital export paid then failed render; guest attempts credit purchase without account; rounding of fractional USD costs; package fee scenario.
