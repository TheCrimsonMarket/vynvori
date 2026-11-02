# M1b source-only merge batch

Execution update 2026-10-19: the founder approved this source-only batch and both merges completed on 2026-10-18. Portal result `35a47c9d` and Core result `30efb9e2` exactly match the previews and approved parent SHAs; source branches retained. [Actual merge receipt](evidence/M1b-Source-Merge-Result-20261018.json). The proposal text below is the reviewed pre-execution record; it does not override the executed receipt. The separate local build/probe batch is now owner-approved, execution pending; all operational activation remains blocked.

2026-10-18, Asia/Dhaka. **PROPOSED; MERGE NOT AUTHORIZED.** The founder approved the original Portal/Core source review and the separate two-line Core Dockerfile log-fix publication. Both are pushed. No source branch has been merged, and no image build, release tag, registration, storage mutation or deployment was performed by the agent.

| PR | Approved source head | Current developmerger target | Locally predicted result tree | Delta |
|---|---|---|---|---|
| [Portal #137](https://dev.azure.com/raum-au/mg23/_git/Portal.Service/pullrequest/137) | `b23f3d5c366438d056b0a68f91d303c395f7d0be` | `e54028d0a3a9fa22fdac2acca1f84744df115225` | `fd4a59e3cb7cd03b280999b1294e5115d849e6ef` | Exactly 24 reviewed source/test files |
| [Core #138](https://dev.azure.com/raum-au/mg23/_git/service.core-ui/pullrequest/138) | `422095fc4c798d0c748d0de9ffc49b515d5d9c82` | `cb7668f4e770bc7b6a916b141e0766f2f4fbd011` | `445e642773a2f5fbe1acb087b89cc428db0395d0` | Three reviewed auth files plus Dockerfile's two approved log-line deletions |

The refs were rechecked read-only at preparation. Merge previews write only local Git tree objects: no branch move, commit or remote mutation. Every candidate blob in the predicted result must match the approved source head, and the target-relative path set must exactly equal the sealed allowlist. If any source/target changes, stop for a fresh comparison instead of rebasing or replacing unrelated work.

## Requested authorization

Authorize publishing the two drafts as needed and completing source-only merges into `developmerger`, using merge commits that retain the reviewed source commits and preserve Core's 14 later target commits. Retain the branches for evidence. No automatic completion, source-branch deletion, force push, policy bypass or release tag is requested. Required validation/policies must permit the action; stop if a required check fails or the action would queue a deployment-capable/image-build job. Do not manually queue a pipeline.

Use a `[skip ci]` merge message to preserve this publication-only boundary: the checked-in pipelines build/push images and deploy Kubernetes workloads when released by tags. Inspect actual branch policy/trigger state before completion; do not treat the message as a policy bypass. After each merge, verify live target SHA, merged status and exact tree equality with the approved preview, and record the resulting source pin. Do not proceed if a tree differs.

## Evidence and limits

Portal's owner-fresh source checks have 281/281 OAuth assertions passing. Full suite: 748 PASS / 19 FAIL in 114 PASS / 30 FAIL suites, retaining all original assertions and exact failure identities. Core's actual current-target comparison has 184 PASS / 22 FAIL versus 165 PASS / 22 FAIL before the auth overlay, retaining every target assertion and exact failure identity. The log-only follow-up changed no auth code or manifest; its staged patch exactly matched the reviewed two-line artifact. No extra full suite was run for that Dockerfile-only deletion.

Existing failures are unresolved and not waived by source review or this proposed batch. This is not permission to bypass required checks or claim milestone acceptance. Actual Node 20.17.0 image/runtime validation, complete deployed legacy-consumer checks and exact-head CI evidence remain open. [Current target validation](evidence/M1b-Core-Current-Target-Validation-20261018.json), [source receipts](evidence/M1b-Draft-Publication-20261018.json).

Owner-supplied Core rollback image is `cr.raum.au/core.ui@sha256:4c9c6e031d86a061fe29bb9655a6f88b5f761a80987a71842073449dcde53e44`, tag `015.375.000.000`; the live matching Git tag points to Core target `cb7668f4`. This supports the rollback/source inventory but is not independent build-to-image attestation. [Rollback receipt](evidence/M1b-Core-Development-Rollback-20261018.json).

No image build/push, release tag, runtime configuration, Kubernetes operation, Mongo write, client/secret creation, domain/project mutation, or VYNVORI bridge activation is included. After source-only merges, prepare the separate owner-run build/image validation batch against the resulting exact source pins. All operational and M1b acceptance gates remain blocked until separately approved and executed.
