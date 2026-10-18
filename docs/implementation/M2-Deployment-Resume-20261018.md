# M2 deployment resume — 2026-10-18

The founder approved the requested strict-TLS secret-version changes and continuation of private Medusa staging execution, with refreshed scans and any remaining security exception presented separately. Existing application source remains `f923f7b26c4fc0684e26cfdf29ebf177d80103f6`; remote main was independently rechecked and is unchanged. No security exception was inferred from this approval.

## Completed authorized changes

- Added **version 3** to `vynvori-medusa-database-url` and **version 2** to `vynvori-medusa-migration-database-url`.
- Only URL options changed: `sslmode=verify-full`; removed `channel_binding`. Exact passwords, scoped usernames, database and pinned direct hostname were preserved. Old versions and IAM were not changed. Secret values stayed in process memory, outside command arguments, logs and files.
- Read-only connections using the actual new versions passed full TLS verification. Both sessions verified `vynvori_medusa_staging` and the expected scoped login. Public table/sequence count remains **0**.
- PR #7 actual runtime catalog: no public functions, role memberships, elevated role attributes, TEMP or schema CREATE. Migrator has schema CREATE, no superuser/CREATEDB/CREATEROLE/BYPASSRLS/TEMP. The first runtime catalog request failed without a diagnostic; a repeat with sanitized stage/error diagnostics passed. No write was retried.
- Migration secret still has no secret-level IAM bindings. Cloud Run staging service remains absent.

## Fresh security results

Docker Desktop was stopped; it was started in the background. The same published linux/amd64 image was scanned with the pinned Trivy scanner and a new official-origin advisory database. No finding/severity/unfixed/VEX suppression was used.

- Published manifest: `sha256:f7ed3cbe7b3231764ea61ffdfd10de717c30e110fa5df4cf52ec8587f63aa64d`.
- Scanned runtime configuration: `sha256:e93f5e397b08587f855ad945ecb01ce3387884be1eab0e1cd3c8c8d9402cf014`.
- Fresh report SHA-256: `c14cc5d2c2683def67bebfd082c118d6a759e023f9370270c1d9cf5a769ef57b`.
- Advisory DB UpdatedAt `2026-10-17T18:34:28.174846796Z`; NextUpdate `2026-10-18T18:34:28.174846475Z`; downloaded `2026-10-17T23:31:52.161687239Z`. **Current at scan completion** `2026-10-17T23:34:02.760Z` (18 October 05:34 Bangladesh time). Yesterday's stale-database blocker is resolved; no freshness exception is requested.
- Image: **1 high** JavaScript finding, `braces@3.0.3` / `CVE-2026-93687`; **31 OS package/advisory pairs**, 23 medium and 8 low. No high/critical OS finding or critical JavaScript finding. The scanner reports no fixed version for these records.
- Fresh unfiltered production npm audit: exit 1, **79** propagated findings (76 high, 3 moderate), originating in `braces` and `sprintf-js`. Full audit: exit 1, **85** (78 high, 7 moderate), additionally build-only `esbuild`. These counts are not counts of independent originating advisories. No vulnerabilities are claimed fixed.

## Exact remaining decision

**PROPOSED, not accepted:** temporary source-pinned acceptance for private IAM-authenticated synthetic staging only, ending `2026-10-24T23:59:59Z` (**25 October 05:59:59 Bangladesh time**):

1. `GHSA-vfj7-8cjw-p6xm`, braces 3.0.3: stack-exhaustion denial of service if attacker-controlled glob/brace patterns reach recursive processing.
2. `GHSA-hp3w-g68c-fv3c`, sprintf-js 1.0.3: formatting failure/denial of service if attacker-controlled numeric precision format strings reach formatting.
3. Exact 31 medium/low OS package/advisory pairs in the fresh report. Existing build-only `GHSA-67mh-4wv8-2f99` / esbuild 0.18.20 remains local-build-only; no development server exposure.

Existing source analysis locates the first two packages in trusted discovery/migration and fixed CLI paths. No attacker-selected HTTP glob/format path was demonstrated; completeness across all native Admin paths is not established. IAM narrows callers but does not fix these packages. Freshness checks, actual negative authorization tests, disabled customer auth/Store mutations, all operational flags OFF, max one instance and no runtime migration secret remain mandatory. New advisories or changed code/dependencies/configuration require review; no automatic renewal.

The exact machine-readable candidate and all 32 image finding records are in `%TEMP%/VYNVORI-M2-resume-20261018/residual-risk-proposal.json`, with hashes in `evidence-manifest.json`. This is a proposal, not an activated policy. A later activation changes image bytes and requires final-image rebuild/scan and binding of digest, configuration, source and IAM evidence. Historical local-only policies have not been modified or reused as remote authorization.

No live Medusa migration, runtime grants, Cloud Run deployment or deployed HTTP smoke test has run. These remain pending the explicit residual-risk decision and reviewed activation. No Git commit/push was performed. Local container tests from the prior attempt remain historical evidence, not remote acceptance. Full M2 is not complete.
