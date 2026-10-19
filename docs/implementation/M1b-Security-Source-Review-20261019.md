# M1b security/source review

2026-10-19. Source review candidate; no residual-risk exception or live activation is approved by this document.

The implementation adds central issuer/client/audience/current-state validation, encrypted generation-bound sessions, single-use browser-bound PKCE, native customer mapping with no email linking, private fixed-path transport and ownership checks. Local connected browser tests and PostgreSQL18 migration/restore checks pass. Production/default-off behavior remains closed. [Evidence and remaining acceptance](M1b-Local-Validation-Review-20261019.md).

## Dependency reachability review

| Finding | Verified source facts and remaining risk |
|---|---|
| braces3.0.3 / GHSA-vfj7-8cjw-p6xm | The advisory describes stack exhaustion from deeply nested brace patterns and lists no patched version. Installed immediate parents include Medusa admin-bundler chokidar and micromatch. New auth/provider/workflow/BFF/migration source makes no direct glob/braces call; route names, provider identifiers, workflow names and migration paths are server-owned. This reduces the reviewed exposure; it does not prove every framework transitive path unreachable. [Primary advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm). |
| sprintf-js1.0.3 / GHSA-hp3w-g68c-fv3c | The advisory concerns attacker-controlled precision format strings and lists no patched version. Installed parent is Rushstack's argparse1.0.10; its inspected uses are parser error/help formatting. New auth HTTP paths do not call sprintf or expose CLI format selection. CLI/migration command inputs are not an authenticated HTTP feature. Residual transitive/CLI risk still needs a separate M1b decision. [Primary advisory](https://github.com/advisories/GHSA-hp3w-g68c-fv3c). |
| nested development esbuild / GHSA-67mh-4wv8-2f99 | The affected nested copy is under @esbuild-kit/core-utils. The advisory applies to esbuild's development server and names0.25.0 as fixed. The new test fixtures resolve root esbuild0.28.2 and use build(), not serve(). No new esbuild development server is started. This is not an acceptance of the nested development finding. [Primary advisory](https://github.com/advisories/GHSA-67mh-4wv8-2f99). |

The unfiltered current production audit has79affected package entries deriving from the first two roots; the full audit has85entries and the third root. Both exit1. Raw reports are linked from the validation review. No severity was filtered or finding silently removed. npm's incompatible major-version downgrade suggestions were not applied. The existing M2 exception does not authorize M1b's changed auth surface.

## CI/deployment compatibility changes

The original M0 smoke check banned every fetch call. Its candidate now permits fetch only in the two account components that call the app BFF; credential, injection, browser storage and server-environment/import prohibitions remain active there. Three negative-boundary tests pass, and the complete17check M0 group plus smoke check pass. This is a source scanner, not a network sandbox or complete security audit. The connected browser test separately checks absence of central/native/service credentials in browser responses and headers.

The deployment fixture now copies the required server-side commerce/database packages, keeps native Medusa/worker source out of its extraction, uses empty npm credential configuration and denies backend/migration/test/reference files in Next deployment traces. The actual Vercel-style build/result is recorded separately after execution. The lockfile's manually inserted SDK dependency was reordered to npm's canonical ordering; package versions, resolved URLs and integrity values did not change. Windows npm rewrites CRLF/LF line endings. The check compares exact UTF8 lock text after only that line-ending normalization and records both raw hashes; all other content changes remain failures.

## Approval boundary

The existing M2 exception JSON, evaluator anchor, private-staging approval and active source seal remain unchanged. Security-policy/staging-source checks still reject this M1b overlay. Full CI is not green. A new exact-source, bounded local/CI approval proposal and compatibility tests are needed before exception activation or merge; that work must not relabel this candidate as the already approved M2 source.

The next requested approval is source-only draft PR publication and source-only follow-up work for review. It does not accept dependency risk, activate a new policy, authorize merge/release tags, register a client, mutate live storage/grants/configuration or deploy. Before live staging, separately review current provenance, legacy compatibility, native image/runtime findings, actual IAM, backup/restore, registration and rollback.
