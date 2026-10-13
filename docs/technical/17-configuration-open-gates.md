# 17 — Configurable operational values and hard launch gates

## Rule

Do not invent real-world specifications or open paid functionality because a coding milestone is complete. All values below are typed operational configuration with `source`, `verified_by`, `verified_at`, `effective_from`, and `approval_status`. Production actions are blocked until required values are approved.

| Area | Founder policy / known | Still unknown | Behavior until verified |
|---|---|---|---|
| Auth | org centralized identity + LuckyLittleDevil bridge, separate dedicated Medusa project | actual Lucky code, central issuer/client/claims/cookies/token exchange, version match | **block authenticated production and Medusa bridge; use staging mocks only** |
| Garment | black oversized, sizes, 220 vs 240 GSM trial, 50–100 unprinted blanks | final fabric, size measurements, stock mix, manufacturer | build placeholders for UI; do not activate live inventory |
| Printing | DTF only, manual pre-print QA | actual zone dimensions, printer sheet/platen, 300 PPI policy, formats/bleed/color, cost | preview with clearly draft profiles; block print release |
| Suppliers | Essential Group and Dhaka DTF shortlist; Dhaka DTF can supply blanks too | quality samples, quotes, SLAs, lead times, defects | no supplier chosen/production promised |
| US shipping | direct Bangladesh→US, prefer delivered duties-inclusive when valid | carrier pricing, ETA, customs, import/merchant responsibilities | no paid US orders until rate/terms verified |
| AU shipping | economy consolidation via Marcus, threshold or deadline, cost-aware fallback | prices, handling, GST/importer, deadline/threshold | no paid AU orders until realistic ETA/cost agreed |
| Merchant | separate Vynvori Medusa Cloud | actual legal entity, payment processor, bank/FX, tax setup | sandbox payments only |
| AI | 3 concepts/2 refinements standard guided journey, model tiers and advanced chooser | qualified models, API rights, true printable final, actual success rate/cost | mock/flagged test only until qualification |
| Credits | minimum $5 top-up, target 4× effective cost, provisional 3× promotion floor, partial physical-order redemption | credit denomination, actual rate cards, % redemption, fees, acceptable discounts | no final live credit store prices |
| Retail | $29/$39/$49 positioning tests, extra print zones separately charged | final USD/AUD prices, contribution margin, tax and duties treatment | waitlist/price testing only |
| Digital exports | paid composed artwork export; originals unchanged free to owner | licensed format rights, fixed price, service fees, download term | entitlement plumbing test, live sale off |
| Gallery | private by default, opt-in moderated showcase; no creator resale at MVP | moderation operating policy and legal rights agreement | publishing can stay off until approved |
| Brand | VYNVORI domain and IG obtained; logo complete | trademark clearance | launch permission gate |

## Required config mechanisms

Versioned feature flags with rollbacks; validated environment schemas; persisted print profiles, model registry, shipping rate tables, credit price list, tax treatment and SKU mappings. Quotes must reference price/config version and expiry; active version cannot be edited retrospectively to alter paid orders.

## External review artifacts expected

Lucky auth audit, supplier quote PDFs, garment sample QA report, DTF print-file spec signed/confirmed by printer, invoice/shipping quotes with total-landed-cost sheet, merchant/payment eligibility record, applicable taxes/duties analysis, model qualification report with rights status and unit pricing, digital export licensing policy, end-to-end launch approval sheet.

## Launch gate

The founder/authorized owner signs off individual gates independently. A coding agent can mark technical tasks complete while leaving business-dependent gates **BLOCKED**. `commerce.checkout_live` and `production.print_release` must remain disabled where required evidence is absent.

## Non-negotiable live activation gates for v1.1 (v1.1)

Additionally require: (a) a qualified commercial Standard final, verified right to digital export **or** supplier+regional physical order availability at *paid full-journey concept* quote authorization; (b) operator-approved postpurchase route-loss remedy, package expiry/forfeiture disclosures and ledger hold/case SLA; (c) M8a support and reconciliation before any paid AI; (d) real merchant authorization and refund framework before credit purchases; (e) no print release absent verified DTF supplier dimensions/material tests, HUMAN QA, customer proof and actual applicable US/AU shipping duties/ETA. Regional capability can be revoked; preserve affected package rights and issue notices/cases. No paid concept-only offer without separate founder approval. Marketing access does not authorize EU delivery. `Archivo`/Monumental Atelier/logo/Design Release1.0 are approved **visual decisions**, not live production evidence. [F-R07,E01,E02]
