# Founder decision memo

## 1. Answer

Use OpenRouter as the funded primary gateway and keep fal as a specialized extension. This is a management recommendation, not a model-quality winner. Standard/premium/preview/refinement winners and runner-up routes are N/A until both blind reviews and applicable production gates pass.

## 2. Evidence

28 delivered images from 30 submitted requests; 0 unresolved requests. Provider-reported usage charges total **US$1.281835**, within the US$10 authorization and US$9.50 inference cap. Invoice-confirmed spending is a separate field; do not treat usage as an invoice. See the generated CSV for p50/p95 latency, output checksums, PPI, alpha and error reasons.

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

Blind artwork scores and accepted counts remain N/A until two independent reviews. The technical inspection uses provisional DTF, 300 x 400 mm, 300 PPI. Native output failures cannot be overridden by attractive artwork. Small-placement suitability differs from full-zone suitability.

## 3. Pricing

Minimum proposed top-up: US$5. Final credit denomination, per-operation price, standard/premium bundle and redemption rate remain N/A. Measured API cost is available; accepted-design and full-session cost need reviewers plus processing/payment/funding-fee assumptions. The simulator preserves 3x/3.5x/4x scenario slots without inventing those values.

## 4. Known risks

One concept trial per brief; no physical print tests; single common mascot edit source; abstract procedural moodboards; token-billing variability; unconfirmed production fees. Nano Banana 2.1 returned two unbilled 429s and was explicitly replaced by Nano Banana 2. fal/Ideogram and Higgsfield remain untested. Seedream's exact reseller territory terms need confirmation before a US-serving production route. Catalog model IDs are not guarantees of immutable weights.

## 5. Decisions required from founders

Import two independent blind score files; adjudicate disagreements; choose qualified operation/tier routes; obtain supplier print specifications and physical samples; reconcile usage with provider exports/receipts; provide payment/processing and garment-margin inputs; approve digital-download/gallery/resale rights and any redemption entitlement. No extra API spending or account funding is assumed.

## 6. Suggested next business-plan work

Resume design-studio UX and manufacturing/export feasibility with these real assets and unresolved gates. Keep naming/trademark, full-order unit economics and checkout implementation separate. Re-run a larger repeat-trial benchmark only if required by inconclusive evidence or changed model behavior.
