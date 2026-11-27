import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { digest } from "../security/audit-policy.mjs";
import { evaluateWaivers, collectWaiverState, inspectWaivedNodes, validateWaiverPolicy, checkWaiverShape, waiverExpiry, activeWaivers,
  WAIVER_POLICY_SHA256, WAIVER_CEILING } from "../security/dependency-waiver-policy.mjs";

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
// ADR-0024: the production audit is clean, so production-side cases inject records at this synthetic production node.
const PRODUCTION_NODE = "node_modules/synthetic-production-package";
packages[PRODUCTION_NODE] = { version: "1.0.0" };
const state = { lockSha256: "a".repeat(64), lock: { lockfileVersion: 3, packages }, installed };
const ESBUILD = "GHSA-67mh-4wv8-2f99";
const now = new Date("2026-11-03T00:00:00Z");
const run = audit => ({ stdout: JSON.stringify(audit), exitCode: audit.metadata?.vulnerabilities?.total ? 1 : 0 });
const call = (overrides = {}) => evaluateWaivers({ policy, state, production: run(fixture.production), all: run(fixture.all), now, env: {}, ...overrides });
const rejected = (result, code) => { assert.equal(result.accepted, false); assert.equal(result.status, "REJECTED"); if (code) assert.equal(result.code, code); };
// A production finding for a package that is not in the reviewed waiver set, with consistent counts.
const withProductionRecord = (audit, { name = "synthetic-production-package", severity = "moderate", ghsa = "GHSA-1111-2222-3333", range = "<2.0.0" } = {}) => {
  const changed = structuredClone(audit);
  changed.vulnerabilities[name] = { name, severity, isDirect: true, via: [{ source: 1, name, dependency: name, title: "Synthetic production advisory",
    url: `https://github.com/advisories/${ghsa}`, severity, cwe: [], cvss: {}, range }], effects: [], range, nodes: [PRODUCTION_NODE], fixAvailable: false };
  changed.metadata.vulnerabilities[severity]++; changed.metadata.vulnerabilities.total++;
  return changed;
};
const origin = audit => audit.vulnerabilities.esbuild.via.find(item => typeof item === "object");
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
  // ADR-0024: Medusa 2.23.1 leaves no production finding; the full audit holds only the esbuild origin and its three dependents.
  assert.equal(result.counts.total, 0);
  assert.equal(result.originalAuditExitCode, 0);
  assert.equal(result.allDependencyCounts.total, 4);
  assert.equal(result.allDependencyCounts.moderate, 4);
  assert.deepEqual(Object.keys(fixture.all.vulnerabilities).sort(), ["@esbuild-kit/core-utils", "@esbuild-kit/esm-loader", "drizzle-kit", "esbuild"]);
  assert.deepEqual(result.waiversUsed, [ESBUILD]);
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
  const context = structuredClone(policy);
  context.waivers[0].nodes[0].context = "production";
  rejected(call({ policy: context }), "WAIVER_POLICY_FINGERPRINT_MISMATCH");
  assert.throws(() => validateWaiverPolicy({ ...policy, waivers: [] }), /WAIVER_POLICY_FINGERPRINT_MISMATCH/);
});

const EXTENDED = "2027-02-28T23:59:59Z";

test("waiver window is absolute: the esbuild per-entry extension ends at its own boundary instant", () => {
  for (const value of ["2026-11-02T00:00:00Z", "2026-12-17T23:59:58Z", "2026-12-17T23:59:59Z", "2026-12-18T00:00:00Z", "2027-02-27T12:00:00Z", "2027-02-28T23:59:58Z"]) {
    const result = call({ now: new Date(value) });
    assert.equal(result.accepted, true, `${value}: ${result.code}`);
    assert.deepEqual(result.waiverExpiries, { [ESBUILD]: EXTENDED });
    assert.equal(result.expiresAt, EXTENDED);
  }
  for (const value of [EXTENDED, "2027-03-01T00:00:00Z", "2026-11-01T23:59:59Z", "invalid"]) {
    rejected(call({ now: new Date(value) }), "WAIVER_EXPIRED_OR_INVALID_TIME");
  }
});

test("the esbuild extension is flagged for re-triage from 2027-02-15 without changing the verdict", () => {
  assert.deepEqual(call({ now: new Date("2027-02-14T23:59:59Z") }).retriageDue, []);
  for (const value of ["2027-02-15T00:00:00Z", "2027-02-28T23:59:58Z"]) {
    const result = call({ now: new Date(value) });
    assert.equal(result.accepted, true);
    assert.deepEqual(result.retriageDue, [ESBUILD]);
  }
});

test("past the global ceiling the extension covers only esbuild: every other advisory is still rejected", () => {
  for (const value of ["2026-12-17T23:59:59Z", "2027-01-15T00:00:00Z"]) {
    const later = new Date(value);
    rejected(call({ now: later, production: run(withProductionRecord(fixture.production)) }), "UNWAIVED_ADVISORY");
    rejected(call({ now: later, all: run(addOrigin(fixture.all, "esbuild", { url: "https://github.com/advisories/GHSA-1111-2222-3333" })) }), "UNWAIVED_ADVISORY");
    // The extension does not relax the reviewed node, severity or graph rules either.
    const changed = structuredClone(fixture.all);
    changed.vulnerabilities.esbuild.severity = "high";
    rejected(call({ now: later, all: run(changed) }), "UNWAIVABLE_SEVERITY");
  }
});

test("per-entry expiry follows the code-listed extension only; any other entry keeps the global ceiling", () => {
  const esbuild = policy.waivers[0];
  assert.equal(esbuild.expiresAt, EXTENDED);
  assert.equal(esbuild.retriageBy, "2027-02-15");
  assert.equal(waiverExpiry(esbuild), EXTENDED);
  const { expiresAt: _drop, ...unextended } = esbuild;
  assert.equal(waiverExpiry(unextended), WAIVER_CEILING);
  assert.equal(waiverExpiry({ ...esbuild, expiresAt: "2027-12-31T23:59:59Z" }), WAIVER_CEILING);
  const other = { ...esbuild, ghsa: "GHSA-1111-2222-3333", package: "other" };
  assert.equal(waiverExpiry(other), WAIVER_CEILING);
  // A synthetic two-entry set: before the global ceiling both are active, after it only the extended esbuild entry.
  const both = [esbuild, other];
  assert.deepEqual(activeWaivers(both, new Date("2026-12-17T23:59:58Z")).map(entry => entry.ghsa), [ESBUILD, "GHSA-1111-2222-3333"]);
  assert.deepEqual(activeWaivers(both, new Date(WAIVER_CEILING)).map(entry => entry.ghsa), [ESBUILD]);
  assert.deepEqual(activeWaivers(both, new Date(EXTENDED)), []);
  assert.deepEqual(activeWaivers([unextended], new Date(WAIVER_CEILING)), []);
});

test("JSON edits cannot add, move or widen a per-entry extension", () => {
  checkWaiverShape(policy);
  // Through the real gate every edit is a fingerprint mismatch first.
  const moved = structuredClone(policy);
  moved.waivers[0].expiresAt = "2027-06-30T23:59:59Z";
  rejected(call({ policy: moved, now: new Date("2027-03-01T00:00:00Z") }), "WAIVER_POLICY_FINGERPRINT_MISMATCH");
  // Behind the anchor, the shape rules reject each edit on their own.
  const edits = [
    changed => { changed.waivers[0].expiresAt = "2027-06-30T23:59:59Z"; },
    changed => { changed.waivers[0].expiresAt = "2027-01-31T23:59:59Z"; },
    changed => { changed.waivers[0].retriageBy = "2027-02-27"; },
    changed => { delete changed.waivers[0].retriageBy; },
    changed => { delete changed.waivers[0].expiresAt; },
    changed => { changed.waivers[0].nodes[0].context = "production"; },
    changed => { changed.waivers[0].nodes.push({ ...changed.waivers[0].nodes[0], path: "node_modules/esbuild" }); },
    changed => { changed.waivers[0].nodes.push({ ...changed.waivers[0].nodes[0] }); },
    changed => { changed.waivers[0].nodes[0].path = "node_modules/esbuild"; },
    changed => { changed.waivers.push({ ...structuredClone(changed.waivers[0]), ghsa: "GHSA-1111-2222-3333" }); },
  ];
  for (const edit of edits) {
    const changed = structuredClone(policy);
    edit(changed);
    assert.throws(() => checkWaiverShape(changed), /WAIVER_EXTENSION_INVALID/, String(edit));
  }
  // An entry without an extension stays valid, and the policy-level window still cannot move.
  const plain = structuredClone(policy);
  delete plain.waivers[0].expiresAt; delete plain.waivers[0].retriageBy;
  checkWaiverShape(plain);
  for (const value of [EXTENDED, "2027-01-31T23:59:59Z"]) assert.throws(() => checkWaiverShape({ ...policy, expiresAt: value }), /WAIVER_METADATA_MISMATCH/);
});

for (const severity of ["low", "moderate"]) test(`a new ${severity} advisory is rejected without severity filtering, in either audit`, () => {
  const changed = addOrigin(fixture.all, "esbuild", { severity, url: "https://github.com/advisories/GHSA-1111-2222-3333" });
  rejected(call({ all: run(changed) }), "UNWAIVED_ADVISORY");
  rejected(call({ production: run(withProductionRecord(fixture.production, { severity })) }), "UNWAIVED_ADVISORY");
});

for (const severity of ["high", "critical"]) test(`a ${severity} record can never be waived`, () => {
  const changed = structuredClone(fixture.all);
  changed.vulnerabilities.esbuild.severity = severity;
  rejected(call({ all: run(changed) }), "UNWAIVABLE_SEVERITY");
  rejected(call({ production: run(withProductionRecord(fixture.production, { severity })) }), "UNWAIVABLE_SEVERITY");
});

test("a waived GHSA must keep its exact package, severity and range", () => {
  const borrowed = structuredClone(fixture.all);
  borrowed.vulnerabilities.unreviewed = { ...structuredClone(borrowed.vulnerabilities.esbuild), name: "unreviewed" };
  borrowed.metadata.vulnerabilities.moderate++; borrowed.metadata.vulnerabilities.total++;
  rejected(call({ all: run(borrowed) }), "ADVISORY_ORIGIN_MISMATCH");
  for (const field of [{ severity: "low" }, { range: "<=99.0.0" }, { name: "other" }]) {
    const changed = structuredClone(fixture.all);
    Object.assign(origin(changed), field);
    rejected(call({ all: run(changed) }), "ADVISORY_ORIGIN_MISMATCH");
  }
});

test("a waived package at a new path or unreviewed installed version is rejected", () => {
  const moved = structuredClone(fixture.all);
  moved.vulnerabilities.esbuild.nodes.push("node_modules/other/node_modules/esbuild");
  const movedState = structuredClone(state);
  movedState.lock.packages["node_modules/other/node_modules/esbuild"] = { version: "0.18.20", dev: true };
  rejected(call({ all: run(moved), state: movedState }), "UNWAIVED_VULNERABLE_NODE");
  const version = structuredClone(state);
  version.installed["node_modules/@esbuild-kit/core-utils/node_modules/esbuild"].version = "0.18.19";
  rejected(call({ state: version }), "UNWAIVED_VULNERABLE_NODE");
});

test("development-only waivers cannot cover production-audit findings", () => {
  const changed = structuredClone(fixture.production);
  changed.vulnerabilities.esbuild = structuredClone(fixture.all.vulnerabilities.esbuild);
  changed.metadata.vulnerabilities.moderate++; changed.metadata.vulnerabilities.total++;
  rejected(call({ production: run(changed) }), "DEVELOPMENT_NODE_IN_PRODUCTION_AUDIT");
  // Even at a production node, the development-only waiver does not apply.
  const promoted = structuredClone(changed);
  promoted.vulnerabilities.esbuild.nodes = [PRODUCTION_NODE];
  rejected(call({ production: run(promoted) }), "UNWAIVED_VULNERABLE_NODE");
});

test("vulnerable paths outside the lockfile are rejected", () => {
  const changed = structuredClone(fixture.all);
  changed.vulnerabilities["drizzle-kit"].nodes = ["node_modules/not-in-lock"];
  rejected(call({ all: run(changed) }), "UNREVIEWED_VULNERABLE_PATH");
});

test("missing, malformed, truncated and inconsistent audit output fail", () => {
  for (const key of ["production", "all"]) {
    for (const stdout of ["", "not json", "{", "null", "{}", JSON.stringify({ ...fixture[key], metadata: {} })]) rejected(call({ [key]: { stdout, exitCode: 1 } }));
    const counts = structuredClone(fixture[key]);
    counts.metadata.vulnerabilities.total++;
    rejected(call({ [key]: run(counts) }), "AUDIT_COUNTS_INCOMPLETE");
    rejected(call({ [key]: run({ ...fixture[key], auditReportVersion: 1 }) }), "AUDIT_INCOMPLETE");
    rejected(call({ [key]: run({ ...fixture[key], vulnerabilities: [] }) }), "AUDIT_INCOMPLETE");
    const dependencies = structuredClone(fixture[key]);
    dependencies.metadata.dependencies.total = 0;
    rejected(call({ [key]: run(dependencies) }), "AUDIT_DEPENDENCIES_INCOMPLETE");
  }
  const truncated = structuredClone(fixture.all);
  truncated.vulnerabilities.esbuild.via = [];
  rejected(call({ all: run(truncated) }), "ADVISORY_RECORD_INCOMPLETE");
  const reference = structuredClone(fixture.all);
  reference.vulnerabilities["drizzle-kit"].via = ["missing-package"];
  rejected(call({ all: run(reference) }), "UNMAPPABLE_ADVISORY_REFERENCE");
  const unmapped = structuredClone(fixture.all);
  origin(unmapped).url = "https://example.invalid/unmapped";
  rejected(call({ all: run(unmapped) }), "UNMAPPABLE_ADVISORY_ORIGIN");
});

test("propagated records must trace to a waived origin and cannot exceed its severity", () => {
  const cycle = structuredClone(fixture.all);
  const record = name => ({ name, severity: "moderate", isDirect: false, via: [name === "cycle-a" ? "cycle-b" : "cycle-a"], effects: [], range: "*", nodes: ["node_modules/drizzle-kit"], fixAvailable: false });
  cycle.vulnerabilities["cycle-a"] = record("cycle-a");
  cycle.vulnerabilities["cycle-b"] = record("cycle-b");
  cycle.metadata.vulnerabilities.moderate += 2; cycle.metadata.vulnerabilities.total += 2;
  rejected(call({ all: run(cycle) }), "UNMAPPABLE_ADVISORY_GRAPH");
  // The only waiver is moderate, so a propagated record can exceed its origin only by becoming high or critical, which is
  // rejected earlier as UNWAIVABLE_SEVERITY. ADVISORY_GRAPH_CHANGED stays in the evaluator as defence in depth (unreachable
  // by tests since ADR-0023); this case proves the escalation is still rejected.
  const escalated = structuredClone(fixture.all);
  assert.deepEqual(escalated.vulnerabilities["@esbuild-kit/core-utils"].via, ["esbuild"]);
  escalated.vulnerabilities["@esbuild-kit/core-utils"].severity = "high";
  escalated.metadata.vulnerabilities.moderate--; escalated.metadata.vulnerabilities.high++;
  rejected(call({ all: run(escalated) }), "UNWAIVABLE_SEVERITY");
});

test("execution, signal and exit-status failures are never waived, for either audit", () => {
  for (const key of ["production", "all"]) {
    const base = run(fixture[key]);
    rejected(call({ [key]: { ...base, executionError: true } }), "AUDIT_EXECUTION_FAILURE");
    rejected(call({ [key]: { ...base, signal: "SIGKILL" } }), "AUDIT_EXECUTION_FAILURE");
    rejected(call({ [key]: { ...base, exitCode: 2 } }), "AUDIT_EXECUTION_FAILURE");
    // The clean production audit exits 0 and the full audit exits 1; flipping either is inconsistent.
    rejected(call({ [key]: { ...base, exitCode: base.exitCode ? 0 : 1 } }), "AUDIT_EXIT_STATUS_INCONSISTENT");
    rejected(call({ [key]: { stdout: JSON.stringify({ error: { code: "EAI_AGAIN" } }), exitCode: 1 } }), "AUDIT_EXECUTION_FAILURE");
  }
});

test("remote context, feature activation and unreviewed registry invalidate the waiver", () => {
  for (const env of [{ M2_ENV: "staging" }, { VERCEL_ENV: "production" }, { VERCEL: "1" }, { K_SERVICE: "remote" }, { VYNVORI_PAYMENTS_LIVE: "true" },
    { NPM_CONFIG_REGISTRY: "https://unreviewed.invalid" }, { npm_config_workspaces: "false" }]) rejected(call({ env }));
  rejected(call({ env: { M2_MEDUSA_ORIGIN: "https://remote.example" } }), "REMOTE_DEPENDENCY_CONFIGURED");
  rejected(call({ env: { M2_DATABASE_URL: "not a url" } }), "INVALID_INTEGRATION_ENVIRONMENT");
  assert.equal(call({ env: { M2_DATABASE_URL: "postgres://localhost:5432/db" } }).accepted, true);
});

test("configuration that could narrow either audit is rejected", () => {
  for (const env of [{ npm_config_omit: "dev" }, { NPM_CONFIG_PRODUCTION: "true" }, { npm_config_include: "prod" }, { npm_config_only: "prod" },
    { npm_config_audit_level: "critical" }, { npm_config_package_lock: "false" }, { NODE_ENV: "production" }]) rejected(call({ env }), "AUDIT_SCOPE_OVERRIDE");
  assert.equal(call({ env: { NODE_ENV: "test", npm_config_user_agent: "npm/10.9.9" } }).accepted, true);
});

test("a full audit that silently dropped development or production findings is rejected", () => {
  // Equivalent to running the "all" audit with dev dependencies omitted.
  rejected(call({ all: run(fixture.production) }), "AUDIT_GRAPH_INCOMPLETE");
  // Coverage change (ADR-0024), for reviewers to accept explicitly: with no production waiver left, any production finding is
  // rejected (UNWAIVED_ADVISORY, UNWAIVED_VULNERABLE_NODE or DEVELOPMENT_NODE_IN_PRODUCTION_AUDIT) before the superset
  // comparison runs, so FULL_AUDIT_NARROWED is unreachable by tests. It stays in the evaluator as defence in depth. This case
  // proves a production finding missing from the full audit is still rejected.
  rejected(call({ production: run(withProductionRecord(fixture.production)) }), "UNWAIVED_ADVISORY");
});

test("an empty audit cannot pass while reviewed vulnerable nodes are still installed", () => {
  const clean = audit => ({ ...audit, vulnerabilities: {}, metadata: { ...audit.metadata, vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 } } });
  rejected(call({ production: run(clean(fixture.production)), all: run(clean(fixture.all)) }), "AUDIT_GRAPH_INCOMPLETE");
  // Once every entry has expired the gate rejects even clean audits, exactly as the whole-policy window did before.
  for (const value of [EXTENDED, "2027-03-01T00:00:00Z"]) {
    rejected(call({ now: new Date(value), production: run(clean(fixture.production)), all: run(clean(fixture.all)) }), "WAIVER_EXPIRED_OR_INVALID_TIME");
  }
  // A full audit that silently lost the reviewed development-only esbuild origin and everything that depends on it.
  const missing = structuredClone(fixture.all);
  const gone = new Set(["esbuild"]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, record] of Object.entries(missing.vulnerabilities)) {
      if (!gone.has(name) && record.via.some(item => typeof item === "string" && gone.has(item))) { gone.add(name); grew = true; }
    }
  }
  assert.equal(gone.size, 4, "every record in the full audit depends on the esbuild origin");
  for (const name of gone) {
    missing.metadata.vulnerabilities[missing.vulnerabilities[name].severity]--; missing.metadata.vulnerabilities.total--;
    delete missing.vulnerabilities[name];
  }
  rejected(call({ all: run(missing) }), "AUDIT_GRAPH_INCOMPLETE");
});

test("installed-tree collection fails closed on changed versions or contexts", async () => {
  const current = await collectWaiverState(root, policy).then(value => ({ value }), error => ({ error }));
  // The real install either matches every reviewed node or is rejected with a waiver-specific code.
  if (current.error) assert.match(current.error.message, /^(WAIVED_|UNREVIEWED_NPM_CONFIGURATION|LOCK_FORMAT)/);
  // With a real install (always the case in CI after npm ci) the reviewed node is present, so the checks below must run.
  const installedNode = await fs.lstat(path.join(root, policy.waivers[0].nodes[0].path, "package.json")).then(stat => stat.isFile(), () => false);
  if (installedNode) assert.equal(current.error, undefined, current.error?.message);
  else assert.deepEqual(Object.keys(current.value.installed).sort(), policy.waivers.flatMap(waiver => waiver.nodes.map(node => node.path)).sort());
  // An unreviewed policy is rejected before any path it names is read.
  await assert.rejects(collectWaiverState(root, { ...policy, waivers: [{ ...policy.waivers[0], nodes: [{ ...policy.waivers[0].nodes[0], path: "node_modules/../../etc" }] }] }), /WAIVER_POLICY_FINGERPRINT_MISMATCH/);
  if (current.error) return;
  for (const [field, value] of [["version", "0.18.19"], ["integrity", "sha512-AAAA"], ["resolved", "https://registry.npmjs.org/esbuild/-/esbuild-0.0.0.tgz"]]) {
    const changed = structuredClone(policy);
    changed.waivers[0].nodes[0][field] = value;
    await assert.rejects(inspectWaivedNodes(root, changed), /WAIVED_LOCK_ENTRY_CHANGED/);
  }
  const context = structuredClone(policy);
  context.waivers[0].nodes[0].context = "production";
  await assert.rejects(inspectWaivedNodes(root, context), /WAIVED_NODE_CONTEXT_CHANGED/);
});

test("ADR-0024 reduction: the reviewed waiver set is exactly esbuild, and the global ceiling is unchanged", () => {
  assert.deepEqual(policy.waivers.map(waiver => [waiver.package, waiver.ghsa]), [["esbuild", ESBUILD]]);
  assert.deepEqual(policy.waivers[0].nodes.map(node => [node.path, node.version, node.context]), [["node_modules/@esbuild-kit/core-utils/node_modules/esbuild", "0.18.20", "development"]]);
  assert.equal(policy.expiresAt, "2026-12-17T23:59:59Z");
  assert.equal(WAIVER_CEILING, "2026-12-17T23:59:59Z");
});

test("the removed glob, minimatch and i18next waivers fail closed if their advisories come back", () => {
  for (const [name, ghsa, range] of [["glob", "GHSA-3g3m-2fjr-6pw4", ">=9.0.0 <=14.0.1"], ["minimatch", "GHSA-g3hv-75wg-m249", ">=7.0.0 <11.0.1"], ["i18next", "GHSA-6jcc-5g8w-32mx", "<26.3.4"]]) {
    assert.ok(!policy.waivers.some(waiver => waiver.ghsa === ghsa || waiver.package === name), name);
    rejected(call({ production: run(withProductionRecord(fixture.production, { name, ghsa, range })) }), "UNWAIVED_ADVISORY");
    rejected(call({ all: run(addOrigin(fixture.all, "esbuild", { url: `https://github.com/advisories/${ghsa}` })) }), "UNWAIVED_ADVISORY");
  }
});

test("the Next.js advisories are not waived", () => {
  for (const ghsa of ["GHSA-mfr8-8qww-v76h", "GHSA-vc7v-qv4w-wrv8", "GHSA-7qx7-33qx-rqx2", "GHSA-f3mh-rxg3-f5g2", "GHSA-pc58-hwjq-p385", "GHSA-rhh4-g77r-r9qj", "GHSA-vvgp-ww4w-46vf"]) {
    assert.ok(!policy.waivers.some(waiver => waiver.ghsa === ghsa), ghsa);
    rejected(call({ production: run(withProductionRecord(fixture.production, { name: "next", ghsa })) }), "UNWAIVED_ADVISORY");
  }
});

test("the esbuild advisory must keep its current range, so an upstream range change fails closed", () => {
  const changed = structuredClone(fixture.all);
  Object.assign(origin(changed), { range: "<=0.25.0" });
  rejected(call({ all: run(changed) }), "ADVISORY_ORIGIN_MISMATCH");
});
