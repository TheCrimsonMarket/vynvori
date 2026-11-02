# M1b local image validation batch — owner review

## Verified local image result — 2026-10-19

Owner local image validation completed on 2026-10-19. Both network-disabled image probes PASS on Node 20.17.0; independently checked image IDs, revision labels, linux/amd64 platforms and private log hashes match the receipt. Core build exit is 0. Portal reused its verified completed image; the earlier runner did not capture its build exit. [Executed result](evidence/M1b-Local-Image-Validation-Result-20261019.json). No rerun is needed. Full application startup, deployed legacy compatibility and M1b acceptance remain unproven. Registry publication, release tags/pipelines, registration, storage/config changes and deployment remain blocked pending separate authorization.

Earlier preparation and recovery instructions below are historical; do not repeat the completed build batch.

2026-10-19, Asia/Dhaka. **FOUNDER APPROVED LOCAL OWNER-RUN BUILD/PROBE ONLY; EXECUTION COMPLETED.** The source-only merges are complete. The founder separately replied "Approve local build/probe validation only" on 2026-10-19. All image publication and operational activation remain excluded. Executed bounded image evidence is linked above; full application and deployed acceptance remain open.

## Fixed input and output

| Component | Verified merged source | Exact source tree | Local image name only |
|---|---|---|---|
| Portal | `35a47c9d6d7b41adbed5cc6556a4e9bbe78269ba` | `fd4a59e3cb7cd03b280999b1294e5115d849e6ef` | `vynvori-m1b-portal-review:35a47c9d` |
| Core | `30efb9e295ccdf4e6a51c3c3d8d2b05c6494381f` | `445e642773a2f5fbe1acb087b89cc428db0395d0` | `vynvori-m1b-core-review:30efb9e2` |

Both live developmerger refs, two-parent merge histories and exact approved preview trees were rechecked. Source branches remain intact. [Merge receipt and screenshots](evidence/M1b-Source-Merge-Result-20261018.json). These image names are local Docker labels, not Git release tags, and will not be pushed.

Two clean detached checkouts are prepared under `%TEMP%\VYNVORI-M1b-20261018\portal-merged-35a47c9d` and `core-merged-30efb9e2`. The owner-run [build script](artifacts/M1b-Build-Only-Validation-20261018.ps1) pins their commits/trees, requires clean tracked/untracked/ignored state and the reviewed artifact hashes, verifies npm/Git/dependency context exclusions, and rejects changed recipes or environment-file logging.

## Proposed execution scope

- Use the existing local default Linux Docker engine and its existing Docker-driver builder. Reject remote host/non-default builder overrides and do not create builders, change contexts or install/start services.
- Preserve existing development build configuration privately. Existing npm configuration is supplied only through the Dockerfiles' BuildKit secret mount; its contents are not printed/copied into the review packet. Ordinary dependency/base-image/package downloads occur during builds. Core uses its existing `NODE_ENV=development` file-selection build argument; the approved Dockerfile follow-up no longer prints that file's contents.
- Build each image once, recording its immutable local image ID and full source SHA. No image push, registry publication, Git tag, pipeline queue, cluster/database operation, domain/IAM change or new live credential is included. Stop on failure; there is no automatic build/provider retry.
- Run each image only as a short-lived synthetic probe, with no network, no published ports, a read-only filesystem, dropped capabilities and no-new-privileges. The only host bind is the read-only reviewed probe; `/tmp` is temporary memory-backed scratch. Strict Portal mode is forced off and Core strict enrollment forced empty.
- Keep raw build/probe logs and local images private. Return only the compact receipt or nonsecret failure detail. No environment file, npm config, credentials, token, account document or raw build log belongs in chat or Git.

The existing [parent AGENTS.md](D:/dev/raum/tcm/AGENTS.md) says, "delegate npm installation back to the user, do not install packages yourself". Both Dockerfiles run npm installations, so the founder executes the prepared script after separate approval. The agent does not run the builds.

## What the probe proves — and does not prove

The [reviewed image probe](artifacts/M1b-Image-Runtime-Probe-20261018.cjs) requires actual Node `20.17.0`. Portal uses the image's production global `tsx` CLI, loads production dependencies and actual strict modules, verifies default-off bootstrap with no database connection or strict route, checks malformed enabled configuration fails closed, and exercises synthetic correctly-bound/wrong-audience JWT verification through in-memory test adapters. Core loads its actual compiled Next authorizer route and checks GET/POST exports. It starts no public application server and makes no central/commerce/provider request.

This is production dependency/module/runtime evidence only. It does not prove full application startup, real consent/cookie behavior, Mongo readiness, refresh/revocation concurrency in the image, complete legacy-client compatibility, deployed acceptance, or M1b completion. The prior Node 22 source tests and preserved failure sets remain separately recorded; existing red suites are not waived. All deployed/operational and dependent bridge gates stay open.

## Current recovery: native stderr handling and verified image reuse

The owner's Portal build created image `sha256:c64402c587ca92283bd78d15fd1e4834bc3ac27afb3fd49304194f6ea4c308b5`, whose tag and revision label match the approved Portal source. Windows PowerShell 5.1 then converted normal Docker stderr progress into NativeCommandError. The original process exit was not captured, so no zero-exit claim is inferred. No matching build/probe worker remains, and Core has no prior image evidence. The existing output directory/log/image-ID file are retained.

The corrected native runner uses System.Diagnostics.Process with shell execution disabled, correct Windows argument quoting, separate asynchronous stdout/stderr byte logs and authoritative exit codes. Synthetic Windows PowerShell 5.1 regression checks reproduce the original failure and prove that exit-zero stderr succeeds, exit seven is retained, seven difficult arguments round-trip and existing logs cannot be overwritten. Read-only actual Docker resume preflight passes. No image build or image probe was run by the agent.

Use the current command below with `-ResumeExisting`. It verifies immutable image ID, tag and source label, refuses duplicate live workers or conflicting image evidence, skips rebuilding the completed Portal image, runs the approved network-disabled probe, then continues Core. Each resume has a new private attempt directory; earlier logs/IDs/receipts are retained. Normal progress prints a heartbeat every 30 seconds. Actual failures stop on their nonzero exit code. Existing local build/probe approval is retained; all remote publication/operational gates remain blocked.

## Prepared verification and owner action

Compatibility correction: the owner's first execution stopped before building because installed Buildx v0.37.1 rejects `inspect --format`. The script now uses plain inspection and rejects non-Docker drivers, non-default or multiple node endpoints and malformed output. The full read-only preflight passed in Windows PowerShell 5.1 against the actual local Linux engine and verifies required build options from installed CLI help. One valid and four unsafe/malformed builder fixtures passed their expected outcomes. No build/output directory was created by this preflight; the existing approval and execution command remain valid.

The script/probe parse checks and Windows PowerShell 5.1 read-only preview pass against both exact merged sources. No image build, container probe or dependency installation was executed. Artifact hashes and limits are in the [preparation receipt](evidence/M1b-Build-Only-Preparation-20261018.json). Execute mode also requires the separate approval to be recorded in that receipt, so this document alone does not enable it.

The founder approved **local owner-run build/probe validation only**. After the agent records that exact approval in the preparation receipt, the owner runs in PowerShell:

```powershell
& 'D:\dev\vynvori\docs\implementation\artifacts\M1b-Build-Only-Validation-20261018.ps1' -Execute -OwnerApprovedBuildOnly -ResumeExisting
```

The separate approval is now received; the preparation receipt must also show `APPROVED_LOCAL_BUILD_ONLY`. The script writes `%TEMP%\VYNVORI-M1b-20261018\private-image-validation\owner-build-receipt.json`. Report completion, or the component/stage and nonsecret error. The agent can read the local receipt; do not paste private logs or credentials. The current reviewed recovery explicitly accepts existing evidence with `-ResumeExisting`; do not delete that directory. Report any genuine failure before another manual attempt. No automatic build retry is performed.

After executed evidence is inspected, prepare a separately scoped image publication/development rollout batch. No registration, storage/config activation, release pipeline/tag, deployment, production permission or M1b acceptance is included here.
