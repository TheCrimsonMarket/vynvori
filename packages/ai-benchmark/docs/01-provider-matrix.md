# Provider decision and capability evidence

Checked 12 October 2026. Operator chose OpenRouter + fal; only OpenRouter is funded. Recommendation: use OpenRouter as the first integration/billing surface, and enable fal when a qualified specialized image endpoint is necessary. This recommendation concerns management convenience, not artwork quality.

| Surface | Benefit | Tradeoff | This experiment |
|---|---|---|---|
| OpenRouter | Unified discovery, generation and reported request costs; provider pinning | Model/provider terms still apply; fee and routing behavior need accounting | Live four-family screen |
| fal | Specialized image endpoints, persistent job IDs and queue polling | Separate account; schema varies by model; invoice export needed | Adapter mocked; zero paid cap |
| Replicate | Broad hosted catalog and custom model hosting | Input/output or runtime billing depends on endpoint; another account | Researched alternative, not tested |
| Direct Google/OpenAI/BFL | Direct billing/control and vendor features | More accounts, billing exports and adapter contracts | Official APIs/terms reviewed; no direct comparison |
| Higgsfield | Official multi-model media API and async jobs | Endpoint prices differ; exact candidate not shortlisted with this budget | Researched, no live test/adapter |
| Ideogram direct | Official generation/reference contracts | Separate account; newest version differs from tested fal v3 contract | Researched; fal v3 contract implemented |
| Midjourney | Manual artistic reference possible | No authorized automated path established here | Outside automated rankings |

The endpoint snapshots in `data/research` are the primary capability/pricing evidence. A parameter absent from an endpoint is rejected locally. Runtime routing pins a `provider_tag` and disables fallback. Catalog presence does not prove account-specific access or an immutable model version.

| Exact candidate | References | Concept/edit/final | Requested concept | Requested final | Notes |
|---|---:|---|---|---|---|
| google/gemini-nano-banana-2.1 | 14 | advertised yes | 1K, 1:1 | 2K, 3:4 | Two unbilled 429s; unavailable in screen |
| google/gemini-3.1-flash-image | 14 | yes | 1K, 1:1 | 2K, 3:4 | Explicit earlier-model replacement |
| openai/gpt-image-2.5-sunburst | 16 | yes | medium, 1:1 | high, 3:4, transparent | Native pixel dimensions measured rather than imposed unsupported size |
| black-forest-labs/flux-3-image | 10 | yes | 1K, 1:1 | 2K, 3:4 | Per-image resolution-tier pricing |
| bytedance-seed/seedream-5-0-flash | 14 | yes | 1K, 1:1 | 2K, 3:4 | Separate territory review required for US production |
| fal-ai/ideogram/v3 | three style references in this protocol | concept only in adapter | square_hd, BALANCED | N/A | No masked editing inferred from style-reference generation |

Masking is unsupported by the current normalized requests and rejected. Native transparency is requested only on the documented OpenAI route. No other model is silently given a background-removal service. No unsupported cross-provider seed promise is made. Temporary fal URLs are downloaded immediately; exact expiration is UNVERIFIED. OpenRouter buffered images are base64 bytes. Batch and watermark behavior are not assumed; original bytes are retained.

Sources: [OpenRouter Images API](https://openrouter.ai/docs/guides/overview/multimodal/image-generation), [OpenRouter terms](https://openrouter.ai/terms), [fal Ideogram schema](https://fal.ai/models/fal-ai/ideogram/v3/api), [Replicate pricing](https://replicate.com/pricing), [Higgsfield quick start](https://open.higgsfield.ai/quick-start), [Ideogram API](https://developer.ideogram.ai/api-reference).
