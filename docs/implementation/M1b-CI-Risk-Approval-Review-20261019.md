# M1b CI-only dependency risk decision

Status: PROPOSED, NOT APPROVED. This document grants no authority. The active policy file is absent and both M1b selectors remain UNACTIVATED.

The requested decision permits the exact reviewed dependency findings during GitHub pull-request CI for `codex/m1b-central-identity` into `main`, expiring at **2026-10-24T23:59:59Z**. It does not approve merging, runtime staging risk, client registration, live storage/configuration changes, image publication, release tags or deployment. All operational flags remain off. Existing M2 approvals remain unchanged.

## Exact evidence

- [Draft PR #10](https://github.com/TheCrimsonMarket/vynvori/pull/10), implementation `a1e457a8c184fbd5bad7d496e9bfc6cb4cd74a51`.
- [Successful evidence-only CI run](https://github.com/TheCrimsonMarket/vynvori/actions/runs/39219523405), artifact ID `12170629288`.
- Artifact ZIP SHA256: `536c811bd47b383c69d4a3b57ef68530171c256e066db4cde2fabb0a474678c8`.
- Canonical unapproved proposal digest: `ed04cd591dc979670082cfab38f2fcf6cb4dcb24ca37089eefbdb960fd8514da`.
- Locally verified all **218** recorded source blobs and Linux lockfile hash against that implementation's Git objects. The later protected-document receipt commit changes no recorded source blob.
- Fresh local CI image: `sha256:a9c48e368da72904e9004b932768d21a1bfcadd9a860db1e1b35f0b62f69482e`; Node 22.23.3, UID 65532. Scanner DB updated 2026-10-19 00:45:30 UTC; next update 2026-10-20 00:45:30 UTC. A future accepting CI run must build and scan afresh.

## Findings to accept temporarily for CI

| Evidence | Findings |
|---|---|
| Unfiltered production npm audit | 79 affected package entries: 76 high, 3 moderate, zero critical. Two advisory roots: braces 3.0.3 `GHSA-vfj7-8cjw-p6xm`, sprintf-js 1.0.3 `GHSA-hp3w-g68c-fv3c`. |
| Unfiltered full npm audit | 85 affected package entries: 78 high, 7 moderate, zero critical. Adds nested development esbuild 0.18.20 `GHSA-67mh-4wv8-2f99`. |
| Fresh runtime scan | One high JavaScript finding: braces `CVE-2026-93687`; 31 OS findings: 8 low and 23 medium. No OS high or critical findings. |

Affected npm entries include inherited dependency effects and are not distinct advisory counts. Both npm audits exit 1; that fact is retained. [Source reachability and remediation review](M1b-Security-Source-Review-20261019.md) describes the known exposure and its limits. This review does not prove every transitive framework path unreachable. npm's proposed incompatible major-version downgrades were not applied.

The proposed evaluator pins the complete audit graph, source/manifests, installed resolution graph, runtime inventory/configuration/base layers and normalized scan. Changed findings, a critical finding, stale scanner database, source drift, unsafe TLS overrides or operational configuration fail closed. Its context is restricted to this repository's Linux GitHub PR CI. No public application or live identity configuration is permitted.

## Activation only after the owner's explicit decision

After approval, copy the exact unapproved proposal into `security/m1b-source-ci-policy.json`, changing only `approved` to true, `authority` to `VYNVORI founder` and `approvedOn` to the actual approval date. Anchor that complete policy's digest and the implementation SHA in the two prepared selectors. Publish these changes as an authorized source follow-up and require fresh exact-head CI. Any other proposal content change requires review again.

Local evaluation with hypothetical approval metadata was performed only in memory to check the evidence fits the proposed bounds; the actual unactivated evaluator still returns `M1B_NOT_APPROVED`. No active approval file was written.

The separate protected-document receipt correction passed `verify:reference`: all 202 protected files and nine app asset/font/license copies match. M1b remains IN_PROGRESS pending CI approval and actual separately authorized staging acceptance.

## Owner decision and test-only amendment

The owner approved the original CI-only exception on 2026-10-19. Activation then exposed two test assertions that specifically expected inactive selectors. With active selectors, the fabricated test policy is still rejected, with `M1B_APPROVAL_CHANGED` rather than `M1B_NOT_APPROVED`. No acceptance rule failed. The activation was withdrawn before publication; selectors remain inactive and no active policy file exists.

Source follow-up `a87250e2ff7f8f1666070bf0634b28621d4390a6` changes only those denial assertions and their test title inside the sealed source surface. Both legitimate rejection codes are accepted; the evaluator must still return `accepted: false`. All 34 policy tests pass. Runtime/evaluator/workflow/lockfile/dependency changes: **none**. Between the original implementation and this commit, the only other changes are the protected-document receipt and this review document, outside the sealed source surface.

Amendment requested: bind the same approved risk bounds, findings and expiry to implementation `a87250e2ff7f8f1666070bf0634b28621d4390a6`, updating only the recorded test-file hash from `9810c67f79fc8538bbd8006f09e6dfc6a1ef837d7d4324a865b6612a64785f54` to `13479d397cbae17903da1b310a35cd8a6f5ae38a8172ccafdaa58bec261df84c`. Canonical amended unapproved proposal digest: `a98f21589d3fb07d9de9a9d53e6099b94976f25e2d4af081636ee708f94b5711`. The original CI artifact supplies unchanged audit/runtime evidence; the amended candidate is not represented as a newly collected artifact. A fresh accepting CI run must still verify its own source, installed dependencies, audits and image.

This amendment is **pending explicit owner approval** because the original decision named the exact earlier source receipt. No risk scope expansion, expiry extension or operational authority is requested.

### Amendment approved and selectors activated

The owner explicitly approved the test-only receipt amendment on 2026-10-19. The active policy now binds implementation `a87250e2ff7f8f1666070bf0634b28621d4390a6` with canonical approved-policy digest `ee9b4ffda2322952da3120de92faff652c26243e00bae38b12ed4aedee78a09b`. Only the three approval metadata fields differ from the amended unapproved proposal. Both prepared selectors are set to these exact values; all 34 policy tests pass with activation present. Earlier inactive/pending descriptions above record the review sequence. Fresh exact-head CI acceptance is still required; this source activation is not staging or milestone acceptance.
