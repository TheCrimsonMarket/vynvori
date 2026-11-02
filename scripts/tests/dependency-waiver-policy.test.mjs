import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { digest } from "../security/audit-policy.mjs";
import { evaluateWaivers, collectWaiverState, validateWaiverPolicy, WAIVER_POLICY_SHA256, WAIVER_CEILING } from "../security/dependency-waiver-policy.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const policy = JSON.parse(await fs.readFile(new URL("../../security/dependency-waiver-policy.json", import.meta.url), "utf8"));
const fixture = JSON.parse(await fs.readFile(new URL("../../security/fixtures/dependency-waiver-audits.json", import.meta.url), "utf8"));

// Frozen synthetic state derived only from the captured audits, so unrelated lockfile changes never alter these cases.
const productionNodes = new Set(Object.values(fixture.production.vulnerabilities).flatMap(record => record.nodes));
const packages = {};
for (const record of Object.values(fixture.all.vulnerabilities)) for (const node of record.nodes) {
  packages[node] = { version: "0.0.0", ...(productionNodes.has(node) ? {} : { dev: true }) };
}
const installed = {};
for (const waiver of policy.waivers) for (const node of waiver.nodes) {
  packages[node.path] = { ...packages[node.path], version: node.version };
  installed[node.path] = { name: waiver.package, version: node.version, context: node.context };
}
const state = { lockSha256: "a".repeat(64), lock: { lockfileVersion: 3, packages }, installed };
const now = new Date("2026-11-03T00:00:00Z");
const run = audit => ({ stdout: JSON.stringify(audit), exitCode: audit.metadata?.vulnerabilities?.total ? 1 : 0 });
const call = (overrides = {}) => evaluateWaivers({ policy, state, production: run(fixture.production), all: run(fixture.all), now, env: {}, ...overrides });
const rejected = (result, code) => { assert.equal(result.accepted, false); assert.equal(result.status, "REJECTED"); if (code) assert.equal(result.code, code); };
const addOrigin = (audit, name, origin) => {
  const changed = structuredClone(audit);
  changed.vulnerabilities[name].via.push({ ...changed.vulnerabilities[name].via.find(item => typeof item === "object"), ...origin });
  return changed;
};

test("reviewed policy is anchored and the captured audits are accepted with every finding counted", () => {
  assert.equal(digest(policy), WAIVER_POLICY_SHA256);
  assert.equal(policy.expiresAt, WAIVER_CEILING);
  const result = call();
  assert.equal(result.accepted, true, result.code);
  assert.equal(result.status, "ACCEPTED_WITH_DATED_WAIVER");
  assert.equal(result.counts.total, 63);
  assert.equal(result.counts.high + result.counts.critical, 0);
  assert.equal(result.allDependencyCounts.total, 82);
  assert.deepEqual(result.waiversUsed, policy.waivers.map(waiver => waiver.ghsa).sort());
});

test("unrelated lockfile and source changes do not invalidate the waiver", () => {
  assert.equal(call({ state: { ...state, lockSha256: "b".repeat(64) } }).accepted, true);
});

test("policy or metadata edits cannot bless themselves, and expiry cannot exceed the code ceiling", () => {
  for (const [key, value] of [["expiresAt", "2027-01-31T23:59:59Z"], ["authority", "unreviewed"], ["deploymentAuthorized", true], ["scope", "production"]]) {
    rejected(call({ policy: { ...policy, [key]: value } }), "WAIVER_POLICY_FINGERPRINT_MISMATCH");
  }
  const widened = structuredClone(policy);
  widened.waivers[0].severity = "high";
  rejected(call({ policy: widened }), "WAIVER_POLICY_FINGERPRINT_MISMATCH");
  assert.throws(() => validateWaiverPolicy({ ...policy, waivers: [] }), /WAIVER_POLICY_FINGERPRINT_MISMATCH/);
});

test("waiver window is absolute and the boundary instant is rejected", () => {
  assert.equal(call({ now: new Date("2026-12-17T23:59:58Z") }).accepted, true);
  for (const value of ["2026-12-17T23:59:59Z", "2026-12-18T00:00:00Z", "2026-11-01T23:59:59Z", "invalid"]) {
    rejected(call({ now: new Date(value) }), "WAIVER_EXPIRED_OR_INVALID_TIME");
  }
});

for (const severity of ["low", "moderate"]) test(`a new ${severity} advisory is rejected without severity filtering`, () => {
  const changed = addOrigin(fixture.production, "glob", { severity, url: "https://github.com/advisories/GHSA-1111-2222-3333" });
  rejected(call({ production: run(changed) }), "UNWAIVED_ADVISORY");
});

for (const severity of ["high", "critical"]) test(`a ${severity} record can never be waived`, () => {
  const changed = structuredClone(fixture.production);
  changed.vulnerabilities.glob.severity = severity;
  rejected(call({ production: run(changed) }), "UNWAIVABLE_SEVERITY");
});

test("a waived GHSA must keep its exact package, severity and range", () => {
  const borrowed = structuredClone(fixture.production);
  borrowed.vulnerabilities.unreviewed = { ...structuredClone(borrowed.vulnerabilities.glob), name: "unreviewed", nodes: ["node_modules/glob"] };
  borrowed.metadata.vulnerabilities.moderate++; borrowed.metadata.vulnerabilities.total++;
  rejected(call({ production: run(borrowed) }), "ADVISORY_ORIGIN_MISMATCH");
  for (const field of [{ severity: "low" }, { range: "<=99.0.0" }, { name: "other" }]) {
    const changed = structuredClone(fixture.production);
    Object.assign(changed.vulnerabilities.glob.via.find(item => typeof item === "object"), field);
    rejected(call({ production: run(changed) }), "ADVISORY_ORIGIN_MISMATCH");
  }
});

test("a waived package at a new path or unreviewed installed version is rejected", () => {
  const path = structuredClone(fixture.production);
  path.vulnerabilities.glob.nodes.push("node_modules/other/node_modules/glob");
  const pathState = structuredClone(state);
  pathState.lock.packages["node_modules/other/node_modules/glob"] = { version: "13.0.7" };
  rejected(call({ production: run(path), state: pathState }), "UNWAIVED_VULNERABLE_NODE");
  const version = structuredClone(state);
  version.installed["node_modules/glob"].version = "13.0.5";
  rejected(call({ state: version }), "UNWAIVED_VULNERABLE_NODE");
});

test("development-only waivers cannot cover production-audit findings", () => {
  const changed = structuredClone(fixture.production);
  changed.vulnerabilities.esbuild = structuredClone(fixture.all.vulnerabilities.esbuild);
  changed.metadata.vulnerabilities.moderate++; changed.metadata.vulnerabilities.total++;
  rejected(call({ production: run(changed) }), "DEVELOPMENT_NODE_IN_PRODUCTION_AUDIT");
});

test("vulnerable paths outside the lockfile are rejected", () => {
  const changed = structuredClone(fixture.production);
  const name = Object.keys(changed.vulnerabilities).find(key => !["glob", "minimatch", "deepmerge"].includes(key));
  changed.vulnerabilities[name].nodes = ["node_modules/not-in-lock"];
  rejected(call({ production: run(changed) }), "UNREVIEWED_VULNERABLE_PATH");
});

test("missing, malformed, truncated and inconsistent audit output fail", () => {
  for (const stdout of ["", "not json", "{", "null", "{}", JSON.stringify({ ...fixture.production, metadata: {} })]) rejected(call({ production: { stdout, exitCode: 1 } }));
  const counts = structuredClone(fixture.production);
  counts.metadata.vulnerabilities.total--;
  rejected(call({ production: run(counts) }), "AUDIT_COUNTS_INCOMPLETE");
  const truncated = structuredClone(fixture.production);
  truncated.vulnerabilities.glob.via = [];
  rejected(call({ production: run(truncated) }), "ADVISORY_RECORD_INCOMPLETE");
  const reference = structuredClone(fixture.production);
  const dependent = Object.keys(reference.vulnerabilities).find(key => reference.vulnerabilities[key].via.every(item => typeof item === "string"));
  reference.vulnerabilities[dependent].via = ["missing-package"];
  rejected(call({ production: run(reference) }), "UNMAPPABLE_ADVISORY_REFERENCE");
  const origin = structuredClone(fixture.production);
  origin.vulnerabilities.glob.via.find(item => typeof item === "object").url = "https://example.invalid/unmapped";
  rejected(call({ production: run(origin) }), "UNMAPPABLE_ADVISORY_ORIGIN");
});

test("propagated records must trace to a waived origin and cannot exceed its severity", () => {
  const cycle = structuredClone(fixture.production);
  const record = name => ({ name, severity: "moderate", isDirect: false, via: [name === "cycle-a" ? "cycle-b" : "cycle-a"], effects: [], range: "*", nodes: ["node_modules/glob"], fixAvailable: false });
  cycle.vulnerabilities["cycle-a"] = record("cycle-a");
  cycle.vulnerabilities["cycle-b"] = record("cycle-b");
  cycle.metadata.vulnerabilities.moderate += 2; cycle.metadata.vulnerabilities.total += 2;
  rejected(call({ production: run(cycle) }), "UNMAPPABLE_ADVISORY_GRAPH");
  const escalated = structuredClone(fixture.production);
  const dependent = Object.keys(escalated.vulnerabilities).find(key => escalated.vulnerabilities[key].via.length === 1 && escalated.vulnerabilities[key].via[0] === "deepmerge");
  assert.ok(dependent, "fixture has a record propagated only from the low deepmerge origin");
  escalated.vulnerabilities[dependent].severity = "moderate";
  escalated.metadata.vulnerabilities.low--; escalated.metadata.vulnerabilities.moderate++;
  rejected(call({ production: run(escalated) }), "ADVISORY_GRAPH_CHANGED");
});

test("execution, signal and exit-status failures are never waived, for either audit", () => {
  for (const key of ["production", "all"]) {
    const base = run(fixture[key]);
    rejected(call({ [key]: { ...base, executionError: true } }), "AUDIT_EXECUTION_FAILURE");
    rejected(call({ [key]: { ...base, signal: "SIGKILL" } }), "AUDIT_EXECUTION_FAILURE");
    rejected(call({ [key]: { ...base, exitCode: 2 } }), "AUDIT_EXECUTION_FAILURE");
    rejected(call({ [key]: { ...base, exitCode: 0 } }), "AUDIT_EXIT_STATUS_INCONSISTENT");
    rejected(call({ [key]: { stdout: JSON.stringify({ error: { code: "EAI_AGAIN" } }), exitCode: 1 } }), "AUDIT_EXECUTION_FAILURE");
  }
});

test("remote context, feature activation and unreviewed registry invalidate the waiver", () => {
  for (const env of [{ M2_ENV: "staging" }, { VERCEL_ENV: "production" }, { VERCEL: "1" }, { K_SERVICE: "remote" }, { VYNVORI_PAYMENTS_LIVE: "true" },
    { NPM_CONFIG_REGISTRY: "https://unreviewed.invalid" }, { npm_config_workspaces: "false" }]) rejected(call({ env }));
});

test("a fully clean pair of audits passes as CLEAN", () => {
  const clean = audit => ({ ...audit, vulnerabilities: {}, metadata: { ...audit.metadata, vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } });
  assert.equal(call({ production: run(clean(fixture.production)), all: run(clean(fixture.all)) }).status, "CLEAN");
});

test("installed-tree collection fails closed on changed versions or contexts", async () => {
  const current = await collectWaiverState(root, policy).then(value => ({ value }), error => ({ error }));
  // The real install either matches every reviewed node or is rejected with a waiver-specific code.
  if (current.error) assert.match(current.error.message, /^(WAIVED_|UNREVIEWED_NPM_CONFIGURATION|LOCK_FORMAT)/);
  else assert.deepEqual(Object.keys(current.value.installed).sort(), policy.waivers.flatMap(waiver => waiver.nodes.map(node => node.path)).sort());
  const version = structuredClone(policy);
  version.waivers[0].nodes[0].version = "13.0.5";
  await assert.rejects(collectWaiverState(root, version), /WAIVED_LOCK_ENTRY_CHANGED/);
  const context = structuredClone(policy);
  context.waivers[0].nodes[0].context = "development";
  await assert.rejects(collectWaiverState(root, context), /WAIVED_NODE_CONTEXT_CHANGED/);
});
