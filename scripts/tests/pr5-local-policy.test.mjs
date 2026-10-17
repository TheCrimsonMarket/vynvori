import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { digest } from "../security/audit-policy.mjs";
import { evaluateLocal, collectLocalState, verifyCleanCheckout, REVIEWED_HEAD, POLICY_PATH } from "../security/pr5-local-policy.mjs";
import { PR5_IMPLEMENTATION_COMMIT, PR5_POLICY_DIGEST } from "../security/run-audit.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const audits = JSON.parse(await fs.readFile(new URL("../../security/fixtures/pr5-reviewed-audits.json", import.meta.url), "utf8"));
const runtime = JSON.parse(await fs.readFile(new URL("../../security/fixtures/pr5-reviewed-runtime.json", import.meta.url), "utf8"));
const legacy = JSON.parse(await fs.readFile(new URL("../../security/m2-exception-policy.json", import.meta.url), "utf8"));
const active = PR5_IMPLEMENTATION_COMMIT !== "UNACTIVATED";
// Pure evaluator cases use frozen reviewed data even before activation. This is
// a test fixture, never a source of production approval or a policy updater.
const fixturePolicy = { schemaVersion: 1, authority: "VYNVORI founder", approvedOn: "2026-10-17", reviewedHead: REVIEWED_HEAD,
  implementationCommit: "1".repeat(40), scope: "synthetic-only-local-PR5-preparation", remoteExecutionApproved: false,
  expiresAt: "2026-11-15T23:59:59Z", lockSha256: legacy.fingerprint.lockSha256, manifests: legacy.fingerprint.manifests,
  rootConfiguration: legacy.fingerprint.rootConfiguration, ancestryEdges: [], advisories: [
    { ghsa: "GHSA-vfj7-8cjw-p6xm", name: "braces", version: "3.0.3", nodes: ["node_modules/braces"], context: "trusted-local-runtime-discovery-only" },
    { ghsa: "GHSA-hp3w-g68c-fv3c", name: "sprintf-js", version: "1.0.3", nodes: ["node_modules/sprintf-js"], context: "fixed-native-cli-only" },
    { ghsa: "GHSA-67mh-4wv8-2f99", name: "esbuild", version: "0.18.20", nodes: ["node_modules/@esbuild-kit/core-utils/node_modules/esbuild"], context: "non-public-build-test-only-no-dev-server" },
  ] };
const policy = active ? JSON.parse(await fs.readFile(new URL(`../../${POLICY_PATH}`, import.meta.url), "utf8")) : fixturePolicy;
const policyDigest = active ? PR5_POLICY_DIGEST : digest(policy);
const state = { boundaryVerified: true, commit: "2".repeat(40), tree: "3".repeat(40), lockSha256: policy.lockSha256,
  manifests: policy.manifests, rootConfiguration: policy.rootConfiguration, edges: policy.ancestryEdges,
  installed: Object.fromEntries(policy.advisories.flatMap(item => item.nodes.map(node => [node, { name: item.name, version: item.version }]))),
  reviewed: audits, runtime };
const input = { policy, policyDigest, implementationCommit: policy.implementationCommit, state,
  production: { stdout: JSON.stringify(audits.rawProduction), exitCode: 1 }, all: { stdout: JSON.stringify(audits.rawAll), exitCode: 1 },
  image: { ...runtime, imageId: runtime.reviewedImageIndex, archiveSha256: "4".repeat(64), localEngineVerified: true,
    database: { UpdatedAt: "2026-10-16T01:00:00Z", NextUpdate: "2026-10-17T01:00:00Z" } },
  now: new Date("2026-10-17T00:00:00Z"), env: { PR5_SECURITY_SCOPE: "local-synthetic-only" } };
const rejected = (changed, code) => { const result = evaluateLocal(changed); assert.equal(result.accepted, false); if (code) assert.equal(result.code, code); };

test("exact frozen local input is accepted, raw audit failures and remote prohibition stay visible", () => {
  const result = evaluateLocal(input);
  assert.equal(result.accepted, true, result.code);
  assert.equal(result.status, "ACCEPTED_WITH_FOUNDER_LOCAL_PR5_EXCEPTION");
  assert.equal(result.originalAuditExitCode, 1);
  assert.equal(result.allDependencyAuditExitCode, 1);
  assert.equal(result.counts.total, 79);
  assert.equal(result.allDependencyCounts.total, 85);
  assert.equal(result.osFindingPairs, 31);
  assert.equal(result.remoteExecutionApproved, false);
});
test("actual committed activation is sealed, or the unactivated implementation fails closed", async () => {
  if (!active) {
    await assert.rejects(collectLocalState(root, PR5_IMPLEMENTATION_COMMIT, PR5_POLICY_DIGEST, fixturePolicy, legacy), /LOCAL_POLICY_NOT_ACTIVATED/);
  } else {
    const actual = await collectLocalState(root, PR5_IMPLEMENTATION_COMMIT, PR5_POLICY_DIGEST, policy, legacy);
    assert.equal(actual.boundaryVerified, true);
    assert.equal(actual.implementationCommit, policy.implementationCommit);
    assert.match(actual.commit, /^[a-f0-9]{40}$/);
    assert.match(actual.tree, /^[a-f0-9]{40}$/);
    await assert.rejects(collectLocalState(root, PR5_IMPLEMENTATION_COMMIT, PR5_POLICY_DIGEST, { ...policy, scope: "remote" }, legacy), /FINGERPRINT_MISMATCH/);
  }
});
for (const env of [{}, { PR5_SECURITY_SCOPE: "remote" }, { M2_ENV: "staging" }, { K_SERVICE: "service" }, { CLOUD_RUN_JOB: "job" },
  { CLOUD_RUN_EXECUTION: "execution" }, { VERCEL: "1" }, { VERCEL_ENV: "preview" }, { NODE_ENV: "production" },
  { VYNVORI_PAYMENTS_LIVE: "true" }, { VYNVORI_M1B: "true" }, { M2_MEDUSA_ORIGIN: "https://remote.invalid" },
  { M2_MEDUSA_DATABASE_URL: "postgres://synthetic:synthetic@remote.invalid/db" }, { STRIPE_SECRET_KEY: "synthetic-not-approved" },
  { GOOGLE_APPLICATION_CREDENTIALS: "/tmp/not-approved" }, { DOCKER_HOST: "tcp://127.0.0.1:2375" },
  { npm_config_workspace: "apps/medusa" }, { npm_config_registry: "https://unreviewed.invalid" }]) {
  test(`unreviewed execution context rejected: ${JSON.stringify(Object.keys(env))}`, () => {
    rejected({ ...input, env: Object.keys(env).length ? { ...input.env, ...env } : {} });
  });
}
test("expiry, invalid time and a changed approval cannot extend acceptance", () => {
  for (const time of ["2026-11-15T23:59:59Z", "2026-11-16T00:00:00Z", "invalid"]) rejected({ ...input, now: new Date(time) }, "LOCAL_APPROVAL_EXPIRED");
  const changed = { ...policy, expiresAt: "2027-01-01T00:00:00Z" };
  rejected({ ...input, policy: changed }, "LOCAL_POLICY_FINGERPRINT_MISMATCH");
  rejected({ ...input, policy: changed, policyDigest: digest(changed) }, "LOCAL_APPROVAL_METADATA_CHANGED");
});
test("changed source proof, lock, manifests, installed versions and resolutions fail", () => {
  for (const [key, value] of [["boundaryVerified", false], ["lockSha256", "changed"], ["manifests", {}], ["edges", [{ child: "changed" }]], ["rootConfiguration", {}]]) {
    rejected({ ...input, state: { ...state, [key]: value } });
  }
  const changed = structuredClone(state); changed.installed["node_modules/braces"].version = "3.0.4";
  rejected({ ...input, state: changed }, "UNAPPROVED_INSTALLED_ADVISORY_PATH");
});
for (const which of ["production", "all"]) {
  test(`${which}: new/changed advisory, missing graph and inconsistent counts fail`, () => {
    const audit = structuredClone(which === "production" ? audits.rawProduction : audits.rawAll);
    audit.vulnerabilities.braces.via[0].url = "https://github.com/advisories/GHSA-1111-2222-3333";
    rejected({ ...input, [which]: { ...input[which], stdout: JSON.stringify(audit) } }, "LOCAL_AUDIT_ADVISORY_OR_GRAPH_CHANGED");
    audit.vulnerabilities.braces.via[0].url = (which === "production" ? audits.rawProduction : audits.rawAll).vulnerabilities.braces.via[0].url;
    audit.vulnerabilities.braces.via[0].title += " changed";
    rejected({ ...input, [which]: { ...input[which], stdout: JSON.stringify(audit) } }, "LOCAL_AUDIT_ADVISORY_OR_GRAPH_CHANGED");
    delete audit.vulnerabilities.braces;
    rejected({ ...input, [which]: { ...input[which], stdout: JSON.stringify(audit) } });
  });
  test(`${which}: malformed output, network error, signal and changed exit cannot be waived`, () => {
    for (const value of [{ stdout: "{" }, { stdout: "{}" }, { executionError: true }, { signal: "SIGTERM" }, { exitCode: 0 }, { exitCode: 2 }]) rejected({ ...input, [which]: { ...input[which], ...value } });
  });
}
test("esbuild exact path, version and advisory cannot borrow runtime acceptance", () => {
  const audit = structuredClone(audits.rawAll); audit.vulnerabilities.esbuild.nodes = ["node_modules/esbuild"];
  rejected({ ...input, all: { ...input.all, stdout: JSON.stringify(audit) } }, "LOCAL_AUDIT_ADVISORY_OR_GRAPH_CHANGED");
});
test("npm redundant cycle/fix suggestions do not alter exact advisory origins or locked scope", () => {
  const audit = structuredClone(audits.rawProduction);
  const name = Object.keys(audit.vulnerabilities).find(key => typeof audit.vulnerabilities[key].fixAvailable === "object" && !audit.vulnerabilities[key].via.some(value => typeof value === "object"));
  assert.ok(name);
  audit.vulnerabilities[name].fixAvailable.name = "different-redundant-parent-suggestion";
  const result = evaluateLocal({ ...input, production: { ...input.production, stdout: JSON.stringify(audit) } });
  assert.equal(result.accepted, true, result.code);
  audit.vulnerabilities.braces.fixAvailable = { name: "eslint-config-next", version: "14.2.35", isSemVerMajor: true };
  assert.equal(evaluateLocal({ ...input, production: { ...input.production, stdout: JSON.stringify(audit) } }).accepted, true);
  audit.vulnerabilities.braces.fixAvailable = { name: "braces", version: "3.0.4", isSemVerMajor: false };
  rejected({ ...input, production: { ...input.production, stdout: JSON.stringify(audit) } }, "LOCAL_AUDIT_ADVISORY_OR_GRAPH_CHANGED");
});
test("unexpected image files, Node binary, base, configuration or incomplete evidence fail", () => {
  for (const [key, value] of [["inventory", {}], ["baseLayers", []], ["configuration", {}], ["archiveSha256", "missing"], ["imageId", "missing"], ["localEngineVerified", false], ["database", {}]]) rejected({ ...input, image: { ...input.image, [key]: value } });
});
test("exact reviewed Linux checkout inventory passes; changed file/mode fingerprint does not", () => {
  const image = { ...input.image, inventory: runtime.linuxInventory };
  assert.equal(evaluateLocal({ ...input, image }).accepted, true);
  rejected({ ...input, image: { ...image, inventory: { ...image.inventory, appFileTreeSha256: "0".repeat(64) } } }, "RUNTIME_FILES_OR_BINARY_CHANGED");
});
test("only the web runner's exact external generated-output symlink may be untracked", async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "VYNVORI-policy-test-"));
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "VYNVORI-M0-next-"));
  const link = path.join(folder, "apps/web/.next");
  try {
    execFileSync("git", ["init", "--quiet", folder]);
    await fs.mkdir(path.dirname(link), { recursive: true });
    await verifyCleanCheckout(folder);
    await fs.symlink(output, link, process.platform === "win32" ? "junction" : "dir");
    await verifyCleanCheckout(folder);
    await fs.writeFile(path.join(folder, "unreviewed.mjs"), "changed");
    await assert.rejects(verifyCleanCheckout(folder), /UNCOMMITTED_SECURITY_BOUNDARY/);
    await fs.unlink(path.join(folder, "unreviewed.mjs"));
    await fs.unlink(link);
    await fs.symlink(folder, link, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(verifyCleanCheckout(folder), /UNCOMMITTED_SECURITY_BOUNDARY/);
    await fs.unlink(link);
    await fs.writeFile(link, "not a generated-output link");
    await assert.rejects(verifyCleanCheckout(folder), /UNCOMMITTED_SECURITY_BOUNDARY/);
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
    await fs.rm(output, { recursive: true, force: true });
  }
});
test("OS/JS new finding, advisory modification, package change or truncated report fail", () => {
  for (const change of ["finding", "metadata", "package", "truncate"]) {
    const scan = structuredClone(runtime.scan);
    if (change === "finding") scan[0].findings.push({ VulnerabilityID: "CVE-NEW" });
    if (change === "metadata") scan[0].findings[0].Title += " changed";
    if (change === "package") scan[0].packages[0].version += "-changed";
    if (change === "truncate") scan.pop();
    rejected({ ...input, image: { ...input.image, scan } }, "RUNTIME_ADVISORY_OR_PACKAGE_CHANGED");
  }
});
test("stale or future vulnerability database metadata cannot pass", () => {
  for (const database of [{ UpdatedAt: "2026-10-01T00:00:00Z", NextUpdate: "2026-10-02T00:00:00Z" },
    { UpdatedAt: "2026-10-18T00:00:00Z", NextUpdate: "2026-10-19T00:00:00Z" }]) rejected({ ...input, image: { ...input.image, database } }, "VULNERABILITY_DATABASE_STALE");
});
