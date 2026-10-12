# Cost provenance and budget

Operator's latest authorization: US$10 total. Existing OpenRouter balance was reported as $10.38. Dedicated lifetime key limit: $9.50, no reset. Experiment inference cap: $9.50, fal cap: $0, general reserve: $0.50. No account funding or automatic recharge is performed by the CLI.

Stage ceilings are concepts $5, edits $2, finals $2. Request planning allowances are $0.30 concept, $0.40 edit, $0.80 final. They are not provider quotes or guaranteed maxima. Token-billed jobs use provider-side key enforcement as a second control. Sequential requests and the unresolved-job stop prevent simultaneous budget reservations and uncertain resubmission. Actual charge above an allowance stops further work for review.

Saved endpoint pricing, checked 12 October 2026:

| Candidate | Endpoint list rate | What remains variable |
|---|---|---|
| Nano Banana 2.1 | $30 / million image-output tokens | Native token usage, input billing completeness |
| Nano Banana 2 replacement | $60 / million image-output tokens | Native token usage, input billing completeness |
| GPT Image 2.5 Sunburst | $5/M text input, $8/M image input, $30/M image output | Reference count and output quality/shape |
| FLUX.3 Image | $0.048 at 1K, $0.100 at 2K, $0.607 at 4K | Selected resolution tier |
| Seedream 5.0 Flash | $0.018/output image; listed input images $0 | Native output size and availability |
| fal Ideogram v3 | $0.03 TURBO, $0.06 BALANCED, $0.09 QUALITY | Account-specific taxes/discounts, not tested |

OpenRouter publishes a 5.5% Standard platform fee and a $5 credit purchase minimum in its terms. The actual prior receipt, taxes, foreign-exchange charges and any minimum transaction fee are unavailable. Fee allocation is therefore provisional, and existing deposited credits are not treated as new cash expenditure. See [pricing](https://openrouter.ai/pricing) and [terms](https://openrouter.ai/terms).

Per-request `usage.cost` is provider-reported charge evidence, not an invoice. HTTP rejection charges are reconciled against key-usage change where possible. Unresolved charges retain their reservation and block the runner. The final report separates usage and invoice evidence; no `estimate` becomes `invoice` merely because a formula fits.

Direct-vendor effective cost, upscalers, preprocessing, R2 storage, Cloud Run processing, creative-director token costs and payment fees are UNVERIFIED/not incurred in this local run. Do not turn local cost measurements into a production margin guarantee.
