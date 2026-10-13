# 04 — Neon/Drizzle domain model and invariants

## DB boundaries and migrations

The dedicated Medusa instance owns commerce data in its independently managed DB. Vynvori Neon PostgreSQL owns creative/credit/QA/gallery data. Cross-system references are text IDs with unique indexes, **not DB-level FKs to Medusa**. Migration source is Drizzle Kit + reviewed SQL. Use `node-postgres` (`pg`) pooled connection from serverless Node runtime for transactions. Use `timestamptz` UTC, UUID/ULID IDs, soft-delete/retention where required, immutable financial history. Every row with customer ownership must have `owner_user_id` or a chain that resolves to it.

## Core entities (representative schema, adapt after migration review)

| Entity | Key attributes | Important constraints |
|---|---|---|
| `user_profiles` | `id`, identity issuer, identity subject, `medusa_customer_id`, status, created_at | UNIQUE(issuer,subject); UNIQUE(medusa_customer_id) nullable |
| `guest_sessions` | opaque id hash, expiry, quotas, migration state | scoped capability; no raw token persisted |
| `creative_briefs` | `id`, owner, entry_mode, normalized structured brief JSON, refs, schema_version | `entry_mode=guided/free`; mutable until generation freeze |
| `design_projects` | `id`, owner, brief_id, title, privacy, status, timestamps | private default; RBAC/ownership |
| `design_versions` | `id`, project_id, parent_version_id, asset_id, source_model_execution_id, kind, metadata JSON, created_at | append-only; never mutate asset IDs |
| `model_registry` | provider, exact_model_id, capabilities JSON, qualification flags, jurisdiction/rights, unit pricing profile | availability != qualified; version/time-bound |
| `model_executions` | `id`, project, operation, model snapshot, provider job ID, idempotency, status, actual metered cost, artifact id, error | UNIQUE(provider,provider_job_id) where present; unique idempotency |
| `assets` | `id`, owner, type, object_key, sha256, mime, pixel dims, bytes, alpha, provenance, rights status, retention | object key private; checksum unique only where suitable |
| `compositions` | id, owner, current_version_id, garment product family, status | no AI dependency |
| `composition_versions` | id, composition_id, version, scene_json, source hashes, created_at, frozen_at | immutable snapshots when quoted/ordered |
| `print_profiles` | id, supplier, print method `DTF`, zone, dimensions, bleed, effective resolution policy, accepted formats, active_from | draft/approved status; supplier approval needed |
| `print_checks` | composition_version_id, profile_version_id, warnings, hard_errors, renderer hash, pass/fail | deterministic reproducible result |
| `production_jobs` | id, order_id, medusa_line_item_id, composition_version_id, profile_version, state, idempotency | UNIQUE(order_id,line_item_id) under appropriate unit split |
| `qa_decisions` | production_job_id, actor/staff ID, proof asset ID, decision, reason, timestamp | append-only; authorized human identity |
| `digital_entitlements` | owner, export_id, medusa_order_item_id, state, download expiry | UNIQUE(order item, export variant) |
| `gallery_posts` | id, owner, project id, approved asset derivative, status, consent_version, published_at | explicit opt-in; no originals exposed |
| `gallery_likes` | post_id, user_id, created_at | UNIQUE(post_id,user_id) |
| `rights_grants` | owner, project, scope, agreement version, status, revoked_at | independent scopes for showcase/shop/remix/export |
| `credit_wallets` | user_id, available_units, reserved_units, revision | CHECK nonnegative balances |
| `credit_ledger_entries` | id, wallet, event_kind, delta_available, delta_reserved, currency/units, source ref, idempotency, timestamp | append-only; unique cause/key |
| `credit_reservations` | id, wallet, max_cost_units, settled_units, generation id, status, expiry | one active claim per charge intent |
| `credit_packages` | SKU, granted_units, face_value_minor, currency, tax policy, active dates | configurable / immutable purchased snapshot |
| `discount_entitlements` | design project, owner, eligible consumed USD/units, redeemed amount, medusa order ref, expiry | unique redemption; never negative |
| `integration_outbox` | id, event_key, topic, version, payload, state, attempts, next_attempt_at | committed with local state |
| `integration_inbox` | event_id+source unique, hash, status, received_at, processed_at | dedupe and replay support |
| `audit_log` | actor, action, entity, old/new state hash, event correlation, date | append-only tamper-evident preferred |

## Versioned composition scene JSON

Use `schemaVersion`, garment product reference, per-zone pages, layer arrays and immutable source IDs. Layers may be `image|text|shape` with stable layer ID, z-order, visible, locked, transform in **physical/normalized zone coordinates** (not browser pixels), anchor, bounds, rotation, scaling and optional typography (font asset, size, line height, tracking, alignment, fill, outline where supported). Include exact content hash of scene version and source object versions.

## Constraints/indices

- Composite `(owner_user_id, id)` or indexed owner filter for per-request access.
- Ledger CHECK `available_units >=0`, `reserved_units >=0`; transactions serializable where justified or atomic conditional updates+uniqueness under `READ COMMITTED`; append-only writer access.
- Unique event ID on inbox, idempotency per financial command, provider job ID unique where available.
- Foreign keys local DB between project→versions→assets and production job→compositions; enforce `ON DELETE RESTRICT` on referenced paid artifacts.
- Avoid cascading deletes of orders, wallet history, QA decisions or publication consent evidence.
- Store currency in integer minor units or numeric exact type, **never float** for charges; credit balance INTEGER/BIGINT.

## Suggested states

`design_version`: draft/generated/approved/superseded (immutable revision data even if status recorded elsewhere).
`composition`: draft/frozen/archived; frozen version is order bound.
`model_execution`: prepared/reserved/submitted/awaiting_provider/completed/failed/unknown/reconciled.
`production_job`: waiting_payment → preflight_pending → qa_pending → approved_for_print → released → printed → packed → handed_to_carrier → delivered; exception/cancelled/refund paths.
`gallery_post`: draft → moderation_pending → published / rejected → unpublished.

## Multi-DB consistency

No distributed DB transaction across Medusa and Neon. Use transactional outbox/inbox, idempotent Medusa workflow/handlers, compensating commands where safe, and scheduled reconciliation. Store `medusa_order_id`, `order_line_item_id`, `payment_capture_id`, `customer_id`, and immutable composition/price quote IDs in a separate mapping table as appropriate.

## Secrets and migrations

Neon pooled connection via `DATABASE_URL`; controlled direct/admin migration URL optional only if official driver/migration operations require it; no staging connection in production. Drizzle ORM/Kit versions pinned to tested compatible versions, with generated SQL included in PR. Medusa migrations remain Medusa-native in its own deploy lifecycle.
