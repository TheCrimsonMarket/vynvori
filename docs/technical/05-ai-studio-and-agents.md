# 05 — AI Design Studio and controlled agents

## User experience

Two public entry points into the same creation engine: **Guide Me** visual wizard (`niche`, aesthetic, palette, optional exact phrase, reference moodboard, restrictions) and **Create Freely** prompt-first mode. Both normalize into a versioned `CreativeBrief`. Guest users may prepare briefs but must authenticate to receive their one-time promotional preview or initiate any billable generation. Default design visibility private.

## Bounded design workflow

**Authoritative sequence** (F-R01–F-R08; UI projection detailed in `21`, machine ownership in `22`):

`guest guided/free brief → verified identity / guest claim → bounded nonbillable Director plan → customer reviews and approves three distinct directions as one frozen plan → offer choice (optional separate promotional preview) → valid paid bundle quote + explicit consent → exactly three newly generated versions, one per approved direction → inspect 0/3..3/3 persisted results → choose a completed concept (only 3/3 permits ordinary progression) → optionally use/skip up to two included refinements on explicitly selected source branches → qualified separately quoted final authorization → persisted final delivery → package closes; user may Use, Save, report objective defect, or request new quoted revision → optional independent editor/digital export/Medusa checkout`.

Plan changes require a new plan version and invalidate old quotes; purchased slots remain attached to their original approved directions. Planning and ordinary plan revisions are bounded platform overhead, not customer credit charges. A promotional output cannot be counted among the purchased three. Partial versions remain accessible; unresolved slots block selection/final progression pending recovery/case. Skip is reversible while eligible, not an execution. A refinement slot becomes used on verified delivered valid output, independent of subjective preference. Informed final submission puts closure in `closure_pending`; successfully persisted final delivery closes unused included slots only under disclosed and approved terms, while unknown/undelivered operations do not silently consume/forfeit. No numeric expiration is invented.

**Prepurchase capability gate:** paid full-journey package is disabled unless rights-qualified Standard final route and at least one eligible downstream use (licensed digital art export or supported physical production) exists **for that user's region and intended rights**. Showing a quote with insufficient wallet balance is allowed; authorization is guarded, revalidated, and reconfirmed after top-up. An interrupted downstream capability post-purchase pauses service-caused expiry, preserves entitlements/artifacts, notifies, opens case and offers consented alternative or approved remedy. Standard final availability is distinct from actual supplier physical print qualification; Premium is hidden until independently qualified. [E01,E02]

## Model registry

Versioned rows specify provider gateway, exact identifier, input editing support, multiple references limit, aspect ratios, transparency, resolution, estimated & observed costs, latency percentiles, license/geography approval and qualification results. Expose tiers `standard|premium`; advanced selector only lists models with current qualification for the requested operation/region. `premium` disabled until a meaningful superior qualified route confirmed, not just more expensive branding. Use controlled rollout and fallback with **user price consent** for route changes.

## Benchmark reuse

Existing CLI at `packages/ai-benchmark` contains `src/model-router.ts`, `providers/openrouter.ts`, `providers/fal.ts`, `cost-meter.ts`, `economics.ts`, tests/fixtures and provider research. It is an **experimental harness**, not the authoritative production router. Extract logic to `packages/ai` only with independent tests, provider API validation, safe credentials, identity/quotas, idempotency, retries, model qualification and metering. Preserve reproducibility of benchmark.

Prior screening results: 28/30 delivered, total provider-reported API usage ~$1.28 (not invoiced), GPT Image quality promising, Seedream low-cost but reseller territorial rights unresolved, Nano Banana 2.1 originally unavailable due 429. None achieved provisional full-size native print gate; no physically qualified winner. Do not hardcode model winners or price denominations.

## Workflow execution

1. Validate authenticated account, asset rights and content policy. Resolve immutable brief/version and model capabilities.
2. Present exact credit quote and operation parameters to customer; require explicit confirmation.
3. In Neon transaction create execution record and reserve quoted maximum credits; check eligibility and rate limits.
4. Start durable workflow with execution ID. Call provider with stable external idempotency key if supported; persist submitted provider request ID immediately.
5. Persist original provider bytes in R2 privately; compute digest, mime, dimensions, alpha and provenance. Produce derived preview separately.
6. Validate operation outcome and commit ledger settlement or refund, publish design version and notify UI. A provider response timeout is `unknown`, not automatically refundable or safe to reissue.
7. Reconcile unknowns from job-status APIs/provider invoices; do not silently retry if duplicate charge possible.

## Editing consistency and exact typography

Treat source artwork and precise phrases as separate assets/layers whenever feasible. AI model changes may alter identity/pose/layout; preserve selected approved version. When customer changes providers at final render, create a new draft and require explicit acceptance before replacing prior version. Optional text-only overlays can be edited in garment composer with deterministic vector text rather than asking AI to regenerate exact phrasing.

## Risks and mitigations

User reference copyrights, gaming publisher IP, unsafe content, excessive moderation false positives, prompt injection through uploaded references, adversarial image metadata, uncontrolled tokens, queue failures, model version drift and failed previews. All provider tool outputs are untrusted. Store actual usage/billed cost without exposing raw prompt/reference assets in monitoring. Require licensed model API for US/AU distribution.

## Acceptance tests

Different entry paths produce equivalent `CreativeBrief`; free preview only once per canonical identity; malformed reference rejected; quota enforced; 3 distinct concepts saved as immutable versions; up to 2 optional included refinements versioned with restore; unauthorized users cannot view designs; charge confirmation exact; concurrency preserves ledger; timeout→unknown needs reconciliation; premium unavailable before qualification; printability not inferred from model score.

## Independent execution, plan freeze and final-review outcomes (v1.1)

Creative Director plan is versioned and immutable on customer approval; three slot IDs are allocated only after the plan is approved and paid bundle authorized. Track separately: `studio_project.stage`, `provider_execution.state`, `asset_persistence.state`, `credit_reservation.state`, `quality_case.state`. Submitted provider request ID and operation idempotency key must be durable before status polling; unknown results never cause blind reissue. Provider successful output with failed R2 persistence is **not** a delivered customer artifact. Never expose vendor charge evidence as a customer debit label.

User final choices are `Use this version`, `Save without using`, `Request another revision (quote required)`, `Report a quality problem`. Successful delivery and credit settlement are separate from selection. An objectively nonconforming final goes to case review and correction/remedy; subjective dislike is not automatic refund. Supplier print approval is an additional independent stage. Paid operation must not go live without M8a support, remedies and approved financial/response SLA. See `22` and `23`.
