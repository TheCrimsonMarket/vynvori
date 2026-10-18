// A separate, founder-approved private staging exception. Historical local
// policies remain unchanged. This evaluator never updates its own approval.
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { digest, snapshot, sha256 } from "./audit-policy.mjs";
import { auditIdentity, contextAllowed } from "./pr5-local-policy.mjs";
import { validateApproval } from "../../apps/medusa/scripts/remote-staging.mjs";

export const POLICY = "security/m2-private-staging-policy.json";
const check = (ok, code) => { if (!ok) throw new Error(code); };
const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 }).trim();
export const normalizeStagingSource = (file, text) => {
  text = text.replaceAll("\r\n", "\n");
  if (file === "scripts/security/run-audit.mjs") text = text.replace(/(STAGING_(?:IMPLEMENTATION_COMMIT|POLICY_DIGEST) = )"[^"]+"/g, '$1"UNACTIVATED"');
  if (file === "apps/medusa/scripts/remote-staging-policy.json") {
    const p = JSON.parse(text);
    return JSON.stringify({ ...p, approved: false, approvedBy: null, sourceCommit: null });
  }
  return text;
};

export async function collectStagingState(root, implementation, anchor, legacy) {
  check(/^[a-f0-9]{40}$/.test(implementation) && /^[a-f0-9]{64}$/.test(anchor), "STAGING_NOT_ACTIVATED");
  const policy = JSON.parse(await fs.readFile(`${root}/${POLICY}`, "utf8"));
  check(digest(policy) === anchor && policy.implementationCommit === implementation &&
    policy.authority === "VYNVORI founder" && policy.approvedOn === "2026-10-18" &&
    policy.scope === "private-synthetic-staging-only" && policy.expiresAt === "2026-10-24T23:59:59Z", "STAGING_POLICY_CHANGED");
  check(git(root, ["rev-parse", "HEAD"]) === implementation && implementation === policy.reviewedBase &&
    policy.reviewedBase === "f923f7b26c4fc0684e26cfdf29ebf177d80103f6", "STAGING_BASE_CHANGED");
  const state = await snapshot(root, legacy);
  check(digest(state.manifests) === digest(legacy.fingerprint.manifests) &&
    digest(state.edges) === digest(legacy.fingerprint.ancestryEdges) &&
    digest(state.rootConfiguration) === digest(legacy.fingerprint.rootConfiguration), "STAGING_DEPENDENCIES_CHANGED");
  for (const edge of state.resolutions) check(edge.child === edge.resolved, "STAGING_INSTALLED_RESOLUTION_CHANGED");
  for (const [location, installed] of Object.entries(state.installed)) {
    const expected = state.lock.packages[location];
    check(expected && installed.version === expected.version, "STAGING_INSTALLED_VERSION_CHANGED");
    for (const kind of ["dependencies", "optionalDependencies", "peerDependencies"]) check(digest(installed[kind]) === digest(expected[kind] ?? {}), "STAGING_INSTALLED_GRAPH_CHANGED");
  }
  // No Git mutation is authorized. Seal the exact overlay on verified main,
  // including this evaluator and all deployment inputs. Only the two literal
  // anchor selectors and the separately validated runtime approval are normalized.
  const fingerprints = {};
  for (const file of [...Object.keys(state.surface), "deploy/medusa/service.yaml", "deploy/medusa/release.example.json"]) {
    const actual = await fs.readFile(`${root}/${file}`);
    const text = !actual.includes(0) && Buffer.from(actual.toString("utf8"), "utf8").equals(actual);
    fingerprints[file] = sha256(text ? normalizeStagingSource(file, actual.toString("utf8")) : actual);
  }
  check(digest(fingerprints) === digest(policy.sourceFingerprints), "STAGING_SOURCE_CHANGED");
  const approval = JSON.parse(await fs.readFile(`${root}/apps/medusa/scripts/remote-staging-policy.json`, "utf8"));
  validateApproval(approval);
  check(approval.sourceCommit === implementation && approval.approvedBy === "VYNVORI founder" && approval.expiresAt === policy.expiresAt, "STAGING_APPROVAL_MISMATCH");
  return { policy, state, sourceCommit: git(root, ["rev-parse", "HEAD"]), implementation,
    runtime: JSON.parse(await fs.readFile(`${root}/security/fixtures/pr5-reviewed-runtime.json`, "utf8")) };
}

export function validateStagingAudits({ policy, production, all, env, now = new Date() }) {
  contextAllowed(env);
  check(Number.isFinite(+now) && +now >= Date.parse("2026-10-17T23:34:00Z") && +now < Date.parse(policy.expiresAt) &&
    policy.expiresAt === "2026-10-24T23:59:59Z", "STAGING_EXCEPTION_EXPIRED");
  for (const [name, audit] of [["production", production], ["all", all]]) {
    check(audit && !audit.executionError && !audit.signal && audit.exitCode === 1, "STAGING_AUDIT_EXECUTION_FAILED");
    check(digest(auditIdentity(JSON.parse(audit.stdout))) === policy.auditIdentities[name], "STAGING_ADVISORY_OR_GRAPH_CHANGED");
  }
}

export function evaluateStaging(input) {
  try {
    validateStagingAudits(input);
    const { policy, image, runtime } = input;
    const now = input.now ?? new Date();
    check(image.localEngineVerified && new Date(image.database.UpdatedAt) <= now && new Date(image.database.NextUpdate) > now, "STAGING_SCAN_DATABASE_STALE");
    check(digest(image.scan) === policy.scanIdentity, "STAGING_IMAGE_FINDINGS_CHANGED");
    check(digest(image.configuration) === digest(runtime.configuration) && digest(image.baseLayers) === digest(runtime.baseLayers), "STAGING_RUNTIME_CHANGED");
    check(image.inventory.uid === 65532 && image.inventory.architecture === "x64" && image.inventory.node === "v22.23.3" &&
      image.inventory.nodeBinarySha256 === runtime.inventory.nodeBinarySha256 && /^[a-f0-9]{64}$/.test(image.inventory.appFileTreeSha256), "STAGING_RUNTIME_INVENTORY_INVALID");
    return { accepted: true, status: "ACCEPTED_WITH_FOUNDER_PRIVATE_STAGING_EXCEPTION", scope: policy.scope,
      remoteExecutionApproved: true, expiresAt: policy.expiresAt, sourceCommit: input.sourceCommit,
      implementationCommit: input.implementation, sourceOverlaySha256: digest(policy.sourceFingerprints), imageId: image.imageId,
      originalAuditExitCode: input.production.exitCode, allDependencyAuditExitCode: input.all.exitCode };
  } catch (error) { return { accepted: false, status: "REJECTED", code: error.message }; }
}
