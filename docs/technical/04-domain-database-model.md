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

See the **sole canonical lifecycle registry** in `22-canonical-state-machines.md` §Plane E — Production QA / fulfillment. Do not use the v1.0 `waiting_payment`, `qa_pending`, `released`, `handed_to_carrier` as production states. Payment remains Medusa guard; provider execution and render attempts are separate. `production_jobs.state` is exactly:

`pending_asset_verification | preflight_pending | preflight_blocked | awaiting_human_qa | needs_customer_reapproval | approved_for_print | released_to_partner | printing | printed | packed | awaiting_dispatch | shipped | delivered | cancelled_before_release | production_exception`.

A release-to-partner transition requires a fresh authoritative Medusa payment check, verified current composition/profile/proof hashes, no blocking refund, and an append-only authorized HUMAN QA decision. Printer acknowledgment is an event, not approval. No unpaid cart can instantiate a printable production job. State values and transitions must be runtime validated. [Phase6A/6B production reconciliation]

## Multi-DB consistency

No distributed DB transaction across Medusa and Neon. Use transactional outbox/inbox, idempotent Medusa workflow/handlers, compensating commands where safe, and scheduled reconciliation. Store `medusa_order_id`, `order_line_item_id`, `payment_capture_id`, `customer_id`, and immutable composition/price quote IDs in a separate mapping table as appropriate.

## Secrets and migrations

Neon pooled connection via `DATABASE_URL`; controlled direct/admin migration URL optional only if official driver/migration operations require it; no staging connection in production. Drizzle ORM/Kit versions pinned to tested compatible versions, with generated SQL included in PR. Medusa migrations remain Medusa-native in its own deploy lifecycle.

## v1.1 Studio persistence additions (v1.1)

Extend the *representative* Neon entity catalog (exact Drizzle migrations require separate review):

| Entity | Fields / invariant |
|---|---|
| `director_plan_versions` | `id`, `project_id`, `brief_version_id`, `directions[3]`, `approval_hash`, `approved_at`; immutable once approved, exactly three distinct direction IDs |
| `studio_packages` | `id`, `owner`, `plan_version_id`, `offer_snapshot`, `capability_snapshot`, `state` (`quoted/authorized/partial/delivered_3_of_3/open_for_refinements/closure_pending/closed/remedy_pending`), `policy_version`; unique active package per approved offer intent |
| `concept_slots` | `package_id`, `slot_no in (1,2,3)`, `direction_id`, `operation_id`, `persisted_design_version_id`; unique package+slot and package+direction; **none before approved plan** |
| `refinement_slots` | package, ordinal 1/2, `state=available/skipped/pending/unknown/used/forfeited`, selected source/branch and operation refs; `skipped` reversible while open; `used` after valid delivered refinement |
| `promo_claims` | stable `(issuer,subject)` uniqueness, direction/plan, `claim_state`, `operation_id`, artifact/rights, audit timestamps; claim uncertainty requires reconciliation |
| `capability_snapshots` | versioned jurisdiction, licensed final route, concept route, digital-export rights, garment availability, effective policy and evidence timestamps; recheck at quote authorization and final operation |
| `studio_quotes` | immutable quote kind, approved plan mapping, price policy, expected balance, expiration, rights snapshot and display disclosures |
| `quality_cases` | customer, project, operation, issue class, evidence, state, assigned operator, notification audit, authorized remedy record |
| `financial_receipts` | operation/quote/reservation id, customer displayed held/settled/released units and ledger cause; vendor billed USD stored separately/internal |
| `render_artifact_manifests` | original+derived+master hashes, rights profile, renderer, source lineage, print profile version; immutable referenced records |

Use transactional constraints/outbox to create all three `concept_slots` only on approved plan+authorized bundle; no placeholder IDs. `plan_version_id` and branch lineage are never reassigned when briefs or selected source change. Retain partial outputs even when bundle completion is blocked. [F-R01–08,E03–05]
