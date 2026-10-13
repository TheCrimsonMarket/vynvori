# 05 — AI Design Studio and controlled agents

## User experience

Two public entry points into the same creation engine: **Guide Me** visual wizard (`niche`, aesthetic, palette, optional exact phrase, reference moodboard, restrictions) and **Create Freely** prompt-first mode. Both normalize into a versioned `CreativeBrief`. Guest users may prepare briefs but must authenticate to receive their one-time promotional preview or initiate any billable generation. Default design visibility private.

## Bounded design workflow

```text
brief_draft -> brief_ready -> creative_direction_approved -> concepts_pending
 -> concepts_ready (3 distinct concept versions) -> selected_concept
 -> refinement_1 -> refinement_2 -> final_render_pending
 -> final_approved -> optionally_open_composer / paid_digital_artwork
```

A guided bundle includes three paid-or-bundled concept options and two refinements per approved policy; one promotional preview entitlement is separate and anti-abuse protected. Additional refinements require explicit charges. The system must **not silently run** three premium generations if the selected bundle funds only standard preview operations.

The Creative Director: gather intent, propose original directions, check rights risks, ask only essential clarification questions, produce a structured plan. Specialists: prompt construction, generation tool, reference/moodboard analyzer, deterministic quality checks and optional refinement scorer. Agent calls bounded by max iterations, allowed tools, time/cost budget, moderated inputs, cancellation semantics and credit authorization. Machine-generated ratings assist triage but cannot claim physical print qualification.

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

Different entry paths produce equivalent `CreativeBrief`; free preview only once per canonical identity; malformed reference rejected; quota enforced; 3 distinct concepts saved as immutable versions; 2 revisions versioned with restore; unauthorized users cannot view designs; charge confirmation exact; concurrency preserves ledger; timeout→unknown needs reconciliation; premium unavailable before qualification; printability not inferred from model score.
