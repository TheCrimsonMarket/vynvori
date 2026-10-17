// Offline validation only: no gcloud, network, SQL, registry or deployment calls.
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { target, validateApproval, bundledPolicy } from "../apps/medusa/scripts/remote-staging.mjs";
const require = createRequire(import.meta.url);
const { load } = require("js-yaml");
const check = (ok, code) => { if (!ok) throw new Error(code); };
const canonical = value => JSON.stringify(value, (_, entry) => entry && typeof entry === "object" && !Array.isArray(entry)
  ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
export const hash = value => createHash("sha256").update(canonical(value)).digest("hex");
export function validateConfiguration(service, release, template) {
  check(release.project === target.project && release.region === target.region &&
    /^[a-f0-9]{40}$/.test(release.sourceCommit ?? "") &&
    new RegExp(`^${target.registry.replaceAll(".", "\\.")}@sha256:[a-f0-9]{64}$`).test(release.image ?? ""), "RELEASE_TARGET_OR_DIGEST_INVALID");
  check(/^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/.test(release.databaseHost ?? "") &&
    !release.databaseHost.includes("-pooler."), "DIRECT_NEON_HOST_REQUIRED");
  const replacements = { REPLACE_REVIEWED_DIGEST: release.image.split("sha256:")[1],
    REPLACE_REVIEWED_SOURCE_COMMIT: release.sourceCommit,
    REPLACE_VERIFIED_DIRECT_NEON_HOST: release.databaseHost,
    REPLACE_VERIFIED_VERCEL_HOST: "www.vynvori.com",
    REPLACE_VERIFIED_OPERATOR_ORIGIN: release.operatorHost };
  check(typeof release.operatorHost === "string" && /^[a-z0-9.-]+$/.test(release.operatorHost) &&
    !/localhost|REPLACE|\.invalid$/.test(release.operatorHost) && new URL(`https://${release.operatorHost}`).hostname === release.operatorHost,
    "VERIFIED_OPERATOR_HOST_REQUIRED");
  const expected = structuredClone(template);
  function replace(value) {
    if (typeof value === "string") for (const [key, replacement] of Object.entries(replacements)) value = value.replaceAll(key, replacement);
    return value;
  }
  expected.spec.template.spec.containers[0].image = replace(expected.spec.template.spec.containers[0].image);
  const names = { M2_MEDUSA_DATABASE_URL: "vynvori-medusa-database-url", M2_MEDUSA_JWT_SECRET: "vynvori-medusa-jwt-secret", M2_MEDUSA_COOKIE_SECRET: "vynvori-medusa-cookie-secret" };
  for (const entry of expected.spec.template.spec.containers[0].env) {
    if (entry.valueFrom) {
      const version = release.secretVersions?.[names[entry.name]];
      check(typeof version === "string" && /^[1-9]\d*$/.test(version), "NUMERIC_SECRET_VERSION_REQUIRED");
      entry.valueFrom.secretKeyRef.key = version;
    } else entry.value = replace(entry.value);
  }
  check(service.apiVersion === expected.apiVersion && service.kind === expected.kind &&
    service.metadata.name === target.service &&
    hash(service.metadata.labels) === hash(expected.metadata.labels) &&
    hash(service.metadata.annotations) === hash(expected.metadata.annotations) && hash(service.spec) === hash(expected.spec),
    "UNREVIEWED_SERVICE_CONFIGURATION");
  check(!JSON.stringify(service).includes("REPLACE_"), "UNRESOLVED_PROVIDER_IDENTIFIER");
  return hash({ labels: service.metadata.labels, annotations: service.metadata.annotations, spec: service.spec });
}
export function validateIam(policies) {
  check(Array.isArray(policies) && policies.length >= 2, "SERVICE_AND_ANCESTOR_IAM_REQUIRED");
  for (const policy of policies) {
    check(Array.isArray(policy?.bindings), "IAM_EVIDENCE_INVALID");
    for (const binding of policy.bindings) {
      check(Array.isArray(binding.members), "IAM_EVIDENCE_INVALID");
      check(!binding.members.some(member => /^(?:allUsers|allAuthenticatedUsers|principalSet:\/\/goog\/public:all)$/.test(member)), "PUBLIC_IAM_REJECTED");
    }
  }
  // This rejects public bindings at every supplied scope, including custom roles.
  // Completeness/freshness and which private principals can invoke require review.
}
export function validateRelease(service, release, template, policies, approval, now) {
  const configurationSha256 = validateConfiguration(service, release, template);
  validateIam(policies);
  validateApproval(approval, now);
  check(release.sourceCommit === approval.sourceCommit && release.approvalId === approval.id &&
    release.configurationSha256 === configurationSha256, "RELEASE_APPROVAL_SCOPE_MISMATCH");
  return { status: "OFFLINE_CHECKS_PASSED_REQUIRES_HUMAN_DEPLOYMENT_APPROVAL", configurationSha256 };
}
async function main() {
  const [releasePath, servicePath, iamPath] = process.argv.slice(2);
  check(releasePath && servicePath && iamPath && process.argv.length === 5, "USAGE: node scripts/medusa-staging-release.mjs release.json resolved-service.yaml iam-policies.json");
  const [release, service, template, policies, approval] = await Promise.all([
    fs.readFile(releasePath, "utf8").then(JSON.parse), fs.readFile(servicePath, "utf8").then(load),
    fs.readFile(new URL("../deploy/medusa/service.yaml", import.meta.url), "utf8").then(load),
    fs.readFile(iamPath, "utf8").then(JSON.parse), bundledPolicy(),
  ]);
  console.log(JSON.stringify(validateRelease(service, release, template, policies, approval)));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  // Do not echo input files: a misprepared operator artifact may contain secrets.
  console.error(error instanceof TypeError || error instanceof SyntaxError ? "INVALID_RELEASE_INPUT" : error.message);
  process.exitCode = 1;
});
