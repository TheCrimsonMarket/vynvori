# 10 — Cross-system events, idempotency and reconciliation

## Why this exists

Medusa and Neon do not share a transaction. A captured payment, credit grant, production hold and refund cannot be atomically written in one database. Build eventual consistency with explicit ownership, durable outbox/inbox, dedupe, retry, and reconciliation. Webhook receipt alone is never final proof that an external balance changed.

## Event envelope

```json
{
  "eventId": "evt_opaque_unique",
  "eventType": "commerce.payment_captured.v1",
  "occurredAt": "2026-10-13T00:00:00Z",
  "producer": "vynvori-medusa",
  "schemaVersion": 1,
  "aggregateType": "order",
  "aggregateId": "order_medusa_id",
  "correlationId": "corr_123",
  "idempotencyKey": "order_medusa_id:capture_id",
  "payload": {"orderId":"...","captureId":"...","status":"captured"}
}
```

Authenticity: signed HMAC or compatible managed message signature, secret rotated, timestamp/nonce/replay bound, TLS, producer allowlist and payload validation. Do not put customer address, payment details, artwork bytes or raw model prompts on event bus. Get full authoritative order/payment state from Medusa before granting entitlements.

## Outbox/inbox algorithm

- Producer commits business change and outbox row in same local DB transaction where possible (Medusa module/workflow extension equivalent for its own DB). Dispatcher retries with exponential backoff plus jitter, bounded attempts and dead-letter visibility; do not assume outbox in Neon can atomically reflect Medusa's own writes without Medusa hooks.
- Receiver inserts `eventId+producer` into inbox (unique) and applies local business command once in same local transaction; duplicate returns success. If payload out of order, park and re-query authoritative state.
- Explicit processed vs received distinction, poison-event logging without secrets, operator replay/admin flow and daily reconciliation of unsettled payment/capture/credit/QA/order mappings.

## Required event catalog

| Producer | Event / trigger | Consumer action |
|---|---|---|
| Medusa | payment captured on credit package | Neon credit grant with unique capture+line-item |
| Medusa | physical custom order payment captured | Freeze production job/QA hold with exact snapshot |
| Medusa | digital export payment captured | Grant export entitlement once |
| Medusa | order cancelled/refunded/chargeback | Apply entitlement/refund/reversal policy; hold/stop production |
| Vynvori | print QA approved | Medusa fulfillment command authorized only after payment/profile checks |
| Vynvori | print ready/released/partner handoff | Medusa operational order/fulfillment update |
| Medusa | shipment/tracking update | Vynvori order UX notification and local read model refresh |
| Central auth | account deactivated (if supported) | Revoke Vynvori sessions/entitlements per policy |

## States and policies

Unknown delivery: retry safely if idempotent, otherwise query source state first. Provider billing unknown: no blind retry. Medusa payment events may repeat; credit balance invariant prevents multiple grants. Refund received after a production job is released: hold future steps if possible and escalate manual operations. Compensation is logged (do not erase history).

## Contract versions

Persist payload version, immutable event ID, producer and `schemaVersion`. Schema compatibility rules: additive fields permitted, breaking fields require new version and dual consumer until migration. Tests serialize fixtures for every event version.

## Integration tests

Duplicates, out-of-order delivery, receiver crash after DB commit before ack, Medusa outage during grant, Vynvori outage after capture, wrong signature, replay outside allowed timestamp, partial refund, failed checkout with stale composition, late refund during fulfillment, manual incident replay, reconciliation alert after induced mismatch.
