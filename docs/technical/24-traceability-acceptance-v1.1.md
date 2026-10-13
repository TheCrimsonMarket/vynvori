# 24 — v1.1 traceability and acceptance mapping (v1.1)

**CANONICAL DOCUMENTATION APPLIED LOCALLY; PRODUCTION ACCEPTANCE NOT_RUN/BLOCKED.** Existing `ACC-01`–`ACC-27` statuses are copied without promotion from `20-acceptance-matrix.md`; v1.1 adds `ACC-28`..`ACC-39`. This does not imply any platform acceptance tests have been executed. Existing 25 UX gap rows preserved in [source gap traceability](reference-contracts/v1.1/review/25-gap-traceability-v1.1.csv) including source anchors, design links and prior classifications; their technical acceptance remains NOT_RUN/BLOCKED.

| Acceptance ID | Canonical requirement | Founder/errata anchor | State |
|---|---|---|---|
| ACC-28 | guide/free -> one brief, three approved directions immutable, plan-bound three slots | F-R01,E05 | NOT_RUN |
| ACC-29 | quote view with insufficient funds; block full bundle without qualified Standard + downstream rights | F-R07,E01,E03 | BLOCKED: model/rights & approved offer terms |
| ACC-30 | one promo separate from three new concepts, two-device identity race | F-R02,E03 | NOT_RUN |
| ACC-31 | 0/3 to 3/3 durable artifact cards, unknown provider and R2 failure recovery | F-R05,F-R06,E06 | NOT_RUN |
| ACC-32 | skip/restore, branching, per-slot consumed on delivered, closure on verified final | F-R04,E06 | BLOCKED: expiry/forfeiture policy |
| ACC-33 | final separately quoted, Premium only qualified, Use/Save/Report distinct from settlement | F-R04,F-R08 | BLOCKED: final model/quality terms |
| ACC-34 | public safe receipt excludes provider billing; ledger invariants and quote reconfirm | F-R06,E04 | NOT_RUN |
| ACC-35 | M8a operator support, notifications, unknown hold and remedy drills before paid AI | F-R05,F-R06,F-R08 | BLOCKED: numeric SLA/operator/terms |
| ACC-36 | post-purchase capability revoked -> preserve assets/pause expiry/open case/remedy | F-R07,E02 | BLOCKED: legally approved remedy |
| ACC-37 | ST00..17 and ED/CO/AC/GA/AD routes, 320/390 mobile/accessibility typed fixture review | E06,R05 | NOT_RUN |
| ACC-38 | independent BYO original+scene+physical mm+Cloud Run/profile+human QA | E01,prior founder | BLOCKED: supplier print profile |
| ACC-39 | founder visual approval independent of design mock, production implementation and print QA acceptance | E06,C08 | NOT_RUN |

## Visual approval versus engineering evidence

- **APPROVED:** original logo, Archivo, Monumental Atelier, Design Release 1.0 **visual baseline** and US/AU priority, independently controlled BYO.
- **NOT_RUN:** Design Release 1.1 typed mock acceptance, real SSO, Medusa payment/checkout, AI provider+credit reconciliation, DTF print and fulfillment. Visual demo reports 94/94 and 71 axe runs do not verify those systems.
- **BLOCKED:** Lucky bridge source SHA, model regional/commercial license, real supplier profile/material/printing, buyer rights, authorized merchant/payments, actual US/AU shipping duties/ETAs, approved named operator/numeric unknown hold SLA and remedies.

## 25 gap mapping and review provenance

All 25 `UX-01`..`UX-19` and `OPS-01`..`OPS-06` from Revision2 matrix retains exact original source and Phase05 matching file anchors in the attached CSV. Applied/review status remains open until independently verified v1.1 typed mock and production evidence. `UX-19` must explicitly distinguish founder visual approval from technical acceptance.

## Mock cases (proposed, NOT_RUN)

Preserve all 32 `CF-01`–`CF-32` from the original `MOCK-FIXTURE-DELTA.csv`, retained here as [mock fixture source](reference-contracts/v1.1/review/32-mock-fixtures-source.csv). Add derived cases: no qualified downstream even though Standard yes; route revoked after bundle paid; provider billed but R2 persistence failed; compare persisted 1/3/2/3 without allowing normal final; live rights unavailable while draft planning works; explicit final forfeiture notice at consent. Tests require route, fixture, owner, expected per-plane state, customer receipt, assistive-tech expectations, and evidence link.

## UX-C06/UX-C07 — Design Release 1.1 proposal acceptance addendum (all NOT_RUN)

| Candidate ID | Required scenario | Evidence needed | State |
|---|---|---|---|
| ACC-UXC-01 | ST-06/08 visibly distinguish optional free one-preview vs three paid NEW concepts, two optional refinements and a separately quoted final | mock snapshot, 320×480 + AT reading order | NOT_RUN |
| ACC-UXC-02 | ST-09/10 render 0/3–3/3, partial persisted results, mixed per-slot receipts and aggregate customer-safe wallet summary; no provider invoice fields | runtime-validated mock fixtures, screenshot and JSON projection assertion | NOT_RUN |
| ACC-UXC-03 | Quote remains browsable with insufficient funds; final/downstream ineligibility, expired quote and post-top-up changed quote disable paid authorization with reasons | negative fixtures, CTA UX, no auto-submit | NOT_RUN |
| ACC-UXC-04 | ST-12–16 skip/restore, pending closure and eventual forfeiture disclosure before final confirmation; quality report never promises automatic refund | mobile keyboard/AT fixtures and policy copy | NOT_RUN |
| ACC-UXC-05 | 320×480, 390×568, 390×844, 200% text, screen keyboard, safe areas and reduced motion; live region only material transitions without focus theft | responsive screenshots, automated a11y and human keyboard test | NOT_RUN |
| ACC-UXC-06 | Canonical route/command registry, deep links, preserved BYO provenance, SSO return and clean refresh during generation; no demo hash redirects | routes/types contract fixtures and accessible navigation | NOT_RUN |

These are **Design Release 1.1 acceptance requirements only** and do not amend approved visual tokens/logo or production acceptance.
