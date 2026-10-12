# Integration specification for a later build

Preserve the handoff's Next.js/Vercel, AI SDK 7 and Workflow 5, Cloud Run processing, R2, Neon/Drizzle/node-postgres stack. This repository implements only local benchmark adapters/router; no storefront, wallet charging, deployed workflow or database is provisioned.

Contracts:

- Moodboard Interpreter: input licensed asset IDs/checksums + intent; output palette, motif, composition/exclusions and uncertainty; no provider call or financial write.
- Creative Director: input interpreted brief + bounded design history; output one proposed action and rationale within operation/attempt budget.
- Prompt Curator: input brief/action; output authored/sent prompts, version and semantic differences; never approves rights or spend.
- Image Tool: exact qualified model/provider + validated capability requirements + idempotent generation job; returns durable original asset, usage/request IDs and warnings.
- Quality Check: technical gates + human acceptance; output reasons, print readiness and proposed routing qualification, never a wallet mutation.

Vercel Workflow jobs: reserve credit/inference allowance in a Neon transaction; persist a GenerationJob/outbox row; validate rights, capability and territory; execute provider operation; immediately persist R2 bytes and checksum; record UsageCharge; resolve DesignVersion; commit/release wallet reservation idempotently. A resumable workflow polls existing async jobs instead of replaying generation POSTs. Unknown charge/delivery stops automatic retry and routes to reconciliation.

Schema recommendations (UUID primary keys, timestamptz, currency USD, money in integer micro-USD / credits in integers):

| Table | Key fields / constraints |
|---|---|
| ModelCatalog | exact model+provider+manifestVersion unique; capabilities/pricing/provenance/territories |
| ModelQualification | model+operation+tier+protocolVersion; human/print evidence; expiry |
| BenchmarkRun | task/run IDs; prompt/reference/output hashes; immutable result events |
| GenerationJob | unique tenant+idempotencyKey; state; providerRequestId; reserved ceiling |
| DesignVersion | design+version unique; parent version; original/derivative asset keys; approval |
| CreditWallet | user+currency unique; available/reserved integer credits; row lock/version |
| CreditLedger | append-only debit/credit/reservation; unique job+entryType; no mutable historical balance |
| UsageCharge | provider request + charge line + source revision unique; usage/invoice classification |

Heavy image cleanup/inspection runs on Cloud Run with jobs keyed by source hash+transform version. R2 asset lifecycle separates temporary references, immutable provider original, editable typography, print derivative and preview. Use private buckets, short signed access, explicit retention/purge, and retain provenance. Rights/references do not become resale permission just because a generated file exists.

US routing requires an explicit provider/model territory qualification; Seedream's BytePlus restriction is unresolved for this exact reseller route and must fail closed for US production until confirmed. Fallbacks must preserve required masking/reference/alpha/size rights and reauthorize price differences. No qualified model means an actionable failure, not an invisible downgrade.
