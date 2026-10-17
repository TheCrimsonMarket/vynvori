# M2 — Private staging operator release checklist

2026-10-17. **NOT AN EXECUTION AUTHORIZATION.** This PR stops before merging, registry build/push, provisioning, actual credentials/SQL, remote migration or Cloud Run deployment. Commands below are for a later separately approved operator window. Do not add automatic deployment to CI.

## Missing provider/review values

| Value | Status / expected contract |
|---|---|
| GCP project/region/service | Fixed: `lucky-little-devil` / `us-east1` / `vynvori-medusa-staging`; actual resource state NOT_QUERIED |
| Runtime identity | Fixed `vynvori-medusa-runtime@lucky-little-devil.iam.gserviceaccount.com`; existence/grants NOT_VERIFIED; never reuse image-worker |
| Artifact repository | Fixed `us-east1-docker.pkg.dev/lucky-little-devil/vynvori-staging-images`; image `medusa`; platform digest MISSING |
| Runtime secrets | Three names fixed in service YAML; numeric versions and secret-level IAM MISSING |
| Neon mapping | Dedicated commerce project ID, staging branch ID, endpoint ID/direct host, owner/ACL audit, restore evidence MISSING |
| Migration-only secret | Proposed `vynvori-medusa-migration-database-url`; founder approval/version/operator grants MISSING; never mounted by runtime |
| Invoker / operator origin | Private operator principal/impersonation path and approved HTTPS operator host MISSING; no invented domain |
| Storefront | Existing `vynvori-dev`, `www.vynvori.com`; no integration/configuration changes here; CORS alone grants no access |
| Release approval | Remote risk approval, sealed source/policy commit, CI exception decision, image/config digest and execution approval MISSING |

## Sequence and evidence

1. Review implementation/ADR, [risk proposal](M2-Remote-Staging-Risk-Proposal.md) and local evidence. Approve a fresh CI policy scope independently; do not bypass the existing red security gate. Obtain founder + independent remote-security approval. Only then separately activate bundled policy (`approved`, `approvedBy`, sealed `sourceCommit`); sole allowed delta from sealed implementation is that reviewed policy file. Its fixed expiry cannot exceed 2026-10-24T23:59:59Z. No env-only activation.
2. Separately authorize publisher build/push after merge/review. Use original Dockerfile, pinned lock/base images, linux/amd64, exact source/activation commits. Preserve fresh raw audits/scan, full inventory, platform manifest digest and provenance. Local PR #5 image is unsuitable for remote rollback because its supervisor refuses Cloud Run.
3. Verify founder resources and **effective** IAM from service plus all project/folder/org ancestors, including custom roles and private principals with invoke/admin capabilities. Check no public principals, invoker check enabled, dedicated SA has only secret-level accessor on three runtime secrets, no keys, project editor, image-worker grants, registry writer or migration secret access. Verify Cloud Run service-agent pull permission; grant runtime SA no registry write. Review project-number/service-agent mapping. Secrets are numeric versions, enabled, correctly scoped and never copied into release artifacts. No secret-access commands in this preparation PR.
4. Independently approve target/recovery/role grants and execute native migration once through [Neon procedure](M2-Neon-Migration-Procedure.md). Reconcile uncertainty before any replay. Produce actual startup/Admin/customer-denial evidence under runtime role; gate real activation on success.
5. Prepare immutable release package outside the repo: resolved `service.yaml`, `release.json` based on `deploy/medusa/release.example.json`, and `iam-policies.json` array containing fresh service/project/all-ancestor policies. Record their resource names, timestamps and raw-file SHA-256 in the signed review. Offline validator checks supplied policies but cannot establish completeness. First-service absence must be evidenced; inspect project/ancestors before creating it and service policy immediately afterward, before granting any invoker. It must start private by default.
6. Resolve service replacements exactly: platform digest, sealed implementation source marker, direct Neon hostname, three numeric versions, storefront `www.vynvori.com`, verified HTTPS operator origin. Preserve project/region/service/SA, ingress all **with IAM enabled**, min 0/max 1 at service+revision, request CPU, no startup boost, 1 CPU/2 GiB, concurrency 8, timeout 60s, `/health` probes, no Redis/worker/migration vars or enabled operational flags. Compute canonical configuration SHA using exported `hash` over `{labels: service.metadata.labels, annotations: service.metadata.annotations, spec: service.spec}`; reviewer verifies it independently. Record full-file SHA too. A matching hash does not itself authorize deployment.

```sh
# Future read-only evidence collection; run only in the approved operator session.
gcloud run services describe vynvori-medusa-staging --project=lucky-little-devil --region=us-east1 --format=json
gcloud run services get-iam-policy vynvori-medusa-staging --project=lucky-little-devil --region=us-east1 --format=json
gcloud projects get-iam-policy lucky-little-devil --format=json
# Also retrieve every actual folder/org ancestor policy; IDs come from provider records.
node scripts/medusa-staging-release.mjs /review/release.json /review/resolved-service.yaml /review/iam-policies.json
```

The validator deliberately rejects the bundled unapproved policy in this PR. Tests use in-memory synthetic approvals only. Once all review/signoff/evidence is complete, the exact manual deployment command is:

```sh
# HUMAN APPROVAL REQUIRED immediately before execution.
gcloud run services replace /review/resolved-service.yaml --project=lucky-little-devil --region=us-east1
```

No `--allow-unauthenticated`, invoker-check disabling, public grant or automatic promotion. The resolved YAML pins the exact image digest, numeric secrets and resource limits; archive its hash before applying. After deployment re-export service/revision/configuration, verify actual resolved image digest, service identity, region, secret versions and resources match the approved package. Recheck IAM/ancestors before granting the specifically reviewed private operator invoker. The command does not repair preexisting IAM policy, so stop if prior state differs. Record active revision/traffic; no old tagged revision may bypass the review.

## Post-deployment smoke (synthetic only)

Run from the approved operator environment. Obtain the origin from the actual service export and Google ID token with that exact audience through the approved human impersonation/federation path; token acquisition details depend on the still-missing operator identity. Never download a service-account key. Do not put tokens into tracked files, command history, screenshots or PR evidence. A protected smoke client should attach `X-Serverless-Authorization: Bearer <audience-bound Google ID token>` and, when needed, separate `Authorization: Bearer <synthetic Medusa user token>` in memory.

- Without Google token: `/health`, native Admin and customer routes must be denied at IAM (401/403). Repeat with wrong audience/unauthorized principal and any tagged revision URL. HTTP 200/redirect to a public login is a failure.
- Approved IAM token alone: `/health` 200; `/admin/m2-readiness` 401. Wrong Medusa actor/user token must remain denied.
- Approved IAM + synthetic native user token: readiness 200 and minimal Admin reads; unauthorized customer auth/register and every Store mutation 403 including valid publishable key; `/store/customers/me` without a customer identity 401. Use the existing container suite route list as the smoke contract. No real order, customer or payment.
- Record cold-start time, response p95 at concurrency 8, memory/CPU, no OOM, TLS/Neon wake latency, secret denial and dependency failure/recovery. Test outage only against this synthetic staging target in the approved window. `/health` remains independent; protected readiness returns generic bounded 503 then recovers. Verify revision startup/shutdown and redacted logs. Local test evidence is not proof of these remote behaviors.
- Verify effective IAM once more, no customer/commerce operational feature enabled, no uploads/AI/print/paid exports. Do not activate Vercel federation/BFF yet. Future server-only integration must hold audience-bound Google credentials and preserve Medusa actor authorization; browser receives neither.

## Stop, rollback and costs

On failed startup/migration/smoke or unexpected public access: stop further requests, revoke only reviewed invoker grants through an approved IAM operator, preserve evidence, fence affected revision traffic. For a first service with no compatible approved previous revision, stop/delete only `vynvori-medusa-staging` after explicit rollback authorization, retaining Neon/secret evidence. For later releases use a compatible approved prior revision plus exact prior configuration/secret versions; never blindly switch to PR #5 or run reverse migrations. Schema incompatibility requires the separate restore/cutover decision. At approval expiry revoke invocation and stop service, including already-running instances.

Scale-to-zero eliminates a reserved warm-instance floor, but cold starts/restarts/health checking and synthetic requests consume resources and request CPU is unavailable for dependable background work. At current [us-east1 request-based list rates](https://cloud.google.com/run/pricing), active compute is approximately `(0.000024 + 2 × 0.0000025) × active instance-seconds`: **$0.1044 per active instance-hour**, about **$3.13 for 30 active hours** or **$75.17 for 720 active hours**, before free tier/discounts/tax, requests ($0.40/million), egress and ancillary charges. These are scenarios, not a bill or hard spending cap. Free tier may already be consumed by other services in the shared billing account. Max 1 does not cap total project cost or prevent temporary revision overlap.

Neon compute/storage/recovery, Secret Manager versions/access, Artifact Registry image storage, logging and image builds/scans can add cost; actual plan/region/storage/retention values remain MISSING. Agree on a staging budget/alerts and log/image retention, then measure actual billed usage after approval. Budget alerts do not stop spending. No paid-provider request or cloud billable operation was executed by this PR.
