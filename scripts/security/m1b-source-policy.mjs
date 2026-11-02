// A separate proposed source/CI approval. These selectors stay inactive until explicit owner approval.
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { snapshot, digest, sha256 } from "./audit-policy.mjs";
import { auditIdentity, contextAllowed } from "./pr5-local-policy.mjs";
export const M1B_IMPLEMENTATION_COMMIT = "UNACTIVATED";
export const M1B_POLICY_DIGEST = "UNACTIVATED";
export const M1B_POLICY_PATH = "security/m1b-source-ci-policy.json";
export const M1B_SCOPE = "m1b-github-ci-source-only";
export const M1B_EXPIRY = "2026-10-24T23:59:59Z";
export const M1B_ADVISORIES = [
  { name: "braces", version: "3.0.3", ghsa: "GHSA-vfj7-8cjw-p6xm", nodes: ["node_modules/braces"] },
  { name: "sprintf-js", version: "1.0.3", ghsa: "GHSA-hp3w-g68c-fv3c", nodes: ["node_modules/sprintf-js"] },
  { name: "esbuild", version: "0.18.20", ghsa: "GHSA-67mh-4wv8-2f99", nodes: ["node_modules/@esbuild-kit/core-utils/node_modules/esbuild"] },
];
const roots = ["apps", "packages", "services", "scripts", ".github/workflows", "package.json", ".env.example", "security/fixtures", "deploy", "vercel.json", ".vercelignore"];
const check = (condition, code) => { if (!condition) throw new Error(code); };
const equal = (a, b) => digest(a) === digest(b);
const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 }).trim();
function normalize(file, bytes) {
  const text = bytes.toString("utf8");
  if (bytes.includes(0) || !Buffer.from(text).equals(bytes)) return bytes;
  let result = text.replaceAll("\r\n", "\n");
  if (file === "scripts/security/audit-policy.mjs") result = result.replace(/export const APPROVED_POLICY_SHA256 = "[^"]+";/, 'export const APPROVED_POLICY_SHA256 = "REVIEWED_ANCHOR";');
  if (file === "scripts/security/m1b-source-policy.mjs") result = result.replace(/(export const M1B_(?:IMPLEMENTATION_COMMIT|POLICY_DIGEST) = )"[^"]+";/g, '$1"UNACTIVATED";');
  return result;
}
const fingerprint = state => ({ lockSha256: state.lockSha256, manifests: state.manifests, surface: state.surface, rootConfiguration: state.rootConfiguration, edges: state.edges, installed: state.installed, resolutions: state.resolutions });
export function m1bContext(env) {
  contextAllowed(env); // Additional existing local-only restrictions; this is not M2 approval.
  check(env.M1B_SECURITY_SCOPE === M1B_SCOPE && env.GITHUB_ACTIONS === "true" && env.GITHUB_REPOSITORY === "TheCrimsonMarket/vynvori" &&
    env.GITHUB_EVENT_NAME === "pull_request" && env.GITHUB_BASE_REF === "main" && env.GITHUB_HEAD_REF === "codex/m1b-central-identity", "M1B_CI_CONTEXT_REQUIRED");
  check((env.NODE_TLS_REJECT_UNAUTHORIZED === undefined || env.NODE_TLS_REJECT_UNAUTHORIZED === "1") && !env.NODE_OPTIONS && !env.NODE_EXTRA_CA_CERTS, "M1B_TLS_OR_NODE_OVERRIDE_FORBIDDEN");
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("M1B_") && key !== "M1B_SECURITY_SCOPE" && value) throw new Error("M1B_LIVE_CONFIGURATION_FORBIDDEN");
    if (key.toLowerCase() === "npm_config_registry" && value) check(/^https:\/\/registry\.npmjs\.org\/?$/.test(value), "UNREVIEWED_AUDIT_REGISTRY");
    if (["npm_config_workspace", "npm_config_workspaces"].includes(key.toLowerCase()) && value !== undefined)
      check(key.toLowerCase() === "npm_config_workspaces" && value === "true", "PARTIAL_WORKSPACE_AUDIT");
    if (/^npm_config_(?:omit|include|only|production|audit_level|ca|cafile|proxy|https_proxy)$/i.test(key) && value) throw new Error("M1B_AUDIT_OVERRIDE_FORBIDDEN");
    if (key.toLowerCase() === "npm_config_strict_ssl" && value !== undefined) check(value === "true", "M1B_TLS_OR_NODE_OVERRIDE_FORBIDDEN");
  }
}
/** Diagnostic collection only. Produces no approval and accepts no caller-selected source roots. */
export async function collectM1bReviewState(root) {
  const lockSha256 = sha256(await fs.readFile(path.join(root, "package-lock.json")));
  const state = await snapshot(root, { fingerprint: { lockSha256, securityRoots: roots }, exceptions: M1B_ADVISORIES });
  check(state.lock.packages["node_modules/@medusajs/medusa"]?.version === "2.21.2" && state.lock.packages["node_modules/@medusajs/js-sdk"]?.version === "2.21.2", "M1B_MEDUSA_VERSION_CHANGED");
  for (const file of Object.keys(state.surface)) state.surface[file] = sha256(normalize(file, await fs.readFile(path.join(root, file))));
  for (const edge of state.resolutions) check(edge.child === edge.resolved, "M1B_INSTALLED_RESOLUTION_CHANGED");
  for (const [location, installed] of Object.entries(state.installed)) {
    const locked = state.lock.packages[location], marker = location.lastIndexOf("node_modules/");
    const name = locked?.name ?? (marker >= 0 ? location.slice(marker + "node_modules/".length) : undefined);
    check(locked && installed.version === locked.version && installed.name === name, "M1B_INSTALLED_VERSION_CHANGED");
    for (const kind of ["dependencies", "optionalDependencies", "peerDependencies"]) check(equal(installed[kind], locked[kind] ?? {}), "M1B_INSTALLED_GRAPH_CHANGED");
  }
  return { ...fingerprint(state), commit: git(root, ["rev-parse", "HEAD"]), platform: process.platform };
}
function metadata(policy, approval, now) {
  check(/^[a-f0-9]{40}$/.test(approval.implementation) && /^[a-f0-9]{64}$/.test(approval.digest), "M1B_NOT_APPROVED");
  check(policy.version === 1 && policy.medusaVersion === "2.21.2" && digest(policy) === approval.digest && policy.implementationCommit === approval.implementation && policy.approved === true &&
    policy.authority === "VYNVORI founder" && policy.scope === M1B_SCOPE && policy.remoteExecutionApproved === false &&
    policy.expiresAt === M1B_EXPIRY && equal(policy.advisories, M1B_ADVISORIES), "M1B_APPROVAL_CHANGED");
  const approved = Date.parse(policy.approvedOn + "T00:00:00Z"), expiry = Date.parse(policy.expiresAt);
  check(/^\d{4}-\d{2}-\d{2}$/.test(policy.approvedOn ?? "") && Number.isFinite(approved) && new Date(approved).toISOString().startsWith(policy.approvedOn) && Number.isFinite(now.getTime()) && approved <= now.getTime() && now.getTime() < expiry, "M1B_APPROVAL_EXPIRED_OR_INVALID");
}
export async function collectApprovedM1bState(root, policy, env, now = new Date()) {
  metadata(policy, { implementation: M1B_IMPLEMENTATION_COMMIT, digest: M1B_POLICY_DIGEST }, now); m1bContext(env);
  const state = await collectM1bReviewState(root);
  check(state.platform === "linux" && equal(fingerprint(state), policy.fingerprint), "M1B_SOURCE_OR_DEPENDENCY_CHANGED");
  check(git(root, ["merge-base", policy.implementationCommit, "HEAD"]) === policy.implementationCommit, "M1B_IMPLEMENTATION_LINEAGE_CHANGED");
  const files = Object.keys(policy.fingerprint.surface).sort();
  const objects = execFileSync("git", ["cat-file", "--batch"], { cwd: root, input: files.map(file => `${policy.implementationCommit}:${file}\n`).join(""), maxBuffer: 32 * 1024 * 1024 });
  let position = 0;
  for (const file of files) {
    const end = objects.indexOf(10, position), [, kind, size] = objects.subarray(position, end).toString().split(" ");
    check(kind === "blob" && /^\d+$/.test(size), "M1B_REVIEWED_SOURCE_OBJECT_MISSING");
    const bytes = objects.subarray(end + 1, end + 1 + Number(size)); position = end + 2 + Number(size);
    check(sha256(normalize(file, bytes)) === policy.fingerprint.surface[file], "M1B_REVIEWED_SOURCE_CHANGED");
  }
  return { ...state, boundaryVerified: true };
}
const defaultApproval = () => ({ implementation: M1B_IMPLEMENTATION_COMMIT, digest: M1B_POLICY_DIGEST });
/** Pure evaluator; the production runner never supplies a test approval or caller-provided image/report. */
export function validateM1bInputs(input, approval = defaultApproval()) {
  const { policy, state, production, all, env, now = new Date() } = input;
  metadata(policy, approval, now); m1bContext(env);
  check(state.boundaryVerified === true && state.platform === "linux" && equal(fingerprint(state), policy.fingerprint), "M1B_SOURCE_OR_DEPENDENCY_CHANGED");
  for (const [name, audit] of [["production", production], ["all", all]]) {
    check(audit && !audit.executionError && !audit.signal && [0, 1].includes(audit.exitCode), "M1B_AUDIT_EXECUTION_FAILED");
    const identity = auditIdentity(JSON.parse(audit.stdout));
    check(identity.counts.critical === 0, "M1B_CRITICAL_ADVISORY_FORBIDDEN");
    const required = M1B_ADVISORIES.filter(item => name === "all" || item.name !== "esbuild").map(item => "https://github.com/advisories/" + item.ghsa).sort();
    const actual = [...new Set(Object.values(identity.graph).flatMap(item => item.mappedOrigins))].sort();
    check(equal(actual, required), "M1B_REQUIRED_ADVISORY_OR_FULL_AUDIT_MISSING");
    check(audit.exitCode === (identity.counts.total ? 1 : 0) && equal(identity, policy.audits[name]), "M1B_ADVISORY_GRAPH_CHANGED");
    const allowed = new Set(M1B_ADVISORIES.map(item => "https://github.com/advisories/" + item.ghsa));
    for (const record of Object.values(identity.graph)) check(record.mappedOrigins.every(origin => allowed.has(origin)), "M1B_UNREVIEWED_ADVISORY");
  }
}
export function evaluateM1b(input, approval = defaultApproval()) {
  try {
    validateM1bInputs(input, approval);
    const { image, policy, now = new Date() } = input;
    check(image?.localEngineVerified === true && /^sha256:[a-f0-9]{64}$/.test(image.imageId) && /^[a-f0-9]{64}$/.test(image.archiveSha256), "M1B_IMAGE_EXECUTION_INVALID");
    check(image.inventory?.uid === 65532 && image.inventory.node === "v22.23.3" && image.inventory.architecture === "x64" &&
      image.inventory.nodeBinarySha256 === "fde6a4bf8d0562f7751d1a2d6cb9b417c4cfe107bbcb0aa3e9a24e125e348f48", "M1B_RUNTIME_PRIVILEGE_OR_VERSION_CHANGED");
    check(image.configuration?.User === "65532:65532", "M1B_RUNTIME_PRIVILEGE_OR_VERSION_CHANGED");
    check(equal({ configuration: image.configuration, inventory: image.inventory, baseLayers: image.baseLayers, scan: image.scan }, policy.runtime), "M1B_RUNTIME_OR_ADVISORY_CHANGED");
    check(Array.isArray(image.scan) && image.scan.length === 2 && new Set(image.scan.map(group => group.class)).size === 2, "M1B_SCAN_INCOMPLETE");
    for (const group of image.scan) {
      check(["os-pkgs", "lang-pkgs"].includes(group.class) && Array.isArray(group.findings), "M1B_SCAN_INCOMPLETE");
      check(group.findings.every(item => ["LOW", "MEDIUM", "HIGH"].includes(item.Severity)), "M1B_CRITICAL_ADVISORY_FORBIDDEN");
      if (group.class === "os-pkgs") check(group.findings.length <= 31 && group.findings.every(item => ["LOW", "MEDIUM"].includes(item.Severity)), "M1B_OS_RISK_LIMIT_EXCEEDED");
      else check(group.findings.every(item => (item.PkgName === "braces" && item.InstalledVersion === "3.0.3" && ["CVE-2026-93687", "GHSA-vfj7-8cjw-p6xm"].includes(item.VulnerabilityID)) ||
        (item.PkgName === "sprintf-js" && item.InstalledVersion === "1.0.3" && ["CVE-2026-97058", "GHSA-hp3w-g68c-fv3c"].includes(item.VulnerabilityID))), "M1B_RUNTIME_ADVISORY_OUTSIDE_SCOPE");
    }
    const updated = Date.parse(image.database?.UpdatedAt), next = Date.parse(image.database?.NextUpdate);
    check(Number.isFinite(updated) && Number.isFinite(next) && updated <= now.getTime() + 300000 && now.getTime() - updated <= 86400000 && next > now.getTime(), "M1B_VULNERABILITY_DATABASE_STALE");
    return { accepted: true, status: "ACCEPTED_WITH_FOUNDER_M1B_CI_ONLY_EXCEPTION", originalAuditExitCode: input.production.exitCode, allDependencyAuditExitCode: input.all.exitCode,
      counts: policy.audits.production.counts, allCounts: policy.audits.all.counts, remoteExecutionApproved: false };
  } catch (error) { return { accepted: false, status: "REJECTED", code: error.message }; }
}
export function m1bProposal(state, production, all, image) {
  return { version: 1, medusaVersion: "2.21.2", approved: false, authority: null, approvedOn: null, scope: M1B_SCOPE, remoteExecutionApproved: false, implementationCommit: state.commit, expiresAt: M1B_EXPIRY,
    advisories: M1B_ADVISORIES, fingerprint: fingerprint(state), audits: { production: auditIdentity(JSON.parse(production.stdout)), all: auditIdentity(JSON.parse(all.stdout)) },
    runtime: { configuration: image.configuration, inventory: image.inventory, baseLayers: image.baseLayers, scan: image.scan } };
}
