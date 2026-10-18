# ADR 0007 — Explicit R2 jurisdiction and synthetic recovery

2026-10-18. Scope: founder-authorized private synthetic R2 completion. Base `f923f7b26c4fc0684e26cfdf29ebf177d80103f6`; local uncommitted source changes only. No dependency or lockfile changes.

The existing bucket is in the US jurisdiction. A global S3 endpoint addresses a different jurisdiction, so its AccessDenied result did not establish that the supplied keys were invalid. The original US bucket and credentials are retained. [Cloudflare data-location documentation](https://developers.cloudflare.com/r2/reference/data-location/) requires a jurisdiction-specific S3 endpoint and states that bucket jurisdiction cannot be changed after creation. US jurisdiction does not block synthetic staging. Customer-asset residency and latency acceptance remain future production decisions.

## Decision and interfaces

- Staging requires explicit `M2_R2_JURISDICTION=default|us|eu`; the adapter derives the endpoint from a validated account and jurisdiction. The configured target uses `us`. No arbitrary endpoint or production environment is accepted.
- The only permitted payload remains the fixed 1x1 synthetic PNG, under `private/staging/synthetic/v1/<uuid>/<sha256>.png`. PUT uses `IfNoneMatch: *`, one SDK attempt, and fixture/hash/run metadata. GET checks headers, caps streamed bytes, verifies exact bytes and aborts/destroys the stream on timeout or failure. HEAD distinguishes absent (404) from denial/network uncertainty. Removal checks matching ownership metadata first.
- `advanceSyntheticProbe` records a target-bound journal before each mutation. One PUT and one DELETE are permitted per probe. Lost acknowledgements reconcile via HEAD and verified GET; pending mutations are never repeated automatically. A collision is preserved. Unobservable outcomes, checksum failures and failed journal persistence stop for operator investigation.
- `scripts/r2-staging.mjs [journal.json]` and the aggregate staging smoke use an external journal. Writes use file sync and atomic rename; an exclusive lock prevents concurrent use of the same journal. This is a local filesystem checkpoint, not a distributed or tamper-proof ledger. Never edit a pending journal to reset attempt counters or start another run as a retry.
- Before mutations the operator reads current bucket identity, jurisdiction, r2.dev, custom domains and lifecycle. Public development access must be disabled and custom domains absent. The ephemeral `M2_R2_CONTROL_API_TOKEN` is independent of the object credentials and is never written to the journal. The CLI loads no `.env` automatically and never emits raw SDK errors/headers/credentials.

No customer API, presigned URL, auth integration, database migration, domain event, public access, bucket-policy change or operational feature activation is introduced. No cloud runtime received these credentials.

## Recovery, rollback and security limits

Preserve the external journal and lock after a crash. Establish that the previous process is gone before any explicit stale-lock recovery. Resume the same journal after re-reading privacy/target state. `PUT_PENDING` with no observable object and `DELETE_PENDING` with an object still present remain blocked; neither state authorizes a repeated mutation. Do not delete foreign metadata or unknown objects. Cleanup requires exact run identity, fixed-byte verification and a reconciled operator decision. No bucket-wide listing or purge is necessary.

Source rollback is limited to the reviewed R2 files in this change; preserve the other dirty Medusa work. It requires no cloud rollback because bucket configuration was not changed and all four created fixtures are absent. Preserve the original bucket. Do not remove `M2_R2_JURISDICTION=us` while continuing to use that bucket.

Current control-plane authentication cannot read token-management metadata (403), so bucket-only Object Read & Write scope is not independently verified. Founder confirmation is requested; working credentials alone do not prove least privilege. No privileges or new credentials are requested by this implementation.

The existing Medusa staging exception seals the prior exact source overlay, including commerce source. The new R2 changes correctly yield `STAGING_SOURCE_CHANGED` from its collector. Do not refresh that seal or redeploy Medusa under the old approval. The running immutable Medusa revision is unchanged. Publication, remote CI and whole-checkout release acceptance are separate pending gates.

[Executed R2 evidence and limitations](M2-R2-Result-20261018.md).
