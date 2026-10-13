# 11 — Medusa Admin extension, QA approval and logistics

## Admin location

Build custom Medusa Admin route/widgets for Vynvori operations where supported by pinned Medusa version. Admin actions call secure Vynvori endpoints with audited staff authorization; Medusa Admin authentication must not grant automatic access to every Neon creative asset. Role permissions scoped: support, QA reviewer, fulfillment operator, finance analyst, administrator. Separate permissions for viewing private assets, approving print, issuing refunds and editing rate tables.

## Production queue

Admin shows paid order, composition version hash, preview, print-preflight checks, supplier profile, garment size, print zones, deadline promised, gift/note and relevant fulfillment choice. Human reviewer must examine proof and gate the transition. Record decision actor, timestamp, evidence and reason. Two-person review optional policy for high-value exceptions. On rejected proof: hold, request adjustment, re-render, obtain customer reapproval for material differences, then re-review.

## Status model

- `awaiting_payment`, `paid_verified`, `preflight_pending`, `preflight_failed`, `awaiting_qa`, `needs_customer_approval`, `approved_for_print`, `released_to_partner`, `printing`, `printed`, `packed`, `awaiting_dispatch`, `shipped`, `delivered`, `cancelled`, `refunded`, `manual_exception`.
- Guards: only paid and matching immutable proof/profile can enter `approved_for_print`; only admin QA role can approve; only released jobs may be printed; scan tracking event/source; no transition to shipped without parcel/label evidence.
- Every significant transition has idempotent event with actor ID or trusted service identity and audit log. Shipment/delivery states mirrored to Medusa by explicit domain command with reconciliation.

## Bangladesh partner workflow

Approved jobs → packaged print manifest → controlled partner access to artifact (short-lived scoped URL or API) → partner acknowledgement → printed proof photo → packing evidence → courier handoff. Supplier partner should not access unrelated user designs or full payment/contact data beyond necessary shipping label. Vynvori retains final QA signoff authority before sending to print; printing partner performs physical checks after printing.

## Australia consolidation

Attach order to batch candidate after print/QA. Evaluate `international_bundle_cost + import/GST/fees + Marcus_handling + local_post + delay_risk`; compare to feasible direct shipment. Dispatch when minimum economical batch is reached OR earliest customer's contractual wait ceiling is reached. At deadline, select lowest-cost method meeting promise; if none feasible, obtain consent to alternative or offer cancellation/refund. A batch manifest maps each internal shipment line item to final recipient, carrier tracking, declared values and customs documents; do not lose per-customer chain of custody.

## US direct fulfillment

Validated courier contract/rate table including all duties/taxes responsibility, truthful customer ETA and returns sender. Rate quote per parcel weight, dimensions, value, destination. Prepare correct export/customs documentation; use payment/merchant operations verification before go-live.

## Exceptions

Broken print, missing shipment, size mismatch, reprint, returns, customs delay, address edit after label printed, partial cancellation. Define state- and deadline-specific allowable operations; alert owner/staff and preserve consumer-protection rights. Track defect and on-time delivery metrics.

## Tests

Unauthorized employee cannot approve; QA approval requires exact proof hash; cancelled payment cannot print; re-render invalidates old QA approval; double-send release ignored; stale carrier status cannot regress delivery; Australia batch threshold, deadline and fallback policies tested with configurable rate inputs.
