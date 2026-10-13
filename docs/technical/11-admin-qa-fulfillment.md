# 11 — Medusa Admin extension, QA approval and logistics

## Admin location

Build custom Medusa Admin route/widgets for Vynvori operations where supported by pinned Medusa version. Admin actions call secure Vynvori endpoints with audited staff authorization; Medusa Admin authentication must not grant automatic access to every Neon creative asset. Role permissions scoped: support, QA reviewer, fulfillment operator, finance analyst, administrator. Separate permissions for viewing private assets, approving print, issuing refunds and editing rate tables.

## Production queue

Admin shows paid order, composition version hash, preview, print-preflight checks, supplier profile, garment size, print zones, deadline promised, gift/note and relevant fulfillment choice. Human reviewer must examine proof and gate the transition. Record decision actor, timestamp, evidence and reason. Two-person review optional policy for high-value exceptions. On rejected proof: hold, request adjustment, re-render, obtain customer reapproval for material differences, then re-review.

## Status model

Customer-visible order status is a **read-only projection** of Medusa payment/fulfillment and Neon `production_jobs.state`; it must not be a third writable state. Canonical production state names/transitions are in `22-canonical-state-machines.md` and `08-assets-rendering-and-dtf.md`. Distinguish `Checking artwork`, `Preparing proof`, `Awaiting human quality approval`, `Awaiting customer proof approval`, `Approved for production`, `Sent to print partner`, `Printing`, `Packed`, `Awaiting dispatch`, `Shipped`, `Delivered`, and `Support review`. Never show `Printing` before human QA, and never let shipping events bypass payment/partner evidence. `cancelled_before_release` is possible only before partner release; post-release cancellation/refund triggers production exception/authorized remedies as applicable.

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

## Paid AI support (M8a) before live M6b (v1.1)

Although most customer support/gallery/analytics arrive in M8b, **M8a is blocking** for any live paid image generation. Implement durable quality/billing/reconciliation cases with owner and staff authorization, customer-safe operation receipts, operator assignment/inbox, notices, trace correlation, status read, audited remedy execution with Medusa/Neon reconciliations and escalation. Require approved named operators, numeric hold limits, response/remedy deadlines and policy version prior to enabling billable operation. No unsupported time promises. [F-R06,F-R08,E02]
