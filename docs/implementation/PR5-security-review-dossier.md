# PR #5 — correction and security review dossier

2026-10-17 (Asia/Dhaka). Final container hardening baseline: reviewed head `04de5d2846f1b821a41de9a1a94926d686375e57`; earlier correction history follows below. **Draft; no advisory acceptance, amended exception, deployment or remote migration authorized.** The accepted architecture remains one Medusa 2.21.2 service in shared mode, no Redis/separate worker/queue, min 0/max 1, request CPU, 1 CPU/2 GiB.

**Founder decision superseding the historical proposal status below:** on 2026-10-17 the founder explicitly approved **local synthetic preparation A only** for reviewed head `b99197ad814d7bffde402e4ee5fde3d18b260f06`, the two exact runtime advisories, the documented 31 medium/low OS pairs and reviewed non-public development esbuild findings, until **2026-11-15T23:59:59Z** or earlier boundary/dependency/advisory change. [Acceptance contract, immutable two-commit implementation/activation seal and actual gate](PR5-local-preparation-acceptance.md). Historical raw scan/audit risks remain visible; no existing M2 approval is modified. **Remote B is still unauthorized.** PR #5 may be marked ready only after every required check, including the real local-policy evaluator, passes; no automatic merge.

## Final runtime hardening and comparison

The change is confined to the final Docker stage and runtime verification/evidence. Medusa source/config, dependency manifests/lock, supervisor, diagnostic, migration commands, deployment template and authentication boundaries are unchanged. A fresh `--no-cache` build ran the existing compiler, not a rewritten application: the compiled application tree, Node binary and installed application-package inventory all hash identically before/after. No provider binary or dependency is patched.

The [official release index](https://nodejs.org/dist/index.json) and refreshed official Node 22 Bookworm Slim tag still resolve to **22.23.3**, the newest compatible Node 22 on the review date. The announced [October 21 security release](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases) is future work, not an available patch. Node 24/26 would violate the current engine contract. The binary remains pinned to the original official Node image. Instead of retaining its general-purpose OS and global tooling in production, the final stage copies only that Node binary plus the unchanged application into supported `gcr.io/distroless/cc-debian13:nonroot`, pinned by digest. Distroless Debian 12 was investigated but [upstream now lists only Debian 13 tags as maintained](https://raw.githubusercontent.com/GoogleContainerTools/distroless/main/README.md); no deprecated tag is adopted.

Build/install stages retain Node/npm and their original immutable base. The final runtime omits global npm, npx, Corepack, Yarn, Perl, shell, apt/dpkg executables and unrelated utilities. It retains the vendor-maintained glibc/C++/CA/SSL library closure; no essential-package force removal or hand-deleted package database hides findings. UID/GID is the base's **65532:65532**, with matching application ownership. Node and the four installed GNU native bindings (lightningcss, Rollup, LZMA and msgpackr-extract) load successfully. Native CLI startup, migrations twice, synthetic Admin auth, customer/Store denials, TLS, independent readiness/outage/recovery/abort and clean SIGTERM/restart passed in the actual minimal image. Shell-free diagnostics use `/usr/local/bin/node`; no shell or package manager is reintroduced for testing. Only tested native commands are supported; development, package installation, custom plugins and shell-based maintenance are outside this image's contract.

Both exports were rescanned with Trivy 0.75.0 and the **same unchanged database** (`bf1f1b29d76cae9ff085d418cb4bfdb3906b6069f837abdef06558b8102dd1db`), with all severities/unfixed findings retained. [Exact before/after package inventories, findings and identities](evidence/pr5-hardening-comparison.json) preserve raw scan hashes and database timestamps. No suppression, VEX, acceptance file or security-policy change is used.

| Unsuppressed package/advisory pairs | Reviewed image | Hardened image |
|---|---:|---:|
| OS packages / OS findings | 88 / 241 | 14 / 31 |
| OS critical / high / medium / low / unknown | 4 / 60 / 93 / 83 / 1 | 0 / 0 / 23 / 8 / 0 |
| JavaScript package records / findings | 1,227 / 22 | 1,029 / 1 |
| JavaScript high / medium / low | 12 / 9 / 1 | 1 / 0 / 0 |
| Total findings | 263 | 32 |
| Uncompressed image bytes | 706,526,720 | 628,151,808 |

The 21 global npm-tooling findings disappeared because their files are absent; the 1,021 application package records remain identical (inventory SHA-256 `6fbb7dc0c3a83b85bb1040630e5078745b0172649d490cbdd0c49386ea1de4a1`). The remaining Trivy high is `braces@3.0.3` / CVE-2026-93687 / GHSA-vfj7-8cjw-p6xm. `sprintf-js@1.0.3` / GHSA-hp3w-g68c-fv3c still exists and remains unresolved even though this scanner does not flag it. Reachability limits in the advisory table below still apply; removal of build tools does not remediate these application dependencies.

The retained OS findings are 23 medium and 8 low package/advisory pairs affecting required glibc/C++/GCC runtime components and zlib. Exact IDs, versions and blank fixed-version fields are recorded without filtering. Node/native modules load these libraries; no exploit reachability claim is inferred from package presence or from passing functional tests. Removing required runtime libraries would break the verified ABI; further package-level pruning of the vendor base is not justified by the evidence. No fixed version is invented, and these findings remain unaccepted pending independent disposition.

### Critical-finding disposition

| Reviewed critical match | Final binary/functionality and Medusa use | Vendor patch/replacement and remaining exposure |
|---|---|---|
| `perl-base` 5.36.0-7+deb12u3 / [CVE-2026-13221](https://security-tracker.debian.org/tracker/CVE-2026-13221) | Old Perl interpreter existed; final `/usr/bin/perl` and Perl base tree are absent. Tested Medusa commands need neither. | Debian Bookworm fix is 5.36.0-7+deb12u4; final runtime removes Perl instead. No remaining match or Perl input path in this runtime. |
| Same package / [CVE-2026-42496](https://security-tracker.debian.org/tracker/CVE-2026-42496) | Perl/Archive::Tar functionality is not shipped in the final runtime; native migrations do not invoke it. | Same vendor fix; removed rather than suppressed. No remaining match. |
| Same package / [CVE-2026-8376](https://security-tracker.debian.org/tracker/CVE-2026-8376) | Final Perl is absent; the advisory additionally describes a 32-bit path, while the tested target is amd64. | Same vendor fix; removal resolves the image match without relying on an architecture waiver. |
| `zlib1g` 1:1.2.13.dfsg-1 / [CVE-2023-45853](https://security-tracker.debian.org/tracker/CVE-2023-45853) | Final libz is `/usr/lib/x86_64-linux-gnu/libz.so.1.3.1`; no MiniZip executable/library or `zipOpenNewFileInZip4_64` name exists in that library. No MiniZip invocation is added. | Debian lists Trixie source 1:1.3.dfsg+really1.3.1-1 as fixed; final binary package is 1:1.3.dfsg+really1.3.1-1+b1. The SSL library requires zlib, so it is retained patched. Node also embeds zlib 1.3.1-e00f703; distro updates do not patch that separate embedded copy. The old critical match is gone, while two separate medium zlib matches remain visible. |

**Remaining critical findings: zero in the unfiltered scan.** This is not a claim of zero vulnerabilities. Debian's Bookworm notes also explain that contrib MiniZip was not built into those old zlib binary packages; the old scan match was never sufficient proof of an exploitable Medusa path. The final result relies on actual file removal/vendor-fixed package replacement, not a suppression or invented fix.

### Exact proposal identities

The comparison artifact distinguishes the OCI index, amd64 manifest and image configuration digest; they are not interchangeable:

| Identity | Reviewed before | Hardened local candidate |
|---|---|---|
| OCI index | `sha256:19866f21d8216ce783f41713fb113910c34bec27668913e5c01e2458a4dd1519` | `sha256:c39b83dda91a2da944d75a0f7fd2a15cebfd829e8ab309048697385168c6e561` |
| Tested/scanned linux/amd64 manifest | `sha256:8470b17e60f56b09ae34c74e07a74fdc191dba693a2c4f81b972a9ae582f2d7a` | `sha256:22046eb34e152aed183ec11c83ac0765be1f57a1672b6216c12237bb70615cfc` |
| Image config | `sha256:8029c6f5ff85be3fd8288d30a7266ee7c4f1755094020e5b1bae3418c2a672f5` | `sha256:7b5687aa139b20a78a36befd7cc0430ae89a310d589baceafc26c45ef494367d` |

Runtime base: `gcr.io/distroless/cc-debian13:nonroot@sha256:e792ab3d241a468a4fd7519ddbbebe66b49b5f365771716ea688ad40b6c6f1c2`. Node donor/build base: `node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392`. The Node binary SHA-256 is unchanged: `fde6a4bf8d0562f7751d1a2d6cb9b417c4cfe107bbcb0aa3e9a24e125e348f48`; compiled Medusa application tree remains `ff96a64fa7dd453c06cbe10aae5211bebcfddfa32e8ea7abec143784ecd749f4`.

The immutable dependency lock SHA-256 remains `3f1110253020bd8b640c51d1d6ea04339ca2bfd8613cab442d29b5b09820b2d3`. The proposal-only normalized runtime/build/test source-set SHA-256 is `5a4d6b2bafbb47c38b3fe1568fdcc5982898d8347b5af33e4941d56e6a129581`, with every constituent path/hash in the artifact. The final full Git commit is recorded in PR #5's exact-head validation report; approval must bind that commit, not a moving branch. These are assessment identities, **not regenerated M2 exception fingerprints**. CI rebuilds may have different metadata/image digests; its artifact records the actual tested image ID and binary/compiled-tree hashes. That does not silently extend acceptance to a different image.

### Separate independent decisions — neither is activated

**A — Local-only preparation proposal:** independently consider approval of the exact final PR commit/source set, lock, and hardened amd64 image manifest above for trusted developer-local or isolated GitHub Linux-runner build/test execution only, with disposable loopback PostgreSQL, synthetic identities, no real secrets/customer data, no paid providers and all operational features OFF. Explicitly review both runtime GHSAs plus the 31 lower-severity OS pairs. The complete unfiltered `npm audit --json` additionally reports **85 propagated package findings (78 high/7 moderate)** and three origins: the two runtime GHSAs plus developer-tool `esbuild` GHSA-67mh-4wv8-2f99 in `@esbuild-kit/core-utils`' nested esbuild. The final image inventories esbuild 0.28.2, not that vulnerable developer-tool copy. No esbuild development server is started or exposed by the preparation command; its root-workspace risk remains visible. The separate production `npm audit --omit=dev --json` reports **79 (76 high/3 moderate)** and still fails the unchanged evaluator with `SECURITY_BOUNDARY_CHANGED`.

An approval for A must name these exact identities, remaining findings and permitted commands; propose no later than the original ceiling `2026-11-15T23:59:59Z`, or earlier on new advisory/patch/source/dependency/image changes. It must not authorize remote execution or automatically amend the old policy. Any actual exception-policy implementation requires separate explicit authorization and independent review; none is made in this PR.

**B — Remote Cloud Run staging:** **unauthorized and not ready for approval**. The exact candidate identities above are only the reference baseline; this image deliberately refuses `K_SERVICE`/`CLOUD_RUN_JOB`/Vercel and cannot serve as an authorized remote image. The deployable source/image fingerprint is **NOT ISSUED**, because removing that guard, resolving placeholder config and approving IAM/Neon/secret scope have not been authorized or executed. A distinct later decision must bind its new commit, lock, source/config set and scanned registry digest, address remote reachability of the GHSAs and OS findings, recheck Node/security updates, verify image provenance, and execute separately approved Neon/IAM/TLS/role/rollback checks. No approval for A may be reused for B. No deployment credentials, image push, cloud resource, remote migration or merge is included.

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

Executed correction-head Linux evidence at `052015f429583a055419e83217de46f289c0f8a1`: [container job passed](https://github.com/TheCrimsonMarket/vynvori/actions/runs/38982236954/job/117245501895); [verify job](https://github.com/TheCrimsonMarket/vynvori/actions/runs/38982237054/job/117245501870) reports **25 tests / 25 passed / 0 failed**, then the unchanged live audit rejects the source. Restored tests also uncovered a previously masked canonical-integrity failure: PR #5's acceptance-matrix addendum changed a sealed file. The addendum is removed by restoring the exact PR #4 canonical bytes; `M0-protected-files.json` and `scripts/integrity.mjs` are not altered. Current acceptance evidence stays in this dossier/runbook; canonical production statuses remain unchanged. Final-head CI must be checked after that restoration.

## Two approved-origin advisories: still unresolved

| Origin | Installed runtime reachability and limits |
|---|---|
| [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), braces 3.0.3, high, affected through 3.0.3; no patched version listed when checked | Remains in the final application dependency closure. Native startup/discovery paths through Awilix `list-modules`, MikroORM metadata discovery and Umzug migrations use fast-glob/micromatch/braces. Admin bundling also retains an installed chain although UI build is disabled. The new readiness handler uses no globs. Fixed, server-owned discovery/migration patterns were inspected; no new request-controlled pattern path was found. This limited review does not prove every native Admin API safe or authorize remote exposure. |
| [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c), sprintf-js 1.0.3, moderate, affected through 1.1.3; no patched version listed when checked | Installed via MikroORM migrations → Umzug → Rushstack ts-command-line → argparse. Argparse's formatter calls `sprintf` with command-owned help/usage/error formats. The supervisor invokes a fixed CLI/argument list; readiness does not invoke a CLI or format caller input. Startup/migration tooling remains installed and reachable from trusted operator execution. No new HTTP format-string path was demonstrated. |

Both advisories describe denial-of-service conditions from attacker-controlled pattern/precision input. No vulnerability is suppressed, reclassified as dev-only or declared harmless. Patching framework/transitive majors or changing tooling requires compatibility/security review. The old acceptance is local, exact-source-only and expires at `2026-11-15T23:59:59Z`, earlier before remote exposure/M1b. It currently does not match this source.

## Historical reviewed image dependency closure and OS findings

The [machine-readable inventory and all unfiltered finding records](evidence/pr5-container-security.json) contain exact names, installed versions, paths, fixed versions/statuses, finding IDs, scanner identity and image config ID. Raw scan and CycloneDX SHA-256 hashes are preserved there; the complete raw scan and SBOM remain under `%TEMP%/VYNVORI-pr5-scan`. This is an inventory/assessment artifact, not an exception policy or a regenerated approval fingerprint.

Docker Scout metadata transfer was explicitly authorized by the founder during this correction, but the installed CLI required a Docker login; no login or credentials were created. Instead, official Trivy **0.75.0**, pinned to `aquasec/trivy@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa`, scanned an exported local image. Only the temporary scan directory was mounted; no Docker socket, repository, cloud credential or private art was given to the scanner. Vulnerability DB download is public network access, not cloud provisioning. The image was not uploaded. No `--ignore-unfixed`, severity threshold, VEX suppression or scanner-policy acceptance was used.

| Inventory | Package records | Findings by scanner severity |
|---|---:|---|
| Debian 12.15 OS | 88 | 241 package/advisory pairs: 4 critical, 60 high, 93 medium, 83 low, 1 unknown |
| JavaScript, including base npm tooling | 1,227 | 22 package/advisory pairs: 12 high, 9 medium, 1 low |

These are package/advisory pairs, not distinct exploitable defects. Twenty-one JavaScript pairs are in `/usr/local/lib/node_modules/npm/...` from the base image (including brace-expansion, pacote, sigstore, ip-address, http-cache-semantics, picomatch and postcss-selector-parser); one is application braces. The root overrides do not patch npm's bundled dependencies. Runtime invokes native CLI with Node, without npm install, but the tooling is still present and must be triaged or removed in a separately reviewed image-hardening change. **sprintf-js 1.0.3 is inventoried despite not being flagged by Trivy**; that scanner omission cannot retire the GitHub advisory or override npm audit. The pinned application pg consumer is 8.23.1; MikroORM also has a nested pg 8.20.0, recorded separately.

Historical critical findings requiring prioritization (the current disposition is above):

- `perl-base` 5.36.0-7+deb12u3: [CVE-2026-13221](https://security-tracker.debian.org/tracker/CVE-2026-13221), [CVE-2026-42496](https://security-tracker.debian.org/tracker/CVE-2026-42496), [CVE-2026-8376](https://security-tracker.debian.org/tracker/CVE-2026-8376). Debian lists 5.36.0-7+deb12u4 as the Bookworm fix. The third description concerns 32-bit Perl; the scanned image is amd64, an applicability detail for independent triage rather than an automatic suppression. No request path invoking Perl was added or observed in this correction.
- `zlib1g` 1:1.2.13.dfsg-1: [CVE-2023-45853](https://security-tracker.debian.org/tracker/CVE-2023-45853), which concerns MiniZip. Package/version detection alone does not demonstrate that vulnerable MiniZip code is shipped or called by this service; verify binary contents and reachability before a reviewed disposition. The finding remains in the report without a suppression.

The old OS findings, vendor status and available fixes are retained in full in the historical machine-readable file. They were not covered by the two-origin npm exception. The explicitly requested final-stage hardening and repeat scan above supersede this image assessment; independent disposition of the actual remaining findings is still outstanding before remote use.

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
