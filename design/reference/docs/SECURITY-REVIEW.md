# Artifact security review

Scope: offline design simulation only. No deployment, migration, server authorization, real identity or production safety claim.

- CSP blocks outbound connections, objects and form submission. All assets and scripts are local. Preview server binds loopback and rejects paths outside the artifact.
- Production gates are typed literal false values independently of synthetic eligibility. No provider/client SDK, real password form, payment processor, Medusa connection, external API request or secret is introduced.
- Mock input validation rejects unknown fields, invalid state/units and unsafe image paths. Customer-facing projections exclude internal execution, provider job IDs, costs and invoices.
- Guest originals are decoded locally, restricted to PNG/JPEG/WebP and byte-preserved for local owner retrieval. No user files are packaged. Tab storage is inspectable, quota-limited and unencrypted; it must not be used as real private-asset storage or authorization.
- A mock issuer/subject demonstrates an identity boundary without inventing LuckyLittleDevil protocols. No email-based account ownership/linking is implemented.
- Concept/final unknown outcomes preserve existing operation IDs and prevent duplicate execution. Quotes require fresh explicit consent; top-up cannot trigger generation. Choosing a final cannot settle/reverse charges.
- Gallery is private by default and requires separate owner consent/moderation. Original marketplace/remix/download rights are absent. QA release is separately guarded; a changed proof invalidates prior approval.

BLOCKED for production: audited central identity/Medusa bridge, signed asset scopes, anti-CSRF, real ownership/role checks, transaction isolation, quote signatures, provider reconciliation, private storage, production print profiles and human approval evidence. No backend BOLA, concurrency or cryptographic verification result is claimed.

Root credentials/configuration, canonical docs and benchmark were not modified or copied into the runtime. The shipped asset set is internal-review-only pending distribution-rights clearance.
