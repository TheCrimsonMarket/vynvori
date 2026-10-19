import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { digest } from "../security/audit-policy.mjs";
import { auditIdentity } from "../security/pr5-local-policy.mjs";
import { collectM1bReviewState, collectApprovedM1bState, evaluateM1b, m1bProposal, M1B_SCOPE, M1B_ADVISORIES, M1B_EXPIRY } from "../security/m1b-source-policy.mjs";
const audits = JSON.parse(await fs.readFile(new URL("../../security/fixtures/pr5-reviewed-audits.json", import.meta.url), "utf8"));
const now = new Date("2026-10-19T12:00:00Z");
const env = { PR5_SECURITY_SCOPE: "local-synthetic-only", M1B_SECURITY_SCOPE: M1B_SCOPE, GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "TheCrimsonMarket/vynvori", GITHUB_EVENT_NAME: "pull_request", GITHUB_BASE_REF: "main", GITHUB_HEAD_REF: "codex/m1b-central-identity" };
// Pure evaluator fixtures do not create a production approval or supply inputs to the runner.
const state = { boundaryVerified: true, platform: "linux", commit: "a".repeat(40), lockSha256: "b".repeat(64), manifests: {}, surface: {}, rootConfiguration: {}, edges: [], installed: {}, resolutions: [] };
const image = { localEngineVerified: true, imageId: "sha256:" + "c".repeat(64), archiveSha256: "d".repeat(64),
  configuration: { User: "65532:65532" }, inventory: { uid: 65532, node: "v22.23.3", architecture: "x64", nodeBinarySha256: "fde6a4bf8d0562f7751d1a2d6cb9b417c4cfe107bbcb0aa3e9a24e125e348f48", appFileTreeSha256: "e".repeat(64) }, baseLayers: ["synthetic-base"], scan: [{ class: "os-pkgs", findings: [] }, { class: "lang-pkgs", findings: [] }],
  database: { UpdatedAt: "2026-10-19T11:00:00Z", NextUpdate: "2026-10-19T17:00:00Z" } };
const production = { stdout: JSON.stringify(audits.rawProduction), exitCode: 1, executionError: false, signal: null }, all = { ...production, stdout: JSON.stringify(audits.rawAll) };
function input() {
  const proposal = m1bProposal(state, production, all, image);
  const policy = { ...proposal, approved: true, approvedOn: "2026-10-19", authority: "VYNVORI founder" };
  assert.equal(policy.expiresAt, M1B_EXPIRY); assert.deepEqual(policy.advisories, M1B_ADVISORIES);
  return { policy, state: structuredClone(state), image: structuredClone(image), production: structuredClone(production), all: structuredClone(all), env: { ...env }, now };
}
const approval = value => ({ implementation: value.policy.implementationCommit, digest: digest(value.policy) });
const rejected = (value, expected, anchor = approval(value)) => { const result = evaluateM1b(value, anchor); assert.equal(result.accepted, false); if (expected) assert.equal(result.code, expected); };
test("unactivated production selectors cannot accept a policy that approves itself", () => {
  const value = input(); assert.equal(evaluateM1b(value).code, "M1B_NOT_APPROVED");
  const proposal = m1bProposal(state, production, all, image); assert.equal(proposal.approved, false); assert.equal(proposal.authority, null);
});
test("real diagnostic collection includes the current install and cannot create approved state", async () => {
  const root = fileURLToPath(new URL("../..", import.meta.url)), current = await collectM1bReviewState(root);
  assert.match(current.commit, /^[a-f0-9]{40}$/); assert.ok(current.surface["scripts/security/m1b-source-policy.mjs"]); assert.ok(current.surface["vercel.json"]);
  assert.equal(current.boundaryVerified, undefined);
  await assert.rejects(collectApprovedM1bState(root, input().policy, env, now), /M1B_NOT_APPROVED/);
});
test("exact trusted test input preserves unfiltered findings and denies remote approval", () => {
  const value = input(), result = evaluateM1b(value, approval(value)); assert.equal(result.accepted, true, result.code);
  assert.equal(result.originalAuditExitCode, 1); assert.equal(result.allDependencyAuditExitCode, 1); assert.equal(result.remoteExecutionApproved, false);
  assert.deepEqual(result.counts, auditIdentity(audits.rawProduction).counts);
});
test("policy edits cannot retain a prior approval digest", () => {
  const value = input(), anchor = approval(value); value.policy.expiresAt = "2027-01-01T00:00:00Z"; rejected(value, "M1B_APPROVAL_CHANGED", anchor);
});
test("source, manifest and installed-resolution drift are refused", () => {
  for (const field of ["surface", "manifests", "installed", "resolutions"]) { const value = input(); value.state[field] = { changed: true }; rejected(value, "M1B_SOURCE_OR_DEPENDENCY_CHANGED"); }
});
test("live, non-Linux, fork and operational contexts are refused", () => {
  for (const patch of [{ VERCEL: "1" }, { K_SERVICE: "service" }, { GITHUB_REPOSITORY: "other/repo" }, { GITHUB_EVENT_NAME: "push" }, { GITHUB_HEAD_REF: "main" },
    { M1B_CENTRAL_CLIENT_SECRET: "synthetic-not-allowed" }, { VYNVORI_IDENTITY_CENTRAL_SSO: "true" }, { M2_CREATIVE_DATABASE_URL: "postgres://synthetic:synthetic@example.invalid/db" }, { npm_config_workspace: "@vynvori/web" },
    { NODE_TLS_REJECT_UNAUTHORIZED: "0" }, { NODE_OPTIONS: "--require=unreviewed" }, { npm_config_omit: "dev" }, { npm_config_strict_ssl: "false" }]) {
    const value = input(); Object.assign(value.env, patch); rejected(value);
  }
  const value = input(); value.state.platform = "win32"; rejected(value, "M1B_SOURCE_OR_DEPENDENCY_CHANGED");
});
test("expiry, failed audits and changed advisory graphs cannot be excepted", () => {
  const expired = input(); expired.now = new Date(M1B_EXPIRY); rejected(expired, "M1B_APPROVAL_EXPIRED_OR_INVALID");
  for (const patch of [{ executionError: true }, { exitCode: 2 }, { signal: "SIGTERM" }]) { const value = input(); Object.assign(value.production, patch); rejected(value, "M1B_AUDIT_EXECUTION_FAILED"); }
  const value = input(); const audit = JSON.parse(value.production.stdout); audit.vulnerabilities.braces.via[0].title += " changed"; value.production.stdout = JSON.stringify(audit); rejected(value, "M1B_ADVISORY_GRAPH_CHANGED");
  const suppressed = input(); suppressed.all = structuredClone(production); suppressed.policy.audits.all = auditIdentity(audits.rawProduction); rejected(suppressed, "M1B_REQUIRED_ADVISORY_OR_FULL_AUDIT_MISSING");
});
test("runtime image substitution, root actor and stale scanner DB are refused", () => {
  for (const patch of [{ localEngineVerified: false }, { imageId: "unverified" }, { archiveSha256: "short" }, { inventory: { ...image.inventory, uid: 0 } }, { scan: [] },
    { database: { UpdatedAt: "2026-10-01T00:00:00Z", NextUpdate: "2026-11-01T00:00:00Z" } }]) { const value = input(); Object.assign(value.image, patch); rejected(value); }
});
test("data-only approval cannot broaden image risk caps", () => {
  const value = input(); value.image.scan[0].findings = [{ Severity: "HIGH" }]; value.policy.runtime.scan = structuredClone(value.image.scan);
  rejected(value, "M1B_OS_RISK_LIMIT_EXCEEDED");
  const foreign = input(); foreign.image.scan[1].findings = [{ PkgName: "unknown", Severity: "MEDIUM" }]; foreign.policy.runtime.scan = structuredClone(foreign.image.scan);
  rejected(foreign, "M1B_RUNTIME_ADVISORY_OUTSIDE_SCOPE");
  const critical = input(); critical.image.scan[1].findings = [{ PkgName: "braces", InstalledVersion: "3.0.3", VulnerabilityID: "CVE-2026-93687", Severity: "CRITICAL" }]; critical.policy.runtime.scan = structuredClone(critical.image.scan);
  rejected(critical, "M1B_CRITICAL_ADVISORY_FORBIDDEN");
});
