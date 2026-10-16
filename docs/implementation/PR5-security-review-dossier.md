# PR #5 — correction and security review dossier

2026-10-17 (Asia/Dhaka). Reviewed head `ed4c734cd22614dc5dc0c45a5ecd8ef8fecb7ae4`. **Draft; no advisory acceptance, amended exception, deployment or remote migration authorized.** The accepted architecture remains one Medusa 2.21.2 service in shared mode, no Redis/separate worker/queue, min 0/max 1, request CPU, 1 CPU/2 GiB.

## Readiness failure: reproduced and measured

The [original Linux job](https://github.com/TheCrimsonMarket/vynvori/actions/runs/38980223526/job/117239083367) built successfully, then returned sanitized readiness 503 after **8,004.688 ms** in the retained HTTP log, violating the test's `<8000 ms` assertion. This was a real product timeout defect, not a reason to loosen the assertion.

An isolated Linux replay of the same installed Medusa/Knex/pg path measured:

| Stage after paused-database request began | Elapsed ms |
|---|---:|
| Shared Knex acquisition completed | 0.38 |
| Query dispatched | 0.47 |
| Knex 3-second timeout entered cancellation | 3,006.42 |
| Cancellation's separate raw connection completed with timeout | 8,019.90 |
| Original connection released / readiness rejected | 8,020.27 |

Knex PostgreSQL `cancelQuery()` calls `acquireRawConnection()`, then sends `SELECT pg_cancel_backend(...)`. With PostgreSQL paused, that new connection cannot complete authentication and consumes the configured **5-second connect timeout** after the **3-second query timeout**. The query timeout promise waits for cancellation before releasing the original connection and returning HTTP 503. The observed delay is therefore about 8 seconds plus overhead. The same replay measured the actual shared Tarn acquisition limit at **60,000 ms**: Medusa 2.21.2's `pg-connection-loader` forwards min/max/idle/reap/retry pool settings, not the proposed acquire/create overrides. Neither apparent timeout was an end-to-end bound.

The correction uses Medusa's existing `@medusajs/framework/pg` export, with one owned connection per diagnostic, maximum eight concurrent diagnostics, 1-second connect timeout and 2-second statement/query timeout. It never borrows from the shared Knex pool and never opens a cancellation connection. On query timeout or request disconnect, `Client.end()` terminates the owned active connection; the handler awaits query settlement and socket closure before returning failure. The query is constant `SELECT 1`; no caller-selected SQL or retries are introduced. Unsupported shared-pool timeout claims were removed. A busy diagnostic limit returns unavailable rather than accumulating waiters.

The local integration test now measures healthy 200, three exact sanitized HTTP 503 responses during paused-connect failure under a **stricter 4-second bound** (1 second connect + 2 seconds query + 1 second scheduler/HTTP allowance), a query already connected before the database is paused, and cancellation by request signal. The owned-query test observes connect/query/termination timestamps, proves the socket is destroyed before the promise settles, and asserts no second connection. After unpause, `pg_stat_activity` must show **zero diagnostic backends**, then readiness must recover to 200. Unit tests also verify request listeners are removed on failure. The synthetic container tests retain migration replay, native Admin auth, valid-key customer/Store denial, TLS, resource sampling and restart; SIGTERM must produce exit 0, PID 0, no OOM and a closed HTTP listener.

This probes database connectivity, not shared-pool saturation, schema completeness or migrations. Future remote sizing must account for up to eight extra short-lived diagnostic connections. The 1-second connect deadline may report not-ready during a Neon wake; that is an intentional 503, not a retry or reason to relax TLS. Real Neon wake behavior is NOT_RUN.

## Original security policy remains authoritative

No change is made to `security/m2-exception-policy.json`, its `APPROVED_POLICY_SHA256` anchor, production evaluator, original audit fixture, expiry, dependency manifests or lockfile. The live audit still returns **REJECTED / SECURITY_BOUNDARY_CHANGED** with raw audit exit 1. Passing regression tests do not accept this source or bypass the live gate.

The 24 existing deterministic cases now use source bytes read with `git cat-file` from immutable PR #4 merge `259d3883f9d346cbfd117b014beb6bc5d9b18a72`. Their source hashes are computed independently and asserted equal to the original policy; expected policy hashes are not copied into a fabricated state. Installed dependencies/manifests/lock still come from the actual read-only snapshot and must match. Existing tamper/new-advisory/malformed-output/expiry/remote-environment tests retain their specific expected rejection codes. A 25th test verifies the changed current source independently returns `SECURITY_BOUNDARY_CHANGED`. The production audit runner imports no historical fixture/helper. The verify job fetches Git history so CI can read the pinned objects. **25/25 passed locally; exact-head Linux results belong in the PR.**

## Two approved-origin advisories: still unresolved

| Origin | Installed runtime reachability and limits |
|---|---|
| [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), braces 3.0.3, high, affected through 3.0.3; no patched version listed when checked | Remains in the final application dependency closure. Native startup/discovery paths through Awilix `list-modules`, MikroORM metadata discovery and Umzug migrations use fast-glob/micromatch/braces. Admin bundling also retains an installed chain although UI build is disabled. The new readiness handler uses no globs. Fixed, server-owned discovery/migration patterns were inspected; no new request-controlled pattern path was found. This limited review does not prove every native Admin API safe or authorize remote exposure. |
| [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c), sprintf-js 1.0.3, moderate, affected through 1.1.3; no patched version listed when checked | Installed via MikroORM migrations → Umzug → Rushstack ts-command-line → argparse. Argparse's formatter calls `sprintf` with command-owned help/usage/error formats. The supervisor invokes a fixed CLI/argument list; readiness does not invoke a CLI or format caller input. Startup/migration tooling remains installed and reachable from trusted operator execution. No new HTTP format-string path was demonstrated. |

Both advisories describe denial-of-service conditions from attacker-controlled pattern/precision input. No vulnerability is suppressed, reclassified as dev-only or declared harmless. Patching framework/transitive majors or changing tooling requires compatibility/security review. The old acceptance is local, exact-source-only and expires at `2026-11-15T23:59:59Z`, earlier before remote exposure/M1b. It currently does not match this source.

## Exact image dependency closure and OS findings

The [machine-readable inventory and all unfiltered finding records](evidence/pr5-container-security.json) contain exact names, installed versions, paths, fixed versions/statuses, finding IDs, scanner identity and image config ID. Raw scan and CycloneDX SHA-256 hashes are preserved there; the complete raw scan and SBOM remain under `%TEMP%/VYNVORI-pr5-scan`. This is an inventory/assessment artifact, not an exception policy or a regenerated approval fingerprint.

Docker Scout metadata transfer was explicitly authorized by the founder during this correction, but the installed CLI required a Docker login; no login or credentials were created. Instead, official Trivy **0.75.0**, pinned to `aquasec/trivy@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa`, scanned an exported local image. Only the temporary scan directory was mounted; no Docker socket, repository, cloud credential or private art was given to the scanner. Vulnerability DB download is public network access, not cloud provisioning. The image was not uploaded. No `--ignore-unfixed`, severity threshold, VEX suppression or scanner-policy acceptance was used.

| Inventory | Package records | Findings by scanner severity |
|---|---:|---|
| Debian 12.15 OS | 88 | 241 package/advisory pairs: 4 critical, 60 high, 93 medium, 83 low, 1 unknown |
| JavaScript, including base npm tooling | 1,227 | 22 package/advisory pairs: 12 high, 9 medium, 1 low |

These are package/advisory pairs, not distinct exploitable defects. Twenty-one JavaScript pairs are in `/usr/local/lib/node_modules/npm/...` from the base image (including brace-expansion, pacote, sigstore, ip-address, http-cache-semantics, picomatch and postcss-selector-parser); one is application braces. The root overrides do not patch npm's bundled dependencies. Runtime invokes native CLI with Node, without npm install, but the tooling is still present and must be triaged or removed in a separately reviewed image-hardening change. **sprintf-js 1.0.3 is inventoried despite not being flagged by Trivy**; that scanner omission cannot retire the GitHub advisory or override npm audit. The pinned application pg consumer is 8.23.1; MikroORM also has a nested pg 8.20.0, recorded separately.

Critical findings requiring prioritization:

- `perl-base` 5.36.0-7+deb12u3: [CVE-2026-13221](https://security-tracker.debian.org/tracker/CVE-2026-13221), [CVE-2026-42496](https://security-tracker.debian.org/tracker/CVE-2026-42496), [CVE-2026-8376](https://security-tracker.debian.org/tracker/CVE-2026-8376). Debian lists 5.36.0-7+deb12u4 as the Bookworm fix. The third description concerns 32-bit Perl; the scanned image is amd64, an applicability detail for independent triage rather than an automatic suppression. No request path invoking Perl was added or observed in this correction.
- `zlib1g` 1:1.2.13.dfsg-1: [CVE-2023-45853](https://security-tracker.debian.org/tracker/CVE-2023-45853), which concerns MiniZip. Package/version detection alone does not demonstrate that vulnerable MiniZip code is shipped or called by this service; verify binary contents and reachability before a reviewed disposition. The finding remains in the report without a suppression.

The rest of the OS findings, vendor status and available fixes are included in full in the machine-readable file. All require review; there is no assertion that these findings are covered by the two-origin npm exception. No base-image or dependency upgrade is silently introduced here. A hardened base/tooling update, reproducible dependency closure, repeat scan and independent security disposition are outstanding before remote use.

## Changed review boundary

Compared with the PR #4 baseline, the existing source inventory detects added Dockerfile/context allowlist/supervisor/tests and changes to Medusa config/readiness, plus the new readiness helper, resource integration harness, historical test helper and CI workflow changes. Those paths are within `apps`, `scripts` and `.github/workflows`, so the original exact-source gate rejects them. `deploy/medusa/service.yaml`, this dossier, ADR/runbook and evidence files are **outside the original securityRoots**; they affect the human deployment/security review even though not individually sealed by that policy. Do not claim the old fingerprint validates a deploy template or container OS. No production policy expansion is made to silently cover these files.

The architecture remains accepted for synthetic preparation. Could a local-only exception cover this preparation? A new, explicit, exact-source approval could authorize trusted local build/readiness tests with fixed inputs, no real data/credentials, loopback-only containers, maintained dependency findings and a reviewed OS/tooling risk disposition. The original approval cannot do so by inference. **No amended policy, digest refresh or activation is included.** A proposed amendment must be separately approved before implementation, retain a bounded expiry and exclude all remote execution, M1b, payments and production. New OS/tooling findings must not be hidden inside the two GHSA entries. Until that decision, merge/security acceptance remains BLOCKED.

## Explicit operational controls and limits

- The supervisor refuses `K_SERVICE`, `CLOUD_RUN_JOB` and `VERCEL=1` before loading Medusa or reading dependencies. Local container tests simulate and verify all three refusals. Removing this preparation interlock requires separate approval. This complements the live security gate; a privileged operator overriding the entrypoint can bypass an application guard, so IAM/governance review is still required.
- The repository contains no workflow registry login, image push, deploy/provision/apply command, service-account credential or cloud OIDC permission for this service. The proposed template retains unresolved image/host/secret placeholders and `invoker-iam-disabled: 'false'`. Effective deployed IAM is NOT_RUN; the template alone does not prove absence of public grants.
- Customer auth providers remain empty; middleware denies all customer auth and Store mutations, including requests with a valid publishable key. All operational `VYNVORI_*` flags reject values other than false. Admin UI stays disabled; protected readiness requires native user auth. No web/frontend code or browser credentials are added. CORS and publishable keys remain explicitly insufficient for authorization.
- Native migration mode requires its separate explicit authorization; serve clears that marker. Proposed migration-owner credentials are separate from runtime DML role. No Neon connection, migration, role creation, credential or GCP/Vercel resource/billing action occurred. Local PostgreSQL is disposable synthetic test state only.
- Direct-host Neon TLS validates the hostname/database/role and `sslmode=verify-full`, strips conflicting URL SSL parameters and supplies `rejectUnauthorized:true`. Local TLS tests cover encrypted pg, untrusted CA and wrong hostname. Real Neon project/branch/role binding, TLS, wake latency and pooling remain NOT_RUN; pooler hosts remain rejected pending session-compatibility evidence.
- Clean native shutdown, runtime dependency resolution, migrations, auth denial, recovery and exact-head Linux workflow are required evidence. Runtime in-memory work/session/file durability is still unsupported across CPU throttling/restart/scale-to-zero. No production gate passes from these local tests.

## Decision requested after independent review

Keep PR #5 draft. Review the correction and scan artifacts, then separately choose remediation or narrowly scoped local-preparation risk acceptance with an exact approved source/dependency/container scope. Remote authorization requires its own resolved advisory/OS findings, IAM/secret/Neon checks and deployment review. No automatic merge, amended exception, deployment or migration follows from this dossier.
