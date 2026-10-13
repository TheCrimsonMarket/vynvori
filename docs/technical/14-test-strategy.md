# 14 — Test plan and evidence

## Layers

- **Static/unit:** schemas, credit math, scene geometry/mm conversion, role policies, print profile limits, pricing quote signatures, tariff config validation, currency minor-unit rounding, model eligibility.
- **DB integration:** migrations; full Neon transaction behavior using real Postgres/pg; constraints/lock/race conditions and outbox commit/replay.
- **Medusa integration:** pinned v2 version checkout custom price flows, inventory reservation, customer bridge, capture/refund states, tax/shipping and personalization line-item behavior.
- **Provider contract tests:** mock AI SDK/model gateways with saved compliant example responses; never rely on paid endpoints for CI. Targeted metered smoke only on explicit budget approval.
- **Render golden tests:** scene reference fixture → expected pixel dimensions, PPI, typography positioning, alpha and color properties plus artifact checksum/visual diff with tolerances.
- **E2E:** browser desktop/mobile; guest anonymous draft to centrally authenticated account; separate BYO editor; AI guided/free; fake sandbox credit and digital export; cart and checkout; gallery publishing; Medusa Admin QA; tracked shipping.
- **Security:** IDOR/BOLA, CSRF/session, insufficient rights, uploads, SSRF, signed URLs, publishable key exposure, webhook replay, admin role escalation, race conditions.
- **Chaos/recovery:** missing Medusa subscriber event, delayed capture, receiver crash, Cloud Run timeout, provider unknown-billed, duplicate checkout, R2 upload not finalized, staging backup restore.

## Critical E2E acceptance paths

1. **BYO happy path:** guest uploads unique image; saves after centralized login; creates multi-layer black tee composition; adds exact phrase; selects size and front/back; sees quote; payment sandbox; human QA; production artifact; fulfillment update. No AI charge and no mandatory export purchase.
2. **AI path:** guided/free brief→bounded nonbillable Director→three approved directions→separately purchased three concepts→select after 3/3→up to two optional included refinements→separately quoted qualified Standard final→eligible garment composition; independently tested optional promotional preview once only; premium unavailable until qualified.
3. **Digital composition export:** original upload available unchanged free to owner; paid composed export requires capture, exact version entitlement and short-lived download; failed render recoverable without duplicate payment.
4. **Cross-account:** authenticated A cannot see/edit/checkout/download B's private design even with stolen stable IDs or same email.
5. **Financial replay:** same Medusa captured payment event delivered N times leads to exactly one paid order production activation/credit grant; refund event reverses entitlements according to defined policy without deleting history.
6. **Print guard:** approved order version replaced by new version requires reapproval; low-PPI artifact blocked per approved printer profile; no automated path bypasses QA.
7. **Australian batch:** threshold reached, deadline reached with cheaper direct fallback, and deadline with no feasible method → explicit customer alternative/refund.
8. **Gallery consent:** private default; moderation pending; creator publication/unpublishing; original R2 asset never public; no third-party remix/shop actions.
9. **SSO bridge:** all cases in `03-centralized-authentication.md` verified against LuckyLittleDevil pattern and canonical org issuer. This is a mandatory launch blocker.

## Quantitative quality gates (proposals, calibrate with reality)

Zero known P0/P1 security defects, zero unreconciled synthetic wallet mismatch, 100% gated production release in tests, no duplicate paid grants under concurrent replay, usable mobile/desktop mockup flows, no loss of immutable design versions. Performance objectives should be established from baseline measurements rather than guessed hard commitments.

## Evidence package for milestone completion

PR/commit, test logs, coverage trend, schema migrations, API reference changes, QA screenshots, benchmark observed metering, ledger stress result, signed event replay result, rendered print artifact manifest, approved supplier profile and real printer output where required. Mark all checks `passed/failed/blocked/not-run` with evidence links—never mark unknown as passed.

## v1.1 executable fixture requirements (v1.1)

Introduce versioned typed-mock fixtures (all NOT_RUN until executed) for: disabled Standard before quote; Final qualified but no downstream digital nor garment use; rights revoke after bundle purchase; insufficient wallet quote view/topup new quote; promo used in one of three same-direction runs; 0/3,1/3,2/3,3/3 persisted partial and unknown provider; provider success/R2 failure; two-device promotional race; free planning quota; skip/restore/refinement branch switch; unknown final closure pending and eventual success; subjective dislike vs objective defect; wallet hold/settle independent from provider invoice; guest BYO without Studio; proof hash change revokes QA; Medusa captured but supplier not approved; SSO return/deep links. Accessibility: 320x480,390x568,390x844 keyboard open, 200% zoom, aria live rate-limit, visible quote/rights footers, numeric mm editing.

Acceptance evidence must record exercised commit, fixture ID, test environment, result and artifacts. Visual prototype 94/94 checks are NOT proof of Medusa/AI/print/SSO behavior.
