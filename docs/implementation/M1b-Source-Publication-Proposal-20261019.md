# VYNVORI M1b source-only publication proposal

Prepared2026-10-19 against HEAD 262489d8a5c367e579839806d7e8554a394dcd2a. This local approval dossier and its allowlist are not themselves staged.

Publish 123 explicitly listed files on branch `codex/m1b-central-identity`, opening a draft PR to `main`. Source digest: `8f7755edf2edceab6a84fe676cbeb18c5a1c9005f589ad929a4935f9082af175`. [Exact path/hash allowlist](artifacts/M1b-Source-Publication-Allowlist-20261019.json).

The candidate implements disabled-by-default centralized SSO, durable encrypted sessions/PKCE, dedicated native Medusa mapping and owned reads, guest ownership, bounded revocation, and explicit identity migration/inspection tooling. [Code/evidence review](M1b-Local-Validation-Review-20261019.md), [security/source review](M1b-Security-Source-Review-20261019.md). Current deployment readiness verifies the normal npm/Next build and excludes backend/migration/test artifacts.

Requested authorization covers commit/push/draft PR publication and source-only follow-up fixes in that draft for review. It does not approve source acceptance/merge, dependency-risk exceptions or policy activation, release tags/images, registration, live schema/grants/configuration, domains or deployment. Full CI remains blocked by the unchanged M2 source/lock approval seal.

Before committing, recheck HEAD, every exact path/hash, secrets and the staged path list. Use only this allowlist; never git add -A. Preserve all excluded work. Any changed candidate path needs review before publication.

Why confirmation is required: earlier Git publication approval named Portal#137/Core#138. The [repository instructions](../../AGENTS.md) separately require authorization for commits and pushes; this VYNVORI batch has not been authorized.
