# 12 — Security, privacy, rights and abuse-prevention requirements

## Trust zones

Public browser; Vynvori server/BFF; organization centralized auth; isolated dedicated Medusa Cloud; Neon; R2; Cloud Run; external AI providers; supplier/fulfillment partners. Each exchange authenticated and least privileged. Hardening must be version-specific and audited for OWASP/ASVS relevant controls.

## Access control

Object-level checks on every `projectId`, `assetId`, `versionId`, `compositionId`, `quoteId`, `medusaOrderId`, `exportId` and `galleryPostId`; never trust existence or opaque ID. User subject and Medusa customer actor link verified server-side. Guest upload/draft capability scoped/expiring; guest cannot buy credits. Role claims verified from trusted central auth or explicitly approved operator directory, not freely editable custom metadata.

## Authentication

T03 reuse LuckyLittleDevil verified org SSO and Medusa bridge. Treat uninspected bridge as blocker. Tokens/cookies: HttpOnly/Secure, CSRF prevention, session invalidation, suitable cross-domain callback rules, PKCE/nonce if the audited protocol uses OAuth/OIDC, audience and issuer verification. No passwords stored in Vynvori, no raw central tokens in localStorage, no privileged Medusa tokens in browser.

## Uploaded files and AI prompts

Size/mime/dimension/decoded pixel caps, file-signature check, antivirus or controlled image decode/quarantine, SVG sanitation/rasterization only after security audit, no remote linked fonts/scripts, no untrusted external URL fetch (SSRF). Exif removal for previews. Prompt input and attached reference content untrusted; tool invocation has schema validation, permissions and explicit operational budgets; model output cannot authorize payments, mutations, approvals, or tool calls outside workflow policy.

## Financial security

Neon ledger append-only with DB checks, idempotent grants/refunds, Medusa capture verification, replay-resistant signed events, no dynamic client prices, rate-limited free preview, credit purchase and refunds. Payment and card data remain with authorized provider; do not collect raw PAN/CVV. Suspicious large refunds or payouts require human review.

## Privacy and copyright

Projects private by default. Public gallery posts require explicit opt-in, moderated publication and separate permission scopes; public preview art must never imply reproduction or resale license. Owners can unpublish; follow actual retention, deletion, support, chargeback and legal hold policies. Uploaded reference rights confirmation and gaming publisher trademark/IP checks; brand-name trademark clearance external gate. Digital export licenses and commercial-use limits disclosed before purchase. Do not claim exclusive rights to output solely from AI generation.

## External credential hygiene

Secrets isolated by deploy environment; use managed secret storage and rotation; protected service accounts; minimal R2 actions, minimal Google Cloud IAM, verified Medusa webhook HMAC/secret. Runtime logs remove bearer tokens, PII, prompt/reference payloads and private signed URLs. Secrets scanning in CI and periodic rotation drills.

## Abuse prevention

Account-level and IP/device-aware rate limits using privacy-consistent signals; one free preview per canonical identity subject, not just email; CAPTCHA/step-up only under abnormal risk; upload limits for guest and authenticated; provider spending ceiling; concurrency/queue caps; community moderation/reporting and admin review. Avoid irreversibly banning users solely on automated false positives.

## Security acceptance

Cross-account BOLA/IDOR audit, CSRF/CORS, logout/revocation, malicious files, SSRF, event forgery/replay, payment capture duplication, self-granted credits, exposed production artwork, order state manipulation, Medusa admin escalation, provider-spend abuse, signed URL expiry, lawful deletion without corrupting accounting history.
