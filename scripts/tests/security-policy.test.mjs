import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { evaluate, snapshot, digest, sha256, APPROVED_POLICY_SHA256 } from "../security/audit-policy.mjs";
import { safeEvidence, summarizeAudit } from "../security/run-audit.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const policy = JSON.parse(await fs.readFile(new URL("../../security/m2-exception-policy.json", import.meta.url), "utf8"));
const audit = JSON.parse(await fs.readFile(new URL("../../security/fixtures/m2-reviewed-audit.json", import.meta.url), "utf8"));
const state = await snapshot(root, policy);
const now = new Date("2026-10-16T00:00:00Z");
const call = (overrides = {}) => evaluate({ policy, state, stdout: JSON.stringify(audit), exitCode: 1, now, ...overrides });
const rejected = (result, code) => { assert.equal(result.accepted, false); assert.equal(result.status, "REJECTED"); if (code) assert.equal(result.code, code); };

test("reviewed fingerprint/graph passes before expiry and records all findings", () => {
  assert.equal(digest(policy), APPROVED_POLICY_SHA256);
  const result = call();
  assert.equal(result.accepted, true, result.code);
  assert.equal(result.status, "ACCEPTED_WITH_TEMPORARY_EXCEPTION");
  assert.equal(result.originalAuditExitCode, 1);
  assert.equal(result.counts.total, 79);
  assert.deepEqual([...new Set(result.records.flatMap(record => record.mappedOrigins))].sort(), policy.exceptions.map(entry => entry.ghsa).sort());
});

for (const severity of ["high", "moderate", "low", "info", "critical"]) test(`new ${severity} advisory is rejected without severity filtering`, () => {
  const changed = structuredClone(audit);
  changed.vulnerabilities.braces.via.push({ ...changed.vulnerabilities.braces.via[0], severity, url: "https://github.com/advisories/GHSA-1111-2222-3333" });
  rejected(call({ stdout: JSON.stringify(changed) }), "UNAPPROVED_ADVISORY");
});
test("unknown package cannot borrow an approved GHSA", () => {
  const changed = structuredClone(audit);
  changed.vulnerabilities.unreviewed = { ...changed.vulnerabilities.braces, name: "unreviewed" };
  rejected(call({ stdout: JSON.stringify(changed) }), "UNREVIEWED_AFFECTED_PACKAGE");
});
test("approved GHSA must retain the exact originating package", () => {
  const changed = structuredClone(audit);
  changed.vulnerabilities.braces.via[0].name = "unknown";
  rejected(call({ stdout: JSON.stringify(changed) }), "ADVISORY_ORIGIN_MISMATCH");
});
test("unapproved installed package version fails", () => {
  const changed = structuredClone(state);
  changed.installed["node_modules/braces"].version = "3.0.4";
  rejected(call({ state: changed }), "INSTALLED_PACKAGE_CHANGED");
});
test("any lockfile byte change fails even with an unchanged audit count", () => {
  rejected(call({ state: { ...state, lockSha256: sha256("changed lockfile") } }), "LOCK_FINGERPRINT_MISMATCH");
});
test("changed installed dependency chain and resolution fail", () => {
  const changed = structuredClone(state);
  changed.installed["node_modules/micromatch"].dependencies.braces = "unreviewed";
  rejected(call({ state: changed }), "INSTALLED_DEPENDENCY_CHAIN_CHANGED");
  const resolution = structuredClone(state);
  resolution.resolutions[0].resolved = "node_modules/unreviewed";
  rejected(call({ state: resolution }), "INSTALLED_RESOLUTION_CHANGED");
  rejected(call({ state: { ...state, edges: state.edges.slice(1) } }), "DEPENDENCY_ANCESTRY_CHANGED");
});
test("changed manifest inventory or dependency fields fail", () => {
  rejected(call({ state: { ...state, manifests: { ...state.manifests, "packages/auth-bridge/package.json": "new" } } }), "MANIFEST_FINGERPRINT_MISMATCH");
});
test("missing, malformed and incomplete audit output fail", () => {
  for (const stdout of ["", "not json", "{", "null", "{}", JSON.stringify({ ...audit, metadata: {} })]) rejected(call({ stdout }));
  const changed = structuredClone(audit);
  changed.vulnerabilities.braces.via = [];
  rejected(call({ stdout: JSON.stringify(changed) }), "ADVISORY_RECORD_INCOMPLETE");
});
test("network, spawn, signal and inconsistent-exit failures cannot be excepted", () => {
  rejected(call({ executionError: true }), "AUDIT_EXECUTION_FAILURE");
  rejected(call({ signal: "SIGKILL" }), "AUDIT_EXECUTION_FAILURE");
  rejected(call({ exitCode: 2 }), "AUDIT_EXECUTION_FAILURE");
  rejected(call({ stdout: JSON.stringify({ error: { code: "EAI_AGAIN" } }) }), "AUDIT_EXECUTION_FAILURE");
  rejected(call({ exitCode: 0 }), "AUDIT_EXIT_STATUS_INCONSISTENT");
});
test("unmappable originating and propagated vulnerability records fail", () => {
  const changed = structuredClone(audit);
  changed.vulnerabilities.braces.via[0].url = "https://example.invalid/unmapped";
  rejected(call({ stdout: JSON.stringify(changed) }), "UNMAPPABLE_ADVISORY_ORIGIN");
  const reference = structuredClone(audit);
  reference.vulnerabilities.micromatch.via = ["missing-package"];
  rejected(call({ stdout: JSON.stringify(reference) }), "UNMAPPABLE_ADVISORY_REFERENCE");
});
test("absolute expiry cannot be extended and the boundary instant is rejected", () => {
  assert.equal(call({ now: new Date("2026-11-15T23:59:58Z") }).accepted, true);
  for (const value of ["2026-11-15T23:59:59Z", "2026-11-16T00:00:00Z"]) rejected(call({ now: new Date(value) }), "APPROVAL_EXPIRED_OR_INVALID_TIME");
});
test("policy or approval-metadata edits cannot bless themselves", () => {
  for (const key of ["authority", "expiresAt", "approvedOn", "scope"]) {
    const changed = structuredClone(policy); changed[key] = "unreviewed";
    rejected(call({ policy: changed }), "POLICY_FINGERPRINT_MISMATCH");
  }
});
test("changed customer/Store boundary, M1b files or workflow exposure fail", () => {
  for (const file of ["apps/medusa/src/config.ts", "apps/medusa/src/api/middlewares.ts", ".github/workflows/m2.yml", "packages/auth-bridge/src/index.ts"]) {
    rejected(call({ state: { ...state, surface: { ...state.surface, [file]: sha256("changed boundary") } } }), "SECURITY_BOUNDARY_CHANGED");
  }
});
test("detectable remote environment and feature activation invalidate the exception", () => {
  for (const env of [{ M2_ENV: "staging" }, { VERCEL_ENV: "production" }, { K_SERVICE: "remote" }, { VYNVORI_PAYMENTS_LIVE: "true" }, { M2_MEDUSA_ORIGIN: "https://remote.example" }]) rejected(call({ env }));
});
test("a fully clean audit can pass without obsolete-origin requirements; changed dependencies still require review", () => {
  const clean = { ...audit, vulnerabilities: {}, metadata: { ...audit.metadata, vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } };
  assert.equal(call({ stdout: JSON.stringify(clean), exitCode: 0 }).status, "CLEAN");
  rejected(call({ stdout: JSON.stringify(clean), exitCode: 0, state: { ...state, lockSha256: sha256("patched but not yet reviewed") } }), "LOCK_FINGERPRINT_MISMATCH");
});
test("audit artifacts cannot expose credential-like command output", () => {
  assert.equal(safeEvidence(JSON.stringify(audit), {}), true);
  assert.equal(safeEvidence("https://synthetic:password@registry.invalid", {}), false);
  assert.equal(safeEvidence("credential-token-synthetic", { NPM_TOKEN: "credential-token-synthetic" }), false);
});
test("rejected new origins still appear in parsed audit evidence", () => {
  const changed = structuredClone(audit);
  changed.vulnerabilities.braces.via.push({ ...changed.vulnerabilities.braces.via[0], url: "https://github.com/advisories/GHSA-1111-2222-3333" });
  rejected(call({ stdout: JSON.stringify(changed) }), "UNAPPROVED_ADVISORY");
  const summary = summarizeAudit(JSON.stringify(changed), state);
  assert.equal(summary.totals.total, 79);
  assert.equal(summary.records.find(record => record.name === "braces").originatingGhsas[1].ghsa, "GHSA-1111-2222-3333");
});
test("consistent counts cannot bless a truncated propagation graph", () => {
  const truncated = structuredClone(audit);
  truncated.vulnerabilities = { braces: truncated.vulnerabilities.braces, "sprintf-js": truncated.vulnerabilities["sprintf-js"] };
  truncated.metadata.vulnerabilities = { info: 0, low: 0, moderate: 1, high: 1, critical: 0, total: 2 };
  rejected(call({ stdout: JSON.stringify(truncated) }), "AUDIT_GRAPH_INCOMPLETE");
});
test("new root npm configuration, shrinkwrap or partial-workspace audit requires review", () => {
  rejected(call({ state: { ...state, rootConfiguration: { ...state.rootConfiguration, "npm-shrinkwrap.json": sha256("unreviewed graph") } } }), "UNREVIEWED_NPM_CONFIGURATION");
  rejected(call({ env: { NPM_CONFIG_REGISTRY: "https://unreviewed.invalid" } }), "UNREVIEWED_AUDIT_REGISTRY");
  rejected(call({ env: { npm_config_workspaces: "false" } }), "PARTIAL_WORKSPACE_AUDIT");
});
