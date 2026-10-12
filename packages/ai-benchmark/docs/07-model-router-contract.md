# Versioned routing contract

Benchmark contract: `Task(operation, exact modelId, requested parameters, sourceTaskId)` → `ModelRouter.resolve` → local capability validation → budget/key preflight → native adapter → `ProviderResult(bytes, requestId, reported USD, usage, warnings)` → technical inspection and durable RunRecord.

Version 1 production request should add operation/tier, territory, tenant/design ID, idempotency key, rights-qualified reference IDs, capability requirements, approved ceiling, and qualified routing-manifest version. Response should expose job state, exact attempted routes, native artifact ID/hash, warning codes and invoice/usage/estimate classification.

Benchmark routing intentionally has no automatic fallback. An unavailable exact model is not silently relabelled. Nano Banana 2 is an explicit protocol amendment with its own records. Native endpoint settings are validated per endpoint; model-level union capabilities are insufficient for provider pinning.

Production routing is only allowed across qualified routes matching operation, territory, tier and all capabilities. Reserve the next route's bounded allowance first. Retry ambiguous requests by retrieving the existing job, not posting again. Failed prior attempts and charges remain attributed to that route. Price or quality downgrades require the product's explicit downgrade policy and the customer's bounded authorization.

Future AI SDK adapter can wrap the native Image Tool response while preserving the dedicated image endpoint's provider pinning and `usage.cost`; do not lose reference count checks or asynchronous IDs behind a generic interface. Production Workflow/Neon adapters are follow-on work, not proven by this local router.
