# Evidence-backed economics

`cost-reconciliation.csv` records each submitted request, including zero-charge rejections and any failed delivery. Usage amounts are measured provider reports. Invoice-confirmed charges are a separate class. Unknown charges cannot be treated as zero. `model-leaderboard.csv` includes completed counts, known usage USD, missing charges, completed-delivery p50/p95 (linear interpolation), failures and acceptance-dependent cost.

Mandatory formulas:

- Cost per accepted output = (all associated charged requests + retry/failure expense + allocated preprocessing/postprocessing) / accepted output count.
- Session cost = 3 concept costs + 2 refinement costs + standard or premium final + creative-director/prompt costs + storage/processing allocation.
- List-price target = 4 × effective session cost; candidate discount boundary = 3 × effective cost, conditional on fees, taxes and redemption.
- Contribution = net paid design revenue − generation cost − payment fees − redemption subsidy − variable support/processing.

Zero accepted outputs yield N/A, not $0 or infinity masquerading as a price. Until both blind reviews exist, per-accepted design/session cost is N/A. Model-stage means can supply a clearly labelled API-cost-only scenario once all three stages were executed; this is not a customer-accepted session estimate.

Sensitivity rows: 3.0× / 3.5× / 4.0×; base / conservative / high-retry. Production assumptions to enter: payment percentage and fixed fee, realized OpenRouter funding-fee allocation, R2 share, Cloud Run processing, prompt-agent usage, support costs and taxes. Base retry allocation comes from observed charged failures; conservative acceptance should reflect a lower observed/pass-rate assumption; high retry should explicitly model extra concept/edit/final attempts. No arbitrary numerical acceptance probability is filled in this small screen.

No least-expensive qualified production model exists until print and territory gates pass. Raw cost advantage is reported as raw cost, not proof of lower accepted-design cost. Native-generation and editing cost can reverse after rejection, cleanup or upscaling. No guaranteed margin or population-level inference follows from one trial per brief.


## Measured API stage costs

| Model | Stage | Delivered / requests | Usage USD | Native print gate |
|---|---|---:|---:|---|
| black-forest-labs/flux-3-image | concept | 4/4 | 0.192000 | See per-image manifest; physical confirmation pending |
| black-forest-labs/flux-3-image | edit | 2/2 | 0.096000 | See per-image manifest; physical confirmation pending |
| black-forest-labs/flux-3-image | final | 1/1 | 0.100000 | See per-image manifest; physical confirmation pending |
| bytedance-seed/seedream-5-0-flash | concept | 4/4 | 0.072000 | See per-image manifest; physical confirmation pending |
| bytedance-seed/seedream-5-0-flash | edit | 2/2 | 0.036000 | See per-image manifest; physical confirmation pending |
| bytedance-seed/seedream-5-0-flash | final | 1/1 | 0.018000 | See per-image manifest; physical confirmation pending |
| google/gemini-3.1-flash-image | concept | 4/4 | 0.275173 | See per-image manifest; physical confirmation pending |
| google/gemini-3.1-flash-image | edit | 2/2 | 0.136151 | See per-image manifest; physical confirmation pending |
| google/gemini-3.1-flash-image | final | 1/1 | 0.101741 | See per-image manifest; physical confirmation pending |
| google/gemini-nano-banana-2.1 | concept | 0/2 | 0.000000 | N/A |
| openai/gpt-image-2.5-sunburst | concept | 4/4 | 0.154284 | See per-image manifest; physical confirmation pending |
| openai/gpt-image-2.5-sunburst | edit | 2/2 | 0.043144 | See per-image manifest; physical confirmation pending |
| openai/gpt-image-2.5-sunburst | final | 1/1 | 0.057342 | See per-image manifest; physical confirmation pending |

These are usage costs per attempted stage, not costs per accepted design.
