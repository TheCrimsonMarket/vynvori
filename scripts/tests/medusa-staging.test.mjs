import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { target, bundledPolicy, validateApproval, validateRemoteContext, verifyMetadata, authorizeExecution } from "../../apps/medusa/scripts/remote-staging.mjs";
import { validateConfiguration, validateRelease, validateIam } from "../medusa-staging-release.mjs";
import { STAGING_IMPLEMENTATION_COMMIT, STAGING_POLICY_DIGEST } from "../security/run-audit.mjs";
import { digest } from "../security/audit-policy.mjs";
import { auditIdentity } from "../security/pr5-local-policy.mjs";
import { collectStagingState, evaluateStaging, stagingLineage } from "../security/staging-policy.mjs";
const { load } = createRequire(import.meta.url)("js-yaml");
const template = load(await fs.readFile(new URL("../../deploy/medusa/service.yaml", import.meta.url), "utf8"));
const now = new Date("2026-10-18T00:00:00Z");
test("published staging provenance permits descendants only behind exact source approval", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const base = "f923f7b26c4fc0684e26cfdf29ebf177d80103f6";
  assert.match(stagingLineage(root, base, base), /^[a-f0-9]{40}$/);
  assert.throws(() => stagingLineage(root, "a".repeat(40), base), /STAGING_BASE_CHANGED/);
  assert.throws(() => stagingLineage(root, base, "a".repeat(40)), /STAGING_BASE_CHANGED/);
});
// Positive fixtures are synthetic test inputs, never written into the bundled policy.
const approval = { ...await bundledPolicy(), approved: true, approvedBy: "synthetic-reviewer", sourceCommit: "a".repeat(40) };
const env = { K_SERVICE: target.service, K_CONFIGURATION: target.service, K_REVISION: `${target.service}-synthetic`,
  NODE_ENV: "production", M2_ENV: "staging", M2_REMOTE_STAGING_APPROVAL: approval.id, M2_REMOTE_SOURCE_COMMIT: approval.sourceCommit };
const release = { project: target.project, region: target.region, sourceCommit: approval.sourceCommit, approvalId: approval.id,
  databaseRoles: { runtime: "vynvori_medusa_runtime_scoped", migration: "vynvori_medusa_migration_scoped" },
  image: `${target.registry}@sha256:${"b".repeat(64)}`, databaseHost: "ep-synthetic.us-east-1.aws.neon.tech", operatorHost: "operator.example.com",
  secretVersions: { "vynvori-medusa-database-url": "1", "vynvori-medusa-jwt-secret": "2", "vynvori-medusa-cookie-secret": "3" } };
let yaml = JSON.stringify(template).replaceAll("REPLACE_REVIEWED_DIGEST", "b".repeat(64)).replaceAll("REPLACE_REVIEWED_SOURCE_COMMIT", approval.sourceCommit)
  .replaceAll("REPLACE_VERIFIED_DIRECT_NEON_HOST", release.databaseHost).replaceAll("REPLACE_VERIFIED_VERCEL_HOST", "www.vynvori.com")
  .replaceAll("REPLACE_VERIFIED_OPERATOR_ORIGIN", release.operatorHost);
let version = 0;
yaml = yaml.replaceAll("REPLACE_NUMERIC_SECRET_VERSION", () => String(++version));
const service = JSON.parse(yaml);
const policies = [{ bindings: [] }, { bindings: [{ role: "roles/run.invoker", members: ["user:synthetic@example.invalid"] }] }];
const actualPolicy = await bundledPolicy();
const awaitPolicy = { ...actualPolicy, approved: false, approvedBy: null, sourceCommit: null };

test("private staging exception pins full audits, image findings, runtime, freshness and expiry", async () => {
  const audits = JSON.parse(await fs.readFile(new URL("../../security/fixtures/pr5-reviewed-audits.json", import.meta.url), "utf8"));
  const runtime = JSON.parse(await fs.readFile(new URL("../../security/fixtures/pr5-reviewed-runtime.json", import.meta.url), "utf8"));
  const policy = { scope: "private-synthetic-staging-only", expiresAt: "2026-10-24T23:59:59Z", sourceFingerprints: {},
    auditIdentities: { production: digest(auditIdentity(audits.rawProduction)), all: digest(auditIdentity(audits.rawAll)) }, scanIdentity: digest(runtime.scan) };
  const input = { policy, runtime, production: { exitCode: 1, stdout: JSON.stringify(audits.rawProduction) },
    all: { exitCode: 1, stdout: JSON.stringify(audits.rawAll) }, env: { PR5_SECURITY_SCOPE: "local-synthetic-only" }, now,
    image: { ...structuredClone(runtime), localEngineVerified: true, database: { UpdatedAt: "2026-10-17T18:00:00Z", NextUpdate: "2026-10-18T18:00:00Z" } } };
  assert.equal(evaluateStaging(input).accepted, true);
  for (const change of [i => { i.production.exitCode = 0; }, i => { i.all.executionError = true; },
    i => { i.production.stdout = "{}"; }, i => { i.env.K_SERVICE = target.service; },
    i => { i.image.scan.pop(); }, i => { i.image.scan[0].findings.push({ VulnerabilityID: "NEW" }); },
    i => { i.image.inventory.uid = 0; }, i => { i.image.baseLayers.push("new"); },
    i => { i.image.database.NextUpdate = "2026-10-17T00:00:00Z"; },
    i => { i.image.database.UpdatedAt = "2026-10-19T00:00:00Z"; },
    i => { i.now = new Date(policy.expiresAt); }, i => { i.policy.expiresAt = "2027-01-01T00:00:00Z"; }]) {
    const changed = structuredClone(input); change(changed); assert.equal(evaluateStaging(changed).accepted, false);
  }
});
test("bundled policy rejects remote execution before metadata/network or Medusa spawn", async () => {
  assert.throws(() => validateApproval(awaitPolicy), /REMOTE_APPROVAL_REQUIRED/);
  assert.throws(() => validateApproval(awaitPolicy), /REMOTE_APPROVAL_REQUIRED/);
});
test("bundled activation matches the sealed implementation while an unapproved policy still fails", () => {
  if (STAGING_IMPLEMENTATION_COMMIT === "UNACTIVATED") assert.throws(() => validateApproval(actualPolicy), /REMOTE_APPROVAL_REQUIRED/);
  else { validateApproval(actualPolicy); assert.equal(actualPolicy.sourceCommit, STAGING_IMPLEMENTATION_COMMIT); }
});
test("actual staging source overlay and policy anchor are verified, or remain unactivated", async () => {
  const legacy = JSON.parse(await fs.readFile(new URL("../../security/m2-exception-policy.json", import.meta.url), "utf8"));
  const root = fileURLToPath(new URL("../..", import.meta.url));
  if (STAGING_IMPLEMENTATION_COMMIT === "UNACTIVATED") await assert.rejects(collectStagingState(root, STAGING_IMPLEMENTATION_COMMIT, STAGING_POLICY_DIGEST, legacy), /STAGING_NOT_ACTIVATED/);
  else { const result = await collectStagingState(root, STAGING_IMPLEMENTATION_COMMIT, STAGING_POLICY_DIGEST, legacy); assert.equal(result.policy.implementationCommit, STAGING_IMPLEMENTATION_COMMIT); }
});
test("reviewed remote fixture accepts only the exact service context and bounded window", () => {
  validateRemoteContext(env, "serve", approval, now);
  for (const patch of [{ K_SERVICE: "other" }, { K_CONFIGURATION: "other" }, { K_REVISION: "" }, { NODE_ENV: "development" },
    { M2_ENV: "production" }, { M2_REMOTE_SOURCE_COMMIT: "c".repeat(40) }, { M2_REMOTE_STAGING_APPROVAL: "local-synthetic-only" },
    { CLOUD_RUN_JOB: "job" }, { CLOUD_RUN_EXECUTION: "execution" }, { VERCEL: "1" }, { VERCEL_ENV: "preview" },
    { M2_AUTHORIZE_MEDUSA_MIGRATION: "vynvori_medusa_staging" }, { VYNVORI_PAYMENTS_LIVE: "true" }, { REDIS_URL: "redis://synthetic" },
    { NEXT_PUBLIC_M2_BACKEND: "https://example.invalid" }, { NODE_TLS_REJECT_UNAUTHORIZED: "0" }]) {
    assert.throws(() => validateRemoteContext({ ...env, ...patch }, "serve", approval, now));
  }
  assert.throws(() => validateRemoteContext(env, "migrate", approval, now));
  for (const date of ["2026-10-16", approval.expiresAt, "invalid"]) assert.throws(() => validateApproval(approval, new Date(date)));
  assert.throws(() => validateApproval({ ...approval, expiresAt: "2027-01-01" }, now));
});
test("unmarked staging and local attempts to supply a remote approval fail closed", async () => {
  await authorizeExecution({ M2_ENV: "local" }, "serve");
  await authorizeExecution({ M2_ENV: "staging", M2_AUTHORIZE_MEDUSA_MIGRATION: "vynvori_medusa_staging" }, "migrate");
  await assert.rejects(authorizeExecution({ M2_ENV: "staging", M2_AUTHORIZE_MEDUSA_MIGRATION: "vynvori_medusa_staging" }, "serve"));
  await assert.rejects(authorizeExecution({ M2_ENV: "staging" }, "serve"));
  await assert.rejects(authorizeExecution({ M2_ENV: "local", M2_REMOTE_STAGING_APPROVAL: approval.id }, "serve"));
});
test("metadata validates project, region and runtime identity, rejecting failures without retries", async () => {
  const values = [target.project, "projects/123456/regions/us-east1", target.account];
  function fetcher(replacements = values, header = "Google", status = 200) {
    let index = 0;
    return async (url, options) => {
      assert.match(url, /^http:\/\/metadata\.google\.internal\/computeMetadata\/v1\//);
      assert.equal(options.redirect, "error"); assert.ok(options.signal);
      assert.equal(options.headers["Metadata-Flavor"], "Google");
      return new Response(replacements[index++], { status, headers: { "Metadata-Flavor": header } });
    };
  }
  await verifyMetadata(fetcher());
  for (let index = 0; index < 3; index++) {
    const changed = [...values]; changed[index] = "wrong";
    await assert.rejects(verifyMetadata(fetcher(changed)), /REMOTE_IDENTITY_REJECTED/);
  }
  await assert.rejects(verifyMetadata(fetcher(values, "wrong")), /REMOTE_METADATA_UNAVAILABLE/);
  await assert.rejects(verifyMetadata(fetcher(values, "Google", 503)), /REMOTE_METADATA_UNAVAILABLE/);
  await assert.rejects(verifyMetadata(async () => { throw new Error("synthetic timeout"); }));
});
test("exact resolved config, secret versions, image digest and IAM are independently checked", () => {
  const configurationSha256 = validateConfiguration(service, release, template);
  const reviewed = { ...release, configurationSha256 };
  validateRelease(service, reviewed, template, policies, approval, now);
  assert.throws(() => validateRelease(service, reviewed, template, policies, awaitPolicy, now), /REMOTE_APPROVAL_REQUIRED/);
  assert.throws(() => validateRelease(service, { ...reviewed, configurationSha256: "c".repeat(64) }, template, policies, approval, now));
  for (const mutate of [s => { s.metadata.annotations["run.googleapis.com/invoker-iam-disabled"] = "true"; },
    s => { s.spec.template.spec.serviceAccountName = "vynvori-image-worker"; },
    s => { s.spec.template.spec.containers[0].image = `${target.registry}:latest`; },
    s => { s.spec.template.spec.containers[0].env[0].value = "other-approval"; },
    s => { s.spec.template.spec.containers[0].env.push({ name: "REDIS_URL", value: "redis://synthetic" }); },
    s => { s.spec.template.spec.containers[0].env.find(e => e.valueFrom).valueFrom.secretKeyRef.key = "latest"; },
    s => { s.spec.template.spec.containers[0].env.find(e => e.valueFrom).valueFrom.secretKeyRef.name = "other-secret"; },
    s => { s.spec.template.spec.containers[0].command = ["bypass"]; },
    s => { s.spec.template.spec.containers[0].startupProbe.httpGet.path = "/admin/m2-readiness"; },
    s => { s.spec.template.spec.containerConcurrency = 80; },
    s => { s.spec.template.spec.containers.push(structuredClone(s.spec.template.spec.containers[0])); }]) {
    const changed = structuredClone(service); mutate(changed);
    assert.throws(() => validateConfiguration(changed, release, template));
  }
  for (const patch of [{ project: "other" }, { region: "us-central1" }, { image: `${target.registry}:latest` },
    { databaseRoles: undefined }, { databaseRoles: { runtime: "vynvori_medusa_app", migration: "vynvori_medusa_migration_scoped" } },
    { databaseRoles: { runtime: "vynvori_medusa_runtime_scoped", migration: "vynvori_medusa_migrator" } },
    { databaseHost: release.databaseHost.replace("ep-synthetic.", "ep-synthetic-pooler.") }, { secretVersions: {} }]) {
    assert.throws(() => validateConfiguration(service, { ...release, ...patch }, template));
  }
  for (const member of ["allUsers", "allAuthenticatedUsers", "principalSet://goog/public:all"]) {
    assert.throws(() => validateIam([{ bindings: [] }, { bindings: [{ role: "custom/unknown", members: [member] }] }]), /PUBLIC_IAM_REJECTED/);
  }
  assert.throws(() => validateIam([]));
  assert.throws(() => validateConfiguration(template, release, template));
});
