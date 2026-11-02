# M1b development rollout readiness

2026-10-19, Asia/Dhaka. Proposal only. Local image probes passed; image publication and deployment remain unauthorized. This document does not supply executable mutation commands or reserve a release version.

## Exact artifacts

Use the already tested local images if a later publication is approved; a fresh pipeline rebuild would produce a different artifact requiring its own evidence.

| Component | Source | Local immutable image ID |
|---|---|---|
| Portal | `35a47c9d6d7b41adbed5cc6556a4e9bbe78269ba` | `sha256:c64402c587ca92283bd78d15fd1e4834bc3ac27afb3fd49304194f6ea4c308b5` |
| Core | `30efb9e295ccdf4e6a51c3c3d8d2b05c6494381f` | `sha256:eaf95af446943e7e6c32a9db16c3d366bda4881aee8480f141be0aea30eee5f9` |

Both are linux/amd64. These local image IDs are not registry manifest digests. A later registry-only publication must record and independently resolve its repository manifest digest before a deployment proposal can name the immutable deployment artifact. Portal's original build exit was not captured; its completed image and successful probe are verified. [Local evidence](evidence/M1b-Local-Image-Validation-Result-20261019.json).

The checked-in Portal and Core tag pipelines both build, push and update development Kubernetes workloads. They cannot serve as a registry-only publication action. Core's pipeline also selects production/test/development build configuration from the tag suffix. The owner-run Core image used development configuration; its bounded module probe does not establish that all compiled public URLs match the currently deployed Core environment. Do not promote that image until relevant nonsecret origins and runtime routing have been checked privately.

## Evidence needed before asking for rollout approval

1. Obtain the development OAuth client inventory using the previously supplied read-only Compass projection. Verify the connection belongs to the actual Portal development environment. Do not request full client documents, secrets, tokens or user records.
2. Map every enabled client to an owner and applicable legacy flow. Missing owners or untested consumer classes remain explicit blockers to a no-regression claim. Include interactive authorization/consent, refresh, revocation and service credentials where used; preserve existing active sessions and response contracts. Disabled clients stay disabled.
3. Capture pre-change smoke results on synthetic accounts through each affected consumer, using its normal login path. Record expected behavior and sanitized outcomes only. A source test passing is not an executed consumer test.
4. Privately inspect current development workload specs, configuration references, routing and node architecture. Share only nonsecret metadata. Confirm rollback digests remain available and current; retain complete rollback specifications privately. Do not post full workload YAML containing environment values.
5. Resolve image publication method and owner-selected unused registry tags without creating Git tags or starting a pipeline. Registry-only publication needs separate approval. Determine whether publishing those registry tags can trigger any external image watcher before authorizing it.
6. Record immutable published digests, source labels and target architecture. Prepare an exact development-only deployment diff with strict Portal disabled and Core enrollment empty, keeping existing runtime configuration. Any required configuration change needs its own reviewed diff and authorization.
7. Present the exact workload/image changes, baseline results, known pre-existing test failures, rollback actions and stopping criteria for owner approval. No failure waiver is inferred from earlier source approval.

## Legacy regression record

Create one row per enabled client after inventory arrives. Required fields: nonsecret client ID/name, responsible owner, grants/scopes, exercised flow, pre-change result, post-change result, active-session continuity, evidence location and rollback outcome. Do not prefill PASS or assume an unknown consumer is covered by another client.

For a separately approved development rollout, stop progression on unexpected login/consent/refresh/revocation failures, changed legacy response contracts, active-session loss, routing drift, database errors or unhealthy workloads. Restore the approved prior image/configuration using the retained rollback specification, then recheck consumer behavior. The actual rollout and rollback drill are NOT_RUN.

## Local implementation proceeds independently of rollout

Founder steering on 2026-10-19: use the existing LuckyLittleDevil Medusa/web integration as the starting point and enhance it for VYNVORI. The legacy consumer checklist protects a proposed Portal rollout; it is not a prerequisite for writing and testing disabled VYNVORI code. Do not request completion of all 19 consumer smoke tests before local bridge implementation. Existing registration, database mutation and deployment approval boundaries remain in force.

Reuse the audited central-login, server-side exchange, product session and Medusa customer/provider architecture. Adapt it to installed Medusa 2.21.2, VYNVORI's issuer+subject key, durable session/revocation checks, single-use callback transactions, fenced provisioning and guest ownership. Use synthetic adapters for unavailable live configuration, and keep production/customer-auth activation disabled. Neither a synthetic result nor reused source demonstrates deployed acceptance.

## Remaining M1b work

Even successful strict-off development regression does not complete M1b. Dedicated client registration, additive strict storage preparation, private signing/credential custody and cohort configuration require separate authorization. Central synthetic trust/revocation/consent acceptance must then pass before the dependent VYNVORI bridge is activated. Durable callback transactions, issuer+subject identity mapping, fenced native Medusa provisioning, sessions/logout, guest ownership, staff separation and isolated staging acceptance remain incomplete. See the [staging sequence](M1b-Staging-Activation-Plan-20261018.md).

Inventory received: 19 active registrations (10 missing-grant legacy records, 3 explicit interactive and 6 explicit service). [Per-client coverage](M1b-Legacy-Consumer-Coverage-20261019.md) is recorded. Owner confirmed the development connection and volunteered as test executor. Current owner action: run the [existing-consumer baseline checklist](M1b-Owner-Legacy-Smoke-Checklist-20261019.md) and report actual URLs/harnesses plus per-check outcomes. No image push, Git tag, pipeline, database write or deployment is needed for those actions.
